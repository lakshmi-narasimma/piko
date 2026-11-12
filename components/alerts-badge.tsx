"use client";

import { useEffect, useState } from "react";

/** Fired by the alerts panel when it marks the alerts read, so the badge clears at once. */
export const ALERTS_READ_EVENT = "piko:alerts-read";

const POLL_MS = 3000;

/** The unread-alerts count on the Org console's nav entry. Polls a small JSON route. */
export function AlertsBadge({ initial }: { initial: number }) {
  const [unread, setUnread] = useState(initial);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function poll() {
      if (stopped) return;
      try {
        const response = await fetch("/api/stream/alerts?format=count", { cache: "no-store" });
        if (response.ok) setUnread(((await response.json()) as { unread: number }).unread);
      } catch {
        // Try again next tick.
      }
      timer = setTimeout(poll, POLL_MS);
    }
    const cleared = () => setUnread(0);
    window.addEventListener(ALERTS_READ_EVENT, cleared);
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener(ALERTS_READ_EVENT, cleared);
    };
  }, []);

  if (unread === 0) return null;
  return (
    <span
      className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-medium text-white tabular-nums"
      aria-label={`${unread} unread alert${unread === 1 ? "" : "s"}`}
    >
      {unread > 99 ? "99+" : unread}
    </span>
  );
}
