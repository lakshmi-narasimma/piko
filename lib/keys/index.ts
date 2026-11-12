/**
 * Agent Keys (docs/API.md section 1). A Key is `pk_agent_` plus 32 random bytes. Piko stores
 * only its SHA-256 hash and a short display prefix, so the raw key exists once, in what
 * `createKey` returns. A fast hash is right here because the key is high-entropy and random.
 *
 * Never log a raw key.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, apiKeys, orgs, teams } from "../db/schema";

const KEY_PREFIX = "pk_agent_";
const KEY_SECRET_BYTES = 32;
const DISPLAY_SECRET_CHARS = 8;
// 32 bytes are exactly 43 base64url characters.
const KEY_FORMAT = /^pk_agent_[A-Za-z0-9_-]{43}$/;

/** The header Piko sends a seller's upstream so their API can reject direct traffic. */
export const UPSTREAM_SECRET_HEADER = "X-Piko-Secret";

/** A database client or an open transaction. */
export type DbOrTx = Pick<Db, "select" | "insert" | "update">;

export type CreatedKey = {
  id: string;
  agentId: string;
  /** The visible part of the key, safe to show in the console. */
  prefix: string;
  /** The whole key. Show it once; it cannot be recovered. */
  rawKey: string;
  createdAt: Date;
};

/** Which kill switch applies. Matches `scope` on the 423 `agent_frozen` error. */
export type FrozenScope = "agent" | "team" | "org";

export type AuthenticatedAgent = {
  keyId: string;
  agentId: string;
  orgId: string;
  teamId: string | null;
  /**
   * The kill switch that is on, or null when the agent may spend. If several are on, this
   * is the widest (org, then team, then agent), the one a human has to lift last.
   * A frozen agent still authenticates: the caller decides to return 423.
   */
  frozenScope: FrozenScope | null;
};

/** Maps to 401 `invalid_key`. Malformed, unknown and revoked keys all produce this value. */
export type InvalidKey = { ok: false; error: "invalid_key" };

export type AuthResult = ({ ok: true } & AuthenticatedAgent) | InvalidKey;

const INVALID_KEY: InvalidKey = Object.freeze({ ok: false, error: "invalid_key" });

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Creates a Key for an agent and returns the raw key, the only time it is available.
 * The caller must already have checked that the agent belongs to the signed-in org.
 */
export async function createKey(db: DbOrTx, agentId: string): Promise<CreatedKey> {
  const secret = randomBytes(KEY_SECRET_BYTES).toString("base64url");
  const rawKey = `${KEY_PREFIX}${secret}`;
  const prefix = `${KEY_PREFIX}${secret.slice(0, DISPLAY_SECRET_CHARS)}`;

  const [row] = await db
    .insert(apiKeys)
    .values({ agentId, hash: hashKey(rawKey), prefix })
    .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt });

  return { id: row!.id, agentId, prefix, rawKey, createdAt: row!.createdAt };
}

/**
 * Resolves a raw key to its agent, org, team and freeze state. A revoked key is filtered
 * out by the same query that misses an unknown one, so callers cannot tell them apart.
 */
export async function authenticateKey(
  db: DbOrTx,
  rawKey: string | null | undefined,
): Promise<AuthResult> {
  if (!rawKey || !KEY_FORMAT.test(rawKey)) return INVALID_KEY;

  const [row] = await db
    .select({
      keyId: apiKeys.id,
      agentId: agents.id,
      orgId: agents.orgId,
      teamId: agents.teamId,
      agentFrozenAt: agents.frozenAt,
      teamFrozenAt: teams.frozenAt,
      orgFrozenAt: orgs.frozenAt,
    })
    .from(apiKeys)
    .innerJoin(agents, eq(apiKeys.agentId, agents.id))
    .innerJoin(orgs, eq(agents.orgId, orgs.id))
    .leftJoin(teams, eq(agents.teamId, teams.id))
    .where(and(eq(apiKeys.hash, hashKey(rawKey)), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!row) return INVALID_KEY;

  const { agentFrozenAt, teamFrozenAt, orgFrozenAt, ...identity } = row;
  return {
    ok: true,
    ...identity,
    frozenScope: widestFrozenScope(agentFrozenAt, teamFrozenAt, orgFrozenAt),
  };
}

/** The widest kill switch that is on: org, then team, then agent. */
function widestFrozenScope(
  agentFrozenAt: Date | null,
  teamFrozenAt: Date | null,
  orgFrozenAt: Date | null,
): FrozenScope | null {
  if (orgFrozenAt) return "org";
  if (teamFrozenAt) return "team";
  if (agentFrozenAt) return "agent";
  return null;
}

/**
 * The kill switch that applies to an agent right now (its own, its team's or its org's),
 * read fresh from the database. The gateway calls it when a Receipt is redeemed, because
 * the freeze state captured when the Receipt was issued may be out of date. Null when the
 * agent may spend, or when it does not exist.
 */
export async function currentFrozenScope(db: DbOrTx, agentId: string): Promise<FrozenScope | null> {
  const [row] = await db
    .select({
      agentFrozenAt: agents.frozenAt,
      teamFrozenAt: teams.frozenAt,
      orgFrozenAt: orgs.frozenAt,
    })
    .from(agents)
    .innerJoin(orgs, eq(agents.orgId, orgs.id))
    .leftJoin(teams, eq(agents.teamId, teams.id))
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!row) return null;
  return widestFrozenScope(row.agentFrozenAt, row.teamFrozenAt, row.orgFrozenAt);
}

/**
 * Authenticates a request from its `Authorization: Bearer pk_agent_…` header. This is the
 * only credential: X-Piko-Secret flows from Piko to sellers and proves nothing about a caller.
 */
export function authenticateRequest(db: DbOrTx, headers: Headers): Promise<AuthResult> {
  const match = /^Bearer +(\S+)$/i.exec(headers.get("authorization") ?? "");
  return authenticateKey(db, match?.[1]);
}

/**
 * Revokes a Key. Returns true if this call revoked it, false if it was already revoked or
 * does not exist. The first `revoked_at` is kept. The caller must already have checked
 * that the key belongs to the signed-in org.
 */
export async function revokeKey(db: DbOrTx, keyId: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/**
 * Headers for a request to a seller's upstream: a copy of `headers` carrying the seller's
 * shared secret if they set one. Any X-Piko-Secret the caller sent is always dropped, so a
 * buyer can never choose the value a seller's API sees.
 */
export function withUpstreamSecret(headers: Headers, secret: string | null | undefined): Headers {
  const upstream = new Headers(headers);
  upstream.delete(UPSTREAM_SECRET_HEADER);
  if (secret) upstream.set(UPSTREAM_SECRET_HEADER, secret);
  return upstream;
}
