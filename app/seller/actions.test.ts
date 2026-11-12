import { beforeEach, describe, expect, it, vi } from "vitest";

// Every dependency is replaced: this checks only that the action takes the org from the session.
const mocks = vi.hoisted(() => ({
  getPrincipal: vi.fn(),
  editEndpoint: vi.fn(),
  revalidatePath: vi.fn(),
  db: { db: true },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth", () => ({ getPrincipal: mocks.getPrincipal }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db }));
vi.mock("./console", () => ({ editEndpoint: mocks.editEndpoint }));

const { saveEndpoint } = await import("./actions");

const PRINCIPAL = { org: { id: "org-priya", slug: "priya" }, role: "admin", area: "seller" };

describe("saveEndpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPrincipal.mockResolvedValue(PRINCIPAL);
  });

  it("passes the session's Principal and revalidates the console", async () => {
    mocks.editEndpoint.mockResolvedValue({ saved: { price: "$0.005", freeQuota: 0 } });
    const form = new FormData();
    form.set("orgId", "someone-else");
    expect(await saveEndpoint({}, form)).toEqual({ saved: { price: "$0.005", freeQuota: 0 } });
    expect(mocks.editEndpoint).toHaveBeenCalledWith({ db: mocks.db }, PRINCIPAL, form);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/seller");
  });

  it("returns a refusal as is and revalidates nothing", async () => {
    mocks.editEndpoint.mockResolvedValue({ error: "No." });
    expect(await saveEndpoint({}, new FormData())).toEqual({ error: "No." });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
