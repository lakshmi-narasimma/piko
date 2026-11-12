import type { Principal } from "@/lib/auth";
import {
  createListing,
  listingJson,
  ListingError,
  MAX_ENDPOINTS,
  type CreateListingDeps,
} from "@/lib/listings";

/**
 * The "Connect an API" form (BACKLOG P4-04): reads the form's fields into a createListing
 * input and turns a ListingError into messages the form shows next to each field. The org
 * always comes from the session's Principal, never from the form.
 */

/** A field's name in the form, which is also its error key: `baseUrl`, `endpoints.0.path`... */
export type FieldErrors = Record<string, string>;

export interface ConnectedListing {
  id: string;
  slug: string;
  name: string;
  embedded: boolean;
  endpoints: Array<{
    id: string;
    method: string;
    path: string;
    /** Display form, "$0.002". */
    price: string;
    freeQuota: number;
    gatewayUrl: string;
  }>;
}

export interface ConnectState {
  /** The top-level message when the Listing wasn't created. */
  error?: string;
  fieldErrors?: FieldErrors;
  listing?: ConnectedListing;
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** The endpoint rows in the order the form sent them: `endpoints.{i}.method` and so on. */
function endpointRows(form: FormData) {
  const indexes = new Set<number>();
  for (const key of form.keys()) {
    const match = /^endpoints\.(\d{1,3})\./.exec(key);
    if (match) indexes.add(Number(match[1]));
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .slice(0, MAX_ENDPOINTS + 1)
    .map((i) => {
      const freeQuota = text(form, `endpoints.${i}.freeQuota`);
      return {
        method: text(form, `endpoints.${i}.method`),
        path: text(form, `endpoints.${i}.path`),
        price: text(form, `endpoints.${i}.price`),
        // A blank box means no free Calls; anything else must be a whole number.
        ...(freeQuota === ""
          ? {}
          : { freeQuota: /^\d+$/.test(freeQuota) ? Number(freeQuota) : NaN }),
      };
    });
}

/** The createListing input a form describes. Blank optional fields are left out. */
export function listingInputFromForm(form: FormData) {
  const category = text(form, "category");
  return {
    baseUrl: text(form, "baseUrl"),
    name: text(form, "name"),
    description: text(form, "description"),
    ...(category ? { category } : {}),
    kind: text(form, "kind") || "http",
    endpoints: endpointRows(form),
  };
}

/** Plainer words for the issues whose schema message is generic. */
function fieldMessage(field: string, message: string): string {
  if (field === "baseUrl") return "Paste your API's base URL.";
  if (field === "name") return "Give your API a name, up to 120 characters.";
  if (field === "description") return "Describe your API in 1 to 500 characters.";
  if (field === "category") return "Keep the category to 60 characters.";
  if (field === "kind") return "Pick HTTP, MCP or both.";
  if (field === "endpoints") return `Add 1 to ${MAX_ENDPOINTS} endpoints.`;
  if (/^endpoints\.\d+\.method$/.test(field)) return "Pick a method.";
  if (/^endpoints\.\d+\.freeQuota$/.test(field)) {
    return "Free calls must be a whole number from 0 to 1,000,000.";
  }
  // The form sends only dollar prices, so the schema's words about priceMicro would confuse.
  if (/^endpoints\.\d+\.price$/.test(field) && /priceMicro/.test(message)) {
    return "Enter a price in dollars, like 0.002.";
  }
  return message;
}

/**
 * Where on the form an issue belongs. The schema puts two kinds of issue on a whole row: a
 * route listed twice (shown by its path) and anything about its price (shown by the price).
 */
function fieldFor(path: string, message: string): string {
  if (!/^endpoints\.\d+$/.test(path)) return path;
  return /listed twice/.test(message) ? `${path}.path` : `${path}.price`;
}

const BASE_URL_REASONS: Record<string, string> = {
  blocked_address:
    "That address can't be reached from Piko: private or local addresses aren't allowed.",
  blocked_port: "That address can't be reached from Piko: only ports 80 and 443 are allowed.",
  unresolvable_host: "That host doesn't resolve. Check the URL and try again.",
};

/** A ListingError as the form's messages. */
export function errorState(error: ListingError, input: ReturnType<typeof listingInputFromForm>) {
  switch (error.code) {
    case "invalid_request": {
      const fieldErrors: FieldErrors = {};
      const issues = (error.details.issues ?? []) as Array<{ path: string; message: string }>;
      for (const issue of issues) {
        const field = fieldFor(issue.path, issue.message);
        fieldErrors[field] ??= fieldMessage(field, issue.message);
      }
      return { error: "Check the highlighted fields.", fieldErrors };
    }
    case "blocked_base_url": {
      const message =
        BASE_URL_REASONS[String(error.details.reason)] ?? BASE_URL_REASONS.blocked_address!;
      return { error: message, fieldErrors: { baseUrl: message } };
    }
    case "invalid_base_url":
      return { error: error.message, fieldErrors: { baseUrl: error.message } };
    case "route_taken": {
      const { method, path } = error.details as { method?: string; path?: string };
      const row = input.endpoints.findIndex(
        (e) => e.method.toUpperCase() === method && e.path === path,
      );
      const message = method
        ? `You already list ${method} ${path} on another Listing. A route can be on only one of your Listings.`
        : error.message;
      return {
        error: message,
        fieldErrors: row >= 0 ? { [`endpoints.${row}.path`]: message } : {},
      };
    }
    case "slug_taken":
    case "listing_limit":
      return { error: error.message };
  }
}

/**
 * Creates the Listing a submitted form describes, for the signed-in seller admin's own org.
 * The server action calls this with the session's Principal.
 */
export async function connectListing(
  deps: CreateListingDeps,
  principal: Principal | null,
  form: FormData,
): Promise<ConnectState> {
  if (!principal || principal.area !== "seller" || principal.role !== "admin") {
    return { error: "Only an admin of a seller org can connect an API." };
  }
  const input = listingInputFromForm(form);
  try {
    const created = listingJson(
      await createListing(deps, { orgId: principal.org.id, slug: principal.org.slug }, input),
    );
    return {
      listing: {
        id: created.id,
        slug: created.slug,
        name: created.name,
        embedded: created.embedded,
        endpoints: created.endpoints.map((e) => ({
          id: e.id,
          method: e.method,
          path: e.path,
          price: e.price,
          freeQuota: e.freeQuota,
          gatewayUrl: e.gatewayUrl,
        })),
      },
    };
  } catch (error) {
    if (error instanceof ListingError) return errorState(error, input);
    throw error;
  }
}
