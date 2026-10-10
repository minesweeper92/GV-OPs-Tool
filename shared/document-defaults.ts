import { z } from "zod";

export const paymentTerm = z
  .strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["days", "end-month"]),
    days: z.number().int().min(0).max(365),
  })
  .refine((t) => t.kind !== "end-month" || t.days === 0, {
    message: "End-of-month terms must use zero additional days.",
  });
export type PaymentTerm = z.infer<typeof paymentTerm>;
export const standardTerms: PaymentTerm[] = [
  { id: "receipt", name: "Due on receipt", kind: "days", days: 0 },
  ...[15, 30, 45, 60].map((days): PaymentTerm => ({
    id: `net${days}`,
    name: `Net ${days}`,
    kind: "days",
    days,
  })),
  { id: "month-end", name: "End of month", kind: "end-month", days: 0 },
];
const note = z.string().trim().max(4000);
export const salesDefaults = z
  .strictObject({
    terms: z.array(paymentTerm).min(1).max(50),
    default_term_id: z.string(),
    quote_valid_days: z.number().int().min(0).max(365).nullable(),
    quote_notes: note,
    quote_terms: note,
    invoice_notes: note,
    invoice_terms: note,
    payment_instructions: note,
  })
  .superRefine((s, ctx) => {
    if (
      new Set(s.terms.map((t) => t.id)).size !== s.terms.length ||
      new Set(s.terms.map((t) => t.name.toLocaleLowerCase())).size !==
        s.terms.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Payment term names and IDs must be unique.",
      });
    if (!s.terms.some((t) => t.id === s.default_term_id))
      ctx.addIssue({
        code: "custom",
        message: "Choose a default from the payment terms library.",
      });
  });
export type SalesDefaults = z.infer<typeof salesDefaults>;
export function initialSalesDefaults(): SalesDefaults {
  return {
    terms: standardTerms.map((t) => ({ ...t })),
    default_term_id: "net30",
    quote_valid_days: null,
    quote_notes: "",
    quote_terms: "",
    invoice_notes: "",
    invoice_terms: "",
    payment_instructions: "",
  };
}
export const defaultsCommands = [
  z.strictObject({
    action: z.literal("settings.sales-defaults"),
    entity_id: z.uuid(),
    version: z.number().int().min(0),
    request_key: z.uuid(),
    settings: salesDefaults,
  }),
] as const;
export interface DefaultsRecord {
  entity_id: string;
  version: number;
  settings: SalesDefaults;
}
export function defaultsFor(
  records: DefaultsRecord[] | undefined,
  entityId: string,
): SalesDefaults {
  return (
    records?.find((r) => r.entity_id === entityId)?.settings ??
    initialSalesDefaults()
  );
}
type CustomerDefaults = {
  payment_days?: number;
  payment_terms_mode?: "entity" | "days" | "end-month";
  document_notes?: string;
  payment_instructions?: string;
};
export function resolvePaymentTerm(
  settings: SalesDefaults,
  customer?: CustomerDefaults,
): PaymentTerm {
  // Old saved payment_days remain an explicit customer override until opted into entity defaults.
  const mode =
    customer?.payment_terms_mode ??
    (customer?.payment_days !== undefined ? "days" : "entity");
  if (mode === "end-month")
    return {
      id: "customer-month-end",
      name: "End of month",
      kind: "end-month",
      days: 0,
    };
  if (mode === "days") {
    const days = customer?.payment_days ?? 30;
    return {
      id: "customer-days",
      name: days ? `Net ${days}` : "Due on receipt",
      kind: "days",
      days,
    };
  }
  return settings.terms.find((t) => t.id === settings.default_term_id)!;
}
export function termDueDate(
  date: string,
  term: Pick<PaymentTerm, "kind" | "days">,
): string {
  if (!z.iso.date().safeParse(date).success) return "";
  const d = new Date(`${date}T12:00:00Z`);
  if (term.kind === "end-month") d.setUTCMonth(d.getUTCMonth() + 1, 0);
  else d.setUTCDate(d.getUTCDate() + term.days);
  return d.toISOString().slice(0, 10);
}
export function resolvedDefaults(
  settings: SalesDefaults,
  kind: "quote" | "invoice",
  date: string,
  customer?: CustomerDefaults,
) {
  const term = resolvePaymentTerm(settings, customer);
  return {
    term,
    terms: kind === "quote" ? settings.quote_terms : settings.invoice_terms,
    customer_notes:
      customer?.document_notes ||
      (kind === "quote" ? settings.quote_notes : settings.invoice_notes),
    payment_instructions:
      customer?.payment_instructions || settings.payment_instructions,
    payment_terms: term.name,
    valid_until:
      kind === "quote" && settings.quote_valid_days !== null
        ? termDueDate(date, { kind: "days", days: settings.quote_valid_days })
        : null,
  };
}
// Only replace a previously supplied default. Deliberate user edits (including clearing) survive.
export function replaceDefault<T>(current: T, previous: T, next: T): T {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, stable(v)]),
          )
        : value;
  return JSON.stringify(stable(current)) === JSON.stringify(stable(previous))
    ? next
    : current;
}
export function defaultDetails(value: ReturnType<typeof resolvedDefaults>) {
  return {
    customer_notes: value.customer_notes,
    payment_instructions: value.payment_instructions,
    payment_terms: value.payment_terms,
    payment_term: value.term,
    valid_until: value.valid_until,
  };
}
export function updateDefaultDetails<
  T extends Omit<ReturnType<typeof defaultDetails>, "payment_term"> & {
    payment_term: PaymentTerm | null;
  },
>(
  current: T,
  previous: ReturnType<typeof resolvedDefaults>,
  next: ReturnType<typeof resolvedDefaults>,
): T {
  const before = defaultDetails(previous),
    after = defaultDetails(next);
  return {
    ...current,
    ...Object.fromEntries(
      Object.keys(before).map((key) => {
        const k = key as keyof typeof before;
        return [key, replaceDefault(current[k], before[k], after[k])];
      }),
    ),
  };
}
