import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  startStubUpstream,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
  type StubUpstream,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { availableFunds, balanceOf } from "../ledger";
import { handlePayRequest, type IssuedReceipt } from "../pay";
import { decodeHeaderValue, type PaymentRequired, type SettlementResponse } from "../x402";
import { agentResponseHeaders, upstreamFailureMessage, upstreamRequestHeaders } from "./forward";
import { handleGatewayRequest, type GatewayConfig } from "./index";

describe("header stripping", () => {
  it("drops hop-by-hop headers, any the Connection header names, and Proxy-*", () => {
    const headers = upstreamRequestHeaders(
      new Headers({
        Connection: "keep-alive, X-Hop-Custom",
        "X-Hop-Custom": "1",
        "Keep-Alive": "timeout=5",
        "Proxy-Authorization": "Basic abc",
        "Proxy-Anything": "x",
        TE: "trailers",
        Trailer: "Expires",
        "Transfer-Encoding": "chunked",
        Upgrade: "websocket",
        Host: "piko.test",
        "Content-Length": "12",
        Accept: "application/json",
      }),
    );
    expect([...headers.keys()]).toEqual(["accept"]);
  });

  it("drops the agent's Key, cookies, Receipt and every X-Piko-* header, but keeps Idempotency-Key", () => {
    const headers = upstreamRequestHeaders(
      new Headers({
        Authorization: "Bearer pk_agent_x",
        Cookie: "piko_session=abc",
        "PAYMENT-SIGNATURE": "e30=",
        "X-Piko-Autopay": "true",
        "X-Piko-Secret": "forged",
        "X-Piko-Anything": "x",
        "Idempotency-Key": "retry-1",
        "Content-Type": "application/json",
      }),
    );
    expect(Object.fromEntries(headers)).toEqual({
      "content-type": "application/json",
      "idempotency-key": "retry-1",
    });
  });

  it("drops hop-by-hop, cookie-setting, x402 and X-Piko-* headers from the response", () => {
    const upstream = new Headers({
      Connection: "close, X-Seller-Hop",
      "X-Seller-Hop": "1",
      "Keep-Alive": "timeout=5",
      "Proxy-Authenticate": "Basic",
      "Content-Encoding": "gzip",
      "PAYMENT-RESPONSE": "forged",
      "PAYMENT-REQUIRED": "forged",
      "X-Piko-Secret": "leak",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    upstream.append("Set-Cookie", "piko_session=evil");
    expect(Object.fromEntries(agentResponseHeaders(upstream))).toEqual({
      "cache-control": "no-store",
      "content-type": "application/json",
    });
  });
});

describe("upstreamFailureMessage", () => {
  it("says plainly what went wrong, and that nothing was charged", () => {
    const failure = { ok: false as const, status: null, latencyMs: 0 };
    expect(upstreamFailureMessage({ ...failure, reason: "unreachable" })).toMatch(
      /seller's API is unreachable.*Nothing was charged/,
    );
    expect(upstreamFailureMessage({ ...failure, reason: "server_error", status: 503 })).toContain(
      "HTTP 503",
    );
  });
});

const url = inject("testDatabaseUrl");

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: Record<string, unknown> }).error;

const settlementOf = (res: Response) =>
  decodeHeaderValue(res.headers.get("PAYMENT-RESPONSE")!) as SettlementResponse;

/** A request body sent as a stream in several chunks, with no Content-Length. */
function streamedBody(chunks: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
  });
}

