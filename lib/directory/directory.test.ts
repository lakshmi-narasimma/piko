import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createDb, type Db } from "../db/client";
import { endpoints, listings, orgs, rateOverrides } from "../db/schema";
import { embedMissingListings, listingText, searchDirectory, type EmbeddingLlm } from "./index";

const DIMENSIONS = 768;

/** A bag-of-words embedding: texts that share words land close together. Offline and exact. */
function embedText(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % DIMENSIONS;
    vector[hash]! += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

function fakeLlm() {
  const llm = {
    embed: vi.fn(async (value: string) => embedText(value)),
    embedMany: vi.fn(async (values: string[]) => values.map(embedText)),
  };
  return llm satisfies EmbeddingLlm;
}

describe("listingText", () => {
  it("joins name, description, category and routes", () => {
    expect(
      listingText({
        name: "Price History",
        description: "90 days of prices.",
        category: "pricing",
        endpoints: [{ method: "GET", path: "/history" }],
      }),
    ).toBe("Price History 90 days of prices. Category: pricing. Endpoints: GET /history.");
  });

  it("skips what is missing", () => {
    expect(listingText({ name: "X", description: "Y", category: null, endpoints: [] })).toBe("X Y");
  });
});

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("directory search", () => {
  let db: Db;
  const tag = randomUUID().slice(0, 8);
  const buyerOrgs: string[] = [];

  beforeAll(async () => {
    db = createDb(url!);
    // Other test files share this database, so start from no unembedded Listings of ours only.
    const [org] = await db
      .insert(orgs)
      .values({ name: `Dir ${tag}`, slug: `dir-${tag}`, kind: "company", billing: "prepaid" })
      .returning({ id: orgs.id });
    const make = async (slug: string, name: string, description: string, price: bigint) => {
      const [listing] = await db
        .insert(listings)
        .values({
          sellerOrgId: org!.id,
          slug: `${slug}-${tag}`,
          name,
          description,
          baseUrl: "http://localhost/x",
          kind: "http",
          category: "test",
        })
        .returning({ id: listings.id });
      await db.insert(endpoints).values({
        listingId: listing!.id,
        method: "GET",
        pathOrTool: `/${slug}-${tag}`,
        priceMicro: price,
      });
      return listing!.id;
    };
    await make("prices", `Price Finder ${tag}`, `product prices zebra${tag}`, 2_000n);
    await make("weather", `Weather ${tag}`, `forecast rain snow wind quokka${tag}`, 1_000n);
  });
  afterAll(async () => {
    await db.$client.end();
  });

  it("ranks the closest Listing first", async () => {
    const results = await searchDirectory(db, fakeLlm(), { query: `product prices zebra${tag}` });
    const mine = results.filter((r) => r.slug.endsWith(tag));
    expect(mine[0]!.name).toBe(`Price Finder ${tag}`);
    expect(mine[0]!.score).toBeGreaterThan(mine[1]!.score);
    expect(mine[0]!.endpoints[0]).toMatchObject({
      method: "GET",
      priceMicro: 2_000n,
      price: "$0.002",
      gatewayPath: `/g/dir-${tag}/prices-${tag}`,
    });
  });

  it("embeds a Listing that has no vector, and keeps it", async () => {
    const llm = fakeLlm();
    await db
      .update(listings)
      .set({ embedding: null })
      .where(eq(listings.slug, `weather-${tag}`));
    expect(await embedMissingListings(db, llm)).toBeGreaterThanOrEqual(1);
    const [row] = await db
      .select()
      .from(listings)
      .where(eq(listings.slug, `weather-${tag}`));
    expect(row!.embedding).toHaveLength(DIMENSIONS);
  });

  it("shows the caller's enterprise rate", async () => {
    const [buyer] = await db
      .insert(orgs)
      .values({ name: `Buyer ${tag}`, slug: `buyer-${tag}`, kind: "company", billing: "invoiced" })
      .returning({ id: orgs.id });
    buyerOrgs.push(buyer!.id);
    const [endpoint] = await db
      .select()
      .from(endpoints)
      .where(eq(endpoints.pathOrTool, `/prices-${tag}`));
    await db
      .insert(rateOverrides)
      .values({ endpointId: endpoint!.id, buyerOrgId: buyer!.id, priceMicro: 700n });

    const withRate = await searchDirectory(db, fakeLlm(), {
      query: `product prices zebra${tag}`,
      buyerOrgId: buyer!.id,
    });
    const plain = await searchDirectory(db, fakeLlm(), { query: `product prices zebra${tag}` });
    const pick = (rs: typeof plain) => rs.find((r) => r.slug === `prices-${tag}`)!.endpoints[0]!;
    expect(pick(withRate).priceMicro).toBe(700n);
    expect(pick(plain).priceMicro).toBe(2_000n);
  });

  it("limits the number of results", async () => {
    const results = await searchDirectory(db, fakeLlm(), { query: "anything", limit: 1 });
    expect(results).toHaveLength(1);
  });
});
