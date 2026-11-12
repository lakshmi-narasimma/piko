import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
});

// No query is run, so the pool never connects to this URL.
const URL = "postgresql://user:SECRET-PASSWORD@localhost:1/unused";

describe("createDb", () => {
  it("logs an idle client's error instead of crashing the process", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createDb(URL);
    try {
      // Without an 'error' listener, EventEmitter.emit throws the error.
      expect(() =>
        db.$client.emit("error", new Error("Connection terminated unexpectedly"), undefined),
      ).not.toThrow();
      expect(log).toHaveBeenCalledWith("pg pool error", "Connection terminated unexpectedly");
      expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-PASSWORD");
    } finally {
      await db.$client.end();
    }
  });

  it("closes idle clients after 10 seconds", async () => {
    const db = createDb(URL);
    try {
      expect(db.$client.options.idleTimeoutMillis).toBe(10_000);
    } finally {
      await db.$client.end();
    }
  });
});
