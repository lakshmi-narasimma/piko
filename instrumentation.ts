/**
 * Runs once when the server starts (`next dev` or `next start`), not during `next build`.
 * Validating here makes a missing variable stop the server at boot instead of failing
 * on the first request that needs it. On a bad env the process exits non-zero, so a
 * Render deploy with a missing variable fails instead of going live and serving 500s.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { EnvError, getEnv } = await import("./lib/env");
    try {
      getEnv();
    } catch (error) {
      if (error instanceof EnvError) {
        // The message names each bad variable, never its value.
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  }
}
