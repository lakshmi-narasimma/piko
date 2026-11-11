import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as productSearch } from "@/app/api/demo/sellers/product-search/search/route";
import { GET as priceHistory } from "@/app/api/demo/sellers/price-history/history/route";
import { FALLBACK_MONITOR } from "./product-search";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Product Search route", () => {
  it("rejects an empty or oversized query", async () => {
    expect((await productSearch(new Request("http://localhost/api?q="))).status).toBe(400);
    expect(
      (await productSearch(new Request(`http://localhost/api?q=${"x".repeat(201)}`))).status,
    ).toBe(400);
  });

  it("calls Channel3 with its server-side contract and returns the results", async () => {
    vi.stubEnv("CHANNEL3_API_KEY", "test-channel3-key");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [{ id: "channel3-monitor", title: "4K display" }] }),
      );
    vi.stubGlobal("fetch", fetcher);

    const response = await productSearch(
      new Request("http://localhost/api/demo/sellers/product-search/search?q=4k%20monitor"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      products: [{ id: "channel3-monitor", title: "4K display" }],
      source: "channel3",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.trychannel3.com/v1/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "test-channel3-key" }),
        body: JSON.stringify({ query: "4k monitor", limit: 10 }),
        redirect: "error",
      }),
    );
    expect(JSON.stringify(body)).not.toContain("test-channel3-key");
  });

  it("uses the fixed monitor if the key is absent or Channel3 has no results", async () => {
    const noKeyResponse = await productSearch(
      new Request("http://localhost/api/demo/sellers/product-search/search?q=monitor"),
    );
    expect(await noKeyResponse.json()).toEqual({
      products: [FALLBACK_MONITOR],
      source: "fallback",
    });
    expect(FALLBACK_MONITOR.offers[0].price).toEqual({ price: 289, currency: "USD" });

    vi.stubEnv("CHANNEL3_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] })));
    const emptyResponse = await productSearch(
      new Request("http://localhost/api/demo/sellers/product-search/search?q=monitor"),
    );
    expect(await emptyResponse.json()).toEqual({
      products: [FALLBACK_MONITOR],
      source: "fallback",
    });
  });

  it("falls back when Channel3 is unavailable", async () => {
    vi.stubEnv("CHANNEL3_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    const response = await productSearch(
      new Request("http://localhost/api/demo/sellers/product-search/search?q=monitor"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).source).toBe("fallback");
  });

  it("falls back when a successful response contains malformed products", async () => {
    vi.stubEnv("CHANNEL3_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ data: [{ name: "missing id/title" }] })),
    );
    const response = await productSearch(
      new Request("http://localhost/api/demo/sellers/product-search/search?q=monitor"),
    );

    expect(await response.json()).toEqual({
      products: [FALLBACK_MONITOR],
      source: "fallback",
    });
  });
});

describe("Price History route", () => {
  it("rejects a missing product id", async () => {
    expect((await priceHistory(new Request("http://localhost/api/history?product="))).status).toBe(
      400,
    );
  });

  it("returns 90 fixed-window points stable for an id and distinct for another id", async () => {
    const request = new Request(
      "http://localhost/api/demo/sellers/price-history/history?product=prod_123",
    );
    const first = await (await priceHistory(request)).json();
    const second = await (await priceHistory(request)).json();
    const different = await (
      await priceHistory(
        new Request("http://localhost/api/demo/sellers/price-history/history?product=prod_456"),
      )
    ).json();

    expect(first.history).toHaveLength(90);
    expect(first).toEqual(second);
    expect(first.history).not.toEqual(different.history);
    expect(first.history[0].date).toBe("2026-08-13");
    expect(first.history.at(-1).date).toBe("2026-11-10");
    expect(
      first.history.every((point: { priceMicroUsd: string }) => /^\d+$/.test(point.priceMicroUsd)),
    ).toBe(true);
  });
});
