/**
 * The paid MCP server behind `POST /mcp/{seller}` (docs/API.md section 5).
 *
 * It lists a seller's Endpoints as MCP tools, with the price in each description. A tool
 * call is an autopay request to the hosted gateway (`X-Piko-Autopay: true`), made in
 * process, so it pays exactly as the gateway does: free allowance, $0 Endpoints, frozen
 * agents, the pay pipeline, forwarding, settling and the refund when the upstream fails.
 *
 * The server is stateless: each HTTP request builds a fresh MCP server and transport, so
 * any instance can answer any request and nothing is kept between them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as z from "zod";
import type { Db } from "../db/client";
import { endpoints, listings, orgs } from "../db/schema";
import { handleGatewayRequest, type GatewayDeps } from "../gateway";
import { jsonError } from "../http";
import { authenticateRequest } from "../keys";
import { formatUsd } from "../money";
import { decodeHeaderValue, PAYMENT_RESPONSE_HEADER, type SettlementResponse } from "../x402";

const SERVER_VERSION = "0.1.0";

/** Methods a tool can call. An Endpoint whose method is TOOL needs an MCP upstream, which the gateway can't forward to yet. */
const TOOL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/** One seller Endpoint, as an MCP tool. */
export interface McpTool {
  name: string;
  description: string;
  method: string;
  path: string;
}

/** MCP tool names: 1 to 128 of A-Z, a-z, 0-9, `_`, `-` and `.`. */
export function toolName(method: string, path: string): string {
  const slug = path
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `${method.toLowerCase()}_${slug || "root"}`.slice(0, 128);
}

function priceText(priceMicro: bigint, freeQuota: number): string {
  if (priceMicro === 0n) return "Price: free.";
  const price = `Price: ${formatUsd(priceMicro)} per call, paid from your Piko wallet.`;
  return freeQuota > 0 ? `${price} Your first ${freeQuota} calls are free.` : price;
}

/**
 * The seller's tools, oldest Listing and Endpoint first. Only Listings offered over MCP
 * (`kind` mcp or both) are included. Null when no seller has this slug.
 */
export async function loadSellerTools(db: Db, sellerSlug: string): Promise<McpTool[] | null> {
  const [seller] = await db
    .select({ id: orgs.id })
    .from(orgs)
    .where(eq(orgs.slug, sellerSlug))
    .limit(1);
  if (!seller) return null;

  const rows = await db
    .select({
      method: endpoints.method,
      path: endpoints.pathOrTool,
      priceMicro: endpoints.priceMicro,
      freeQuota: endpoints.freeQuota,
      listingName: listings.name,
      listingDescription: listings.description,
    })
    .from(endpoints)
    .innerJoin(listings, eq(endpoints.listingId, listings.id))
    .where(
      and(
        eq(listings.sellerOrgId, seller.id),
        inArray(listings.kind, ["mcp", "both"]),
        inArray(endpoints.method, [...TOOL_METHODS]),
      ),
    )
    .orderBy(asc(listings.createdAt), asc(endpoints.createdAt), asc(endpoints.id));

  const used = new Set<string>();
  return rows.map((row) => {
    // Two paths can clean up to the same name (/a-b and /a_b), so number the later ones.
    const base = toolName(row.method, row.path);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base.slice(0, 120)}_${n}`;
    used.add(name);
    return {
      name,
      description: `${row.listingName} (${row.method} ${row.path}): ${row.listingDescription} ${priceText(row.priceMicro, row.freeQuota)}`,
      method: row.method,
      path: row.path,
    };
  });
}

const queryShape = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe('Query string parameters, for example {"product": "monitor-27"}.');
const bodyShape = z.unknown().optional().describe("The JSON request body.");

type ToolArgs = { query?: Record<string, string | number | boolean>; body?: unknown };

/** The gateway request a tool call stands for: autopay with the caller's Key. */
function gatewayRequest(
  deps: GatewayDeps,
  sellerSlug: string,
  tool: McpTool,
  args: ToolArgs,
  authorization: string,
): Request {
  const url = new URL(`${deps.config.appBaseUrl}/g/${sellerSlug}${tool.path}`);
  for (const [name, value] of Object.entries(args.query ?? {})) {
    url.searchParams.set(name, String(value));
  }
  const headers = new Headers({
    authorization,
    accept: "application/json",
    "X-Piko-Autopay": "true",
  });
  let body: string | undefined;
  if (METHODS_WITH_BODY.has(tool.method) && args.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(args.body);
  }
  return new Request(url, { method: tool.method, headers, body });
}

/**
 * Error codes Piko itself answers with, and their statuses (docs/API.md section 4). A
 * response is a Piko error only when both match, so an upstream's own error body passes
 * through as the upstream's.
 */
const PIKO_ERRORS: Record<string, number[]> = {
  invalid_key: [401],
  agent_frozen: [423],
  breaker_tripped: [429],
  policy_denied: [403],
  approval_pending: [202],
  budget_exceeded: [402],
  challenge_expired: [410],
  insufficient_funds: [402],
  invalid_request: [400],
  invalid_amount: [400],
  invalid_receipt: [402],
  not_found: [404],
  challenge_buyer_mismatch: [403],
  idempotent_replay: [409],
  idempotency_in_progress: [409],
  request_timeout: [408],
  upstream_failed: [502],
  internal_error: [500],
};

interface PikoError {
  code: string;
  message: string;
  [detail: string]: unknown;
}

function pikoError(status: number, text: string): PikoError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const error = (parsed as { error?: unknown } | null)?.error as Partial<PikoError> | undefined;
  if (typeof error?.code !== "string" || typeof error.message !== "string") return null;
  return PIKO_ERRORS[error.code]?.includes(status) ? (error as PikoError) : null;
}

function toolError(error: PikoError): CallToolResult {
  const { code, message, ...details } = error;
  const extra = Object.keys(details).length > 0 ? `\n${JSON.stringify(details)}` : "";
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}${extra}` }],
    structuredContent: { error },
  };
}

