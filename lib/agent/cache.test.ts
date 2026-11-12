import { describe, expect, it } from "vitest";
import { isCacheable, RunCache, shouldReplay } from "./cache";
import type { AgentEvent } from "./run";

const done: AgentEvent = {
  type: "done",
  spentMicro: "0",
  spent: "$0.00",
  remaining: "$0.10",
  recommendation: null,
};
const paidCall: AgentEvent = {
  type: "tool-result",
  id: "1",
  name: "call_api",
  ok: true,
  costMicro: "2000",
  cost: "$0.002",
  output: {},
};
const answer: AgentEvent = { type: "answer", text: "Buy it." };

describe("RunCache", () => {
  it("returns a run for the same buyer and prompt, ignoring case and spacing", () => {
    const cache = new RunCache();
    cache.set("org1", "Find  a MONITOR", [answer]);
    expect(cache.get("org1", "find a monitor")).toEqual([answer]);
  });

  it("keeps buyers apart", () => {
    const cache = new RunCache();
    cache.set("org1", "x", [answer]);
    expect(cache.get("org2", "x")).toBeNull();
  });

  it("forgets a run after the time limit", () => {
    let now = 0;
    const cache = new RunCache({ ttlMs: 1000, maxEntries: 5, now: () => now });
    cache.set("o", "x", [answer]);
    now = 999;
    expect(cache.get("o", "x")).not.toBeNull();
    now = 1001;
    expect(cache.get("o", "x")).toBeNull();
  });

  it("drops the oldest run when full", () => {
    const cache = new RunCache({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
    cache.set("o", "a", [answer]);
    cache.set("o", "b", [answer]);
    cache.set("o", "c", [answer]);
    expect(cache.get("o", "a")).toBeNull();
    expect(cache.get("o", "c")).not.toBeNull();
  });
});

describe("isCacheable", () => {
  it("wants a paid call and an answer, and no failure", () => {
    expect(isCacheable([paidCall, answer, done])).toBe(true);
    expect(isCacheable([answer, done])).toBe(false);
    expect(isCacheable([paidCall, done])).toBe(false);
    expect(isCacheable([paidCall, answer, { type: "busy", message: "b" }, done])).toBe(false);
  });
});

describe("shouldReplay", () => {
  const busy: AgentEvent = { type: "busy", message: "AI is busy" };
  const fresh = { spentMicro: 0n, reservedMicro: 0n };

  it("replays when the model is busy and nothing has been paid", () => {
    expect(shouldReplay(busy, fresh)).toBe(true);
  });

  it("does not replay once a paid call has settled", () => {
    expect(shouldReplay(busy, { spentMicro: 2_000n, reservedMicro: 0n })).toBe(false);
  });

  it("does not replay while a paid call is in flight", () => {
    expect(shouldReplay(busy, { spentMicro: 0n, reservedMicro: 2_000n })).toBe(false);
  });

  it("ignores anything but a busy event", () => {
    expect(shouldReplay(done, fresh)).toBe(false);
    expect(shouldReplay({ type: "error", message: "x" }, fresh)).toBe(false);
  });
});
