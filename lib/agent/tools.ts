/**
 * The tools the playground agent can use: search the Directory, call a paid endpoint through
 * the real x402 gateway with the agent's own Key, and check what is left to spend.
 *
 * The agent is told its Task budget and the tools refuse to start a call that would cross it,
 * but that is only the agent keeping to its word. Piko's own enforcement (Budgets, Policies,
 * the breaker) lives in the pay pipeline and does not depend on the model (docs/DESIGN.md 9).
 * Every result says what the call cost, so the model can reason about price.
 */
import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client";
import { searchDirectory, type EmbeddingLlm } from "../directory";
import { gatewayConfigFromEnv, handleGatewayRequest } from "../gateway";
import { AUTOPAY_HEADER } from "../gateway/forward";
import { findRoute } from "../gateway/route";
import { balanceOf } from "../ledger";
import { formatUsd } from "../money";

/** Where the agent's answers stop being useful: a model doesn't need a megabyte of JSON. */
const MAX_BODY_CHARS = 4000;

export interface AgentToolContext {
  /** The agent's own Key. It stays server-side and is never shown to the model. */
  key: string;
  baseUrl: string;
  taskBudgetMicro: bigint;
  /**
   * What this task has paid, and what calls still in flight have set aside. The tools update
   * both. A call reserves its price before it awaits anything, so parallel tool calls from one
   * model step can't all pass the budget check on the same remaining amount.
   */
  state: { spentMicro: bigint; reservedMicro: bigint };
  search(query: string, limit: number): ReturnType<typeof searchDirectory>;
  /** The list price of an endpoint, or null if there is no such endpoint. */
  lookupPrice(seller: string, method: string, path: string): Promise<bigint | null>;
  walletBalance(): Promise<bigint>;
  /** Sends a request through the gateway. Tests replace it. */
  send(request: Request, params: { seller: string; path: string[] }): Promise<Response>;
}

/** The real wiring: Directory search, the route table, the Ledger and the in-process gateway. */
export function createToolContext(input: {
  db: Db;
  llm: EmbeddingLlm;
  key: string;
  orgId: string;
  baseUrl: string;
  taskBudgetMicro: bigint;
}): AgentToolContext {
  const { db, llm, key, orgId, baseUrl, taskBudgetMicro } = input;
  return {
    key,
    baseUrl,
    taskBudgetMicro,
    state: { spentMicro: 0n, reservedMicro: 0n },
    search: (query, limit) => searchDirectory(db, llm, { query, buyerOrgId: orgId, limit }),
    lookupPrice: async (seller, method, path) =>
      (await findRoute(db, seller, method, path))?.priceMicro ?? null,
    walletBalance: () => balanceOf(db, { type: "wallet", orgId }),
    send: (request, params) =>
      handleGatewayRequest({ db, config: gatewayConfigFromEnv() }, request, params),
  };
}

const usd = (micro: bigint) => formatUsd(micro);

/** Spent plus reserved: what the task has committed, settled or not. */
function committed(ctx: AgentToolContext): bigint {
  return ctx.state.spentMicro + ctx.state.reservedMicro;
}

function remaining(ctx: AgentToolContext): bigint {
  const left = ctx.taskBudgetMicro - committed(ctx);
  return left > 0n ? left : 0n;
}

function settledAmount(response: Response): bigint {
  const header = response.headers.get("PAYMENT-RESPONSE");
  if (!header) return 0n;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      success?: boolean;
      amount?: string;
    };
    return decoded.success && decoded.amount ? BigInt(decoded.amount) : 0n;
  } catch {
    return 0n;
  }
}

