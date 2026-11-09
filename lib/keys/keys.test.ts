import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { agents, apiKeys, orgs, teams } from "../db/schema";
import {
  authenticateKey,
  authenticateRequest,
  createKey,
  revokeKey,
  withUpstreamSecret,
  type DbOrTx,
} from "./index";

const url = inject("testDatabaseUrl");

const INVALID = { ok: false, error: "invalid_key" };

// A well-formed key that was never issued.
const unissuedKey = () =>
  `pk_agent_${"A".repeat(30)}${randomUUID().replaceAll("-", "").slice(0, 13)}`;

const bearer = (token: string) => new Headers({ Authorization: `Bearer ${token}` });

// These inputs must be rejected before any query, so touching the database is a failure.
const noDb = new Proxy({} as DbOrTx, {
  get() {
    throw new Error("the database must not be queried");
  },
});

describe("malformed keys", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["the prefix alone", "pk_agent_"],
    ["too short", `pk_agent_${"a".repeat(42)}`],
    ["too long", `pk_agent_${"a".repeat(44)}`],
    ["the wrong prefix", `pk_seller_${"a".repeat(43)}`],
    ["illegal characters", `pk_agent_${"a".repeat(42)}!`],
    ["surrounding space", ` pk_agent_${"a".repeat(43)} `],
    ["a trailing newline", `pk_agent_${"a".repeat(43)}\n`],
  ])("rejects %s without a query", async (_name, key) => {
    expect(await authenticateKey(noDb, key)).toEqual(INVALID);
  });

  it.each([
    ["no header", new Headers()],
    ["another scheme", new Headers({ Authorization: `Basic pk_agent_${"a".repeat(43)}` })],
    ["a bearer with no token", new Headers({ Authorization: "Bearer " })],
    ["two tokens", new Headers({ Authorization: `Bearer a b` })],
    ["only X-Piko-Secret", new Headers({ "X-Piko-Secret": `pk_agent_${"a".repeat(43)}` })],
  ])("rejects a request with %s", async (_name, headers) => {
    expect(await authenticateRequest(noDb, headers)).toEqual(INVALID);
  });
});

describe("withUpstreamSecret", () => {
  it("adds the seller's secret", () => {
    const upstream = withUpstreamSecret(new Headers({ Accept: "text/plain" }), "s3cret");
    expect(upstream.get("X-Piko-Secret")).toBe("s3cret");
    expect(upstream.get("Accept")).toBe("text/plain");
  });

  it("replaces a value the caller sent", () => {
    const upstream = withUpstreamSecret(new Headers({ "x-piko-secret": "forged" }), "s3cret");
    expect(upstream.get("X-Piko-Secret")).toBe("s3cret");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
  ])("drops a value the caller sent when the secret is %s", (_name, secret) => {
    const upstream = withUpstreamSecret(new Headers({ "X-Piko-Secret": "forged" }), secret);
    expect(upstream.has("X-Piko-Secret")).toBe(false);
  });

  it("leaves the original headers alone", () => {
    const original = new Headers({ "X-Piko-Secret": "forged" });
    withUpstreamSecret(original, "s3cret");
    expect(original.get("X-Piko-Secret")).toBe("forged");
  });
});

