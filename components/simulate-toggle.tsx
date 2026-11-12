"use client";

import { useCallback, useEffect, useState } from "react";

interface SimulationState {
  running: boolean;
  ratePerSecond: number;
  produced: number;
  stoppedBecause: "duration" | "call_cap" | null;
}

const POLL_MS = 2000;

const STOPPED_BECAUSE = {
  duration: "Stopped itself after 30 minutes.",
  call_cap: "Stopped itself at the row cap.",
} as const;

/**
 * Starts and stops the simulated traffic (`POST /api/demo/simulate`, demo mode only; the
 * page decides whether to render this). Everything it makes is labelled "simulated" wherever
 * Calls are listed.
 */
export function SimulateToggle() {
  const [state, setState] = useState<SimulationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/demo/simulate");
      if (response.ok) setState((await response.json()) as SimulationState);
    } catch {
      // Try again on the next poll.
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  async function send(action: "start" | "stop") {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/demo/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json()) as SimulationState & {
        error?: { message: string };
      };
      if (response.ok) setState(body);
      else setError(body.error?.message ?? "Couldn't change the simulated traffic.");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  const running = state?.running ?? false;
  return (
    <div className="flex flex-wrap items-center gap-3" aria-label="Simulated traffic">
      <button
        type="button"
        disabled={pending || state === null}
        onClick={() => send(running ? "stop" : "start")}
        className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60"
      >
        {running ? "Stop simulated traffic" : "Start simulated traffic"}
      </button>
      <span className="text-sm text-muted" role="status">
        {state === null
          ? "Checking…"
          : running
            ? `Running, 1 to ${state.ratePerSecond} calls a second · ${state.produced} simulated so far`
            : state.stoppedBecause
              ? `${STOPPED_BECAUSE[state.stoppedBecause]} ${state.produced} simulated calls.`
              : state.produced > 0
                ? `Stopped · ${state.produced} simulated calls`
                : "Stopped"}
      </span>
      {error && (
        <span role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
