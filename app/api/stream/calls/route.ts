import { getPrincipal } from "@/lib/auth";
import { callsAfter, recentCalls, type FeedCursor, type FeedSide } from "@/lib/calls/feed";
import { getDb } from "@/lib/db";
import { jsonError } from "@/lib/http";

const POLL_MS = 1000;
const HEARTBEAT_MS = 15_000;

function parseCursor(text: string | null): FeedCursor | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<FeedCursor>;
    return typeof value.at === "string" && typeof value.id === "string"
      ? { at: value.at, id: value.id }
      : null;
  } catch {
    return null;
  }
}

/**
 * Live Calls for the signed-in org. By default a server-sent event stream: a `snapshot` of the
 * latest Calls, then a `calls` event for each new batch. With `?format=json` it answers once
 * (the polling fallback): pass the previous answer's `cursor` as `after`.
 *
 * `side` is `buyer` (Calls this org made) or `seller` (Calls to this org's listings). It
 * defaults to the side that matches the signed-in area.
 */
export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return jsonError(401, "unauthenticated", "Sign in first.");

  const params = new URL(request.url).searchParams;
  const side = (params.get("side") ??
    (principal.area === "seller" ? "seller" : "buyer")) as FeedSide;
  if (side !== "buyer" && side !== "seller") {
    return jsonError(400, "invalid_request", "side must be buyer or seller.");
  }
  const db = getDb();
  const orgId = principal.org.id;
  const after = parseCursor(params.get("after"));

  if (params.get("format") === "json") {
    return Response.json(
      after
        ? await callsAfter(db, { orgId, side, cursor: after })
        : await recentCalls(db, { orgId, side }),
    );
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const close = () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };
      request.signal.addEventListener("abort", close);

      let cursor: FeedCursor | null;
      try {
        const first = after
          ? await callsAfter(db, { orgId, side, cursor: after })
          : await recentCalls(db, { orgId, side });
        cursor = first.cursor;
        send("snapshot", first.calls);
      } catch {
        close();
        return;
      }

      let busy = false;
      let lastBeat = Date.now();
      timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          if (cursor) {
            const next = await callsAfter(db, { orgId, side, cursor });
            if (next.calls.length > 0) send("calls", next.calls);
            cursor = next.cursor;
          } else {
            const next = await recentCalls(db, { orgId, side });
            if (next.calls.length > 0) send("calls", next.calls);
            cursor = next.cursor;
          }
          if (Date.now() - lastBeat > HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            lastBeat = Date.now();
          }
        } catch {
          // A failed poll just skips a tick; the client reconnects if the stream dies.
        } finally {
          busy = false;
        }
      }, POLL_MS);
    },
    cancel() {
      clearInterval(timer);
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