describe.skipIf(!url)("keys in the database", () => {
  let db: Db;

  // Test files share one database and run in parallel, so every test gets its own org.
  const setup = async (options: { team?: boolean } = {}) => {
    const [org] = await db
      .insert(orgs)
      .values({
        name: "Keys Test",
        slug: `keys-test-${randomUUID()}`,
        kind: "company",
        billing: "invoiced",
      })
      .returning({ id: orgs.id });
    const orgId = org!.id;

    let teamId: string | null = null;
    if (options.team) {
      const [team] = await db
        .insert(teams)
        .values({ orgId, name: "Marketing" })
        .returning({ id: teams.id });
      teamId = team!.id;
    }

    const [agent] = await db
      .insert(agents)
      .values({ orgId, teamId, name: "shopping-assistant" })
      .returning({ id: agents.id });
    const agentId = agent!.id;

    const key = await createKey(db, agentId);
    return { orgId, teamId, agentId, key };
  };

  beforeAll(() => {
    db = createDb(url!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  describe("createKey", () => {
    it("returns a pk_agent_ key with 32 bytes of randomness", async () => {
      const { key } = await setup();
      expect(key.rawKey).toMatch(/^pk_agent_[A-Za-z0-9_-]{43}$/);
      const secret = key.rawKey.slice("pk_agent_".length);
      expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    });

    it("issues a different key every time", async () => {
      const { agentId, key } = await setup();
      const second = await createKey(db, agentId);
      expect(second.rawKey).not.toBe(key.rawKey);
      expect(second.id).not.toBe(key.id);
    });

    it("stores only the hash and a short prefix", async () => {
      const { key } = await setup();
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));

      expect(row!.hash).toBe(createHash("sha256").update(key.rawKey).digest("hex"));
      expect(row!.prefix).toBe(key.prefix);
      expect(key.rawKey.startsWith(row!.prefix)).toBe(true);
      expect(row!.prefix).toHaveLength("pk_agent_".length + 8);

      const stored = JSON.stringify(row);
      const secret = key.rawKey.slice("pk_agent_".length);
      expect(stored).not.toContain(key.rawKey);
      expect(stored).not.toContain(secret);
    });

    it("works inside a transaction that rolls back", async () => {
      const { agentId } = await setup();
      let rawKey = "";
      await db
        .transaction(async (tx) => {
          rawKey = (await createKey(tx, agentId)).rawKey;
          expect((await authenticateKey(tx, rawKey)).ok).toBe(true);
          throw new Error("roll back");
        })
        .catch(() => undefined);
      expect(await authenticateKey(db, rawKey)).toEqual(INVALID);
    });
  });

  describe("authenticateKey", () => {
    it("resolves a valid key to its agent, org and team", async () => {
      const { agentId, orgId, teamId, key } = await setup({ team: true });
      expect(await authenticateKey(db, key.rawKey)).toEqual({
        ok: true,
        keyId: key.id,
        agentId,
        orgId,
        teamId,
        frozenScope: null,
      });
    });

    it("resolves an agent with no team", async () => {
      const { key } = await setup();
      const result = await authenticateKey(db, key.rawKey);
      expect(result).toMatchObject({ ok: true, teamId: null, frozenScope: null });
    });

    it("rejects an unknown key", async () => {
      expect(await authenticateKey(db, unissuedKey())).toEqual(INVALID);
    });

    it("rejects a key whose last character changed", async () => {
      const { key } = await setup();
      const last = key.rawKey.endsWith("A") ? "B" : "A";
      expect(await authenticateKey(db, key.rawKey.slice(0, -1) + last)).toEqual(INVALID);
    });

    it("gives a revoked key the same result as an unknown one", async () => {
      const { key } = await setup();
      await revokeKey(db, key.id);
      const revoked = await authenticateKey(db, key.rawKey);
      const unknown = await authenticateKey(db, unissuedKey());
      expect(revoked).toStrictEqual(INVALID);
      expect(revoked).toStrictEqual(unknown);
    });
  });

  describe("authenticateRequest", () => {
    it("accepts a bearer token, whatever the scheme's case", async () => {
      const { agentId, key } = await setup();
      for (const scheme of ["Bearer", "bearer", "BEARER"]) {
        const headers = new Headers({ Authorization: `${scheme} ${key.rawKey}` });
        expect(await authenticateRequest(db, headers)).toMatchObject({ ok: true, agentId });
      }
    });

    it("ignores X-Piko-Secret when the key is valid", async () => {
      const { key } = await setup();
      const headers = bearer(key.rawKey);
      headers.set("X-Piko-Secret", "anything");
      expect(await authenticateRequest(db, headers)).toEqual(
        await authenticateRequest(db, bearer(key.rawKey)),
      );
    });

    it("does not let X-Piko-Secret rescue a revoked key", async () => {
      const { key } = await setup();
      await revokeKey(db, key.id);
      const headers = bearer(key.rawKey);
      headers.set("X-Piko-Secret", "anything");
      expect(await authenticateRequest(db, headers)).toEqual(INVALID);
    });
  });

  describe("revokeKey", () => {
    it("reports whether this call revoked the key and keeps the first timestamp", async () => {
      const { key } = await setup();
      expect(await revokeKey(db, key.id)).toBe(true);
      const [first] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
      expect(first!.revokedAt).toBeInstanceOf(Date);

      expect(await revokeKey(db, key.id)).toBe(false);
      const [second] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
      expect(second!.revokedAt).toEqual(first!.revokedAt);
    });

    it("returns false for a key that does not exist", async () => {
      expect(await revokeKey(db, randomUUID())).toBe(false);
    });

    it("leaves the agent's other keys working", async () => {
      const { agentId, key } = await setup();
      const other = await createKey(db, agentId);
      await revokeKey(db, key.id);
      expect(await authenticateKey(db, other.rawKey)).toMatchObject({ ok: true, keyId: other.id });
    });
  });

  describe("freeze reporting", () => {
    const now = new Date();
    const freezeAgent = (id: string) =>
      db.update(agents).set({ frozenAt: now }).where(eq(agents.id, id));
    const freezeTeam = (id: string) =>
      db.update(teams).set({ frozenAt: now }).where(eq(teams.id, id));
    const freezeOrg = (id: string) => db.update(orgs).set({ frozenAt: now }).where(eq(orgs.id, id));

    it("reports a frozen agent and still authenticates it", async () => {
      const { agentId, key } = await setup({ team: true });
      await freezeAgent(agentId);
      expect(await authenticateKey(db, key.rawKey)).toMatchObject({
        ok: true,
        agentId,
        frozenScope: "agent",
      });
    });

    it("reports a frozen team", async () => {
      const { teamId, key } = await setup({ team: true });
      await freezeTeam(teamId!);
      expect(await authenticateKey(db, key.rawKey)).toMatchObject({
        ok: true,
        frozenScope: "team",
      });
    });

    it("reports a frozen org", async () => {
      const { orgId, key } = await setup({ team: true });
      await freezeOrg(orgId);
      expect(await authenticateKey(db, key.rawKey)).toMatchObject({ ok: true, frozenScope: "org" });
    });

    it("reports a frozen org for an agent with no team", async () => {
      const { orgId, key } = await setup();
      await freezeOrg(orgId);
      expect(await authenticateKey(db, key.rawKey)).toMatchObject({ ok: true, frozenScope: "org" });
    });

    it("reports the widest scope when several are frozen", async () => {
      const { agentId, teamId, orgId, key } = await setup({ team: true });
      await freezeAgent(agentId);
      await freezeTeam(teamId!);
      expect(await authenticateKey(db, key.rawKey)).toMatchObject({ frozenScope: "team" });
      await freezeOrg(orgId);
      expect(await authenticateKey(db, key.rawKey)).toMatchObject({ frozenScope: "org" });
    });

    it("does not report another agent's freeze", async () => {
      const { orgId, key } = await setup({ team: true });
      const [sibling] = await db
        .insert(agents)
        .values({ orgId, name: "sibling" })
        .returning({ id: agents.id });
      await freezeAgent(sibling!.id);
      expect(await authenticateKey(db, key.rawKey)).toMatchObject({ frozenScope: null });
    });

    it("rejects a revoked key even when its agent is frozen", async () => {
      const { agentId, key } = await setup();
      await freezeAgent(agentId);
      await revokeKey(db, key.id);
      expect(await authenticateKey(db, key.rawKey)).toEqual(INVALID);
    });
  });
});
