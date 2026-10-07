import { round } from "./money.ts";
// Historical-rate prepayments release their carrying amount proportionally;
// the final release clears every rounding residual exactly.
export function releasePrepayment(
  amount: bigint,
  available: bigint,
  carrying: bigint,
) {
  if (amount <= 0n || available <= 0n || amount > available || carrying < 0n)
    throw new Error("Enter an amount within the available advance balance.");
  return round(carrying * amount, available);
}
// A non-monetary purchase prepayment does not become a settlement FX gain.
// The bill's cost/asset is adjusted to the advance's historical carrying value.
// Signed positive values are credits (reductions) to the original cost account.
export function prepaymentCostAdjustment(
  lines: { account_code: string; subtotal: string; taxMinor: string }[],
  treatment: string,
  difference: bigint,
) {
  const weights = new Map<string, bigint>();
  for (const l of lines)
    weights.set(
      l.account_code,
      (weights.get(l.account_code) || 0n) +
        BigInt(l.subtotal) +
        (treatment === "expense" ? BigInt(l.taxMinor) : 0n),
    );
  const total = [...weights.values()].reduce((a, b) => a + b, 0n);
  if (total <= 0n)
    throw new Error(
      "The bill needs a positive cost basis before an advance can be applied.",
    );
  let cumulative = 0n,
    allocated = 0n;
  const sign = difference < 0n ? -1n : 1n,
    absolute = difference < 0n ? -difference : difference;
  return [...weights]
    .filter(([, w]) => w > 0n)
    .map(([account, w]) => {
      cumulative += w;
      const n = round(absolute * cumulative, total) - allocated;
      allocated += n;
      return { account, amount_minor: String(n * sign) };
    })
    .filter((a) => a.amount_minor !== "0");
}
