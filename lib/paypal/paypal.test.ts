import { describe, expect, it, vi } from "vitest";
import { PayPalClient, PayPalError } from "./client";
import { captureOrder, createOrder, fromPayPalValue, toPayPalValue } from "./orders";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function client(handler: (url: string, init: RequestInit) => Response, now = () => 0) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  );
  return {
    fetchMock,
    paypal: new PayPalClient({
      baseUrl: "https://paypal.test",
      clientId: "id",
      clientSecret: "secret",
      fetch: fetchMock as unknown as typeof fetch,
      now,
    }),
  };
}

const tokenOr =
  (next: (url: string, init: RequestInit) => Response) => (url: string, init: RequestInit) =>
    url.endsWith("/v1/oauth2/token")
      ? json({ access_token: "tok", expires_in: 3600 })
      : next(url, init);

describe("amounts", () => {
  it("converts whole cents both ways and rejects anything else", () => {
    expect(toPayPalValue(5_000_000n)).toBe("5.00");
    expect(toPayPalValue(10_000n)).toBe("0.01");
    expect(toPayPalValue(12_340_000n)).toBe("12.34");
    expect(fromPayPalValue("12.34")).toBe(12_340_000n);
    expect(fromPayPalValue("5")).toBe(5_000_000n);
    expect(fromPayPalValue("0.5")).toBe(500_000n);
    expect(() => toPayPalValue(2_000n)).toThrow(RangeError);
    expect(() => toPayPalValue(0n)).toThrow(RangeError);
    expect(() => fromPayPalValue("1.234")).toThrow(RangeError);
  });
});

describe("PayPalClient", () => {
  it("caches the token and sends a PayPal-Request-Id on writes only", async () => {
    const { paypal, fetchMock } = client(tokenOr(() => json({ id: "x" })));
    await paypal.request("GET", "/a");
    await paypal.request("POST", "/b", { body: {}, requestId: "fixed" });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    const get = calls.find((c) => c.url.endsWith("/a"))!.init as RequestInit;
    const post = calls.find((c) => c.url.endsWith("/b"))!.init as RequestInit;
    expect((get.headers as Record<string, string>)["PayPal-Request-Id"]).toBeUndefined();
    expect((post.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("fixed");
  });

  it("fetches a new token once the old one nears expiry", async () => {
    let time = 0;
    const { paypal, fetchMock } = client(
      tokenOr(() => json({})),
      () => time,
    );
    await paypal.request("GET", "/a");
    time = 3_600_000 - 30_000;
    await paypal.request("GET", "/a");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/token"))).toHaveLength(2);
  });

  it("shares one token request between concurrent calls", async () => {
    const { paypal, fetchMock } = client(tokenOr(() => json({})));
    await Promise.all([paypal.request("GET", "/a"), paypal.request("GET", "/b")]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/token"))).toHaveLength(1);
  });

  it("turns an error body into a readable PayPalError", async () => {
    const { paypal } = client(
      tokenOr(() =>
        json(
          {
            name: "UNPROCESSABLE_ENTITY",
            message: "The requested action could not be performed.",
            debug_id: "abc123",
            details: [{ issue: "ORDER_ALREADY_CAPTURED", description: "Order already captured." }],
          },
          422,
        ),
      ),
    );
    const error = await paypal.request("POST", "/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({ status: 422, debugId: "abc123", name_: "UNPROCESSABLE_ENTITY" });
    expect((error as PayPalError).message).toContain("ORDER_ALREADY_CAPTURED");
  });

  it("says so when the credentials are rejected", async () => {
    const { paypal } = client(() =>
      json({ error: "invalid_client", error_description: "Bad" }, 401),
    );
    await expect(paypal.request("GET", "/a")).rejects.toThrow(/rejected the client id/);
  });
});

describe("orders", () => {
  it("creates a CAPTURE order for the amount in dollars, with a stable request id", async () => {
    let sent: { body: string; id: string } | undefined;
    const { paypal } = client(
      tokenOr((_, init) => {
        sent = {
          body: String(init.body),
          id: (init.headers as Record<string, string>)["PayPal-Request-Id"]!,
        };
        return json({ id: "ORDER1", status: "CREATED" });
      }),
    );
    await createOrder(paypal, { amountMicro: 5_000_000n, requestId: "topup-1" });
    expect(JSON.parse(sent!.body)).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "5.00" } }],
    });
    expect(sent!.id).toBe("topup-1");
  });

  it("derives the capture request id from the order", async () => {
    let id: string | undefined;
    const { paypal } = client(
      tokenOr((_, init) => {
        id = (init.headers as Record<string, string>)["PayPal-Request-Id"];
        return json({ id: "O", status: "COMPLETED" });
      }),
    );
    await captureOrder(paypal, "O");
    expect(id).toBe("capture-O");
  });
});
