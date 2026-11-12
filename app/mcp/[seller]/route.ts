import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { gatewayConfigFromEnv } from "@/lib/gateway";
import { handleMcpRequest } from "@/lib/mcp";

async function handler(request: NextRequest, context: RouteContext<"/mcp/[seller]">) {
  const { seller } = await context.params;
  return handleMcpRequest({ db: getDb(), config: gatewayConfigFromEnv() }, request, seller);
}

// GET and DELETE get 405: the server is stateless, with no SSE stream and no sessions.
export { handler as GET, handler as POST, handler as DELETE };
