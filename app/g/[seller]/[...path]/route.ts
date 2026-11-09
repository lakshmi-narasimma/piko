import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { gatewayConfigFromEnv, handleGatewayRequest } from "@/lib/gateway";

async function handler(request: NextRequest, context: RouteContext<"/g/[seller]/[...path]">) {
  const params = await context.params;
  return handleGatewayRequest({ db: getDb(), config: gatewayConfigFromEnv() }, request, params);
}

// HEAD is listed explicitly: Next would otherwise answer it by running GET.
export {
  handler as GET,
  handler as HEAD,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as OPTIONS,
};
