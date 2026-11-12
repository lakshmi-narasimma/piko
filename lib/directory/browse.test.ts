import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createDb, type Db } from "../db/client";
import { endpoints, listings, orgs, rateOverrides } from "../db/schema";
import { AiBusy } from "../llm";
import {
  browseDirectory,
  embedMissingListings,
  keywordSearchDirectory,
  keywordTerms,
  likePattern,
  loadDirectoryListing,
  lowestPriceMicro,
  type EmbeddingLlm,
} from "./index";

const DIMENSIONS = 768;

/** A bag-of-words embedding, as in directory.test.ts: offline and exact. */
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
  return {
    embed: vi.fn(async (value: string) => embedText(value)),
    embedMany: vi.fn(async (values: string[]) => values.map(embedText)),
  } satisfies EmbeddingLlm;
}

/** An embedding model that is always busy, as lib/llm reports it. */
function busyLlm() {
  return {
    embed: vi.fn(async (): Promise<number[]> => {
      throw new AiBusy([]);
    }),
    embedMany: vi.fn(async (): Promise<number[][]> => {
      throw new AiBusy([]);
    }),
  } satisfies EmbeddingLlm;
}

describe("keywordTerms", () => {
  it("lowercases, splits on anything but letters and digits, and drops repeats", () => {
    expect(keywordTerms("  Product PRICES, product-prices! 4K ")).toEqual([
      "product",
      "prices",
      "4k",
    ]);
  });

  it("is empty for a query with no words", () => {
    expect(keywordTerms(" %_ ")).toEqual([]);
  });
});