export function createAgentTools(ctx: AgentToolContext) {
  return {
    search_directory: tool({
      description:
        "Search the Piko directory of paid APIs. Returns each API's name, what it does, its " +
        "rating, and the price per call of every endpoint. Search before you spend.",
      inputSchema: z.object({
        query: z.string().describe("What you need, in plain words, e.g. 'product prices'."),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      execute: async ({ query, limit }) => {
        const results = await ctx.search(query, limit ?? 5);
        return {
          costMicro: "0",
          cost: usd(0n),
          results: results.map((r) => ({
            name: r.name,
            description: r.description,
            rating: r.rating,
            seller: r.seller.name,
            endpoints: r.endpoints.map((e) => ({
              method: e.method,
              seller: r.seller.slug,
              path: e.path,
              price: e.price,
              priceMicro: e.priceMicro.toString(),
            })),
          })),
        };
      },
    }),

    call_api: tool({
      description:
        "Call one paid endpoint. Piko charges the price from your wallet, so only call what you " +
        "need. Use the seller, method and path exactly as search_directory returned them.",
      inputSchema: z.object({
        seller: z.string().describe("The seller slug from the search results."),
        path: z.string().describe("The endpoint path, e.g. /history."),
        method: z.enum(["GET", "POST"]).default("GET"),
        query: z.record(z.string(), z.string()).optional().describe("Query string parameters."),
        body: z.unknown().optional().describe("JSON body for POST."),
      }),
      execute: async ({ seller, path, method, query, body }) => {
        const price = await ctx.lookupPrice(seller, method, path);
        if (price === null) {
          return fail("no_such_endpoint", `No ${method} ${path} on ${seller}.`);
        }
        // Check and reserve with no await in between, so parallel calls see each other.
        const left = remaining(ctx);
        if (price > left) {
          return fail(
            "over_task_budget",
            `This costs ${usd(price)} but only ${usd(left)} of the task budget is left. Nothing was charged.`,
          );
        }
        ctx.state.reservedMicro += price;

        const url = new URL(`/g/${seller}${path}`, ctx.baseUrl);
        for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${ctx.key}`,
          [AUTOPAY_HEADER]: "true",
        };
        // A GET can't carry a body (new Request would throw), so a model-supplied one is dropped.
        const sendBody = method === "GET" || body === undefined ? undefined : JSON.stringify(body);
        if (sendBody !== undefined) headers["Content-Type"] = "application/json";

        let paid = 0n;
        let response: Response;
        try {
          response = await ctx.send(new Request(url, { method, headers, body: sendBody }), {
            seller,
            path: path.split("/").filter(Boolean),
          });
          paid = settledAmount(response);
        } finally {
          // One synchronous block: the reservation becomes what was actually paid (0 on a throw).
          ctx.state.reservedMicro -= price;
          ctx.state.spentMicro += paid;
        }

        const text = (await response.text()).slice(0, MAX_BODY_CHARS);
        if (!response.ok) {
          const code = errorCode(text) ?? `http_${response.status}`;
          return { ...fail(code, errorMessage(text) ?? `HTTP ${response.status}`), ...cost(paid) };
        }
        return { ok: true as const, status: response.status, body: parseBody(text), ...cost(paid) };
      },
    }),

    check_budget: tool({
      description: "How much of this task's budget is left, and the wallet balance.",
      inputSchema: z.object({}),
      execute: async () => ({
        taskBudgetMicro: ctx.taskBudgetMicro.toString(),
        // Spent includes calls still in flight, so this never shows more left than there is.
        spentMicro: committed(ctx).toString(),
        remainingMicro: remaining(ctx).toString(),
        remaining: usd(remaining(ctx)),
        spent: usd(committed(ctx)),
        walletBalance: usd(await ctx.walletBalance()),
        costMicro: "0",
        cost: usd(0n),
      }),
    }),
  };
}

export type AgentTools = ReturnType<typeof createAgentTools>;

function cost(micro: bigint) {
  return { costMicro: micro.toString(), cost: usd(micro) };
}

function fail(code: string, message: string) {
  return { ok: false as const, error: code, message, ...cost(0n) };
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorCode(text: string): string | null {
  const body = parseBody(text) as { error?: { code?: string } };
  return typeof body === "object" && body !== null ? (body.error?.code ?? null) : null;
}

function errorMessage(text: string): string | null {
  const body = parseBody(text) as { error?: { message?: string } };
  return typeof body === "object" && body !== null ? (body.error?.message ?? null) : null;
}
