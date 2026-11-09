const BPS_DENOMINATOR = 10_000n;

// Moves to the money helpers when P1-02 lands.
export function splitPrice(priceMicro: bigint, feeBps: bigint) {
  const sellerMicro = (priceMicro * (BPS_DENOMINATOR - feeBps)) / BPS_DENOMINATOR;
  return { sellerMicro, platformMicro: priceMicro - sellerMicro };
}
