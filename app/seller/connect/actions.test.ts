import { beforeEach, describe, expect, it, vi } from "vitest";

// Every dependency is replaced: this checks only that the action takes the org from the session.
const mocks = vi.hoisted(() => ({
  getPrincipal: vi.fn(),
  connectListing: vi.fn(),
  revalidatePath: vi.fn(),
  db: { db: true },
  llm: { llm: true },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth", () => ({ getPrincipal: mocks.getPrincipal }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_BASE_URL: "http://localhost:3000" }) }));
vi.mock("@/lib/llm", () => ({ getLlm: () => mocks.llm }));
vi.mock("./connect", () => ({ connectListing: mocks.connectListing }));

const { connectApi } = await import("./actions");

const PRINCIPAL = { org: { id: "org-priya", slug: "priya" }, role: "admin", area: "seller" };

describe("connectApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPrincipal.mockResolvedValue(PRINCIPAL);
  });

  it("passes the session's Principal, not anything from the form", async () => {
    mocks.connectListing.mockResolvedValue({ listing: { id: "l1" } });
    const form = new FormData();
    form.set("orgId", "someone-else");
    expect(await connectApi({}, form)).toEqual({ listing: { id: "l1" } });
    expect(mocks.connectListing).toHaveBeenCalledWith(
      { db: mocks.db, llm: mocks.llm, appBaseUrl: "http://localhost:3000" },
      PRINCIPAL,
      form,
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/seller");
  });

  it("returns a refusal as is and revalidates nothing", async () => {
    mocks.connectListing.mockResolvedValue({ error: "No." });
    expect(await connectApi({}, new FormData())).toEqual({ error: "No." });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
