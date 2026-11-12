import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_GATEWAY_CONFIG as config } from "../../test/gateway-fixtures";
import type { Db } from "../db/client";
import { handleSettleRequest, handleVerifyRequest } from "./index";

// Verification fails unexpectedly, as a bug or a lost database would.
vi.mock("../gateway/settlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/settlement")>()),
  verifyPayment: () => Promise.reject(new Error("SECRET internal detail")),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const body = JSON.stringify({ x402Version: 2, paymentPayload: {}, paymentRequirements: {} });

describe.each([
  ["verify", handleVerifyRequest],
  ["settle", handleSettleRequest],
])("facilitator %s: unexpected failures", (_name, handler) => {
  it("answers 500 internal_error with the standard body and logs the cause", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handler(
      { db: {} as Db, config },
      new Request("https://piko.test/api/facilitator/x", { method: "POST", body }),
    );

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal_error", message: expect.any(String) },
    });
    expect(text).not.toContain("SECRET");
    expect(log).toHaveBeenCalledOnce();
  });
});
