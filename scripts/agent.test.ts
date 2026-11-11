import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  startStubUpstream,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG,
  type StubUpstream,
} from "../test/gateway-fixtures";
import { createDb, type Db } from "../lib/db/client";
import { handleGatewayRequest, type GatewayConfig } from "../lib/gateway";
import { balanceOf } from "../lib/ledger";
import { handlePayRequest } from "../lib/pay";
import { runAgent } from "./agent";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("scripts/agent.ts", () => {
  let db: Db;
  let upstream: StubUpstream;
  let app: Server;
  let baseUrl: string;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 10 });
    upstream = await startStubUpstream();

    let config: GatewayConfig = TEST_GATEWAY_CONFIG;
    // The real handlers over real HTTP, as Next.js would call them.
    app = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        const requestUrl = `${baseUrl}${req.url}`;
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const request = new Request(requestUrl, { method: req.method, headers, body });

        const { pathname } = new URL(requestUrl);
        const gateway = /^\/g\/([^/]+)\/(.+)$/.exec(pathname);
        const response = gateway
          ? await handleGatewayRequest({ db, config }, request, {
              seller: gateway[1]!,
              path: gateway[2]!.split("/"),
            })
          : await handlePayRequest({ db, config }, request);

        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    config = { ...TEST_GATEWAY_CONFIG, appBaseUrl: baseUrl };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => {
      app.closeAllConnections();
      app.close(() => resolve());
    });
    await upstream.close();
    await db.$client.end();
  });

  it("runs the three-step loop, and the buyer's balance drops by the price", async () => {
    upstream.respond((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ series: [1, 2, 3] }));
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const lines: string[] = [];

    const result = await runAgent({
      baseUrl,
      key: buyer.rawKey,
      seller: seller.slug,
      path: "/history",
      query: "product=abc",
      log: (line) => lines.push(line),
    });

    expect(result).toMatchObject({
      status: 200,
      body: JSON.stringify({ series: [1, 2, 3] }),
      amountMicro: "2000",
    });
    expect(upstream.requests.at(-1)!.url).toBe("/history?product=abc");
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);

    expect(lines.join("\n")).toContain("1. GET");
    expect(lines.join("\n")).toContain("$0.002");
    expect(lines.join("\n")).toContain(result.callId);
    expect(lines.join("\n")).not.toContain(buyer.rawKey);
  });

  it("stops at the failing step, with the API's error", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db);

    await expect(
      runAgent({
        baseUrl,
        key: buyer.rawKey,
        seller: seller.slug,
        path: "/history",
        query: "",
      }),
    ).rejects.toThrow(/Payment failed: 402 insufficient_funds/);
  });

  it("reports an unknown route at the Challenge step", async () => {
    await expect(
      runAgent({
        baseUrl,
        key: "pk_agent_any",
        seller: "no-such-seller",
        path: "/history",
        query: "",
      }),
    ).rejects.toThrow(/Challenge failed: 404 not_found/);
  });
});
