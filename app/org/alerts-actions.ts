"use server";

import { cookies } from "next/headers";
import { ALERTS_SEEN_COOKIE } from "@/lib/alerts";
import { getPrincipal } from "@/lib/auth";

/**
 * Marks the org's alerts read in this browser. The `alerts` table has no read column, so the
 * moment is kept in a cookie and the unread count is the alerts written after it.
 */
export async function markAlertsReadAction(): Promise<void> {
  const principal = await getPrincipal();
  if (!principal || principal.area !== "org" || principal.role !== "admin") return;
  (await cookies()).set(ALERTS_SEEN_COOKIE, new Date().toISOString(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
