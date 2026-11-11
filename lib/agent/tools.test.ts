import { describe, expect, it, vi } from "vitest";
import { createAgentTools, type AgentToolContext } from "./tools";

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    key: "pk_agent_secret",
    baseUrl: "http://localhost:3000",
    taskBudgetMicro: 100_000n,
    state: { spentMicro: 0n },
    search: vi.fn(async () => []),
    lookupPrice: vi.fn(async () => 2_000n),
    walletBalance: vi.fn(async () => 5_000_000n),
    send: vi.fn(async () => paid({ ok: true }, 2_000n)),
    ...overrides,
  };
}

function paid(body: unknown, amount: bigint, status = 200) {
  const settlement = Buffer.from(
    JSON.stringify({ success: true, amount: amount.toString() }),
  ).toString("base64");
  return new Response(JSON.stringify(body), {
    status,
    headers: { "PAYMENT-RESPONSE": settlement },
  });
}

// The SDK's execute takes (input, options); the tools here ignore the options.
const run = <T>(t: { execute?: (...args: never[]) => unknown }, input: unknown) =>
  (t.execute as unknown as (i: unknown, o: unknown) => Promise<T>)(input, {});

describe("call_api", () => {
  it("pays through the gateway with the key and autopay, and counts the cost", async () => {
    const ctx = context();
    const tools = createAgentTools(ctx);
    const result = await run<Record<string, unknown>>(tools.call_api, {
      seller: "priya",
      path: "/history",
      method: "GET",
      query: { product: "p1" },
    });

    expect(result).toMatchObject({ ok: true, status: 200, costMicro: "2000", cost: "$0.002" });
    expect(ctx.state.spentMicro).toBe(2_000n);
    const [request, params] = vi.mocked(ctx.send).mock.calls[0]!;
    expect(request.url).toBe("http://localhost:3000/g/priya/history?product=p1");
    expect(request.headers.get("authorization")).toBe("Bearer pk_agent_secret");
    expect(request.headers.get("x-piko-autopay")).toBe("true");
    expect(params).toEqual({ seller: "priya", path: ["history"] });
  });

  it("never puts the key in what the model sees", async () => {
    const tools = createAgentTools(context());
    const result = await run(tools.call_api, { seller: "priya", path: "/history", method: "GET" });
    expect(JSON.stringify(result)).not.toContain("pk_agent_secret");
  });

  it("refuses a call that would cross the task budget, without calling or charging", async () => {
    const ctx = context({ taskBudgetMicro: 3_000n, state: { spentMicro: 2_000n } });
    const result = await run<Record<string, unknown>>(createAgentTools(ctx).call_api, {
      seller: "priya",
      path: "/history",
      method: "GET",
    });
    expect(result).toMatchObject({ ok: false, error: "over_task_budget", costMicro: "0" });
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.state.spentMicro).toBe(2_000n);
  });

  it("says so for an endpoint that doesn't exist", async () => {
    const ctx = context({ lookupPrice: vi.fn(async () => null) });
    const result = await run(createAgentTools(ctx).call_api, {
      seller: "x",
      path: "/nope",
      method: "GET",
    });
    expect(result).toMatchObject({ ok: false, error: "no_such_endpoint" });
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it("passes Piko's error code on and charges nothing", async () => {
    const ctx = context({
      send: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "insufficient_funds", message: "Empty." } }),
            {
              status: 402,
            },
          ),
      ),
    });
    const result = await run(createAgentTools(ctx).call_api, {
      seller: "priya",
      path: "/history",
      method: "GET",
    });
    expect(result).toMatchObject({ ok: false, error: "insufficient_funds", costMicro: "0" });
    expect(ctx.state.spentMicro).toBe(0n);
  });

  it("does not charge for an upstream failure that Piko refunded", async () => {
    const ctx = context({
      send: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "upstream_failed", refunded: true } }), {
            status: 502,
          }),
      ),
    });
    const result = await run(createAgentTools(ctx).call_api, {
      seller: "priya",
      path: "/history",
      method: "GET",
    });
    expect(result).toMatchObject({ ok: false, error: "upstream_failed", costMicro: "0" });
  });

  it("truncates a huge response", async () => {
    const ctx = context({ send: vi.fn(async () => paid("x".repeat(100_000), 2_000n)) });
    const result = await run<{ body: string }>(createAgentTools(ctx).call_api, {
      seller: "priya",
      path: "/history",
      method: "GET",
    });
    expect(String(result.body).length).toBeLessThanOrEqual(4000);
  });
});

describe("check_budget", () => {
  it("reports what is left", async () => {
    const ctx = context({ taskBudgetMicro: 100_000n, state: { spentMicro: 30_000n } });
    expect(await run(createAgentTools(ctx).check_budget, {})).toMatchObject({
      spentMicro: "30000",
      remainingMicro: "70000",
      remaining: "$0.07",
      walletBalance: "$5.00",
    });
  });
});

describe("search_directory", () => {
  it("returns names, ratings and prices", async () => {
    const ctx = context({
      search: vi.fn(async () => [
        {
          id: "1",
          slug: "price-history",
          name: "Price History",
          description: "90 days.",
          category: "pricing",
          rating: "4.8",
          kind: "http" as const,
          seller: { slug: "priya", name: "Priya Labs" },
          score: 0.9,
          endpoints: [
            {
              method: "GET",
              path: "/history",
              priceMicro: 2_000n,
              price: "$0.002",
              gatewayPath: "/g/priya/history",
            },
          ],
        },
      ]),
    });
    const result = await run<{ results: Array<Record<string, unknown>> }>(
      createAgentTools(ctx).search_directory,
      { query: "prices" },
    );
    expect(result.results[0]).toMatchObject({
      name: "Price History",
      rating: "4.8",
      endpoints: [{ seller: "priya", path: "/history", price: "$0.002", priceMicro: "2000" }],
    });
  });
});
