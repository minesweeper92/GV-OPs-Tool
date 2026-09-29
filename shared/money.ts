// All arithmetic uses integer minor units. Supported launch currencies have two decimals.
export const currencies = ["PKR", "USD", "AED", "EUR", "GBP"] as const;
export function scaled(value: string, decimals: number): bigint {
  if (!new RegExp(`^\\d{1,13}(?:\\.\\d{1,${decimals}})?$`).test(value))
    throw new Error(
      `Enter a positive decimal with at most ${decimals} decimal places.`,
    );
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"))
  );
}
export const minor = (value: string) => scaled(value, 2);
export const round = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator / 2n) / denominator;
export function baseAmount(amount: bigint, fx: bigint) {
  const result = round(amount * fx, 1_000_000n);
  if (amount < 0n || fx <= 0n || result > 9_000_000_000_000_000n)
    throw new RangeError(
      "The converted amount is outside the supported range. Check the amount and exchange rate.",
    );
  return result;
}
export function totals(
  lines: {
    description: string;
    quantity: string;
    price: string;
    tax: string;
    discount_type?: "percent" | "amount";
    discount?: string;
  }[],
) {
  let net = 0n,
    tax = 0n;
  const calculated = lines.map((line) => {
    const quantity = scaled(line.quantity, 3),
      rate = minor(line.price),
      bps = scaled(line.tax, 2);
    if (quantity <= 0n || bps > 10000n)
      throw new Error("Quantity must be positive and tax between 0 and 100%.");
    const gross = round(quantity * rate, 1000n);
    const discountValue = minor(line.discount || "0");
    if (line.discount_type !== "amount" && discountValue > 10000n)
      throw new Error("Percentage discount must be between 0 and 100%.");
    const discountMinor =
      line.discount_type === "amount"
        ? discountValue
        : round(gross * discountValue, 10000n);
    if (discountMinor > gross)
      throw new Error("Discount cannot exceed the line amount.");
    const subtotal = gross - discountMinor,
      taxMinor = round(subtotal * bps, 10000n);
    net += subtotal;
    tax += taxMinor;
    return {
      ...line,
      discountMinor: String(discountMinor),
      subtotal: String(subtotal),
      taxMinor: String(taxMinor),
    };
  });
  if (net + tax <= 0n || net + tax > 9_000_000_000_000_000n)
    throw new Error("Document total is outside the supported range.");
  return {
    lines: calculated,
    net: String(net),
    tax: String(tax),
    total: String(net + tax),
  };
}
