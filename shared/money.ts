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
  documentDiscount: { type: "percent" | "amount"; amount: string } = {
    type: "percent",
    amount: "0",
  },
) {
  const preliminary = lines.map((line) => {
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
    return { line, discountMinor, subtotal: gross - discountMinor, bps };
  });
  const beforeDiscount = preliminary.reduce(
    (sum, row) => sum + row.subtotal,
    0n,
  );
  const entered =
    documentDiscount.type === "percent"
      ? scaled(documentDiscount.amount, 2)
      : minor(documentDiscount.amount);
  if (documentDiscount.type === "percent" && entered > 10000n)
    throw new Error("Document discount cannot exceed 100%.");
  const documentDiscountMinor =
    documentDiscount.type === "percent"
      ? round(beforeDiscount * entered, 10000n)
      : entered;
  if (documentDiscountMinor >= beforeDiscount)
    throw new Error("Document discount must leave a positive item subtotal.");
  let weight = 0n,
    assigned = 0n,
    net = 0n,
    tax = 0n;
  const calculated = preliminary.map(
    ({ line, discountMinor, subtotal, bps }) => {
      weight += subtotal;
      const cumulative = round(documentDiscountMinor * weight, beforeDiscount);
      const allocated = cumulative - assigned;
      assigned = cumulative;
      const discountedSubtotal = subtotal - allocated;
      const taxMinor = round(discountedSubtotal * bps, 10000n);
      net += discountedSubtotal;
      tax += taxMinor;
      return {
        ...line,
        discountMinor: String(discountMinor + allocated),
        documentDiscountMinor: String(allocated),
        subtotal: String(discountedSubtotal),
        taxMinor: String(taxMinor),
      };
    },
  );
  if (net + tax <= 0n || net + tax > 9_000_000_000_000_000n)
    throw new Error("Document total is outside the supported range.");
  return {
    lines: calculated,
    net: String(net),
    tax: String(tax),
    total: String(net + tax),
    beforeDiscount: String(beforeDiscount),
    documentDiscountMinor: String(documentDiscountMinor),
  };
}
