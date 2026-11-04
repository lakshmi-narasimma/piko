import { expect, it } from "vitest";

// Temporary: proves a failing test turns CI red. Reverted in the next commit.
it("fails on purpose", () => {
  expect(1 + 1).toBe(3);
});
