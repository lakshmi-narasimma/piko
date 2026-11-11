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
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_BASE_URL: "http://localhost:3000" }) }));
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
});
