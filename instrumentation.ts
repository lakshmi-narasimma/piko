/**
 * Runs once when the server starts (`next dev` or `next start`), not during `next build`.
 * Validating here makes a missing variable stop the server at boot instead of failing
 * on the first request that needs it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("./lib/env");
    getEnv();
  }
}