describe.skipIf(!url)("gateway: forwarding", () => {
  let db: Db;
  let upstream: StubUpstream;
  const small: GatewayConfig = { ...config, maxBodyBytes: 1024, maxResponseBytes: 1024 };

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 5 });
    upstream = await startStubUpstream();
  });

  afterEach(() => {
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

  type Seller = Awaited<ReturnType<typeof createSeller>>;

  function send(seller: Seller, request: Request, cfg: GatewayConfig = config) {
    return handleGatewayRequest({ db, config: cfg }, request, {
      seller: seller.slug,
      path: seller.path.slice(1).split("/"),
    });
  }

  function sellerUrl(seller: Seller, query = "") {
    return `https://piko.test/g/${seller.slug}${seller.path}${query}`;
  }

  /** Runs the real loop up to a Receipt: 402, then POST /api/pay. */
  async function paidSignature(seller: Seller, key: string, method: string) {
    const res = await send(seller, gatewayRequest(method, sellerUrl(seller)));
    expect(res.status).toBe(402);
    const { accepts } = (await res.json()) as PaymentRequired;
    const payRes = await handlePayRequest(
      { db, config },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ nonce: accepts[0]!.extra.nonce }),
      }),
    );
    expect(payRes.status).toBe(200);
    return ((await payRes.json()) as IssuedReceipt).paymentSignature;
  }

  it("forwards a GET with its query string exactly, repeated keys included", async () => {
    const seller = await createSeller(db, `${upstream.url}/v1`, { priceMicro: 0n });
    const query = "?tag=b&tag=a&q=hello%20world&empty=&flag";

    const res = await send(seller, gatewayRequest("GET", sellerUrl(seller, query)));

    expect(res.status).toBe(200);
    const received = upstream.requests.at(-1)!;
    expect(received.method).toBe("GET");
    expect(received.url).toBe(`/v1/history${query}`);
    expect(received.headers.host).toBe(new URL(upstream.url).host);
  });

  it("forwards a POST with a JSON body byte for byte", async () => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 0n, method: "POST" });
    const json = '{ "text": "naïve café ☕", "n": 1.50,\n  "list": [1, 2] }';

    const res = await send(
      seller,
      gatewayRequest("POST", sellerUrl(seller, "?dry=1"), {
        headers: { "content-type": "application/json" },
        body: json,
      }),
    );

    expect(res.status).toBe(200);
    const received = upstream.requests.at(-1)!;
    expect(received.method).toBe("POST");
    expect(received.url).toBe("/history?dry=1");
    expect(received.headers["content-type"]).toBe("application/json");
    expect(received.bytes.equals(Buffer.from(json, "utf8"))).toBe(true);
    expect(received.headers["content-length"]).toBe(String(Buffer.byteLength(json)));
  });

  it("forwards a binary body unchanged", async () => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 0n, method: "PUT" });
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

    const res = await send(
      seller,
      new Request(sellerUrl(seller), {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      }),
    );

    expect(res.status).toBe(200);
    expect(upstream.requests.at(-1)!.bytes.equals(Buffer.from(bytes))).toBe(true);
  });

  it("strips hop-by-hop and Piko headers in both directions", async () => {
    upstream.respond((_req, res) => {
      res.setHeader("connection", "close, x-seller-hop");
      res.setHeader("x-seller-hop", "1");
      res.setHeader("proxy-authenticate", "Basic");
      res.setHeader("x-piko-anything", "x");
      res.setHeader("payment-response", "forged");
      res.setHeader("set-cookie", "piko_session=evil");
      res.setHeader("x-seller-ok", "yes");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const seller = await createSeller(db, upstream.url, { priceMicro: 0n, freeQuota: 0 });
    const buyer = await createBuyer(db);

    const res = await send(
      seller,
      gatewayRequest("GET", sellerUrl(seller), {
        key: buyer.rawKey,
        headers: {
          connection: "x-agent-hop",
          "x-agent-hop": "1",
          "keep-alive": "timeout=5",
          "proxy-authorization": "Basic abc",
          te: "trailers",
          upgrade: "websocket",
          cookie: "piko_session=abc",
          "x-piko-debug": "1",
          "idempotency-key": "retry-1",
          "x-agent-ok": "yes",
        },
      }),
    );

    expect(res.status).toBe(200);
    const sent = upstream.requests.at(-1)!.headers;
    expect(sent["x-agent-ok"]).toBe("yes");
    expect(sent["idempotency-key"]).toBe("retry-1");
    for (const name of [
      "authorization",
      "cookie",
      "x-agent-hop",
      "keep-alive",
      "proxy-authorization",
      "te",
      "upgrade",
      "x-piko-debug",
    ]) {
      expect(sent[name], name).toBeUndefined();
    }
    expect(res.headers.get("x-seller-ok")).toBe("yes");
    for (const name of [
      "x-seller-hop",
      "proxy-authenticate",
      "x-piko-anything",
      "payment-response",
      "set-cookie",
    ]) {
      expect(res.headers.get(name), name).toBeNull();
    }
  });

  it("answers 413 to a paid body over the limit, forwards nothing and releases the hold", async () => {
    const seller = await createSeller(db, upstream.url, { method: "POST" });
    const buyer = await createBuyer(db, 10_000n);
    const signature = await paidSignature(seller, buyer.rawKey, "POST");
    expect(await availableFunds(db, buyer.orgId)).toBe(8_000n);
    const before = upstream.requests.length;

    const res = await send(
      seller,
      gatewayRequest("POST", sellerUrl(seller), {
        headers: { "PAYMENT-SIGNATURE": signature, "content-type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(2_000) }),
      }),
      small,
    );

    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: "payload_too_large", maxBytes: 1024 });
    expect(upstream.requests.length).toBe(before);
    expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    expect(await balanceOf(db, { type: "seller", orgId: seller.orgId })).toBe(0n);

    // The released Receipt is spent: retrying it is refused.
    const retry = await send(
      seller,
      gatewayRequest("POST", sellerUrl(seller), { headers: { "PAYMENT-SIGNATURE": signature } }),
      small,
    );
    expect(retry.status).toBe(410);
  });

  it("answers 413 to a streamed body with no Content-Length and gives the free Call back", async () => {
    const seller = await createSeller(db, upstream.url, { method: "POST", freeQuota: 1 });
    const buyer = await createBuyer(db);
    const before = upstream.requests.length;

    const res = await send(
      seller,
      new Request(sellerUrl(seller), {
        method: "POST",
        headers: { authorization: `Bearer ${buyer.rawKey}` },
        body: streamedBody(3, 600),
        duplex: "half",
      } as RequestInit),
      small,
    );

    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: "payload_too_large" });
    expect(upstream.requests.length).toBe(before);

    // The quota was returned: a body at the limit still gets the free Call.
    const again = await send(
      seller,
      new Request(sellerUrl(seller), {
        method: "POST",
        headers: { authorization: `Bearer ${buyer.rawKey}` },
        body: streamedBody(2, 512),
        duplex: "half",
      } as RequestInit),
      small,
    );
    expect(again.status).toBe(200);
    expect(upstream.requests.at(-1)!.bytes.byteLength).toBe(1024);
  });

  it("answers 502 when the seller's API is unreachable, and charges nothing", async () => {
    const gone = await startStubUpstream();
    await gone.close();
    const seller = await createSeller(db, gone.url);
    const buyer = await createBuyer(db, 10_000n);
    const signature = await paidSignature(seller, buyer.rawKey, "GET");

    const res = await send(
      seller,
      gatewayRequest("GET", sellerUrl(seller), { headers: { "PAYMENT-SIGNATURE": signature } }),
    );

    expect(res.status).toBe(502);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: "upstream_failed", refunded: true, reason: "unreachable" });
    expect(error.message).toMatch(/seller's API is unreachable/);
    expect(error.message).not.toContain("127.0.0.1");
    expect(settlementOf(res)).toMatchObject({ success: false, errorReason: "upstream_failed" });
    expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
  });

  it("gives the free Call back when the seller's API is unreachable", async () => {
    const gone = await startStubUpstream();
    await gone.close();
    const seller = await createSeller(db, gone.url, { freeQuota: 1 });
    const buyer = await createBuyer(db);

    const res = await send(seller, gatewayRequest("GET", sellerUrl(seller), { key: buyer.rawKey }));

    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ refunded: false, reason: "unreachable" });
  });

  it.each([
    ["streamed with no Content-Length", false],
    ["with a Content-Length", true],
  ])(
    "refunds a paid Call whose upstream response is over the limit (%s)",
    async (_case, withLength) => {
      const payload = Buffer.alloc(4096, 0x62);
      upstream.respond((_req, res) => {
        const headers: Record<string, string> = { "content-type": "text/plain" };
        if (withLength) headers["content-length"] = String(payload.byteLength);
        res.writeHead(200, headers);
        if (withLength) return res.end(payload);
        res.write(payload.subarray(0, 2048));
        res.end(payload.subarray(2048));
      });
      const seller = await createSeller(db, upstream.url);
      const buyer = await createBuyer(db, 10_000n);
      const signature = await paidSignature(seller, buyer.rawKey, "GET");

      const res = await send(
        seller,
        gatewayRequest("GET", sellerUrl(seller), { headers: { "PAYMENT-SIGNATURE": signature } }),
        small,
      );

      expect(res.status).toBe(502);
      expect(await errorOf(res)).toMatchObject({
        code: "upstream_failed",
        refunded: true,
        reason: "response_too_large",
      });
      expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
      expect(await balanceOf(db, { type: "seller", orgId: seller.orgId })).toBe(0n);
    },
  );
});
