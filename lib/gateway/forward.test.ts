import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  startStubUpstream,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG,
  type StubUpstream,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { rewriteUpstreamUrl } from "./forward";
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

const url = inject("testDatabaseUrl");

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
