import { createHash, timingSafeEqual } from "node:crypto";
import { getEnv } from "../env";
import { jsonError } from "../http";
import { UPSTREAM_SECRET_HEADER } from "../keys";

/** Hashing first gives both sides the same length, which timingSafeEqual requires. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * The sample seller APIs only answer the gateway, which sends DEMO_UPSTREAM_SECRET as
 * X-Piko-Secret. Without it anyone could call them directly and spend the Gemini and
 * Channel3 free tiers. Returns the 401 to send, or null when the request may proceed.
 */
export function rejectUnlessFromGateway(
  request: Request,
  expected: string = getEnv().DEMO_UPSTREAM_SECRET,
): Response | null {
  const given = request.headers.get(UPSTREAM_SECRET_HEADER);
  if (given !== null && timingSafeEqual(digest(given), digest(expected))) return null;
  return jsonError(
    401,
    "unauthorized",
    "This sample API is only reachable through the Piko gateway at /g/{seller}/….",
  );
}
