import { beforeEach, describe, expect, it, vi } from "vitest";

// No session, database or loop is touched here: the route's checks and answers only.
const mocks = vi.hoisted(() => ({
  getPrincipal: vi.fn(),
  env: { DEMO_MODE: true },
  startSimulation: vi.fn(),
  stopSimulation: vi.fn(),
  getSimulationState: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getPrincipal: mocks.getPrincipal }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ db: true }) }));
vi.mock("@/lib/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/lib/demo/simulate", async (importOriginal) => ({
  NotSeededError: (await importOriginal<typeof import("@/lib/demo/simulate")>()).NotSeededError,
  startSimulation: mocks.startSimulation,
  stopSimulation: mocks.stopSimulation,
  getSimulationState: mocks.getSimulationState,
}));

const { GET, POST } = await import("./route");
const { NotSeededError } = await import("@/lib/demo/simulate");

const STATE = {
  running: true,
  ratePerSecond: 3,
  startedAt: "2026-11-12T17:00:00.000Z",
  produced: 4,
  stoppedBecause: null,
};

function post(body: unknown) {
  return POST(
    new Request("http://localhost:3000/api/demo/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.DEMO_MODE = true;
  mocks.getPrincipal.mockResolvedValue({ org: { id: "org1" }, area: "org" });
  mocks.startSimulation.mockResolvedValue(STATE);
  mocks.stopSimulation.mockReturnValue({ ...STATE, running: false });
  mocks.getSimulationState.mockReturnValue(STATE);
});

describe("POST /api/demo/simulate", () => {
  it("404s outside demo mode, before it even checks the session", async () => {
    mocks.env.DEMO_MODE = false;
    for (const principal of [null, { org: { id: "org1" } }]) {
      mocks.getPrincipal.mockResolvedValue(principal);
      const response = await post({ action: "start" });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
    expect((await GET()).status).toBe(404);
    expect(mocks.startSimulation).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    mocks.getPrincipal.mockResolvedValue(null);
    const response = await post({ action: "start" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect((await GET()).status).toBe(401);
    expect(mocks.startSimulation).not.toHaveBeenCalled();
  });

  it.each([{}, { action: "pause" }, { action: 1 }, "not json", null])(
    "400s on a bad body (%j)",
    async (body) => {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(mocks.startSimulation).not.toHaveBeenCalled();
      expect(mocks.stopSimulation).not.toHaveBeenCalled();
    },
  );

  it("starts and answers the state, for any signed-in area", async () => {
    for (const area of ["buyer", "org", "seller"]) {
      mocks.getPrincipal.mockResolvedValue({ org: { id: "org1" }, area });
      const response = await post({ action: "start" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(STATE);
    }
    expect(mocks.startSimulation).toHaveBeenCalledTimes(3);
  });

  it("stops and answers the state", async () => {
    const response = await post({ action: "stop" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...STATE, running: false });
    expect(mocks.stopSimulation).toHaveBeenCalledOnce();
  });

  it("409s not_seeded when there is nothing to simulate", async () => {
    mocks.startSimulation.mockRejectedValue(new NotSeededError());
    const response = await post({ action: "start" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "not_seeded", message: expect.stringContaining("seed") },
    });
  });

  it("500s without leaking the cause when the engine fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.startSimulation.mockRejectedValue(new Error("password=hunter2"));
    const response = await post({ action: "start" });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
    log.mockRestore();
  });
});

describe("GET /api/demo/simulate", () => {
  it("answers the current state", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(STATE);
  });
});
