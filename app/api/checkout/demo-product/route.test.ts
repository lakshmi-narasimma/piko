import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKOUT_TOKEN_TTL_SECONDS, signCheckoutToken } from "@/lib/checkout/token";

// No session or PayPal is touched: the principal and the PayPal client are fakes.
const mocks = vi.hoisted(() => ({
  SECRET: "s".repeat(32),
  SHOP: "shop@business.example.com",
  getPrincipal: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getPrincipal: mocks.getPrincipal }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ SESSION_SECRET: mocks.SECRET, PAYPAL_DEMO_SHOP_EMAIL: mocks.SHOP }),
}));
vi.mock("@/lib/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal")>()),
  getPayPal: () => ({ request: mocks.request }),
}));

const { POST } = await import("./route");
const { SECRET, SHOP } = mocks;

const PRODUCT = { orgId: "org1", name: "LG 27UP850", priceMicro: 279_990_000n };

function post(body: unknown) {
  return new Request("http://localhost:3000/api/checkout/demo-product", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sentUnit() {
  const init = mocks.request.mock.calls[0]![2] as {
    requestId: string;
    body: { purchase_units: Array<Record<string, unknown>> };
  };
  return { requestId: init.requestId, unit: init.body.purchase_units[0]! };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrincipal.mockResolvedValue({ org: { id: "org1" } });
  mocks.request.mockResolvedValue({ id: "ORD1", status: "CREATED" });
});

describe("POST /api/checkout/demo-product", () => {
  it("401s without a session", async () => {
    mocks.getPrincipal.mockResolvedValue(null);
    const response = await POST(post({ token: signCheckoutToken(PRODUCT, SECRET) }));
    expect(response.status).toBe(401);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("creates the order at the signed price, payable to the demo shop", async () => {
    const token = signCheckoutToken(PRODUCT, SECRET);
    const response = await POST(post({ token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orderId: "ORD1" });
    const { unit, requestId } = sentUnit();
    expect(unit).toMatchObject({
      amount: { currency_code: "USD", value: "279.99" },
      payee: { email_address: SHOP },
      description: "Piko demo checkout: LG 27UP850",
    });
    expect(requestId).toMatch(/^checkout-[0-9a-f-]{36}$/);
  });

  it("sends the same PayPal request id when a token is reused, so it can't make a second order", async () => {
    const token = signCheckoutToken(PRODUCT, SECRET);
    await POST(post({ token }));
    await POST(post({ token }));
    const [first, second] = mocks.request.mock.calls.map(
      (call) => (call[2] as { requestId: string }).requestId,
    );
    expect(first).toBe(second);
  });

  it("ignores a price or name the browser sends alongside the token", async () => {
    const token = signCheckoutToken(PRODUCT, SECRET);
    await POST(post({ token, price: "1.00", name: "Cheap", priceMicro: "1000000" }));
    expect(sentUnit().unit).toMatchObject({ amount: { value: "279.99" } });
  });

  it("400s the old { name, price } body", async () => {
    const response = await POST(post({ name: "LG 27UP850", price: "1.00" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("400s a token whose price was tampered with", async () => {
    const [body, signature] = signCheckoutToken(PRODUCT, SECRET).split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    claims.priceMicro = "1000000";
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    const response = await POST(post({ token: forged }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_checkout_token", message: expect.any(String) },
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("400s a token signed with another secret", async () => {
    const response = await POST(post({ token: signCheckoutToken(PRODUCT, "x".repeat(32)) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_checkout_token" } });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("400s another org's token", async () => {
    const token = signCheckoutToken({ ...PRODUCT, orgId: "org2" }, SECRET);
    const response = await POST(post({ token }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_checkout_token" } });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("400s an expired token", async () => {
    const issued = Date.now() - CHECKOUT_TOKEN_TTL_SECONDS * 1000 - 1000;
    const response = await POST(post({ token: signCheckoutToken(PRODUCT, SECRET, issued) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "checkout_token_expired" } });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("400s a signed price outside what the shop sells, without calling PayPal", async () => {
    const token = signCheckoutToken({ ...PRODUCT, priceMicro: 500_000n }, SECRET);
    const response = await POST(post({ token }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_amount" } });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
