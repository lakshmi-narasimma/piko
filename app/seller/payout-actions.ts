"use server";

import { revalidatePath } from "next/cache";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { formatUsd } from "@/lib/money";
import { PayoutError, sendPayout } from "@/lib/payouts";

export interface WithdrawState {
  message?: string;
  error?: string;
}

/**
 * The Withdraw button: pays the signed-in seller's whole-cent balance to their PayPal email.
 * The org comes from the session, never from the form. Admins only.
 */
export async function withdrawAction(_: WithdrawState, __: FormData): Promise<WithdrawState> {
  const principal = await getPrincipal();
  if (!principal || principal.area !== "seller") return { error: "Sign in to the Seller console." };
  if (principal.role !== "admin") return { error: "Only an admin can withdraw earnings." };

  try {
    const payout = await sendPayout({ db: getDb() }, principal.org.id, "manual");
    revalidatePath("/seller");
    return {
      message: `Sent ${formatUsd(payout.amountMicro)} to PayPal. It shows as pending until PayPal confirms it.`,
    };
  } catch (error) {
    if (error instanceof PayoutError) {
      revalidatePath("/seller");
      return { error: error.message };
    }
    console.error("Withdraw failed", error);
    return { error: "The payout could not be sent. Nothing was taken from your balance." };
  }
}
