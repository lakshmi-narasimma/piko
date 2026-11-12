import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { handleGatewayRequest } from "./index";

// The pay pipeline fails unexpectedly (not a PayError), as a bug or a lost database would.
vi.mock("../pay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pay")>()),
  runPayPipeline: () => Promise.reject(new Error("SECRET internal detail")),
}));

/** A database whose every use throws. */
const brokenDb = new Proxy(
  {},
  {
    get() {
      throw new Error("SECRET connection string");
    },
  },
) as Db;

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectInternalError(response: Response) {
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    error: { code: "internal_error", message: expect.any(String) },
  });
  expect(text).not.toContain("SECRET");
  // Still a gateway response: browser callers can read the error.
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
}

describe("gateway: unexpected failures", () => {
  it("answers 500 internal_error with the standard body and logs the cause", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handleGatewayRequest(
      { db: brokenDb, config },
      gatewayRequest("GET", "https://piko.test/g/acme/history"),
      { seller: "acme", path: ["history"] },
    );

    await expectInternalError(response);
    expect(log).toHaveBeenCalledOnce();
  });
});

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("gateway: unexpected failures in autopay", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 3 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  it("answers 500 internal_error when the pay step throws something unexpected", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const seller = await createSeller(db, "http://127.0.0.1:1");
    const buyer = await createBuyer(db, 10_000n);

    const response = await handleGatewayRequest(
      { db, config },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}/history`, {
        key: buyer.rawKey,
        headers: { "X-Piko-Autopay": "true" },
      }),
      { seller: seller.slug, path: ["history"] },
    );

    await expectInternalError(response);
    expect(log).toHaveBeenCalledOnce();
  });
});
