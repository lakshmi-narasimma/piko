import { connection } from "next/server";
import { supportedResponse } from "@/lib/facilitator";
import { x402ConfigFromEnv } from "@/lib/x402";

export async function GET() {
  // Reads the environment, so it must not be prerendered at build time.
  await connection();
  return Response.json(supportedResponse(x402ConfigFromEnv()));
}
