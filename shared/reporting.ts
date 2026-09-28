import { z } from "zod";

export const reportFilter = z
  .strictObject({
    entityId: z.union([z.uuid(), z.literal("all")]),
    from: z.iso.date().refine((d) => d >= "1900-01-01", "Use 1900 or later."),
    to: z.iso.date(),
  })
  .refine((q) => q.from <= q.to, "Start date must not follow end date.");
export type ReportFilter = z.infer<typeof reportFilter>;
export interface AccountBalance {
  entity_id: string;
  entity_code: string;
  code: string;
  name: string;
  type: string;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
}
export interface AgedDocument {
  id: string;
  entity_id: string;
  entity_code: string;
  party_id: string;
  party: string;
  number: string;
  date: string;
  due_date: string;
  currency: string;
  outstanding: string;
  base: string;
  days: number;
  bucket: number;
}
export interface AgeingReport {
  documents: AgedDocument[];
  buckets: string[];
  total: string;
  control: string;
  difference: string;
}
export interface FinancialReport {
  filter: ReportFilter;
  generatedAt: string;
  entities: { id: string; code: string; name: string }[];
  accounts: AccountBalance[];
  income: string;
  expenses: string;
  profit: string;
  assets: string;
  liabilities: string;
  equity: string;
  earnings: string;
  balanceDifference: string;
  cash: {
    opening: string;
    closing: string;
    operating: string;
    investing: string;
    financing: string;
    workingCapital: string;
    capitalAdjustment: string;
    difference: string;
    unsupported: string[];
  };
  receivables: AgeingReport;
  payables: AgeingReport;
}
export const ageingLabels = [
  "Current",
  "1–30 days",
  "31–60 days",
  "61–90 days",
  "90+ days",
];
export function ageBucket(asOf: string, due: string) {
  const days = Math.floor(
    (Date.parse(asOf + "T00:00:00Z") - Date.parse(due + "T00:00:00Z")) /
      86400000,
  );
  return {
    days,
    bucket:
      days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4,
  };
}
export interface AccountDetail {
  account: { code: string; name: string; entity_code: string };
  opening: string;
  closing: string;
  debit: string;
  credit: string;
  total: number;
  lines: {
    id: string;
    journal_id: string;
    posted_on: string;
    description: string;
    source_type: string;
    source_id: string;
    debit: string;
    credit: string;
    balance: string;
  }[];
}