describe("likePattern", () => {
  it("escapes LIKE wildcards", () => {
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});

describe("lowestPriceMicro", () => {
  it("is the cheapest Endpoint, or null with none", () => {
    expect(lowestPriceMicro({ endpoints: [{ priceMicro: 3n }, { priceMicro: 1n }] })).toBe(1n);
    expect(lowestPriceMicro({ endpoints: [] })).toBeNull();
  });
});

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("Directory screen data", () => {
  let db: Db;
  const tag = randomUUID().slice(0, 8);
  const sellerSlug = `browse-${tag}`;
  let buyerOrgId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [seller] = await db
      .insert(orgs)
      .values({
        name: `Browse Seller ${tag}`,
        slug: sellerSlug,
        kind: "company",
        billing: "prepaid",
      })
      .returning({ id: orgs.id });
    const [buyer] = await db
      .insert(orgs)
      .values({
        name: `Browse Buyer ${tag}`,
        slug: `bbuyer-${tag}`,
        kind: "company",
        billing: "invoiced",
      })
      .returning({ id: orgs.id });
    buyerOrgId = buyer!.id;

    const [prices] = await db
      .insert(listings)
      .values({
        sellerOrgId: seller!.id,
        slug: `prices-${tag}`,
        name: `Okapi Prices ${tag}`,
        description: `Live product prices for okapi${tag} shoppers.`,
        baseUrl: "http://localhost/x",
        kind: "both",
        category: "shopping",
        rating: "4.5",
      })
      .returning({ id: listings.id });
    const [reviews] = await db
      .insert(listings)
      .values({
        sellerOrgId: seller!.id,
        slug: `reviews-${tag}`,
        name: `Okapi Reviews ${tag}`,
        description: `Summaries of okapi${tag} product reviews.`,
        baseUrl: "http://localhost/x",
        kind: "mcp",
        category: "reviews",
        rating: "3.0",
      })
      .returning({ id: listings.id });
    // One insert each, so each gets its own created_at and the oldest-first order is fixed.
    const rows = [
      {
        listingId: prices!.id,
        method: "GET",
        pathOrTool: `/p-${tag}/search`,
        priceMicro: 2_000n,
        freeQuota: 10,
      },
      { listingId: prices!.id, method: "GET", pathOrTool: `/p-${tag}/history`, priceMicro: 1_000n },
      {
        listingId: reviews!.id,
        method: "POST",
        pathOrTool: `/r-${tag}/summary`,
        priceMicro: 5_000n,
      },
    ];
    const inserted = [];
    for (const row of rows) {
      const [endpoint] = await db
        .insert(endpoints)
        .values(row)
        .returning({ id: endpoints.id, path: endpoints.pathOrTool });
      inserted.push(endpoint!);
    }
    const history = inserted.find((e) => e.path.endsWith("/history"))!;
    await db.insert(rateOverrides).values({ endpointId: history.id, buyerOrgId, priceMicro: 400n });
  });
  afterAll(async () => {
    await db.$client.end();
  });

  const mine = <T extends { slug: string }>(rs: T[]) => rs.filter((r) => r.slug.endsWith(tag));

  it("keyword search matches words in name, description or category, most matches first", async () => {
    const results = await keywordSearchDirectory(db, { query: `okapi${tag} reviews` });
    expect(results[0]!.name).toBe(`Okapi Reviews ${tag}`);
    expect(mine(results).map((r) => r.name)).toEqual([
      `Okapi Reviews ${tag}`,
      `Okapi Prices ${tag}`,
    ]);
  });

  it("keyword search finds nothing for words no Listing has", async () => {
    expect(await keywordSearchDirectory(db, { query: `nothing${tag}here` })).toEqual([]);
  });

  it("an empty query lists every Listing, best rated first, without the AI", async () => {
    const llm = busyLlm();
    const { mode, results } = await browseDirectory(db, llm, { query: "  " });
    expect(mode).toBe("all");
    expect(mine(results).map((r) => r.slug)).toEqual([`prices-${tag}`, `reviews-${tag}`]);
    expect(llm.embed).not.toHaveBeenCalled();
  });

  it("searches by meaning when the AI is up", async () => {
    const llm = fakeLlm();
    // Other test files share this database, so there may be more unembedded Listings than
    // one search's batch embeds. Embed them all first.
    for (let i = 0; i < 100 && (await embedMissingListings(db, llm)) > 0; i++);
    const { mode, results } = await browseDirectory(db, llm, {
      query: `okapi${tag} product reviews summaries`,
      buyerOrgId,
    });
    expect(mode).toBe("semantic");
    expect(results[0]!.slug).toBe(`reviews-${tag}`);
    expect(results[0]!.endpoints).toEqual([
      expect.objectContaining({ method: "POST", freeQuota: 0, price: "$0.005" }),
    ]);
  });

  it("falls back to keyword results when the AI is busy", async () => {
    const { mode, results } = await browseDirectory(db, busyLlm(), {
      query: `okapi${tag} reviews`,
      buyerOrgId,
    });
    expect(mode).toBe("keyword");
    expect(results[0]!.slug).toBe(`reviews-${tag}`);
  });

  it("does not hide other failures behind the fallback", async () => {
    const broken = {
      embed: vi.fn(async (): Promise<number[]> => {
        throw new Error("boom");
      }),
      embedMany: vi.fn(async (values: string[]) => values.map(embedText)),
    } satisfies EmbeddingLlm;
    await expect(browseDirectory(db, broken, { query: "anything" })).rejects.toThrow("boom");
  });

  it("loads a Listing's details with every Endpoint, priced for the buyer", async () => {
    const listing = await loadDirectoryListing(db, {
      sellerSlug,
      slug: `prices-${tag}`,
      buyerOrgId,
    });
    expect(listing).toMatchObject({
      name: `Okapi Prices ${tag}`,
      kind: "both",
      rating: "4.5",
      category: "shopping",
      seller: { slug: sellerSlug, name: `Browse Seller ${tag}` },
    });
    expect(listing!.endpoints).toEqual([
      {
        method: "GET",
        path: `/p-${tag}/search`,
        priceMicro: 2_000n,
        price: "$0.002",
        freeQuota: 10,
        gatewayPath: `/g/${sellerSlug}/p-${tag}/search`,
      },
      {
        method: "GET",
        path: `/p-${tag}/history`,
        priceMicro: 400n,
        price: "$0.0004",
        freeQuota: 0,
        gatewayPath: `/g/${sellerSlug}/p-${tag}/history`,
      },
    ]);
    expect(lowestPriceMicro(listing!)).toBe(400n);
  });

  it("shows list prices to an org without a rate", async () => {
    const listing = await loadDirectoryListing(db, { sellerSlug, slug: `prices-${tag}` });
    expect(listing!.endpoints.map((e) => e.priceMicro)).toEqual([2_000n, 1_000n]);
  });

  it("is null for an unknown Listing, or a real slug under the wrong seller", async () => {
    expect(await loadDirectoryListing(db, { sellerSlug, slug: `missing-${tag}` })).toBeNull();
    expect(
      await loadDirectoryListing(db, { sellerSlug: `bbuyer-${tag}`, slug: `prices-${tag}` }),
    ).toBeNull();
  });
});
