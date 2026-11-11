import { getDb } from "@/lib/db";
import { handleSettleRequest } from "@/lib/facilitator";
import { x402ConfigFromEnv } from "@/lib/x402";

export function POST(request: Request) {
  return handleSettleRequest({ db: getDb(), config: x402ConfigFromEnv() }, request);
}
