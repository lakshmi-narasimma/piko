import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  startStubUpstream,
  stubGatewayEnv,
  TEST_DEMO_UPSTREAM_SECRET,
  TEST_GATEWAY_CONFIG,
  type StubUpstream,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { rewriteUpstreamUrl, upstreamSecretFor } from "./forward";
import { handleGatewayRequest } from "./index";

describe("rewriteUpstreamUrl", () => {
  const route = { baseUrl: "https://api.seller.example/v1/", sellerSlug: "acme" };
  const upstreamUrl = "https://api.seller.example/v1/history?q=1";
  const rewrite = (value: string) => rewriteUpstreamUrl(value, route, upstreamUrl);

  it("maps a URL under the seller's base URL onto the gateway", () => {
    expect(rewrite("https://api.seller.example/v1/history/2?page=3#top")).toBe(
      "/g/acme/history/2?page=3#top",
    );
    expect(rewrite("https://api.seller.example/v1")).toBe("/g/acme/");
  });

  it("resolves a relative URL against the upstream request first", () => {
    expect(rewrite("/v1/search")).toBe("/g/acme/search");
    expect(rewrite("next")).toBe("/g/acme/next");
  });

  it("drops a URL on the upstream origin outside the base path", () => {
    expect(rewrite("https://api.seller.example/admin")).toBeNull();
    expect(rewrite("/v10/other")).toBeNull();
  });

  it("leaves a URL on another origin alone", () => {
    expect(rewrite("https://cdn.example.com/file.json")).toBe("https://cdn.example.com/file.json");
  });
});

describe("upstreamSecretFor", () => {
  const config = { appBaseUrl: "https://piko.test", demoUpstreamSecret: "demo-secret" };

  it("gives DEMO_UPSTREAM_SECRET to the sample seller APIs under the app", () => {
    expect(
      upstreamSecretFor("https://piko.test/api/demo/sellers/price-history/history?p=1", config),
    ).toBe("demo-secret");
  });

  it("honours an app base URL with a path", () => {
    const nested = { ...config, appBaseUrl: "https://host.test/piko/" };
    expect(upstreamSecretFor("https://host.test/piko/api/demo/sellers/x/y", nested)).toBe(
      "demo-secret",
    );
    expect(upstreamSecretFor("https://host.test/api/demo/sellers/x/y", nested)).toBeNull();
  });

  it.each([
    ["another origin with the same path", "https://evil.test/api/demo/sellers/x/y"],
    ["a look-alike host", "https://piko.test.evil.test/api/demo/sellers/x/y"],
    ["another port", "https://piko.test:8443/api/demo/sellers/x/y"],
    ["another scheme", "http://piko.test/api/demo/sellers/x/y"],
    ["another path on the app", "https://piko.test/api/pay"],
    ["a path that only starts like it", "https://piko.test/api/demo/sellers-evil/x"],
    ["dot segments out of the prefix", "https://piko.test/api/demo/sellers/../../pay"],
    ["credentials in the URL", "https://piko.test@evil.test/api/demo/sellers/x"],
    ["not a URL", "nope"],
  ])("gives no secret to %s", (_case, target) => {
    expect(upstreamSecretFor(target, config)).toBeNull();
  });

  it("gives no secret when none is configured", () => {
    expect(
      upstreamSecretFor("https://piko.test/api/demo/sellers/x/y", {
        appBaseUrl: "https://piko.test",
      }),
    ).toBeNull();
  });
});

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("gateway: X-Piko-Secret for the sample seller APIs", () => {
  let db: Db;
  let upstream: StubUpstream;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 3 });
    upstream = await startStubUpstream();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await upstream.close();
    await db.$client.end();
  });

  /** One free Call through the gateway, with the stub upstream standing in for the app. */
  async function receivedSecret(baseUrl: string, priceMicro: bigint) {
    const seller = await createSeller(db, baseUrl, { priceMicro, freeQuota: 1 });
    const buyer = await createBuyer(db);
    const res = await handleGatewayRequest(
      { db, config: { ...TEST_GATEWAY_CONFIG, appBaseUrl: upstream.url } },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}/history`, {
        key: buyer.rawKey,
        headers: { "X-Piko-Secret": "forged" },
      }),
      { seller: seller.slug, path: ["history"] },
    );
    expect(res.status).toBe(200);
    return upstream.requests.at(-1)!.headers["x-piko-secret"];
  }

  it("sends DEMO_UPSTREAM_SECRET to an upstream under the app's /api/demo/sellers", async () => {
    const base = `${upstream.url}/api/demo/sellers/price-history`;
    expect(await receivedSecret(base, 2_000n)).toBe(TEST_DEMO_UPSTREAM_SECRET);
    expect(await receivedSecret(base, 0n)).toBe(TEST_DEMO_UPSTREAM_SECRET);
  });

  it("sends no secret to any other upstream, even on the app's origin", async () => {
    expect(await receivedSecret(`${upstream.url}/api/other`, 2_000n)).toBeUndefined();
    expect(await receivedSecret(`${upstream.url}/api/demo/sellers-x`, 0n)).toBeUndefined();
  });
});

describe.skipIf(!url)("gateway: proxied response headers", () => {
  let db: Db;
  let upstream: StubUpstream;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 3 });
    upstream = await startStubUpstream();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await upstream.close();
    await db.$client.end();
  });

  it("drops Set-Cookie and serves the seller's body as inert content", async () => {
    const seller = await createSeller(db, `${upstream.url}/api`, { priceMicro: 0n });
    upstream.respond((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": ["piko_session=stolen; Path=/", "other=1"],
        "content-security-policy": "default-src *",
      });
      res.end("<script>alert(1)</script>");
    });

    const res = await handleGatewayRequest(
      { db, config: TEST_GATEWAY_CONFIG },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}/history`),
      { seller: seller.slug, path: ["history"] },
    );

    expect(res.status).toBe(200);
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });
});

describe.skipIf(!url)("gateway: upstream URL headers", () => {
  let db: Db;
  let upstream: StubUpstream;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 3 });
    upstream = await startStubUpstream();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await upstream.close();
    await db.$client.end();
  });

  it("never passes the seller's base URL back in Location or Content-Location", async () => {
    const seller = await createSeller(db, `${upstream.url}/api`, { freeQuota: 1 });
    const buyer = await createBuyer(db);
    upstream.respond((_req, res) => {
      res.writeHead(302, {
        location: `${upstream.url}/api/history/next?page=2`,
        "content-location": `${upstream.url}/internal/raw`,
      });
      res.end();
    });

    const res = await handleGatewayRequest(
      { db, config: TEST_GATEWAY_CONFIG },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}/history`, { key: buyer.rawKey }),
      { seller: seller.slug, path: ["history"] },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/g/${seller.slug}/history/next?page=2`);
    expect(res.headers.has("content-location")).toBe(false);
  });
});
