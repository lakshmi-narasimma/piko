import { describe, expect, it } from "vitest";
import { formatUsd, parseUsd, splitPrice } from ".";

describe("splitPrice", () => {
  it("splits an even price at 5%", () => {
    expect(splitPrice(2000n, 500n)).toEqual({ sellerMicro: 1900n, platformMicro: 100n });
    expect(splitPrice(1_000_000n, 500n)).toEqual({
      sellerMicro: 950_000n,
      platformMicro: 50_000n,
    });
  });

  it("rounds the seller down and gives the platform the remainder", () => {
    expect(splitPrice(3n, 500n)).toEqual({ sellerMicro: 2n, platformMicro: 1n });
    expect(splitPrice(1n, 500n)).toEqual({ sellerMicro: 0n, platformMicro: 1n });
    expect(splitPrice(2001n, 500n)).toEqual({ sellerMicro: 1900n, platformMicro: 101n });
  });

  it("always adds back up to the price", () => {
    for (let price = 0n; price <= 500n; price++) {
      for (const fee of [0n, 1n, 250n, 500n, 3333n, 9999n, 10_000n]) {
        const { sellerMicro, platformMicro } = splitPrice(price, fee);
        expect(sellerMicro + platformMicro).toBe(price);
        expect(sellerMicro).toBeGreaterThanOrEqual(0n);
        expect(platformMicro).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it("handles a zero price, no fee and a full fee", () => {
    expect(splitPrice(0n, 500n)).toEqual({ sellerMicro: 0n, platformMicro: 0n });
    expect(splitPrice(7n, 0n)).toEqual({ sellerMicro: 7n, platformMicro: 0n });
    expect(splitPrice(7n, 10_000n)).toEqual({ sellerMicro: 0n, platformMicro: 7n });
  });

  it("stays exact above the safe integer range", () => {
    const price = 9_007_199_254_740_993n;
    const { sellerMicro, platformMicro } = splitPrice(price, 500n);
    expect(sellerMicro).toBe(8_556_839_292_003_943n);
    expect(sellerMicro + platformMicro).toBe(price);
  });

  it("rejects a negative price and an out-of-range fee", () => {
    expect(() => splitPrice(-1n, 500n)).toThrow(RangeError);
    expect(() => splitPrice(100n, -1n)).toThrow(RangeError);
    expect(() => splitPrice(100n, 10_001n)).toThrow(RangeError);
  });
});

describe("parseUsd", () => {
  it.each([
    ["0", 0n],
    ["25", 25_000_000n],
    ["$25", 25_000_000n],
    ["0.002", 2000n],
    ["$0.000001", 1n],
    [".5", 500_000n],
    ["5.", 5_000_000n],
    ["1,234.56", 1_234_560_000n],
    ["  $10.00 ", 10_000_000n],
    ["-0.50", -500_000n],
    ["-$3", -3_000_000n],
  ])("reads %j as %s micro-USD", (text, micro) => {
    expect(parseUsd(text)).toBe(micro);
  });

  it("stays exact where a float would not", () => {
    expect(parseUsd("0.1") + parseUsd("0.2")).toBe(parseUsd("0.3"));
    expect(parseUsd("90071992547.409993")).toBe(90_071_992_547_409_993n);
  });

  it.each(["", "$", ".", "abc", "1e3", "1.2.3", "1,23", "12,34.5", "--1", "$-1", "0x10", "1 000"])(
    "rejects %j",
    (text) => {
      expect(() => parseUsd(text)).toThrow(RangeError);
    },
  );

  it("rejects more than six decimal places instead of rounding", () => {
    expect(() => parseUsd("0.0000001")).toThrow(/more than 6 decimal places/);
  });
});

describe("formatUsd", () => {
  it.each([
    [0n, "$0.00"],
    [1n, "$0.000001"],
    [2000n, "$0.002"],
    [500_000n, "$0.50"],
    [1_000_000n, "$1.00"],
    [1_234_567_800n, "$1,234.5678"],
    [1_000_000_000_000n, "$1,000,000.00"],
    [-500_000n, "-$0.50"],
    [-2000n, "-$0.002"],
  ])("shows %s micro-USD as %j", (micro, text) => {
    expect(formatUsd(micro)).toBe(text);
  });

  it("round-trips with parseUsd", () => {
    for (const micro of [0n, 1n, 2000n, 999_999n, 1_000_001n, 123_456_789_012n, -42n]) {
      expect(parseUsd(formatUsd(micro))).toBe(micro);
    }
  });
});
