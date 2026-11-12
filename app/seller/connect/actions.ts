"use server";

import { revalidatePath } from "next/cache";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getLlm } from "@/lib/llm";
import { connectListing, type ConnectState } from "./connect";

/** Publishes the "Connect an API" form as a Listing of the signed-in seller's own org. */
export async function connectApi(_: ConnectState, form: FormData): Promise<ConnectState> {
  const state = await connectListing(
    { db: getDb(), llm: getLlm(), appBaseUrl: getEnv().APP_BASE_URL },
    await getPrincipal(),
    form,
  );
  if (state.listing) revalidatePath("/seller");
  return state;
}
