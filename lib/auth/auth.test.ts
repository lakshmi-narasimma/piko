import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { accounts, memberships, orgs } from "../db/schema";
import { areaFor, findByPassword, findPersona, isPersona, loadPrincipal } from "./accounts";
import { hashPassword, verifyPassword } from "./password";
import { readSession, SESSION_TTL_SECONDS, signSession } from "./session";

const secret = "test-secret-test-secret-test-secret";
const claims = { accountId: randomUUID(), orgId: randomUUID() };

describe("session token", () => {
  it("round-trips its claims", () => {
    expect(readSession(signSession(claims, secret), secret)).toMatchObject(claims);
  });

  it("rejects a token signed with another secret, a tampered body and junk", () => {
    const token = signSession(claims, secret);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ accountId: "someone-else", orgId: claims.orgId, exp: 9_999_999_999 }),
    ).toString("base64url");
    expect(readSession(token, "another-secret")).toBeNull();
    expect(readSession(`${forged}.${sig}`, secret)).toBeNull();
    expect(readSession(`${body}.`, secret)).toBeNull();
    expect(readSession("not a token", secret)).toBeNull();
    expect(readSession(undefined, secret)).toBeNull();
  });

  it("expires after the TTL", () => {
    const now = Date.now();
    const token = signSession(claims, secret, now);
    expect(readSession(token, secret, now + (SESSION_TTL_SECONDS - 1) * 1000)).not.toBeNull();
    expect(readSession(token, secret, now + (SESSION_TTL_SECONDS + 1) * 1000)).toBeNull();
  });
});

describe("password hashing", () => {
  it("accepts the right password and rejects others", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", hash)).toBe(true);
    expect(await verifyPassword("hunter3", hash)).toBe(false);
    expect(await verifyPassword("hunter2", "garbage")).toBe(false);
  });

  it("salts each hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });
});

describe("areaFor", () => {
  it("sends solo devs to the Wallet, invoiced orgs to the Org console and sellers to theirs", () => {
    expect(areaFor({ kind: "personal", billing: "prepaid" })).toBe("wallet");
    expect(areaFor({ kind: "company", billing: "invoiced" })).toBe("org");
    expect(areaFor({ kind: "company", billing: "prepaid" })).toBe("seller");
  });
});

const url = inject("testDatabaseUrl");

describe("isPersona", () => {
  it("accepts only the seeded personas, without case", () => {
    expect(isPersona("sam@demo.piko")).toBe(true);
    expect(isPersona(" Dana@Acme.demo ")).toBe(true);
    expect(isPersona("someone@acme.demo")).toBe(false);
    expect(isPersona("")).toBe(false);
  });
});

describe.skipIf(!url)("account lookups", () => {
  let db: Db;
  const tag = randomUUID().slice(0, 8);
  const email = `sam-${tag}@auth.test`;
  let accountId: string;
  let orgId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [org] = await db
      .insert(orgs)
      .values({ name: "Sam", slug: `sam-${tag}`, kind: "personal", billing: "prepaid" })
      .returning({ id: orgs.id });
    const [account] = await db
      .insert(accounts)
      .values({ email, name: "Sam", passwordHash: await hashPassword("correct horse") })
      .returning({ id: accounts.id });
    await db.insert(memberships).values({ accountId: account!.id, orgId: org!.id, role: "admin" });
    accountId = account!.id;
    orgId = org!.id;
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("refuses a passwordless login for any account that isn't a persona", async () => {
    // This account exists and has an org, but it isn't in PERSONAS.
    expect(await findPersona(db, email)).toBeNull();
    expect(await findPersona(db, "nobody@auth.test")).toBeNull();
  });

  it("puts a solo dev's account in the Wallet", async () => {
    expect(await loadPrincipal(db, accountId, orgId)).toMatchObject({
      area: "wallet",
      role: "admin",
    });
  });

  it("logs in by password only with the right one", async () => {
    expect(await findByPassword(db, email, "correct horse")).toMatchObject({ area: "wallet" });
    expect(await findByPassword(db, email, "wrong")).toBeNull();
    expect(await findByPassword(db, "nobody@auth.test", "correct horse")).toBeNull();
  });

  it("matches the email without case or surrounding spaces", async () => {
    expect(await findByPassword(db, ` ${email.toUpperCase()} `, "correct horse")).toMatchObject({
      area: "wallet",
    });
  });

  it("reloads a principal only for the org it was issued for", async () => {
    expect(await loadPrincipal(db, accountId, orgId)).not.toBeNull();
    expect(await loadPrincipal(db, accountId, randomUUID())).toBeNull();
  });
});
