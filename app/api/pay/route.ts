import { getDb } from "@/lib/db";
import { handlePayRequest } from "@/lib/pay";
import { x402ConfigFromEnv } from "@/lib/x402";

export function POST(request: Request) {
  return handlePayRequest({ db: getDb(), config: x402ConfigFromEnv() }, request);
}
