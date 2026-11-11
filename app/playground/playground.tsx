"use client";

import { useRef, useState } from "react";
import { CallFeed } from "@/components/call-feed";
import { formatUsd } from "@/lib/money";
import { CheckoutButton } from "./checkout-button";

const DEFAULT_PROMPT = "Find me the best 4K monitor under $300 that's actually in stock";

type Recommendation = { name: string; priceMicro: string; url?: string } | null;

type Step =
  | { kind: "reasoning"; text: string }
  | { kind: "call"; id: string; label: string; costMicro?: string; ok?: boolean; error?: string }
  | { kind: "note"; tone: "busy" | "error"; text: string };

interface RunState {
  status: "idle" | "running" | "done";
  steps: Step[];
  answer: string;
  budgetMicro: bigint;
  spentMicro: bigint;
  recommendation: Recommendation;
}

const idle: RunState = {
  status: "idle",
  steps: [],
  answer: "",
  budgetMicro: 0n,
  spentMicro: 0n,
  recommendation: null,
};

type ServerEvent =
  | { type: "start"; agent: string; budgetMicro: string }
  | { type: "reasoning"; text: string }
  | { type: "answer"; text: string }
  | { type: "tool-call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool-result"; id: string; ok: boolean; costMicro: string; output: unknown }
  | { type: "notice"; text: string }
  | { type: "busy"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; spentMicro: string; recommendation: Recommendation };

function describeCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "search_directory":
      return `Searching the directory for “${String(input.query ?? "")}”`;
    case "call_api":
      return `Calling ${String(input.seller ?? "")}${String(input.path ?? "")}`;
    case "check_budget":
      return "Checking the budget";
    case "recommend_product":
      return `Recommending ${String(input.name ?? "a product")}`;
    default:
      return name;
  }
}

function apply(state: RunState, event: ServerEvent): RunState {
  switch (event.type) {
    case "start":
      return { ...state, budgetMicro: BigInt(event.budgetMicro) };
    case "reasoning":
      return { ...state, steps: [...state.steps, { kind: "reasoning", text: event.text }] };
    case "answer":
      return { ...state, answer: event.text };
    case "tool-call":
      return {
        ...state,
        steps: [
          ...state.steps,
          { kind: "call", id: event.id, label: describeCall(event.name, event.input) },
        ],
      };
    case "tool-result": {
      const output = (event.output ?? {}) as { message?: string };
      return {
        ...state,
        spentMicro: state.spentMicro + BigInt(event.costMicro),
        steps: state.steps.map((step) =>
          step.kind === "call" && step.id === event.id
            ? {
                ...step,
                ok: event.ok,
                costMicro: event.costMicro,
                error: event.ok ? undefined : output.message,
              }
            : step,
        ),
      };
    }
    case "notice":
      return {
        ...state,
        steps: [...state.steps, { kind: "note", tone: "busy", text: event.text }],
      };
    case "busy":
      return {
        ...state,
        steps: [...state.steps, { kind: "note", tone: "busy", text: event.message }],
      };
    case "error":
      return {
        ...state,
        steps: [...state.steps, { kind: "note", tone: "error", text: event.message }],
      };
    case "done":
      return {
        ...state,
        status: "done",
        spentMicro: BigInt(event.spentMicro),
        recommendation: event.recommendation,
      };
  }
}

