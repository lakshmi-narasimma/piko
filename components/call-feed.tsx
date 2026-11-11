"use client";

import { useEffect, useRef, useState } from "react";
import { formatUsd } from "@/lib/money";

interface FeedCall {
  id: string;
  createdAt: string;
  agent: string;
  endpoint: string;
  amountMicro: string;
  status: "paid" | "free" | "refunded" | "blocked";
  blockReason: string | null;
  simulated: boolean;
}

const MAX_ROWS = 50;
const POLL_MS = 2000;

const statusClass: Record<FeedCall["status"], string> = {
  paid: "text-emerald-700 dark:text-emerald-400",
  free: "text-muted",
  refunded: "text-amber-700 dark:text-amber-400",
  blocked: "text-red-700 dark:text-red-400",
};

/**
 * Live Calls for the signed-in org. Streams over server-sent events and, if the stream keeps
 * failing, falls back to polling the same route, so the feed still moves.
 */
export function CallFeed({ side }: { side?: "buyer" | "seller" }) {
  const [rows, setRows] = useState<FeedCall[]>([]);
  const [state, setState] = useState<"connecting" | "live" | "polling">("connecting");
  const [loaded, setLoaded] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const query = side ? `side=${side}` : "";
    const url = (extra = "") => `/api/stream/calls?${[query, extra].filter(Boolean).join("&")}`;
    const source = new EventSource(url());
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor: unknown;
    let failures = 0;
    let stopped = false;

    function add(incoming: FeedCall[]) {
      const fresh = incoming.filter((call) => !seen.current.has(call.id));
      if (fresh.length === 0) return;
      fresh.forEach((call) => seen.current.add(call.id));
      // Newest first.
      setRows((current) => [...fresh.reverse(), ...current].slice(0, MAX_ROWS));
    }

    async function poll() {
      if (stopped) return;
      try {
        const extra = cursor
          ? `format=json&after=${encodeURIComponent(JSON.stringify(cursor))}`
          : "format=json";
        const response = await fetch(url(extra));
        if (response.ok) {
          const body = (await response.json()) as { calls: FeedCall[]; cursor: unknown };
          cursor = body.cursor;
          add(body.calls);
          setLoaded(true);
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
      add(JSON.parse((event as MessageEvent<string>).data) as FeedCall[]);
      setLoaded(true);
    });
    source.addEventListener("calls", (event) => {
      add(JSON.parse((event as MessageEvent<string>).data) as FeedCall[]);
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
  }, [side]);

  return (
    <section aria-label="Live calls" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Live calls</h2>
        <span className="text-sm text-muted" aria-live="polite">
          {state === "live" ? "Live" : state === "polling" ? "Updating every 2 s" : "Connecting…"}
        </span>
      </div>
      {loaded && rows.length === 0 ? (
        <p className="rounded-md border border-line p-4 text-muted">
          No calls yet. They appear here the moment an agent makes one.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {rows.map((call) => (
            <li
              key={call.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{call.agent}</span>{" "}
                <span className="text-muted">→ {call.endpoint}</span>
                {call.simulated && (
                  <span className="ml-2 rounded border border-line px-1 text-xs text-muted">
                    simulated
                  </span>
                )}
              </span>
              <span className={statusClass[call.status]}>
                {call.status === "blocked" && call.blockReason ? call.blockReason : call.status}
                {" · "}
                {formatUsd(BigInt(call.amountMicro))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
