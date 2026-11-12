"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { markAlertsReadAction } from "@/app/org/alerts-actions";
import { describeAlertType, type AlertKind, type AlertView } from "@/lib/alerts/types";
import { ALERTS_READ_EVENT } from "./alerts-badge";

const MAX_ROWS = 50;
const POLL_MS = 2000;

const ICON: Record<AlertKind, string> = {
  breaker: "⚡",
  budget: "$",
  policy: "⛔",
  frozen: "❄",
  unfrozen: "▶",
  other: "•",
};

const RED =
  "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300";
const TONE: Record<AlertKind, string> = {
  breaker: RED,
  policy: RED,
  budget:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  frozen:
    "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  unfrozen:
    "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  other: "border-line text-muted",
};

const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

interface Page {
  alerts: AlertView[];
  unread: number;
  cursor?: unknown;
}

/**
 * The Org console's alerts: breaker trips, Budget hits, Policy denials and freezes, newest
 * first. Streams new ones over server-sent events and, if the stream keeps failing, falls back
 * to polling the same route.
 */
export function AlertsPanel() {
  const [rows, setRows] = useState<AlertView[]>([]);
  const [unread, setUnread] = useState(0);
  const [state, setState] = useState<"connecting" | "live" | "polling">("connecting");
  const [loaded, setLoaded] = useState(false);
  const [pending, startTransition] = useTransition();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const url = (extra = "") => `/api/stream/alerts${extra ? `?${extra}` : ""}`;
    const source = new EventSource(url());
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor: unknown;
    let failures = 0;
    let stopped = false;

    /** Adds alerts (newest first) and returns how many were new. */
    function add(incoming: AlertView[]): number {
      const fresh = incoming.filter((alert) => !seen.current.has(alert.id));
      fresh.forEach((alert) => seen.current.add(alert.id));
      if (fresh.length > 0) setRows((current) => [...fresh, ...current].slice(0, MAX_ROWS));
      return fresh.length;
    }

    /** The first page sets the unread count; each later batch adds to it. */
    function firstPage(page: Page) {
      add(page.alerts);
      setUnread(page.unread);
      setLoaded(true);
    }
    function nextBatch(alerts: AlertView[]) {
      const added = add(alerts);
      if (added > 0) setUnread((n) => n + added);
    }

    async function poll() {
      if (stopped) return;
      try {
        const extra = cursor
          ? `format=json&after=${encodeURIComponent(JSON.stringify(cursor))}`
          : "format=json";
        const response = await fetch(url(extra), { cache: "no-store" });
        if (response.ok) {
          const page = (await response.json()) as Page;
          if (cursor) nextBatch(page.alerts);
          else firstPage(page);
          cursor = page.cursor ?? cursor;
        }
      } catch {
        // Try again next tick.
      }
      pollTimer = setTimeout(poll, POLL_MS);
    }

    function startPolling() {
      source.close();
      setState("polling");
      void poll();
    }

    source.addEventListener("snapshot", (event) => {
      failures = 0;
      setState("live");
      firstPage(JSON.parse((event as MessageEvent<string>).data) as Page);
    });
    source.addEventListener("alerts", (event) => {
      nextBatch(JSON.parse((event as MessageEvent<string>).data) as AlertView[]);
    });
    source.onerror = () => {
      failures += 1;
      if (failures >= 3) startPolling();
    };

    return () => {
      stopped = true;
      source.close();
      clearTimeout(pollTimer);
    };
  }, []);

  function markRead() {
    startTransition(async () => {
      await markAlertsReadAction();
      setUnread(0);
      window.dispatchEvent(new Event(ALERTS_READ_EVENT));
    });
  }

  return (
    <section aria-label="Alerts" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-medium">
          Alerts
          {unread > 0 && (
            <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 align-middle text-xs font-medium text-white tabular-nums">
              {unread} unread
            </span>
          )}
        </h2>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted" aria-live="polite">
            {state === "live" ? "Live" : state === "polling" ? "Updating every 2 s" : "Connecting…"}
          </span>
          {unread > 0 && (
            <button
              type="button"
              onClick={markRead}
              disabled={pending}
              className="rounded-md border border-line px-3 py-1 hover:bg-surface disabled:opacity-50"
            >
              Mark all read
            </button>
          )}
        </div>
      </div>
      {loaded && rows.length === 0 ? (
        <p className="rounded-md border border-line p-4 text-muted">
          No alerts. Breaker trips, budget hits and policy denials show up here within seconds.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rows.map((alert) => {
            const { kind, label } = describeAlertType(alert.type);
            return (
              <li key={alert.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span
                  aria-hidden
                  className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${TONE[kind]}`}
                >
                  {ICON[kind]}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-medium">
                      {label}
                      {alert.agent && (
                        <>
                          {" · "}
                          <code>{alert.agent}</code>
                        </>
                      )}
                    </span>
                    <time dateTime={alert.createdAt} className="text-muted tabular-nums">
                      {time(alert.createdAt)}
                    </time>
                  </div>
                  <span className="break-words text-muted">{alert.message}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
