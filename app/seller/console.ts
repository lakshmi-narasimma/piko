import type { Principal } from "@/lib/auth";
import type { Db } from "@/lib/db/client";
import { ListingError, updateEndpoint } from "@/lib/listings";
import { formatUsd } from "@/lib/money";

/**
 * The Seller console's endpoint editor (BACKLOG P6-01): reads one Endpoint's price and free
 * allowance from a form and saves them for the signed-in seller admin's own org. The org
 * always comes from the session's Principal, never from the form.
 */

export interface EndpointEditState {
  error?: string;
  fieldErrors?: { price?: string; freeQuota?: string };
  /** The saved values, in display form ("$0.002"). */
  saved?: { price: string; freeQuota: number };
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export async function editEndpoint(
  deps: { db: Db },
  principal: Principal | null,
  form: FormData,
): Promise<EndpointEditState> {
  if (!principal || principal.area !== "seller" || principal.role !== "admin") {
    return { error: "Only an admin of a seller org can change prices." };
  }
  const quota = text(form, "freeQuota");
  const input = {
    price: text(form, "price").replace(/^\$/, ""),
    // A blank box means no free Calls; anything else must be a whole number.
    freeQuota: quota === "" ? 0 : /^\d+$/.test(quota) ? Number(quota) : NaN,
  };
  try {
    const row = await updateEndpoint(deps.db, principal.org.id, text(form, "endpointId"), input);
    return { saved: { price: formatUsd(row.priceMicro), freeQuota: row.freeQuota } };
  } catch (error) {
    if (!(error instanceof ListingError)) throw error;
    if (error.code !== "invalid_request") return { error: error.message };
    const issues = (error.details.issues ?? []) as Array<{ path: string; message: string }>;
    const fieldErrors: NonNullable<EndpointEditState["fieldErrors"]> = {};
    for (const issue of issues) {
      if (issue.path === "freeQuota") {
        fieldErrors.freeQuota = "Free calls must be a whole number from 0 to 1,000,000.";
      } else {
        fieldErrors.price ??= /between/.test(issue.message)
          ? issue.message
          : "Enter a price in dollars, like 0.002.";
      }
    }
    return { error: "Check the highlighted fields.", fieldErrors };
  }
}