export function Playground({ paypalClientId }: { paypalClientId: string }) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [run, setRun] = useState<RunState>(idle);
  const [asked, setAsked] = useState("");
  const abort = useRef<AbortController | null>(null);

  async function start() {
    const text = prompt.trim();
    if (!text || run.status === "running") return;
    setAsked(text);
    setRun({ ...idle, status: "running" });
    const controller = new AbortController();
    abort.current = controller;

    try {
      const response = await fetch("/api/playground/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? "Couldn't start the agent.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line) setRun((current) => apply(current, JSON.parse(line.slice(6)) as ServerEvent));
        }
      }
      setRun((current) =>
        current.status === "running" ? { ...current, status: "done" } : current,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setRun((current) => ({
        ...current,
        status: "done",
        steps: [
          ...current.steps,
          {
            kind: "note",
            tone: "error",
            text: error instanceof Error ? error.message : "Something went wrong.",
          },
        ],
      }));
    }
  }

  function stop() {
    abort.current?.abort();
    setRun((current) => ({ ...current, status: "done" }));
  }

  const percent =
    run.budgetMicro > 0n ? Math.min(100, Number((run.spentMicro * 100n) / run.budgetMicro)) : 0;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="Chat" className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Ask the agent</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
            className="flex flex-col gap-3"
          >
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              maxLength={500}
              aria-label="What should the agent do?"
              className="w-full resize-none rounded-lg border border-line bg-transparent p-3"
            />
            <div className="flex gap-2">
              <button
                disabled={run.status === "running" || !prompt.trim()}
                className="rounded-md bg-brand px-4 py-2 text-brand-foreground disabled:opacity-60"
              >
                {run.status === "running" ? "Working…" : "Run the agent"}
              </button>
              {run.status === "running" && (
                <button
                  type="button"
                  onClick={stop}
                  className="rounded-md border border-line px-4 py-2 hover:bg-surface"
                >
                  Stop
                </button>
              )}
            </div>
          </form>

          {asked && (
            <div className="flex flex-col gap-3">
              <p className="self-end rounded-2xl bg-surface px-4 py-2">{asked}</p>
              {run.answer ? (
                <p className="whitespace-pre-wrap rounded-2xl border border-line px-4 py-3">
                  {run.answer}
                </p>
              ) : run.status === "running" ? (
                <p className="text-muted" role="status">
                  The agent is working…
                </p>
              ) : null}
            </div>
          )}
          {run.recommendation && (
            <div className="rounded-lg border border-line bg-surface p-4">
              <p className="text-sm text-muted">Recommended</p>
              <p className="font-medium">{run.recommendation.name}</p>
              <p className="mb-3">{formatUsd(BigInt(run.recommendation.priceMicro))}</p>
              <CheckoutButton
                clientId={paypalClientId}
                name={run.recommendation.name}
                priceMicro={BigInt(run.recommendation.priceMicro)}
              />
            </div>
          )}
        </section>

        <section aria-label="Reasoning" className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-lg border border-line p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-medium">Budget</h2>
              <span className="tabular-nums">
                {formatUsd(run.spentMicro)}
                <span className="text-muted">
                  {" "}
                  of {run.budgetMicro > 0n ? formatUsd(run.budgetMicro) : "—"}
                </span>
              </span>
            </div>
            <div
              role="progressbar"
              aria-label="Task budget used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 overflow-hidden rounded-full bg-surface"
            >
              <div className="h-full bg-brand transition-all" style={{ width: `${percent}%` }} />
            </div>
          </div>

          <h2 className="text-lg font-medium">What the agent is thinking</h2>
          {run.steps.length === 0 ? (
            <p className="rounded-md border border-line p-4 text-muted">
              Its reasoning about price and value appears here as it works.
            </p>
          ) : (
            <ol className="flex flex-col gap-2" aria-live="polite">
              {run.steps.map((step, index) => (
                <li key={index} className="rounded-md border border-line p-3 text-sm">
                  {step.kind === "reasoning" && <p className="italic">{step.text}</p>}
                  {step.kind === "call" && (
                    <p className="flex flex-wrap items-baseline justify-between gap-2">
                      <span>{step.label}</span>
                      {step.ok === undefined ? (
                        <span className="text-muted">…</span>
                      ) : (
                        <span
                          className={
                            step.ok
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-red-700 dark:text-red-400"
                          }
                        >
                          {step.ok
                            ? formatUsd(BigInt(step.costMicro ?? "0"))
                            : (step.error ?? "failed")}
                        </span>
                      )}
                    </p>
                  )}
                  {step.kind === "note" && (
                    <p role="alert" className="text-amber-800 dark:text-amber-300">
                      {step.text}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <CallFeed side="buyer" />
    </div>
  );
}
