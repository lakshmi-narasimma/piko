import { beforeEach, describe, expect, it, vi } from "vitest";

// Every dependency is replaced: no session, database, model or gateway is touched here.
const mocks = vi.hoisted(() => ({
  getPrincipal: vi.fn(),
  startPlaygroundRun: vi.fn(),
  finishPlaygroundRun: vi.fn(),
  createToolContext: vi.fn(),
  runAgent: vi.fn(),
  getLlm: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth", () => ({ getPrincipal: mocks.getPrincipal }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ APP_BASE_URL: "http://localhost:3000", SESSION_SECRET: "s".repeat(32) }),
}));
vi.mock("@/lib/llm", () => ({ getLlm: mocks.getLlm }));
vi.mock("@/lib/agent/tools", () => ({ createToolContext: mocks.createToolContext }));
vi.mock("@/lib/agent/run", () => ({ runAgent: mocks.runAgent }));
vi.mock("@/lib/agent/playground", async (importOriginal) => ({
  NoAgentError: (await importOriginal<typeof import("@/lib/agent/playground")>()).NoAgentError,
  startPlaygroundRun: mocks.startPlaygroundRun,
  finishPlaygroundRun: mocks.finishPlaygroundRun,
}));

const { POST } = await import("./route");
const { NoAgentError } = await import("@/lib/agent/playground");
const { getRunCache } = await import("@/lib/agent/cache");
const { verifyCheckoutToken } = await import("@/lib/checkout/token");

const RUN = {
  agentId: "a1",
  agentName: "Shopper",
  keyId: "k1",
  key: "pk_secret",
  taskBudgetMicro: 100_000n,
};

function post(body: unknown) {
  return new Request("http://localhost:3000/api/playground/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function frames(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as { type: string });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrincipal.mockResolvedValue({ org: { id: "org1" } });
  mocks.startPlaygroundRun.mockResolvedValue(RUN);
  mocks.finishPlaygroundRun.mockResolvedValue(undefined);
  mocks.createToolContext.mockReturnValue({ state: { spentMicro: 0n, reservedMicro: 0n } });
  mocks.runAgent.mockImplementation(async function* () {
    yield { type: "answer", text: "Buy it." };
    yield { type: "done", spentMicro: "0", recommendation: null };
  });
});

describe("POST /api/playground/run", () => {
  it("401s without a session", async () => {
    mocks.getPrincipal.mockResolvedValue(null);
    const response = await POST(post({ prompt: "hi" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(mocks.startPlaygroundRun).not.toHaveBeenCalled();
  });

  it.each([{}, { prompt: "" }, { prompt: "x".repeat(501) }, "not json"])(
    "400s on a bad body (%j)",
    async (body) => {
      const response = await POST(post(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(mocks.startPlaygroundRun).not.toHaveBeenCalled();
    },
  );

  it("409s when the org has no agent", async () => {
    mocks.startPlaygroundRun.mockRejectedValue(new NoAgentError());
    const response = await POST(post({ prompt: "hi" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "no_agent" } });
  });

  it("streams start first and done last, then revokes the run's Key", async () => {
    const response = await POST(post({ prompt: "Find a monitor" }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = await frames(response);
    expect(events[0]).toMatchObject({ type: "start", agent: "Shopper", budgetMicro: "100000" });
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(mocks.finishPlaygroundRun).toHaveBeenCalledWith(expect.anything(), RUN);
    expect(JSON.stringify(events)).not.toContain("pk_secret");
  });

  it("revokes the Key and returns the standard error body if the run can't start", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createToolContext.mockImplementation(() => {
      throw new Error("bad env");
    });
    const response = await POST(post({ prompt: "hi" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(mocks.finishPlaygroundRun).toHaveBeenCalledWith(expect.anything(), RUN);
    log.mockRestore();
  });

  it("logs, rather than throws, when the final revoke fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.finishPlaygroundRun.mockRejectedValue(new Error("db down"));
    const events = await frames(await POST(post({ prompt: "hi" })));
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("signs the recommendation for this org into a checkout token on done", async () => {
    const recommendation = { name: "LG 27UP850", priceMicro: "279990000", url: "https://x" };
    mocks.runAgent.mockImplementation(async function* () {
      yield { type: "done", spentMicro: "0", recommendation };
    });
    const events = await frames(await POST(post({ prompt: "Find a monitor" })));
    const done = events.at(-1) as unknown as {
      recommendation: typeof recommendation & { checkoutToken: string };
    };
    expect(done.recommendation).toMatchObject(recommendation);
    const verified = verifyCheckoutToken(done.recommendation.checkoutToken, "s".repeat(32), "org1");
    expect(verified).toMatchObject({
      ok: true,
      claims: { orgId: "org1", name: "LG 27UP850", priceMicro: 279_990_000n, url: "https://x" },
    });
  });
});

describe("POST /api/playground/run replay", () => {
  const earlier = [
    { type: "answer", text: "Earlier answer." },
    {
      type: "done",
      spentMicro: "2000",
      spent: "$0.002",
      remaining: "$0.098",
      recommendation: null,
    },
  ] as const;

  beforeEach(() => {
    mocks.runAgent.mockImplementation(async function* () {
      yield { type: "busy", message: "AI is busy" };
      yield { type: "done", spentMicro: "0", recommendation: null };
    });
  });

  it("sends a notice, then the earlier run, when busy before anything was paid", async () => {
    getRunCache().set("org1", "replay me", [...earlier]);
    const events = await frames(await POST(post({ prompt: "replay me" })));
    expect(events.map((e) => e.type)).toEqual(["start", "notice", "answer", "done"]);
    expect(events.at(-1)).toMatchObject({ spentMicro: "2000" });
    expect(mocks.finishPlaygroundRun).toHaveBeenCalled();
  });

  it("doesn't replay once a paid call has settled", async () => {
    getRunCache().set("org1", "paid already", [...earlier]);
    mocks.createToolContext.mockReturnValue({ state: { spentMicro: 2_000n, reservedMicro: 0n } });
    const events = await frames(await POST(post({ prompt: "paid already" })));
    expect(events.map((e) => e.type)).toEqual(["start", "busy", "done"]);
  });
});