function settlementOf(response: Response): SettlementResponse | null {
  const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
  if (header === null) return null;
  return decodeHeaderValue(header) as SettlementResponse | null;
}

/** Turns the gateway's answer into a tool result. */
export async function toolResult(response: Response): Promise<CallToolResult> {
  const settlement = settlementOf(response);
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);

  if (!settlement?.success) {
    const error = pikoError(response.status, text);
    if (error) return toolError(error);
  }

  // Past this point the upstream answered: a paid Call (with a settlement) or a free one.
  const charged =
    settlement?.success && settlement.amount
      ? `Charged ${formatUsd(BigInt(settlement.amount))} via Piko (Call ${settlement.transaction}).`
      : "Free call via Piko: nothing was charged.";
  const content: CallToolResult["content"] = [];
  if (contentType.startsWith("image/")) {
    content.push({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: contentType.split(";")[0]!.trim(),
    });
  } else if (bytes.length > 0) {
    content.push({ type: "text", text });
  }
  const upstreamFailed = response.status >= 400;
  content.push({
    type: "text",
    text: upstreamFailed ? `The upstream API answered ${response.status}. ${charged}` : charged,
  });
  return { isError: upstreamFailed, content };
}

function buildServer(
  deps: GatewayDeps,
  sellerSlug: string,
  tools: McpTool[],
  authorization: string,
): McpServer {
  const server = new McpServer({ name: `piko-${sellerSlug}`, version: SERVER_VERSION });
  for (const tool of tools) {
    const inputSchema: z.ZodType<ToolArgs> = METHODS_WITH_BODY.has(tool.method)
      ? z.object({ query: queryShape, body: bodyShape })
      : z.object({ query: queryShape });
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema, annotations: { openWorldHint: true } },
      async (args) => {
        try {
          const request = gatewayRequest(deps, sellerSlug, tool, args, authorization);
          const response = await handleGatewayRequest(deps, request, {
            seller: sellerSlug,
            path: tool.path.split("/").filter(Boolean),
          });
          return await toolResult(response);
        } catch (error) {
          // Never hand the client an internal message (it can hold SQL or upstream details).
          console.error(`MCP tool ${tool.name} on ${sellerSlug} failed`, error);
          return toolError({
            code: "internal_error",
            message: "Something went wrong. Nothing was charged.",
          });
        }
      },
    );
  }
  return server;
}

/** Handles any method on `/mcp/{seller}`. */
export async function handleMcpRequest(
  deps: GatewayDeps,
  request: Request,
  sellerSlug: string,
): Promise<Response> {
  // Stateless: no standalone SSE stream (GET) and no session to end (DELETE).
  if (request.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const tools = await loadSellerTools(deps.db, sellerSlug);
  if (!tools) return jsonError(404, "not_found", `No seller '${sellerSlug}'.`);
  if (tools.length === 0) {
    return jsonError(404, "not_found", `Seller '${sellerSlug}' offers no MCP tools.`);
  }

  const auth = await authenticateRequest(deps.db, request.headers);
  if (!auth.ok) return jsonError(401, "invalid_key", "Missing, wrong or revoked key.");

  const server = buildServer(deps, sellerSlug, tools, request.headers.get("authorization")!);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
