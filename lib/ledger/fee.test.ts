import { describe, expect, it } from "vitest";
import { splitPrice } from "./fee";

describe("splitPrice", () => {
  it("splits an even price at 5%", () => {
    expect(splitPrice(2000n, 500n)).toEqual({ sellerMicro: 1900n, platformMicro: 100n });
  });

  it("rounds the seller down and gives the platform the remainder", () => {
    expect(splitPrice(3n, 500n)).toEqual({ sellerMicro: 2n, platformMicro: 1n });
    expect(splitPrice(1n, 500n)).toEqual({ sellerMicro: 0n, platformMicro: 1n });
  });

  it("handles no fee and a full fee", () => {
    expect(splitPrice(7n, 0n)).toEqual({ sellerMicro: 7n, platformMicro: 0n });
    expect(splitPrice(7n, 10_000n)).toEqual({ sellerMicro: 0n, platformMicro: 7n });
  });

  it("stays exact above the safe integer range", () => {
    const price = 9_007_199_254_740_993n;
    const { sellerMicro, platformMicro } = splitPrice(price, 500n);
    expect(sellerMicro).toBe(8_556_839_292_003_943n);
    expect(sellerMicro + platformMicro).toBe(price);
  });
});
