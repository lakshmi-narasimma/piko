import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { calls } from "../db/schema";
import { availableFunds, balanceOf } from "../ledger";
import { decodeHeaderValue, type SettlementResponse } from "../x402";
import { handleGatewayRequest, type GatewayConfig } from "./index";
import type { LookupFn } from "./ssrf";

const url = inject("testDatabaseUrl");

/**
 * DNS rebinding: a Listing saved while its host pointed at a public address, whose DNS now
 * points inside the network. The gateway re-checks the host before every fetch.
 */
describe.skipIf(!url)("gateway: SSRF re-check at forward time", () => {
  let db: Db;
  let fetchSpy: MockInstance<typeof fetch> | undefined;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 5 });
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  /** The real check (no test bypass), with DNS answering `address` for every host. */
  function configResolvingTo(address: string) {
    const lookup = vi.fn<LookupFn>(async () => [{ address, family: 4 }]);
    const config: GatewayConfig = {
      ...TEST_GATEWAY_CONFIG,
      checkUpstream: undefined,
      upstreamLookup: lookup,
    };
    return { config, lookup };
  }

  function stubFetch() {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ ok: true }));
    fetchSpy = spy;
    return spy;
  }

  function call(
    config: GatewayConfig,
    seller: { slug: string },
    init: { key?: string; headers?: Record<string, string> } = {},
  ) {
    return handleGatewayRequest(
      { db, config },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}/history`, init),
      { seller: seller.slug, path: ["history"] },
    );
  }

  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: { code: string; refunded: boolean } }).error;

  it.each(["127.0.0.1", "169.254.169.254", "10.0.0.7"])(
    "never fetches a paid upstream whose host now resolves to %s, and charges nothing",
    async (address) => {
      const { config, lookup } = configResolvingTo(address);
      const fetch = stubFetch();
      const seller = await createSeller(db, "https://rebind.seller.example/v1");
      const buyer = await createBuyer(db, 10_000n);

      const res = await call(config, seller, {
        key: buyer.rawKey,
        headers: { "X-Piko-Autopay": "true" },
      });

      expect(res.status).toBe(502);
      expect(await errorOf(res)).toMatchObject({ code: "upstream_failed", refunded: true });
      const settlement = decodeHeaderValue(
        res.headers.get("PAYMENT-RESPONSE")!,
      ) as SettlementResponse;
      expect(settlement).toMatchObject({ success: false, errorReason: "upstream_failed" });
      expect(lookup).toHaveBeenCalledWith("rebind.seller.example");
      expect(fetch).not.toHaveBeenCalled();

      // Nothing charged, and the hold is released.
      expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
      expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
      const recorded = await db.select().from(calls).where(eq(calls.buyerOrgId, buyer.orgId));
      expect(recorded.filter((c) => c.status === "paid")).toEqual([]);
    },
  );

  it("never fetches a free-allowance or $0 upstream that now resolves to 127.0.0.1", async () => {
    const { config } = configResolvingTo("127.0.0.1");
    const fetch = stubFetch();
    const free = await createSeller(db, "https://rebind.seller.example", { freeQuota: 1 });
    const zero = await createSeller(db, "https://rebind.seller.example", { priceMicro: 0n });
    const buyer = await createBuyer(db);

    const freeRes = await call(config, free, { key: buyer.rawKey });
    expect(freeRes.status).toBe(502);
    expect(await errorOf(freeRes)).toMatchObject({ code: "upstream_failed", refunded: false });

    const zeroRes = await call(config, zero);
    expect(zeroRes.status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();

    // The refused free Call gave its quota back.
    const recorded = await db.select().from(calls).where(eq(calls.buyerOrgId, buyer.orgId));
    expect(recorded.filter((c) => c.status === "free")).toEqual([]);
  });

  it("never fetches a host that no longer resolves", async () => {
    const lookup = vi.fn<LookupFn>(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const config: GatewayConfig = {
      ...TEST_GATEWAY_CONFIG,
      checkUpstream: undefined,
      upstreamLookup: lookup,
    };
    const fetch = stubFetch();
    const seller = await createSeller(db, "https://gone.seller.example", { priceMicro: 0n });

    expect((await call(config, seller)).status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still forwards to a host that resolves to a public address, and charges once", async () => {
    const { config, lookup } = configResolvingTo("93.184.216.34");
    const fetch = stubFetch();
    const seller = await createSeller(db, "https://api.seller.example/v1");
    const buyer = await createBuyer(db, 10_000n);

    const res = await call(config, seller, {
      key: buyer.rawKey,
      headers: { "X-Piko-Autopay": "true" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(lookup).toHaveBeenCalledWith("api.seller.example");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.seller.example/v1/history");
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
  });

  it("still forwards to the app's own demo seller URLs without a DNS lookup", async () => {
    const { config, lookup } = configResolvingTo("127.0.0.1");
    const fetch = stubFetch();
    const seller = await createSeller(db, "https://piko.test/api/demo/sellers/price-history", {
      priceMicro: 0n,
    });

    const res = await call(config, seller);

    expect(res.status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://piko.test/api/demo/sellers/price-history/history",
    );
  });

  it("never fetches another URL on the app's own origin", async () => {
    const { config } = configResolvingTo("93.184.216.34");
    const fetch = stubFetch();
    const seller = await createSeller(db, "https://piko.test/api/pay", { priceMicro: 0n });

    expect((await call(config, seller)).status).toBe(502);
    expect(fetch).not.toHaveBeenCalled();
  });
});
