import { z } from "zod";
import { reportFilter, type AgedDocument } from "./reporting.ts";

export const statementFilter = reportFilter.safeExtend({
  companyId: z.uuid(),
  kind: z.enum(["customer", "vendor"]),
});
export type StatementFilter = z.infer<typeof statementFilter>;
export interface StatementEntry {
  id: string;
  date: string;
  type: string;
  number: string;
  description: string;
  amount: string;
  base: string;
  balance: string;
  baseBalance: string;
  link_type:
    "invoice" | "bill" | "credit" | "vendor-credits" | "vendor-payments";
  link_id: string;
}
export interface StatementGroup {
  entity_id: string;
  entity_code: string;
  entity_name: string;
  currency: string;
  opening: string;
  closing: string;
  openingBase: string;
  closingBase: string;
  increases: string;
  decreases: string;
  outstanding: string;
  availableCredit: string;
  entries: StatementEntry[];
  documents: AgedDocument[];
}
export interface PartyStatement {
  filter: StatementFilter;
  generatedAt: string;
  company: { id: string; name: string; address: string; tax_id: string };
  groups: StatementGroup[];
}
