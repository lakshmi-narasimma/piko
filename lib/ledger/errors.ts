export type LedgerErrorCode =
  | "invalid_amount"
  | "org_not_found"
  | "call_already_posted"
  | "call_not_posted"
  | "call_already_refunded"
  | "insufficient_funds"
  | "challenge_not_found"
  | "challenge_expired"
  | "challenge_consumed"
  | "challenge_already_reserved"
  | "reservation_not_active";

/** An expected failure of a Ledger operation. Branch on `code`. */
export class LedgerError extends Error {
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** The buyer can't cover a reservation. The pay pipeline maps this to 402. */
export class InsufficientFundsError extends LedgerError {
  constructor(
    public readonly requiredMicro: bigint,
    public readonly availableMicro: bigint,
  ) {
    super(
      "insufficient_funds",
      `Needs ${requiredMicro} micro-USD but only ${availableMicro} is available.`,
    );
    this.name = "InsufficientFundsError";
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";
const ONCE_PER_EVENT_INDEX = "ledger_entries_once_per_event";

/** True when an insert hit the index that stops one event posting twice to an account. */
export function isDuplicateEvent(error: unknown): boolean {
  // drizzle wraps driver errors, so look through `cause` for the Postgres error.
  for (let e = error; e instanceof Error; e = e.cause) {
    const { code, constraint } = e as Error & { code?: string; constraint?: string };
    if (code === POSTGRES_UNIQUE_VIOLATION && constraint === ONCE_PER_EVENT_INDEX) return true;
  }
  return false;
}
