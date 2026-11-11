import { randomUUID } from "node:crypto";
import { getEnv } from "../env";

export const PAYPAL_BASE_URL = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

/** A PayPal call that failed. `message` is readable; `debugId` is what PayPal support asks for. */
export class PayPalError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly name_: string | undefined,
    public readonly debugId: string | undefined,
    public readonly issues: string[],
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export interface PayPalClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface RequestOptions {
  body?: unknown;
  /**
   * Sent as `PayPal-Request-Id` on every write. PayPal replays the first answer for a
   * repeated id, so pass a stable one when a retry must not repeat the effect.
   */
  requestId?: string;
}

/** Refresh a token this long before it expires, so a request never carries a dying one. */
const TOKEN_SKEW_MS = 60_000;

export class PayPalClient {
  private token: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: PayPalClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_SKEW_MS > this.now()) {
      return Promise.resolve(this.token.value);
    }
    // Concurrent callers share one token request.
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret, baseUrl } = this.options;
    const response = await this.fetchImpl(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!response.ok || !body.access_token) {
      throw await toError(response, body, "PayPal rejected the client id and secret");
    }
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + (body.expires_in ?? 300) * 1000,
    };
    return body.access_token;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const isWrite = method !== "GET";
    const send = async (token: string) =>
      this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(isWrite ? { "PayPal-Request-Id": options.requestId ?? randomUUID() } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

    let response = await send(await this.accessToken());
    if (response.status === 401) {
      // The token was revoked or expired early: fetch a new one and try once more.
      this.token = undefined;
      response = await send(await this.accessToken());
    }
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) throw await toError(response, body, `PayPal ${method} ${path} failed`);
    return body as T;
  }
}

async function toError(response: Response, body: unknown, fallback: string): Promise<PayPalError> {
  const b = (body ?? {}) as {
    name?: string;
    error?: string;
    message?: string;
    error_description?: string;
    debug_id?: string;
    details?: Array<{ issue?: string; description?: string }>;
  };
  const issues = (b.details ?? []).map((d) => [d.issue, d.description].filter(Boolean).join(": "));
  const reason = b.message ?? b.error_description ?? b.error ?? response.statusText;
  const message = [`${fallback} (${response.status}): ${reason}`, ...issues].join(". ");
  return new PayPalError(message, response.status, b.name ?? b.error, b.debug_id, issues);
}

const globalForPayPal = globalThis as typeof globalThis & { __pikoPayPal?: PayPalClient };

/** The app's PayPal client, built from PAYPAL_ENV and the sandbox credentials. */
export function getPayPal(): PayPalClient {
  const env = getEnv();
  globalForPayPal.__pikoPayPal ??= new PayPalClient({
    baseUrl: PAYPAL_BASE_URL[env.PAYPAL_ENV],
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
  });
  return globalForPayPal.__pikoPayPal;
}
