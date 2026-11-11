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
