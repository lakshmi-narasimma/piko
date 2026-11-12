import type { AgentEvent } from "./run";

/**
 * Remembers each buyer's most recent successful playground runs, so that if Gemini is rate
 * limited the same prompt can be shown again instead of failing in front of a judge. The cache
 * lives in this server process only; a restart empties it, which is fine for a fallback.
 */
export class RunCache {
  private readonly runs = new Map<string, { events: AgentEvent[]; at: number }>();

  constructor(
    private readonly options: { ttlMs: number; maxEntries: number; now?: () => number } = {
      ttlMs: 10 * 60_000,
      maxEntries: 20,
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private static key(orgId: string, prompt: string) {
    return `${orgId}\u0000${prompt.trim().toLowerCase().replace(/\s+/g, " ")}`;
  }

  get(orgId: string, prompt: string): AgentEvent[] | null {
    const key = RunCache.key(orgId, prompt);
    const hit = this.runs.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.options.ttlMs) {
      this.runs.delete(key);
      return null;
    }
    return hit.events;
  }

  set(orgId: string, prompt: string, events: AgentEvent[]): void {
    const key = RunCache.key(orgId, prompt);
    this.runs.delete(key);
    this.runs.set(key, { events, at: this.now() });
    while (this.runs.size > this.options.maxEntries) {
      this.runs.delete(this.runs.keys().next().value!);
    }
  }
}

/** Only a run that really worked is worth replaying: it paid for something and answered. */
export function isCacheable(events: AgentEvent[]): boolean {
  return (
    events.some((e) => e.type === "tool-result" && e.name === "call_api" && e.ok) &&
    events.some((e) => e.type === "answer") &&
    !events.some((e) => e.type === "busy" || e.type === "error")
  );
}

const globalForCache = globalThis as typeof globalThis & { __pikoRunCache?: RunCache };

export function getRunCache(): RunCache {
  globalForCache.__pikoRunCache ??= new RunCache();
  return globalForCache.__pikoRunCache;
}

/**
 * Whether a busy model should fall back to replaying the buyer's earlier run: only while no
 * paid call has settled or is in flight. A failed free step (a search that errored) doesn't
 * block the replay, but once money has moved the buyer must see this run, not an old one.
 */
export function shouldReplay(
  event: AgentEvent,
  state: { spentMicro: bigint; reservedMicro: bigint },
): boolean {
  return event.type === "busy" && state.spentMicro === 0n && state.reservedMicro === 0n;
}
