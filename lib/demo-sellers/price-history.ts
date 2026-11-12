import { rejectUnlessFromGateway } from "./auth";

const DAYS = 90;
const END_DATE = "2026-11-10";

export interface PricePoint {
  date: string;
  /** Integer micro-USD; callers can format it without floating-point arithmetic. */
  priceMicroUsd: string;
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pointValue(productId: string, day: number, base: number): bigint {
  // A hash per day avoids mutable random state and makes any point reproducible.
  const random = hash32(`${productId}:${day}`);
  const movement = BigInt(random % 4_000_001) - 2_000_000n;
  return BigInt(base) + movement;
}

/** Build a fixed-window synthetic series, stable across requests and calendar dates. */
export function createPriceHistory(productId: string): PricePoint[] {
  const base = 50_000_000 + (hash32(productId) % 25_000_001); // $50–$75, in micro-USD
  const end = new Date(`${END_DATE}T00:00:00.000Z`);

  return Array.from({ length: DAYS }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (DAYS - 1 - index));
    return {
      date: date.toISOString().slice(0, 10),
      priceMicroUsd: pointValue(productId, index, base).toString(),
    };
  });
}

export function handlePriceHistory(request: Request): Response {
  const rejected = rejectUnlessFromGateway(request);
  if (rejected) return rejected;
  const productId = new URL(request.url).searchParams.get("product")?.trim() ?? "";
  if (!productId || productId.length > 200) {
    return Response.json(
      { error: "product must contain between 1 and 200 characters." },
      { status: 400 },
    );
  }

  return Response.json({
    productId,
    currency: "USD",
    history: createPriceHistory(productId),
  });
}
