/**
 * Money helpers. Every amount is integer micro-USD held in a bigint (1 USD = 1,000,000;
 * see docs/decisions/0009). Dollars exist only at the edges: parseUsd reads what a person
 * typed, formatUsd shows an amount. Neither goes through a JavaScript number, so no float
 * ever touches an amount.
 */

/** An amount in integer micro-USD. */
export type MicroUsd = bigint;

export const MICRO_PER_USD = 1_000_000n;

/** Basis points in a whole: a fee of 500 bps is 5%. */
export const BPS_DENOMINATOR = 10_000n;

const MICRO_DIGITS = 6;

// Optional minus, optional $, whole dollars (commas allowed in groups of three), then up to
// six decimal places. "$1,234.50", "0.002", ".5" and "-3" match; "1e3" and "1.2345678" don't.
const USD_PATTERN = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/;

/**
 * Reads a dollar amount a person typed, such as a top-up of "$25" or a policy limit of
 * "0.05", into micro-USD. Takes a string, never a number, so the value is exact.
 *
 * @throws RangeError when the text isn't a dollar amount or has more than six decimals.
 */
export function parseUsd(text: string): MicroUsd {
  const match = USD_PATTERN.exec(text.trim());
  const [, minus, whole = "", fraction = ""] = match ?? [];
  if (!match || (whole === "" && fraction === "")) {
    throw new RangeError(`"${text}" is not a dollar amount.`);
  }
  if (fraction.length > MICRO_DIGITS) {
    throw new RangeError(`"${text}" has more than ${MICRO_DIGITS} decimal places.`);
  }

  const micro =
    BigInt(whole.replaceAll(",", "") || "0") * MICRO_PER_USD +
    BigInt(fraction.padEnd(MICRO_DIGITS, "0"));
  return minus ? -micro : micro;
}

/**
 * Shows micro-USD as dollars, for display only: at least two decimals and no trailing
 * zeros past them, so per-call prices stay readable. 2000n is "$0.002", 1_000_000n is
 * "$1.00", 1_234_567_800n is "$1,234.5678" and -500_000n is "-$0.50".
 */
export function formatUsd(micro: MicroUsd): string {
  const sign = micro < 0n ? "-" : "";
  const abs = micro < 0n ? -micro : micro;
  const whole = (abs / MICRO_PER_USD).toString().replace(/\B(?=(\d{3})+$)/g, ",");
  const fraction = (abs % MICRO_PER_USD)
    .toString()
    .padStart(MICRO_DIGITS, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${sign}$${whole}.${fraction}`;
}

export interface PriceSplit {
  sellerMicro: MicroUsd;
  platformMicro: MicroUsd;
}

/**
 * Splits a Call's price between the seller and the platform fee (PLATFORM_FEE_BPS). The
 * seller's share rounds down and the platform gets the remainder, so the two always add
 * up to the price exactly. At 5%, 3 micro-USD is 2 to the seller and 1 to the platform.
 *
 * @throws RangeError when the price is negative or the fee isn't 0 to 10,000 bps.
 */
export function splitPrice(priceMicro: MicroUsd, feeBps: bigint): PriceSplit {
  if (priceMicro < 0n) throw new RangeError("A price can't be negative.");
  if (feeBps < 0n || feeBps > BPS_DENOMINATOR) {
    throw new RangeError(`A fee must be 0 to ${BPS_DENOMINATOR} bps, not ${feeBps}.`);
  }
  const sellerMicro = (priceMicro * (BPS_DENOMINATOR - feeBps)) / BPS_DENOMINATOR;
  return { sellerMicro, platformMicro: priceMicro - sellerMicro };
}
