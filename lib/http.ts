/** The API's error body: `{ "error": { "code", "message", ...details } }` (docs/API.md section 4). */
export function errorBody(code: string, message: string, details: Record<string, unknown> = {}) {
  return { error: { code, message, ...details } };
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return Response.json(errorBody(code, message, details), { status });
}

/**
 * Runs a route handler, turning an unexpected throw into the documented `500 internal_error`
 * body. The cause is logged on the server under `label`, never returned (docs/API.md §4).
 */
export async function orInternalError(
  label: string,
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    console.error(`${label} failed`, error);
    return jsonError(500, "internal_error", "Something went wrong.");
  }
}
