import { z } from "zod";
import { minor } from "./money.ts";

// Customer receipts: one bank movement from one customer, allocated over
// several invoices, with any remainder held as unapplied customer cash.
const id = z.uuid(),
  date = z.iso.date(),
  money = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  fx = z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
  text = z.string().trim().min(1).max(200),
  currency = z.enum(["PKR", "USD", "AED", "EUR", "GBP"]);

export const receiptAllocation = z.strictObject({
  invoice_id: id,
  amount: money,
  wht: money,
  sales_tax_withheld: money,
});

export const customerReceiptCommands = [
  z.strictObject({
    action: z.literal("customer-receipt.create"),
    entity_id: id,
    company_id: id,
    currency,
    bank_account_id: id.nullable().optional(),
    date,
    // Cash the customer paid. The bank fee is what the bank kept from it.
    amount: money,
    fee: money,
    fx,
    reference: text,
    notes: z.string().trim().max(1000).default(""),
    allocations: z.array(receiptAllocation).max(100),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("customer-receipt.apply"),
    receipt_id: id,
    invoice_id: id,
    date,
    amount: money,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("customer-receipt.refund"),
    receipt_id: id,
    bank_account_id: id.nullable().optional(),
    date,
    amount: money,
    fx,
    reference: text,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("customer-receipt.reverse"),
    id,
    date,
    reason: text,
  }),
  z.strictObject({
    action: z.literal("customer-receipt.reverse-application"),
    id,
    date,
    reason: text,
  }),
  z.strictObject({
    action: z.literal("customer-receipt.reverse-refund"),
    id,
    date,
    reason: text,
  }),
] as const;

export interface CustomerReceipt {
  id: string;
  entity_id: string;
  company_id: string;
  customer_name: string;
  currency: string;
  receipt_date: string;
  amount_minor: string;
  wht_minor: string;
  sales_tax_withheld_minor: string;
  fee_minor: string;
  unapplied_minor: string;
  // Unapplied cash still available after later applications and refunds.
  available_minor: string;
  fx_micros: string;
  bank_account_id: string | null;
  reference: string;
  notes: string;
  reversal_date: string | null;
  reversal_reason: string | null;
}
export interface CustomerReceiptAllocation {
  id: string;
  receipt_id: string;
  invoice_id: string;
  amount_minor: string;
  wht_minor: string;
  sales_tax_withheld_minor: string;
}
export interface CustomerReceiptApplication {
  id: string;
  receipt_id: string;
  invoice_id: string;
  application_date: string;
  amount_minor: string;
  reversal_date: string | null;
  reversal_reason: string | null;
}
export interface CustomerReceiptRefund {
  id: string;
  receipt_id: string;
  refund_date: string;
  amount_minor: string;
  fx_micros: string;
  bank_account_id: string | null;
  reference: string;
  reversal_date: string | null;
  reversal_reason: string | null;
}

// Oldest invoices first, by due date then number. A suggestion only: people
// edit it, and the server validates whatever is finally submitted.
export function suggestAllocations(
  cash: bigint,
  invoices: { id: string; due_date: string; number: string; balance: bigint }[],
) {
  let left = cash;
  return [...invoices]
    .sort(
      (a, b) =>
        a.due_date.localeCompare(b.due_date) ||
        a.number.localeCompare(b.number),
    )
    .map((i) => {
      const take = left < i.balance ? left : i.balance;
      left -= take;
      return { invoice_id: i.id, amount: take };
    })
    .filter((a) => a.amount > 0n);
}

export interface ReceiptTotals {
  cash: bigint;
  fee: bigint;
  allocatedCash: bigint;
  wht: bigint;
  salesTax: bigint;
  unapplied: bigint;
  bank: bigint;
}
// Shared by the review screen and the server so both explain the same numbers.
export function receiptTotals(c: {
  amount: string;
  fee: string;
  allocations: { amount: string; wht: string; sales_tax_withheld: string }[];
}): ReceiptTotals {
  const cash = minor(c.amount),
    fee = minor(c.fee),
    allocatedCash = c.allocations.reduce((s, a) => s + minor(a.amount), 0n),
    wht = c.allocations.reduce((s, a) => s + minor(a.wht), 0n),
    salesTax = c.allocations.reduce(
      (s, a) => s + minor(a.sales_tax_withheld),
      0n,
    );
  return {
    cash,
    fee,
    allocatedCash,
    wht,
    salesTax,
    unapplied: cash - allocatedCash,
    bank: cash - fee,
  };
}
export function receiptProblem(c: Parameters<typeof receiptTotals>[0]) {
  const t = receiptTotals(c);
  if (t.cash + t.wht + t.salesTax <= 0n)
    return "Enter the cash received or the tax the customer withheld.";
  if (t.fee > t.cash) return "The bank fee cannot exceed the cash received.";
  if (t.allocatedCash > t.cash)
    return "Invoices are allocated more cash than was received.";
  if (
    c.allocations.some(
      (a) => minor(a.amount) + minor(a.wht) + minor(a.sales_tax_withheld) <= 0n,
    )
  )
    return "Remove invoices with nothing allocated.";
  return null;
}
