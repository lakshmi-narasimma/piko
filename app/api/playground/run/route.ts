import { getPrincipal } from "@/lib/auth";
import { getRunCache, isCacheable } from "@/lib/agent/cache";
import { runAgent, type AgentEvent } from "@/lib/agent/run";
import { finishPlaygroundRun, NoAgentError, startPlaygroundRun } from "@/lib/agent/playground";
import { createToolContext } from "@/lib/agent/tools";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { getLlm } from "@/lib/llm";

const MAX_PROMPT_CHARS = 500;

/**
 * Runs the playground agent on a prompt and streams what it does as server-sent events:
 * a `start` event with the budget, then one event per thing the agent does (see AgentEvent),
 * ending with `done`. Signed-in buyers only.
 */
export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return jsonError(401, "unauthenticated", "Sign in first.");

  const body = (await request.json().catch(() => null)) as { prompt?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return jsonError(
      400,
      "invalid_request",
      `Send a prompt of up to ${MAX_PROMPT_CHARS} characters.`,
    );
  }

  const db = getDb();
  let run;
  try {
    run = await startPlaygroundRun(db, principal.org.id);
  } catch (error) {
    if (error instanceof NoAgentError) return jsonError(409, "no_agent", error.message);
    throw error;
  }

  const ctx = createToolContext({
    db,
    llm: getLlm(),
    key: run.key,
    orgId: principal.org.id,
    baseUrl: getEnv().APP_BASE_URL,
    taskBudgetMicro: run.taskBudgetMicro,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The client went away; the run still finishes and revokes its Key below.
        }
      };
      send({
        type: "start",
        agent: run.agentName,
        budgetMicro: run.taskBudgetMicro.toString(),
      });
      const cache = getRunCache();
      const events: AgentEvent[] = [];
      try {
        for await (const event of runAgent({
          llm: getLlm(),
          ctx,
          prompt,
          abortSignal: request.signal,
        })) {
          const madeProgress = events.some((e) => e.type !== "done");
          const earlier =
            event.type === "busy" && !madeProgress ? cache.get(principal.org.id, prompt) : null;
          if (earlier) {
            // The model is busy and this buyer already ran this prompt: show that run, and say so.
            send({
              type: "notice",
              text: "The AI is busy right now, so this is a replay of your recent run. No new charges were made.",
            });
            for (const past of earlier) send(past);
            events.length = 0;
            break;
          }
          events.push(event);
          send(event);
        }
        if (isCacheable(events)) cache.set(principal.org.id, prompt, events);
      } finally {
        await finishPlaygroundRun(db, run).catch(() => {});
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
