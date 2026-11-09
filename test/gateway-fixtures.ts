import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import type { Db } from "../lib/db/client";
import { agents, endpoints, ledgerEntries, listings, orgs } from "../lib/db/schema";
import type { GatewayConfig } from "../lib/gateway";
import { createKey } from "../lib/keys";

/** Variables getEnv validates. The Ledger reads PLATFORM_FEE_BPS through it. */
export function stubGatewayEnv(): void {
  const env: Record<string, string> = {
    APP_BASE_URL: "https://piko.test",
    SESSION_SECRET: "test",
    RECEIPT_SIGNING_SECRET: "test-receipt-secret",
    DATABASE_URL: "postgresql://unused@localhost/unused",
    DATABASE_URL_POOLED: "postgresql://unused@localhost/unused",
    PAYPAL_CLIENT_ID: "test",
    PAYPAL_CLIENT_SECRET: "test",
    NEXT_PUBLIC_PAYPAL_CLIENT_ID: "test",
    PAYPAL_DEMO_SHOP_EMAIL: "shop@example.com",
    GEMINI_API_KEY: "test",
    PLATFORM_FEE_BPS: "500",
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

export const TEST_GATEWAY_CONFIG: GatewayConfig = {
  appBaseUrl: "https://piko.test",
  network: "paypal:sandbox",
  challengeTtlSeconds: 30,
  receiptTtlSeconds: 60,
  upstreamTimeoutMs: 2_000,
};

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface StubUpstream {
  url: string;
  requests: RecordedRequest[];
  /** Replaces how the stub answers. By default it returns 200 with a JSON body. */
  respond: (handler: (req: RecordedRequest, res: ServerResponse) => void) => void;
  close: () => Promise<void>;
}

/** An ephemeral local HTTP server standing in for a seller's API. */
export async function startStubUpstream(): Promise<StubUpstream> {
  const requests: RecordedRequest[] = [];
  let handler = (_req: RecordedRequest, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    respond: (next) => {
      handler = next;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function createSeller(
  db: Db,
  upstreamUrl: string,
  options: { priceMicro?: bigint; freeQuota?: number; method?: string; path?: string } = {},
) {
  const slug = `seller-${randomUUID()}`;
  const [org] = await db
    .insert(orgs)
    .values({ name: "Test Seller", slug, kind: "company", billing: "prepaid" })
    .returning({ id: orgs.id });
  const [listing] = await db
    .insert(listings)
    .values({
      sellerOrgId: org!.id,
      slug: `listing-${randomUUID()}`,
      name: "Test Listing",
      description: "For gateway tests",
      baseUrl: upstreamUrl,
      kind: "http",
    })
    .returning({ id: listings.id });
  const path = options.path ?? "/history";
  const [endpoint] = await db
    .insert(endpoints)
    .values({
      listingId: listing!.id,
      method: options.method ?? "GET",
      pathOrTool: path,
      priceMicro: options.priceMicro ?? 2_000n,
      freeQuota: options.freeQuota ?? 0,
    })
    .returning({ id: endpoints.id });
  return { orgId: org!.id, slug, endpointId: endpoint!.id, path };
}

export async function createBuyer(db: Db, fundedMicro = 0n) {
  const [org] = await db
    .insert(orgs)
    .values({
      name: "Test Buyer",
      slug: `buyer-${randomUUID()}`,
      kind: "personal",
      billing: "prepaid",
    })
    .returning({ id: orgs.id });
  const [agent] = await db
    .insert(agents)
    .values({ orgId: org!.id, name: "test-agent" })
    .returning({ id: agents.id });
  const key = await createKey(db, agent!.id);
  if (fundedMicro > 0n) {
    await db.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "wallet",
      orgId: org!.id,
      amountMicro: fundedMicro,
      reason: "seed",
      refId: randomUUID(),
    });
  }
  return { orgId: org!.id, agentId: agent!.id, rawKey: key.rawKey };
}

export function gatewayRequest(
  method: string,
  url: string,
  init: { key?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  return new Request(url, { method, headers, body: init.body });
}
