import { getDb } from "@/lib/db";
import { handleVerifyRequest } from "@/lib/facilitator";
import { x402ConfigFromEnv } from "@/lib/x402";

export function POST(request: Request) {
  return handleVerifyRequest({ db: getDb(), config: x402ConfigFromEnv() }, request);
}
