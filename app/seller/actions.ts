"use server";

import { revalidatePath } from "next/cache";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { editEndpoint, type EndpointEditState } from "./console";

/** Saves one Endpoint's price and free allowance for the signed-in seller's own org. */
export async function saveEndpoint(
  _: EndpointEditState,
  form: FormData,
): Promise<EndpointEditState> {
  const state = await editEndpoint({ db: getDb() }, await getPrincipal(), form);
  if (state.saved) revalidatePath("/seller");
  return state;
}
