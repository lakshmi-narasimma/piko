import { rejectUnlessFromGateway } from "./auth";

const CHANNEL3_SEARCH_URL = "https://api.trychannel3.com/v1/search";
const SEARCH_TIMEOUT_MS = 5_000;
const MAX_QUERY_LENGTH = 200;

export const FALLBACK_MONITOR = {
  id: "piko-demo-27-inch-4k-monitor",
  title: "27-inch 4K Monitor",
  brand: "Piko Demo",
  offers: [
    {
      // Channel3 ProductOffer uses `price.price` (major currency units).
      price: { price: 289, currency: "USD" },
      url: null,
    },
  ],
} as const;

interface Channel3SearchResponse {
  data?: unknown;
}

function isChannel3Product(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const product = value as Record<string, unknown>;
  return (
    typeof product.id === "string" &&
    product.id.length > 0 &&
    typeof product.title === "string" &&
    product.title.length > 0
  );
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Search Channel3 server-side; the API key is never returned to the caller. */
export async function handleProductSearch(
  request: Request,
  options: {
    apiKey?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<Response> {
  const rejected = rejectUnlessFromGateway(request);
  if (rejected) return rejected;
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > MAX_QUERY_LENGTH) {
    return json({ error: `q must contain between 1 and ${MAX_QUERY_LENGTH} characters.` }, 400);
  }

  const { apiKey = process.env.CHANNEL3_API_KEY, fetcher = fetch } = options;
  if (apiKey) {
    try {
      const response = await fetcher(CHANNEL3_SEARCH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ query, limit: 10 }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        // The credential is a custom header, so never forward it through an upstream redirect.
        redirect: "error",
      });

      if (response.ok) {
        const result = (await response.json()) as Channel3SearchResponse;
        if (
          Array.isArray(result.data) &&
          result.data.length > 0 &&
          result.data.every(isChannel3Product)
        ) {
          return json({ products: result.data, source: "channel3" });
        }
      }
    } catch {
      // Channel3 is optional in local/demo environments; use the documented fallback.
    }
  }

  return json({ products: [FALLBACK_MONITOR], source: "fallback" });
}
