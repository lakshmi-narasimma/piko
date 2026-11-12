import { cookies } from "next/headers";
import {
  ALERTS_SEEN_COOKIE,
  alertsAfter,
  countUnread,
  listAlerts,
  unreadSince,
  type AlertCursor,
} from "@/lib/alerts";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jsonError } from "@/lib/http";

const POLL_MS = 1000;
const HEARTBEAT_MS = 15_000;

function parseCursor(text: string | null): AlertCursor | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<AlertCursor>;
    return typeof value.at === "string" && typeof value.id === "string"
      ? { at: value.at, id: value.id }
      : null;
  } catch {
    return null;
  }
}

/**
 * Live alerts for the signed-in org's admins. By default a server-sent event stream: a
 * `snapshot` of the latest alerts with the unread count, then an `alerts` event for each new
 * batch. With `?format=json` it answers once (the polling fallback): pass
 * the previous answer's `cursor` as `after` to get only newer alerts. `?format=count` answers
 * just `{ unread }`, for the nav badge.
 */
export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return jsonError(401, "unauthenticated", "Sign in first.");
  if (principal.area !== "org" || principal.role !== "admin") {
    return jsonError(403, "forbidden", "Only an org admin can see alerts.");
  }

  const db = getDb();
  const orgId = principal.org.id;
  const params = new URL(request.url).searchParams;
  const after = parseCursor(params.get("after"));
  const since = unreadSince((await cookies()).get(ALERTS_SEEN_COOKIE)?.value);
  const read = async () => {
    const [page, unread] = await Promise.all([
      after ? alertsAfter(db, { orgId, cursor: after }) : listAlerts(db, { orgId }),
      countUnread(db, { orgId, since }),
    ]);
    return { ...page, unread };
  };

  if (params.get("format") === "count") {
    return Response.json({ unread: await countUnread(db, { orgId, since }) });
  }
  if (params.get("format") === "json") return Response.json(await read());

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

      let cursor: AlertCursor | null;
      try {
        const first = await read();
        cursor = first.cursor;
        send("snapshot", { alerts: first.alerts, unread: first.unread });
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
          const next = cursor
            ? await alertsAfter(db, { orgId, cursor })
            : await listAlerts(db, { orgId });
          if (next.alerts.length > 0) send("alerts", next.alerts);
          cursor = next.cursor;
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
