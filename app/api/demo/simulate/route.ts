import { getPrincipal } from "@/lib/auth";
import {
  getSimulationState,
  NotSeededError,
  startSimulation,
  stopSimulation,
} from "@/lib/demo/simulate";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { jsonError, orInternalError } from "@/lib/http";

/** The demo-mode and sign-in checks both methods share: an error response, or null to go on. */
async function guard(): Promise<Response | null> {
  // Demo mode only: with it off, the route reads as if it doesn't exist.
  if (!getEnv().DEMO_MODE) return jsonError(404, "not_found", "Not found.");
  if (!(await getPrincipal())) return jsonError(401, "unauthenticated", "Sign in first.");
  return null;
}

/** The simulated traffic's state: `{ running, ratePerSecond, startedAt, produced, stoppedBecause }`. */
export function GET() {
  return orInternalError("GET /api/demo/simulate", async () => {
    return (await guard()) ?? Response.json(getSimulationState());
  });
}

/**
 * Starts or stops simulated traffic (demo mode only, any signed-in person). Body
 * `{ "action": "start" | "stop" }`; answers the new state. Both are idempotent. Starting a
 * world with no seeded Acme agents or listings answers 409 `not_seeded`.
 */
export function POST(request: Request) {
  return orInternalError("POST /api/demo/simulate", async () => {
    const refused = await guard();
    if (refused) return refused;

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== "start" && body?.action !== "stop") {
      return jsonError(400, "invalid_request", 'action must be "start" or "stop".');
    }
    if (body.action === "stop") return Response.json(stopSimulation());

    try {
      return Response.json(await startSimulation(getDb()));
    } catch (error) {
      if (error instanceof NotSeededError) return jsonError(409, "not_seeded", error.message);
      throw error;
    }
  });
}
