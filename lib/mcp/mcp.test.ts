import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  startStubUpstream,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
  type StubUpstream,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, calls, endpoints, ledgerEntries, listings } from "../db/schema";
import { balanceOf } from "../ledger";
import { handleMcpRequest, toolName } from "./index";

const url = inject("testDatabaseUrl");

describe("toolName", () => {
  it("derives a valid MCP tool name from the method and path", () => {
    expect(toolName("GET", "/history")).toBe("get_history");
    expect(toolName("POST", "/v1/reviews/summarise")).toBe("post_v1_reviews_summarise");
    expect(toolName("GET", "/")).toBe("get_root");
    expect(toolName("GET", "/a-b.c")).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
  });
});

describe.skipIf(!url)("MCP server: /mcp/{seller}", () => {
  let db: Db;
  let upstream: StubUpstream;
  const open: Client[] = [];

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 10 });
    upstream = await startStubUpstream();
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((client) => client.close()));
    upstream.respond((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await upstream.close();
    await db.$client.end();
  });

  /** A fetch that answers `/mcp/{seller}` in process, so the SDK client talks to the route. */
  function routeFetch(seller: string) {
    return (input: string | URL | Request, init?: RequestInit) =>
      handleMcpRequest({ db, config }, new Request(input, init), seller);
  }

  async function connect(seller: string, key: string) {
    const client = new Client({ name: "piko-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`https://piko.test/mcp/${seller}`),
      {
        fetch: routeFetch(seller),
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      },
    );
    await client.connect(transport);
    open.push(client);
    return client;
  }

  /** A raw JSON-RPC POST, for the HTTP-level answers the SDK client hides. */
  function rawPost(seller: string, key?: string) {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    if (key) headers.set("authorization", `Bearer ${key}`);
    return handleMcpRequest(
      { db, config },
      new Request(`https://piko.test/mcp/${seller}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "1.0.0" },
          },
        }),
      }),
      seller,
    );
  }

  async function mcpSeller(options: Parameters<typeof createSeller>[2] = {}) {
    return createSeller(db, upstream.url, { kind: "both", ...options });
  }

  async function addEndpoint(
    sellerOrgId: string,
    method: string,
    path: string,
    priceMicro: bigint,
  ) {
    const [listing] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.sellerOrgId, sellerOrgId));
    await db
      .insert(endpoints)
      .values({ listingId: listing!.id, method, pathOrTool: path, priceMicro });
  }

  const textOf = (result: CallToolResult) =>
    result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

  async function buyerEntries(orgId: string) {
    return db.select().from(ledgerEntries).where(eq(ledgerEntries.orgId, orgId));
  }

  it("initializes and lists the seller's endpoints as tools with prices", async () => {
    const seller = await mcpSeller();
    await addEndpoint(seller.orgId, "POST", "/summarise", 5_000n);
    const buyer = await createBuyer(db);

    const client = await connect(seller.slug, buyer.rawKey);
    expect(client.getServerVersion()?.name).toBe(`piko-${seller.slug}`);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["get_history", "post_summarise"]);
    expect(tools[0]!.description).toContain("Test Listing");
    expect(tools[0]!.description).toContain("$0.002 per call");
    expect(tools[1]!.description).toContain("$0.005 per call");
    expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(["query"]);
    expect(Object.keys(tools[1]!.inputSchema.properties ?? {})).toEqual(["query", "body"]);
  });

  it("answers 404 for a seller whose listings are all http-only", async () => {
    const seller = await createSeller(db, upstream.url, { kind: "http" });
    const buyer = await createBuyer(db);

    const res = await rawPost(seller.slug, buyer.rawKey);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("charges a tool call once and returns the upstream content", async () => {
    const seller = await mcpSeller();
    const buyer = await createBuyer(db, 10_000n);
    upstream.respond((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ prices: [199, 189] }));
    });
    const before = upstream.requests.length;

    const client = await connect(seller.slug, buyer.rawKey);
    const result = (await client.callTool({
      name: "get_history",
      arguments: { query: { product: "monitor-27", days: 90 } },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(JSON.stringify({ prices: [199, 189] }));
    expect(textOf(result)).toContain("Charged $0.002 via Piko");

    expect(upstream.requests.length - before).toBe(1);
    const forwarded = upstream.requests.at(-1)!;
    expect(forwarded.url).toBe("/history?product=monitor-27&days=90");
    expect(forwarded.headers.authorization).toBeUndefined();

    const [call] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.buyerOrgId, buyer.orgId), eq(calls.endpointId, seller.endpointId)));
    expect(call).toMatchObject({ status: "paid", amountMicro: 2_000n, upstreamStatus: 200 });
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, call!.id));
    expect(entries.map((entry) => entry.amountMicro).sort()).toEqual([-2_000n, 100n, 1_900n]);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
  });

  it("forwards a POST tool's body as JSON", async () => {
    const seller = await mcpSeller({ method: "POST", path: "/summarise" });
    const buyer = await createBuyer(db, 10_000n);

    const client = await connect(seller.slug, buyer.rawKey);
    const result = (await client.callTool({
      name: "post_summarise",
      arguments: { body: { product: "monitor-27" } },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const forwarded = upstream.requests.at(-1)!;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(forwarded.body)).toEqual({ product: "monitor-27" });
  });

  it("returns insufficient_funds as a tool error and charges nothing", async () => {
    const seller = await mcpSeller();
    const buyer = await createBuyer(db);
    const before = upstream.requests.length;

    const client = await connect(seller.slug, buyer.rawKey);
    const result = (await client.callTool({
      name: "get_history",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^insufficient_funds: /);
    expect(result.structuredContent).toMatchObject({
      error: { code: "insufficient_funds", balance: "0" },
    });
    expect(upstream.requests.length).toBe(before);
    expect(await buyerEntries(buyer.orgId)).toEqual([]);
  });

  it("refunds and returns upstream_failed as a tool error when the upstream fails", async () => {
    const seller = await mcpSeller();
    const buyer = await createBuyer(db, 10_000n);
    upstream.respond((_req, res) => {
      res.writeHead(503);
      res.end("down");
    });

    const client = await connect(seller.slug, buyer.rawKey);
    const result = (await client.callTool({
      name: "get_history",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^upstream_failed: /);
    expect(result.structuredContent).toMatchObject({ error: { refunded: true } });
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    const paid = await db.select().from(calls).where(eq(calls.buyerOrgId, buyer.orgId));
    expect(paid).toEqual([]);
  });

  it("passes an upstream 4xx through as a paid tool error", async () => {
    const seller = await mcpSeller();
    const buyer = await createBuyer(db, 10_000n);
    upstream.respond((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "No such product" } }));
    });

    const client = await connect(seller.slug, buyer.rawKey);
    const result = (await client.callTool({
      name: "get_history",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No such product");
    expect(textOf(result)).toContain("The upstream API answered 404. Charged $0.002 via Piko");
  });

  it("serves a free-allowance Call free", async () => {
    const seller = await mcpSeller({ freeQuota: 1 });
    const buyer = await createBuyer(db);

    const client = await connect(seller.slug, buyer.rawKey);
    const tools = (await client.listTools()).tools;
    expect(tools[0]!.description).toContain("Your first 1 calls are free.");

    const first = (await client.callTool({ name: "get_history", arguments: {} })) as CallToolResult;
    expect(first.isError).toBeFalsy();
    expect(textOf(first)).toContain("Free call via Piko");

    const second = (await client.callTool({
      name: "get_history",
      arguments: {},
    })) as CallToolResult;
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/^insufficient_funds: /);
  });

  it("returns agent_frozen as a tool error", async () => {
    const seller = await mcpSeller();
    const buyer = await createBuyer(db, 10_000n);
    const client = await connect(seller.slug, buyer.rawKey);
    await db.update(agents).set({ frozenAt: new Date() }).where(eq(agents.id, buyer.agentId));

    const result = (await client.callTool({
      name: "get_history",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^agent_frozen: /);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
  });

  it("answers 401 invalid_key without a Key or with a wrong one", async () => {
    const seller = await mcpSeller();

    for (const key of [undefined, "pk_agent_wrong"]) {
      const res = await rawPost(seller.slug, key);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_key" } });
    }
  });

  it("answers 404 for an unknown seller", async () => {
    const buyer = await createBuyer(db);
    const res = await rawPost("no-such-seller", buyer.rawKey);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers a raw initialize with JSON and 405 for GET", async () => {
    const seller = await mcpSeller();
    const buyer = await createBuyer(db);

    const res = await rawPost(seller.slug, buyer.rawKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: {} } });

    const get = await handleMcpRequest(
      { db, config },
      new Request(`https://piko.test/mcp/${seller.slug}`, {
        headers: { authorization: `Bearer ${buyer.rawKey}`, accept: "text/event-stream" },
      }),
      seller.slug,
    );
    expect(get.status).toBe(405);
  });
});
