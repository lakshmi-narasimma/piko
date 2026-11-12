import { getPrincipal } from "@/lib/auth";
import { getRunCache, isCacheable, shouldReplay } from "@/lib/agent/cache";
import { runAgent, type AgentEvent } from "@/lib/agent/run";
import { finishPlaygroundRun, NoAgentError, startPlaygroundRun } from "@/lib/agent/playground";
import { createToolContext } from "@/lib/agent/tools";
import { signCheckoutToken } from "@/lib/checkout/token";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { getLlm } from "@/lib/llm";

const MAX_PROMPT_CHARS = 500;

/**
 * Runs the playground agent on a prompt and streams what it does as server-sent events:
 * a `start` event with the budget, then one event per thing the agent does (see AgentEvent),
 * ending with `done`. Signed-in buyers only.
 *
 * A `done` event with a recommendation also carries `recommendation.checkoutToken`: the
 * product and its price, signed for this org (lib/checkout/token). The checkout route charges
 * only what that token says, never a price the browser sends. Tokens are minted as each event
 * is sent, not cached, so a replayed run gets a fresh one.
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

  // From here the run holds a live Key, so any failure before the stream starts revokes it.
  let ctx;
  let llm;
  let secret: string;
  try {
    secret = getEnv().SESSION_SECRET;
    llm = getLlm();
    ctx = createToolContext({
      db,
      llm,
      key: run.key,
      orgId: principal.org.id,
      baseUrl: getEnv().APP_BASE_URL,
      taskBudgetMicro: run.taskBudgetMicro,
    });
  } catch (error) {
    console.error("playground run failed to start", error);
    await revokeQuietly(db, run);
    return jsonError(500, "internal_error", "The agent couldn't start. Try again.");
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          const framed = withCheckoutToken(event, principal.org.id, secret);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(framed)}\n\n`));
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
          llm,
          ctx,
          prompt,
          abortSignal: request.signal,
        })) {
          // Replay only while no paid call has settled or is in flight (see shouldReplay).
          const earlier = shouldReplay(event, ctx.state)
            ? cache.get(principal.org.id, prompt)
            : null;
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
        await revokeQuietly(db, run);
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

/** Adds a signed checkout token to a `done` event that has a recommendation. */
function withCheckoutToken(event: unknown, orgId: string, secret: string): unknown {
  const done = event as Partial<Extract<AgentEvent, { type: "done" }>> | null;
  if (done?.type !== "done" || !done.recommendation) return event;
  const { name, priceMicro, url } = done.recommendation;
  const checkoutToken = signCheckoutToken(
    { orgId, name, priceMicro: BigInt(priceMicro), url },
    secret,
  );
  return { ...done, recommendation: { ...done.recommendation, checkoutToken } };
}

/** Revokes the run's Key. A failure here is logged, never thrown into the stream. */
async function revokeQuietly(db: ReturnType<typeof getDb>, run: { keyId: string }) {
  try {
    await finishPlaygroundRun(db, run);
  } catch (error) {
    console.error(`playground run: couldn't revoke Key ${run.keyId}`, error);
  }
}
