import { describe, expect, it, vi } from "vitest";
import type { PayPalClient } from "../paypal";
import { captureCheckout, createCheckout } from "./index";

function fake(order: unknown = {}) {
  const request = vi.fn(async (method: string, path: string, init?: { body?: unknown }) => {
    if (method === "POST" && path === "/v2/checkout/orders")
      return { id: "ORD1", status: "CREATED" };
    if (path.endsWith("/capture")) {
      return {
        id: "ORD1",
        status: "COMPLETED",
        purchase_units: [
          { payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: {} }] } },
        ],
      };
    }
    void init;
    return order;
  });
  return { paypal: { request } as unknown as PayPalClient, request };
}

const SHOP = "shop@business.example.com";

describe("createCheckout", () => {
  it("creates an order payable to the shop for the product", async () => {
    const { paypal, request } = fake();
    expect(
      await createCheckout(paypal, {
        name: "LG 27UP850",
        priceMicro: 279_990_000n,
        shopEmail: SHOP,
      }),
    ).toEqual({ orderId: "ORD1" });
    const sent = (
      request.mock.calls[0]![2] as { body: { purchase_units: Array<Record<string, unknown>> } }
    ).body.purchase_units[0]!;
    expect(sent).toMatchObject({
      amount: { currency_code: "USD", value: "279.99" },
      payee: { email_address: SHOP },
      description: "Piko demo checkout: LG 27UP850",
    });
  });

  it("rejects prices outside the range or not in whole cents, without calling PayPal", async () => {
    const { paypal, request } = fake();
    for (const priceMicro of [500_000n, 3_000_000_000n, 1_000_001n]) {
      await expect(
        createCheckout(paypal, { name: "x", priceMicro, shopEmail: SHOP }),
      ).rejects.toMatchObject({ code: "invalid_amount" });
    }
    expect(request).not.toHaveBeenCalled();
  });
});

describe("captureCheckout", () => {
  it("captures an order made for the shop", async () => {
    const { paypal } = fake({
      purchase_units: [{ description: "Piko demo checkout: x", payee: { email_address: SHOP } }],
    });
    expect(await captureCheckout(paypal, { orderId: "ORD1", shopEmail: SHOP })).toEqual({
      status: "COMPLETED",
      captureId: "CAP1",
    });
  });

  it("won't capture an order that isn't a demo checkout", async () => {
    for (const unit of [
      { description: "Piko wallet top-up", payee: { email_address: SHOP } },
      { description: "Piko demo checkout: x", payee: { email_address: "other@x.com" } },
      {},
    ]) {
      const { paypal, request } = fake({ purchase_units: [unit] });
      await expect(
        captureCheckout(paypal, { orderId: "ORD1", shopEmail: SHOP }),
      ).rejects.toMatchObject({ code: "not_a_checkout_order" });
      expect(request.mock.calls.some(([, path]) => String(path).endsWith("/capture"))).toBe(false);
    }
  });
});
