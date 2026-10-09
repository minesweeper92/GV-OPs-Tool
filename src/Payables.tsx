import { useState, useRef, useEffect, lazy, Suspense } from "react";
import { ContactCompanyField } from "./ContactCompanyField";
import { hasCapability } from "../shared/permissions";
import {
  approvalPlan,
  approvalTiers,
  billReviewDecision,
  tierProblem,
  type ApprovalRole,
} from "../shared/bill-approval";
import { minor } from "../shared/money";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import {
  Heading,
  Table,
  Field,
  Drawer,
  ErrorBox,
  Badge,
  Empty,
  ConfirmationDialog,
} from "./components";
import { Timeline } from "./Records";
import { BankSelect } from "./Banking";
import {
  request,
  day,
  today,
  money,
  decimal,
  rate,
  type Data,
  type Me,
  type Bill,
  type VendorPayment,
  type Line,
  type Event,
} from "./model";
import { totals } from "../shared/money";
import { openRemittanceAdvice } from "./remittanceAdvice";
import { z } from "zod";
import {
  clearBrowserDraft,
  draftLines,
  readBrowserDraft,
  writeBrowserDraft,
} from "./browserDraft";
const VendorPaymentBatches = lazy(() =>
  import("./VendorPaymentBatches").then((m) => ({
    default: m.VendorPaymentBatches,
  })),
);

const billDraft = z.object({
  savedAt: z.number(),
  selectedEntity: z.string(),
  vendor: z.string(),
  project: z.string(),
  currency: z.string(),
  fx: z.string(),
  taxTreatment: z.enum(["expense", "recoverable"]),
  lines: z
    .array(draftLines.element.extend({ account_code: z.string() }))
    .max(500),
  requestKey: z.uuid(),
  fields: z.object({
    reference: z.string(),
    bill_date: z.string(),
    due_date: z.string(),
    notes: z.string(),
    acknowledge_duplicate: z.boolean(),
  }),
});

const accounts = [
  ["5000", "Operating expenses"],
  ["5200", "Project production costs"],
  ["1400", "Prepayments"],
  ["1500", "Equipment"],
] as const;
const balance = (b: Bill) =>
  BigInt(b.total_minor) - BigInt(b.paid_minor) - BigInt(b.credited_minor);
function status(b: Bill) {
  if (b.status === "Paid" && BigInt(b.credited_minor) > 0n) return "Settled";
  return b.status === "Open"
    ? b.due_date < today()
      ? "Overdue"
      : BigInt(b.paid_minor) > 0n
        ? "Partially paid"
        : "Open"
    : b.status;
}
type Editor = {
  kind: "create" | "edit" | "pay" | "void" | "return" | "reverse";
  bill?: Bill;
  payment?: VendorPayment;
};
export function Payables({
  data,
  me,
  entity,
  view,
  id,
  newVendor,
  list,
  setList,
  rememberPosition,
}: {
  data: Data;
  me: Me;
  entity: string;
  view: string;
  id?: string;
  newVendor: () => void;
  list: { filter: string; search: string };
  setList: (value: { filter: string; search: string }) => void;
  rememberPosition: () => void;
}) {
  const cache = useQueryClient(),
    [editor, setEditor] = useState<Editor | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const { filter, search } = list;
  const setFilter = (filter: string) => setList({ ...list, filter });
  const setSearch = (search: string) => setList({ ...list, search });
  const [posting, setPosting] = useState<Bill | null>(null);
  const [notice, setNotice] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const bills = (data.bills || []).filter(
      (b) => entity === "all" || b.entity_id === entity,
    ),
    payments = data.vendorPayments || [];
  const canPost = hasCapability(me.user, "books.post"),
    canAddVendor = hasCapability(me.user, "contacts.manage"),
    canManageRules = hasCapability(me.user, "team.manage");
  const review = (b: Bill) =>
    billReviewDecision(
      me.user,
      me.user.id,
      b,
      data.entities.find((e) => e.id === b.entity_id),
    );
  const pending = bills.filter((b) => b.status === "Pending approval");
  const ready = pending.filter((b) => review(b).allowed);
  async function save(c: Record<string, unknown>) {
    const result = await request<{ id: string }>(
      "commands",
      "POST",
      c,
      me.csrf,
    );
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["data"] }),
      cache.invalidateQueries({ queryKey: ["report"] }),
      cache.invalidateQueries({ queryKey: ["financial-report"] }),
      cache.invalidateQueries({ queryKey: ["financial-detail"] }),
      cache.invalidateQueries({ queryKey: ["banking"] }),
    ]);
    return result;
  }
  async function action(b: Bill, kind: "submit" | "approve" | "review") {
    setBusy(true);
    setPendingAction(kind);
    setError("");
    setNotice("");
    try {
      await save({ action: `bill.${kind}`, id: b.id, version: b.version });
      setPosting(null);
      setNotice(
        kind === "submit"
          ? `${b.reference} submitted for approval. Nothing posted yet.`
          : kind === "review"
            ? `First review completed for ${b.reference}. Final approval is still required.`
            : `${b.reference} approved and posted to ${b.entity_name}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPendingAction("");
    }
  }
  const entityCode = (id: string) =>
    data.entities.find((e) => e.id === id)?.code || "";
  const open = bills.filter((b) => b.status === "Open");
  const totalOpen = open.reduce(
      (n, b) =>
        n +
        BigInt(b.base_minor) -
        BigInt(b.paid_base_minor) -
        BigInt(b.credited_base_minor),
      0n,
    ),
    overdue = open
      .filter((b) => b.due_date < today())
      .reduce(
        (n, b) =>
          n +
          BigInt(b.base_minor) -
          BigInt(b.paid_base_minor) -
          BigInt(b.credited_base_minor),
        0n,
      );
  function billTable(rows: Bill[]) {
    return rows.length ? (
      <Table
        headers={[
          "Bill / vendor",
          "Entity / project",
          "Due date",
          "Total",
          "Outstanding",
          "Status",
        ]}
      >
        {rows.map((b) => (
          <tr key={b.id}>
            <td>
              <a href={`#bill/${b.id}`} onClick={rememberPosition}>
                {b.reference}
              </a>
              <small>{b.vendor_name}</small>
            </td>
            <td>
              {entityCode(b.entity_id)}
              <small>
                {data.deals.find((d) => d.id === b.deal_id)?.name ||
                  "General overhead"}
              </small>
            </td>
            <td>{day(b.due_date)}</td>
            <td className="num">{money(b.total_minor, b.currency)}</td>
            <td className="num">
              {b.status === "Draft" || b.status === "Pending approval"
                ? "Not posted"
                : b.status === "Voided"
                  ? "—"
                  : money(String(balance(b)), b.currency)}
            </td>
            <td>
              <Badge>{status(b)}</Badge>
              {b.status === "Pending approval" && (
                <small>{review(b).reason}</small>
              )}
            </td>
          </tr>
        ))}
      </Table>
    ) : (
      <Empty title="No bills in this view">
        Create a bill when a vendor invoices you. For costs already paid
        directly, use Expenses—do not record both for the same purchase.
      </Empty>
    );
  }
  function paymentTable(rows: VendorPayment[]) {
    return rows.length ? (
      <Table
        headers={[
          "Payment reference",
          "Bill / vendor",
          "Payment date",
          "Cash paid",
          "Withheld",
          "Bank charge",
          "Status",
          "Actions",
        ]}
      >
        {rows.map((p) => {
          const b = (data.bills || []).find((b) => b.id === p.bill_id)!;
          return (
            <tr key={p.id}>
              <td>{p.reference}</td>
              <td>
                <a href={`#bill/${p.bill_id}`}>{b.reference}</a>
                <small>
                  {b.vendor_name} · {entityCode(p.entity_id)}
                </small>
              </td>
              <td>{day(p.payment_date)}</td>
              <td className="num">{money(p.amount_minor, b.currency)}</td>
              <td className="num">{money(p.wht_minor, b.currency)}</td>
              <td className="num">{money(p.fee_minor, b.currency)}</td>
              <td>
                {p.reversal_date
                  ? `Reversed ${day(p.reversal_date)}`
                  : "Recorded"}
              </td>
              <td>
                <button
                  onClick={() => {
                    try {
                      openRemittanceAdvice(data, p);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Remittance advice
                </button>
                {canPost && !p.reversal_date ? (
                  <button
                    onClick={() =>
                      setEditor({ kind: "reverse", bill: b, payment: p })
                    }
                  >
                    Reverse
                  </button>
                ) : (
                  <small>{p.reversal_reason}</small>
                )}
              </td>
            </tr>
          );
        })}
      </Table>
    ) : (
      <p className="muted">No payments recorded yet.</p>
    );
  }
  let content;
  if (view === "bill") {
    const b = (data.bills || []).find((b) => b.id === id);
    content = !b ? (
      <Empty title="Bill unavailable">
        Open a bill from Purchases → Bills.
      </Empty>
    ) : (
      <>
        <a href="#bills">← All bills</a>
        <Heading
          title={b.reference}
          subtitle={`${b.vendor_name} · ${b.entity_name}`}
        />
        {b.status === "Pending approval" && (
          <>
            <p role="status" aria-label="Bill review status">
              {review(b).reason} Nothing is posted until approval.{" "}
              <a href="#bills">Back to review queue →</a>
            </p>
            <ApprovalSteps bill={b} data={data} />
          </>
        )}
        {data.vendorCredits
          .filter(
            (v) =>
              v.bill_id === b.id ||
              data.vendorCreditApplications.some(
                (a) => a.bill_id === b.id && a.credit_id === v.id,
              ),
          )
          .map((v) => (
            <p key={v.id}>
              Vendor credit: <a href={`#vendor-credits/${v.id}`}>{v.number}</a>{" "}
              ·{" "}
              {v.reversal_date
                ? "Reversed"
                : `${money(v.available, v.currency)} available`}
            </p>
          ))}
        {b.purchase_order_id && b.status === "Draft" && (
          <p>
            This bill retains its purchase-order quantities. To correct them,
            void this draft and convert the order again; the reserved quantities
            will be released.
          </p>
        )}
        <div className="toolbar record-action-bar">
          {b.purchase_order_id && (
            <a href={`#purchase-orders/${b.purchase_order_id}`}>
              View purchase order
            </a>
          )}
          <Badge>{status(b)}</Badge>
          <div className="row-actions">
            {canPost && ["Open", "Paid"].includes(b.status) && (
              <a href={`#vendor-credits/${b.id}`}>Record vendor credit</a>
            )}
            {canPost && b.status === "Draft" ? (
              <>
                {!b.purchase_order_id && (
                  <button onClick={() => setEditor({ kind: "edit", bill: b })}>
                    Edit draft
                  </button>
                )}
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void action(b, "submit")}
                >
                  {pendingAction === "submit"
                    ? "Submitting…"
                    : "Submit for approval"}
                </button>
              </>
            ) : null}
            {b.status === "Pending approval" && review(b).allowed ? (
              <>
                <button onClick={() => setEditor({ kind: "return", bill: b })}>
                  Return to draft
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    review(b).action === "review"
                      ? void action(b, "review")
                      : setPosting(b);
                  }}
                >
                  {pendingAction === "review"
                    ? "Completing review…"
                    : review(b).action === "review"
                      ? review(b).step === 1
                        ? "Complete first review"
                        : `Approve step ${review(b).step} of ${review(b).steps}`
                      : "Approve & post"}
                </button>
              </>
            ) : null}
            {canPost && b.status === "Open" ? (
              <button
                className="primary"
                onClick={() => setEditor({ kind: "pay", bill: b })}
              >
                Record vendor payment
              </button>
            ) : null}
            {canPost &&
            b.status !== "Voided" &&
            b.status !== "Paid" &&
            BigInt(b.paid_minor) === 0n &&
            BigInt(b.credited_minor) === 0n &&
            !data.vendorCredits.some(
              (v) => v.bill_id === b.id && !v.reversal_date,
            ) &&
            (b.status !== "Open" || me.user.role === "admin") ? (
              <button onClick={() => setEditor({ kind: "void", bill: b })}>
                Void bill
              </button>
            ) : null}
          </div>
        </div>
        <section className="panel bill-record-panel">
          <div className="payable-metrics">
            <div>
              <span>Total bill</span>
              <strong>{money(b.total_minor, b.currency)}</strong>
            </div>
            <div>
              <span>Settled (cash + withholding)</span>
              <strong>{money(b.paid_minor, b.currency)}</strong>
            </div>
            <div>
              <span>Credits applied</span>
              <strong>{money(b.credited_minor, b.currency)}</strong>
            </div>
            <div>
              <span>Outstanding</span>
              <strong>
                {["Draft", "Pending approval"].includes(b.status)
                  ? "Not posted"
                  : b.status === "Voided"
                    ? "—"
                    : money(String(balance(b)), b.currency)}
              </strong>
            </div>
          </div>
          <dl className="bill-details">
            <div>
              <dt>Bill date</dt>
              <dd>{day(b.bill_date)}</dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>{day(b.due_date)}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>
                {data.deals.find((d) => d.id === b.deal_id)?.name ||
                  "General overhead"}
              </dd>
            </div>
            <div>
              <dt>Exchange rate</dt>
              <dd>
                1 {b.currency} = {rate(b.fx_micros)} PKR
              </dd>
            </div>
          </dl>
          <Table
            headers={[
              "Description",
              "Account",
              "Quantity",
              "Unit cost",
              "Tax %",
              "Total",
            ]}
          >
            {b.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.description}</td>
                <td>
                  {accounts.find(([code]) => code === l.account_code)?.[1]}
                </td>
                <td>{l.quantity}</td>
                <td>
                  {l.price} {b.currency}
                </td>
                <td>{l.tax}</td>
                <td className="num">
                  {money(
                    String(
                      BigInt(l.subtotal || "0") + BigInt(l.taxMinor || "0"),
                    ),
                    b.currency,
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <p>
            Tax: {money(b.tax_minor, b.currency)} ·{" "}
            {b.tax_treatment === "recoverable"
              ? "Posted separately as input tax receivable"
              : "Included in the expense or asset cost"}
            .{" "}
            {["Draft", "Pending approval"].includes(b.status)
              ? "No ledger entry until approved."
              : ""}
          </p>
          {b.notes ? <p>{b.notes}</p> : null}
        </section>
        <section className="panel">
          <h2>Payments and corrections</h2>
          {paymentTable(payments.filter((p) => p.bill_id === b.id))}
          {(data.vendorPaymentBatches || [])
            .filter((p) => p.allocations.some((a) => a.bill_id === b.id))
            .map((p) => (
              <p key={p.id}>
                <a href={`#vendor-payments/${p.id}`}>{p.reference}</a> ·{" "}
                {p.reversal_date ? "Reversed" : "Multi-bill payment"}
              </p>
            ))}
        </section>
        <section className="panel">
          <BillApprovalTrail bill={b} me={me} />
        </section>
        <section className="panel">
          <h2>Bill activity</h2>
          <Timeline events={data.events.filter((e) => e.record_id === b.id)} />
        </section>
      </>
    );
  } else if (view === "vendor-payments")
    content = (
      <>
        <Suspense fallback={<p>Loading payments…</p>}>
          <VendorPaymentBatches data={data} me={me} entity={entity} id={id} />
        </Suspense>
        {!id ? <h2>Earlier single-bill payments</h2> : null}
        {!id
          ? paymentTable(
              payments.filter(
                (p) => entity === "all" || p.entity_id === entity,
              ),
            )
          : null}
      </>
    );
  else if (view === "payables") {
    const vendors = [...new Set(open.map((b) => b.vendor_id))];
    content = (
      <>
        <Heading
          title="Payable balances"
          subtitle="Approved unpaid bills at their remaining historical PKR carrying values—not closing-rate FX revaluations."
        />
        <div className="payable-metrics panel">
          <div>
            <span>Total outstanding</span>
            <strong>{money(String(totalOpen), "PKR")}</strong>
          </div>
          <div>
            <span>Overdue</span>
            <strong>{money(String(overdue), "PKR")}</strong>
          </div>
          <div>
            <span>Open bills</span>
            <strong>{open.length}</strong>
          </div>
        </div>
        <Table
          headers={[
            "Vendor",
            "Open bills",
            "Outstanding (PKR)",
            "Overdue (PKR)",
          ]}
        >
          {vendors.map((v) => {
            const rows = open.filter((b) => b.vendor_id === v),
              sum = (list: Bill[]) =>
                money(
                  String(
                    list.reduce(
                      (n, b) =>
                        n +
                        BigInt(b.base_minor) -
                        BigInt(b.paid_base_minor) -
                        BigInt(b.credited_base_minor),
                      0n,
                    ),
                  ),
                  "PKR",
                );
            return (
              <tr key={v}>
                <td>{rows[0].vendor_name}</td>
                <td>{rows.length}</td>
                <td className="num">{sum(rows)}</td>
                <td className="num">
                  {sum(rows.filter((b) => b.due_date < today()))}
                </td>
              </tr>
            );
          })}
        </Table>
        <h2 className="space-top">Outstanding bills</h2>
        {billTable(open)}
      </>
    );
  } else if (view === "vendors")
    content = (
      <>
        <Heading
          title="Vendors"
          subtitle="Shared companies marked as vendors. One vendor can supply several legal entities."
          action={canAddVendor ? "New vendor" : undefined}
          onAction={newVendor}
        />
        <Table headers={["Vendor", "Tax reference", "Address", "Open bills"]}>
          {data.companies
            .filter((c) => c.vendor)
            .map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`#company/${c.id}`}>{c.name}</a>
                </td>
                <td>{c.tax_id || "—"}</td>
                <td>{c.address || "—"}</td>
                <td>{open.filter((b) => b.vendor_id === c.id).length}</td>
              </tr>
            ))}
        </Table>
        <p>
          <a href="#bills">Go to bills →</a>
        </p>
      </>
    );
  else
    content = (
      <>
        <Heading
          title="Bills"
          subtitle="Capture vendor invoices, review them, then post and track payments. Drafts do not affect your books."
          action={canPost ? "New bill" : undefined}
          onAction={() => setEditor({ kind: "create" })}
        />
        <div className="toolbar" aria-label="Bill review queues">
          <button
            aria-pressed={filter === "my-review"}
            onClick={() => setFilter("my-review")}
          >
            Ready for my review ({ready.length})
          </button>
          <button
            aria-pressed={filter === "other-review"}
            onClick={() => setFilter("other-review")}
          >
            Waiting for another reviewer ({pending.length - ready.length})
          </button>
          <button
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All bills ({bills.length})
          </button>
        </div>
        <div className="toolbar">
          {canManageRules && (
            <button onClick={() => setRulesOpen(true)}>Approval rules</button>
          )}
          <Field label="Search bills">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Bill number or vendor"
            />
          </Field>
          <Field label="Bill status">
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {[
                "all",
                "my-review",
                "other-review",
                "Draft",
                "Pending approval",
                "Open",
                "Partially paid",
                "Overdue",
                "Paid",
                "Voided",
              ].map((s) => (
                <option key={s} value={s}>
                  {s === "all"
                    ? "All statuses"
                    : s === "my-review"
                      ? "Ready for my review"
                      : s === "other-review"
                        ? "Waiting for another reviewer"
                        : s}
                </option>
              ))}
            </select>
          </Field>
          <a href="#payables">View payable balances →</a>
        </div>
        {billTable(
          bills.filter(
            (b) =>
              (filter === "all" ||
                (filter === "my-review" &&
                  b.status === "Pending approval" &&
                  review(b).allowed) ||
                (filter === "other-review" &&
                  b.status === "Pending approval" &&
                  !review(b).allowed) ||
                status(b) === filter ||
                (filter === "Open" && b.status === "Open")) &&
              `${b.reference} ${b.vendor_name}`
                .toLowerCase()
                .includes(search.toLowerCase()),
          ),
        )}
      </>
    );
  return (
    <>
      {error && !posting ? <ErrorBox error={error} /> : null}
      {notice ? (
        <div className="action-notice" role="status">
          {notice}
          <button
            aria-label="Dismiss confirmation"
            onClick={() => setNotice("")}
          >
            ×
          </button>
        </div>
      ) : null}
      {content}
      {posting ? (
        <ConfirmationDialog
          title="Approve and post this bill?"
          confirmLabel="Confirm & post"
          busy={busy}
          error={error}
          cancel={() => {
            setPosting(null);
            setError("");
          }}
          confirm={() => void action(posting, "approve")}
        >
          <p>
            This records the vendor payable in your books. It does not send
            money or email the vendor.
          </p>
          <dl className="posting-summary">
            <dt>Bill</dt>
            <dd>{posting.reference}</dd>
            <dt>Vendor</dt>
            <dd>{posting.vendor_name}</dd>
            <dt>Legal entity</dt>
            <dd>{posting.entity_name}</dd>
            <dt>Amount</dt>
            <dd>{money(posting.total_minor, posting.currency)}</dd>
          </dl>
          <p className="muted">
            Once posted, bill details cannot be edited. Corrections need a
            credit or reversal.
          </p>
        </ConfirmationDialog>
      ) : null}
      {rulesOpen && (
        <BillApprovalRules
          data={data}
          entity={entity}
          close={() => setRulesOpen(false)}
          save={save}
        />
      )}
      {editor ? (
        <PayableEditor
          key={`${me.organization.id}:${me.user.id}:${editor.kind}-${editor.bill?.id || ""}:${editor.bill?.version || ""}`}
          editor={editor}
          data={data}
          entity={entity}
          draftScope={`${me.organization.id}:${me.user.id}`}
          close={() => setEditor(null)}
          save={save}
        />
      ) : null}
    </>
  );
}

const roleNames: Record<ApprovalRole, string> = {
  finance: "Finance or administrator",
  admin: "Administrator",
};
// Shows every step of the current submission so the next reviewer is clear.
function ApprovalSteps({ bill, data }: { bill: Bill; data: Data }) {
  const policy =
    bill.approval_policy || data.entities.find((e) => e.id === bill.entity_id);
  if (!policy) return null;
  const { steps } = approvalPlan(policy, bill.base_minor),
    approvals = bill.approvals || [],
    name = (id: string) =>
      data.crmMembers.find((m) => m.id === id)?.name || "Former team member";
  return (
    <section className="panel" aria-label="Approval steps">
      <h2>Approval steps</h2>
      {bill.approval_policy ? (
        <p className="muted">
          Saved rules · version {bill.approval_policy.bill_approval_version}
          {bill.approval_policy.source === "upgrade"
            ? " · retained at system upgrade"
            : " · retained on submission"}
          . Later rule changes do not alter these steps.
        </p>
      ) : null}
      <ol className="approval-steps">
        {steps.map((step, i) => (
          <li key={i}>
            <strong>{roleNames[step.role]}</strong>
            {" — "}
            {approvals[i]
              ? `Approved by ${name(approvals[i])}`
              : i === approvals.length
                ? i === steps.length - 1
                  ? "Waiting · approval posts to the books"
                  : "Waiting"
                : "Not started"}
          </li>
        ))}
      </ol>
      <p className="muted">
        Each step needs a different person. Returning the bill restarts the
        steps.
      </p>
    </section>
  );
}
function BillApprovalTrail({ bill, me }: { bill: Bill; me: Me }) {
  const history = useInfiniteQuery({
    queryKey: [
      "bill-approval-history",
      me.organization.id,
      me.user.id,
      bill.id,
      bill.version,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      request<{ events: Event[]; nextCursor: string | null }>(
        `bills/${bill.id}/approval-history${pageParam ? `?cursor=${pageParam}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  const label = (event: Event) =>
    event.action === "bill.review" &&
    typeof event.details.step === "number" &&
    event.details.step > 1
      ? `Step ${event.details.step} of ${event.details.steps} approved — not posted`
      : labels[event.action] || event.action;
  const labels: Record<string, string> = {
    "bill.create": "Draft created",
    "bill.submit": "Submitted for approval",
    "bill.review": "First review completed — not posted",
    "bill.return": "Returned to draft",
    "bill.approve": "Final approval — posted to books",
    "bill.void": "Bill voided",
  };
  return (
    <>
      <h2>Approval history</h2>
      <p className="muted">
        Newest first. Previous reviews remain here when a bill is returned and
        resubmitted.
      </p>
      {history.isPending ? (
        <p role="status">Loading approval history…</p>
      ) : null}
      {history.error ? (
        <>
          <ErrorBox error={history.error.message} />
          <button onClick={() => void history.refetch()}>Retry history</button>
        </>
      ) : null}
      {history.data ? (
        <ol>
          {history.data.pages
            .flatMap((page) => page.events)
            .map((event) => (
              <li key={event.id}>
                <strong>{label(event)}</strong>
                {" · "}
                {typeof event.details.actorName === "string"
                  ? event.details.actorName
                  : `Team member (${event.actor_id.slice(0, 8)})`}
                {" · "}
                <time dateTime={event.created_at}>
                  {new Date(event.created_at).toLocaleString()}
                </time>
                {event.action === "bill.return" &&
                typeof event.details.text === "string" ? (
                  <p>{event.details.text}</p>
                ) : null}
              </li>
            ))}
        </ol>
      ) : null}
      {history.hasNextPage ? (
        <button
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage
            ? "Loading older approvals…"
            : "Load older approvals"}
        </button>
      ) : null}
    </>
  );
}

type TierDraft = { from: string; steps: ApprovalRole[] };
function BillApprovalRules({
  data,
  entity,
  close,
  save,
}: {
  data: Data;
  entity: string;
  close: () => void;
  save: (c: Record<string, unknown>) => Promise<{ id: string }>;
}) {
  const [selected, setSelected] = useState(
    entity === "all" ? data.entities[0]?.id || "" : entity,
  );
  const policy = data.entities.find((e) => e.id === selected);
  const draftFrom = (id: string): TierDraft[] => {
    const p = data.entities.find((e) => e.id === id);
    return p
      ? approvalTiers(p).map((t) => ({
          from: decimal(t.from_minor),
          steps: t.steps.map((s) => s.role),
        }))
      : [];
  };
  const [tiers, setTiers] = useState(() => draftFrom(selected));
  const [separate, setSeparate] = useState(!!policy?.bill_separate_approver);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const change = (next: TierDraft[]) => {
    setTiers(next);
    setDirty(true);
  };
  const setTier = (i: number, tier: TierDraft) =>
    change(tiers.map((t, j) => (j === i ? tier : t)));
  let problem: string | null = null;
  try {
    problem = tierProblem(
      tiers.map((t) => ({
        from_minor: String(minor(t.from || "0")),
        steps: t.steps.map((role) => ({ role })),
      })),
    );
  } catch {
    problem = "Use amounts with at most two decimals.";
  }
  return (
    <Drawer title="Bill approval rules" close={close} dirty={dirty}>
      <p>
        Choose who approves a bill, by its PKR amount including tax. Steps run
        in order, each by a different person, and only the last step posts to
        the books. New rules apply when a draft is submitted. Pending bills keep
        their saved rules; return a bill to draft and resubmit to use new rules.
      </p>
      <Field label="Legal entity">
        <select
          value={selected}
          disabled={dirty || busy}
          onChange={(e) => {
            const p = data.entities.find((x) => x.id === e.target.value);
            setSelected(e.target.value);
            setTiers(draftFrom(e.target.value));
            setSeparate(!!p?.bill_separate_approver);
          }}
        >
          {data.entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      {policy && (
        <form
          key={selected}
          onSubmit={async (e) => {
            e.preventDefault();
            if (problem) return setError(problem);
            setBusy(true);
            setError("");
            try {
              await save({
                action: "bill.approval-policy",
                entity_id: selected,
                version: policy.bill_approval_version,
                finance_limit:
                  policy.bill_finance_limit_minor === null
                    ? null
                    : decimal(policy.bill_finance_limit_minor),
                separate_approver: separate,
                tiers: tiers.map((t) => ({
                  from: t.from || "0",
                  steps: t.steps.map((role) => ({ role })),
                })),
              });
              close();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {tiers.map((tier, i) => (
            <fieldset
              key={i}
              className="approval-tier"
              aria-label={`Tier ${i + 1}`}
            >
              <legend>
                {i === 0
                  ? "All bills"
                  : `Tier ${i + 1}: bills from PKR ${tier.from || "…"}`}
              </legend>
              {i > 0 ? (
                <Field label={`Tier ${i + 1} starts at (PKR)`}>
                  <input
                    inputMode="decimal"
                    value={tier.from}
                    onChange={(e) =>
                      setTier(i, { ...tier, from: e.target.value })
                    }
                  />
                </Field>
              ) : null}
              <ol>
                {tier.steps.map((role, j) => (
                  <li key={j}>
                    <Field label={`Tier ${i + 1} step ${j + 1} approver`}>
                      <select
                        value={role}
                        onChange={(e) =>
                          setTier(i, {
                            ...tier,
                            steps: tier.steps.map((r, k) =>
                              k === j ? (e.target.value as ApprovalRole) : r,
                            ),
                          })
                        }
                      >
                        <option value="finance">
                          Finance or administrator
                        </option>
                        <option value="admin">Administrator only</option>
                      </select>
                    </Field>
                    {tier.steps.length > 1 ? (
                      <button
                        type="button"
                        aria-label={`Remove tier ${i + 1} step ${j + 1}`}
                        onClick={() =>
                          setTier(i, {
                            ...tier,
                            steps: tier.steps.filter((_, k) => k !== j),
                          })
                        }
                      >
                        Remove step
                      </button>
                    ) : null}
                  </li>
                ))}
              </ol>
              <div className="row-actions">
                {tier.steps.length < 4 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setTier(i, { ...tier, steps: [...tier.steps, "admin"] })
                    }
                  >
                    Add step to tier {i + 1}
                  </button>
                ) : null}
                {i > 0 ? (
                  <button
                    type="button"
                    onClick={() => change(tiers.filter((_, j) => j !== i))}
                  >
                    Remove tier {i + 1}
                  </button>
                ) : null}
              </div>
            </fieldset>
          ))}
          {tiers.length < 5 ? (
            <button
              type="button"
              onClick={() =>
                change([...tiers, { from: "", steps: ["finance", "admin"] }])
              }
            >
              Add amount tier
            </button>
          ) : null}
          <Field label="Separate reviewer">
            <label>
              <input
                type="checkbox"
                checked={separate}
                onChange={(e) => {
                  setSeparate(e.target.checked);
                  setDirty(true);
                }}
              />{" "}
              Bill creators cannot approve their own bills
            </label>
          </Field>
          <p className="muted">
            Add steps only when enough different people are available. A bill
            waiting on a step nobody can complete can still be returned by
            someone allowed to act on that step.
          </p>
          {problem && dirty ? <p role="alert">{problem}</p> : null}
          {error && <ErrorBox error={error} />}
          <button className="primary" disabled={busy || !!problem}>
            {busy ? "Saving…" : "Save approval rules"}
          </button>
        </form>
      )}
    </Drawer>
  );
}

function PayableEditor({
  editor,
  data,
  entity,
  draftScope,
  close,
  save,
}: {
  editor: Editor;
  data: Data;
  entity: string;
  draftScope: string;
  close: () => void;
  save: (c: Record<string, unknown>) => Promise<{ id: string }>;
}) {
  const b = editor.bill,
    kind = editor.kind,
    isDraft = kind === "create" || kind === "edit";
  const draftKey = `gv-bill-draft-v1:${draftScope}:${kind}:${b?.id || "new"}:${b?.version || ""}`;
  const [restored] = useState(() =>
    isDraft ? readBrowserDraft(draftKey, billDraft) : null,
  );
  const [draftStored, setDraftStored] = useState(!!restored);
  const [addingVendor, setAddingVendor] = useState(false);
  const [vendorBusy, setVendorBusy] = useState(false);
  const [fields, setFields] = useState(
    restored?.fields ?? {
      reference: b?.reference || "",
      bill_date: b?.bill_date || today(),
      due_date: b?.due_date || today(),
      notes: b?.notes || "",
      acknowledge_duplicate: false,
    },
  );
  const [selectedEntity, setEntity] = useState(
      b?.entity_id ||
        restored?.selectedEntity ||
        (entity === "all" ? "" : entity),
    ),
    [vendor, setVendor] = useState(restored?.vendor ?? b?.vendor_id ?? ""),
    [project, setProject] = useState(restored?.project ?? b?.deal_id ?? ""),
    [currency, setCurrency] = useState(
      restored?.currency ?? b?.currency ?? "PKR",
    ),
    [fx, setFx] = useState(restored?.fx ?? (b ? rate(b.fx_micros) : "1"));
  const [lines, setLines] = useState<(Line & { account_code: string })[]>(
    restored?.lines ??
      (b?.lines.map(({ description, quantity, price, tax, account_code }) => ({
        description,
        quantity,
        price,
        tax,
        account_code,
      })) || [
        {
          description: "",
          quantity: "1",
          price: "",
          tax: "0",
          account_code: "5000",
        },
      ]),
  );
  const [taxTreatment, setTaxTreatment] = useState(
      restored?.taxTreatment ?? b?.tax_treatment ?? "expense",
    ),
    [dirty, setDirty] = useState(!!restored),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key] = useState(() => restored?.requestKey ?? crypto.randomUUID());
  useEffect(() => {
    if (!isDraft || !dirty) return;
    setDraftStored(
      writeBrowserDraft(draftKey, {
        selectedEntity,
        vendor,
        project,
        currency,
        fx,
        taxTreatment,
        lines,
        requestKey: key,
        fields,
      }),
    );
  }, [
    isDraft,
    dirty,
    draftKey,
    selectedEntity,
    vendor,
    project,
    currency,
    fx,
    taxTreatment,
    lines,
    key,
    fields,
  ]);
  const discardAndClose = () => {
    if (busy || vendorBusy) return;
    if (isDraft) clearBrowserDraft(draftKey);
    if (isDraft) clearBrowserDraft(`${draftKey}:vendor`);
    close();
  };
  let sum = "";
  try {
    sum = totals(lines).total;
  } catch {
    /* Incomplete input. */
  }
  const title = {
    create: "New vendor bill",
    edit: "Edit bill draft",
    pay: "Record vendor payment",
    void: "Void bill",
    return: "Return bill to draft",
    reverse: "Reverse vendor payment",
  }[kind];
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [error]);
  function field(
    label: string,
    name: string,
    value = "",
    type = "text",
    hint?: string,
  ) {
    const recovered = fields[name as keyof typeof fields];
    return (
      <Field label={label} hint={hint}>
        <input
          name={name}
          defaultValue={
            isDraft && typeof recovered === "string" ? recovered : value
          }
          type={type}
          required
          maxLength={200}
        />
      </Field>
    );
  }
  function changeLine(index: number, field: string, value: string) {
    setLines((current) =>
      current.map((line, i) =>
        i === index ? { ...line, [field]: value } : line,
      ),
    );
  }
  return (
    <Drawer title={title} close={discardAndClose} dirty={dirty}>
      <form
        className="editor"
        onChange={(event) => {
          setDirty(true);
          if (isDraft) {
            const values = new FormData(event.currentTarget);
            setFields({
              reference: String(values.get("reference") || ""),
              bill_date: String(values.get("bill_date") || ""),
              due_date: String(values.get("due_date") || ""),
              notes: String(values.get("notes") || ""),
              acknowledge_duplicate:
                values.get("acknowledge_duplicate") === "on",
            });
          }
        }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || addingVendor || vendorBusy) return;
          setBusy(true);
          setError("");
          const f = Object.fromEntries(new FormData(e.currentTarget));
          try {
            let c: Record<string, unknown>;
            if (isDraft)
              c = {
                action: kind === "create" ? "bill.create" : "bill.edit",
                ...(kind === "create"
                  ? { entity_id: selectedEntity, request_key: key }
                  : { id: b!.id, version: b!.version }),
                vendor_id: vendor,
                deal_id: project || null,
                reference: f.reference,
                bill_date: f.bill_date,
                due_date: f.due_date,
                currency,
                fx,
                lines,
                tax_treatment: taxTreatment,
                notes: f.notes,
                acknowledge_duplicate: f.acknowledge_duplicate === "on",
              };
            else if (kind === "pay")
              c = {
                action: "vendor-payment.create",
                bank_account_id: f.bank_account_id || null,
                bill_id: b!.id,
                date: f.date,
                amount: f.amount,
                wht: f.wht,
                fee: f.fee,
                fx,
                reference: f.reference,
                request_key: key,
              };
            else if (kind === "reverse")
              c = {
                action: "vendor-payment.reverse",
                id: editor.payment!.id,
                date: f.date,
                reason: f.reason,
              };
            else
              c = {
                action: `bill.${kind}`,
                id: b!.id,
                version: b!.version,
                ...(kind === "void" ? { date: f.date } : {}),
                reason: f.reason,
              };
            const result = await save(c);
            if (isDraft) clearBrowserDraft(draftKey);
            if (isDraft) clearBrowserDraft(`${draftKey}:vendor`);
            close();
            if (kind === "create") location.hash = `bill/${result.id}`;
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="editor-body">
          {isDraft && dirty && (
            <div className="quote-draft-notice" role="status">
              <span>
                {draftStored
                  ? "Bill draft saved in this tab for 24 hours. Saving a bill still requires review before posting."
                  : "Draft recovery is unavailable. Save your bill before leaving."}
              </span>
              {draftStored && (
                <button
                  type="button"
                  disabled={busy || vendorBusy}
                  onClick={close}
                >
                  Keep draft & close
                </button>
              )}
            </div>
          )}
          {error ? (
            <div ref={errorRef} tabIndex={-1}>
              <ErrorBox error={error} />
            </div>
          ) : null}
          {isDraft ? (
            <>
              <Field
                label="Legal entity"
                hint={
                  b
                    ? "The legal entity cannot change on an existing bill. Void the draft and create a new bill if needed."
                    : "Choose the legal entity that owes this vendor."
                }
              >
                <select
                  required
                  disabled={!!b}
                  value={selectedEntity}
                  onChange={(e) => {
                    setEntity(e.target.value);
                    setProject("");
                  }}
                >
                  <option value="">Choose legal entity</option>
                  {data.entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} ({e.code})
                    </option>
                  ))}
                </select>
              </Field>
              <ContactCompanyField
                draftKey={`${draftKey}:vendor`}
                companies={data.companies.filter((c) => c.vendor)}
                create={save}
                vendor
                required
                initialCompanyId={vendor}
                onSelectionChange={setVendor}
                onOpenChange={setAddingVendor}
                onBusyChange={setVendorBusy}
                onChange={() => setDirty(true)}
              />
              {field("Vendor bill number", "reference", b?.reference)}
              <div className="form-row">
                {field(
                  "Bill date",
                  "bill_date",
                  b?.bill_date || today(),
                  "date",
                )}
                {field("Due date", "due_date", b?.due_date || today(), "date")}
              </div>
              <Field label="Project (optional)">
                <select
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">General company overhead</option>
                  {data.deals
                    .filter((d) => d.entity_id === selectedEntity)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="form-row">
                <Field label="Bill currency">
                  <select
                    value={currency}
                    onChange={(e) => {
                      setCurrency(e.target.value);
                      setFx(e.target.value === "PKR" ? "1" : "");
                    }}
                  >
                    {["PKR", "USD", "AED", "EUR", "GBP"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`PKR per 1 ${currency}`}>
                  <input
                    required
                    value={fx}
                    readOnly={currency === "PKR"}
                    inputMode="decimal"
                    onChange={(e) => setFx(e.target.value)}
                  />
                </Field>
              </div>
              <h3>Bill lines</h3>
              {lines.map((l, i) => (
                <fieldset className="bill-line" key={i}>
                  <legend>Line {i + 1}</legend>
                  <Field label={`Description ${i + 1}`}>
                    <input
                      required
                      maxLength={200}
                      value={l.description}
                      onChange={(e) =>
                        changeLine(i, "description", e.target.value)
                      }
                    />
                  </Field>
                  <Field label={`Account ${i + 1}`}>
                    <select
                      value={l.account_code}
                      onChange={(e) =>
                        changeLine(i, "account_code", e.target.value)
                      }
                    >
                      {accounts.map(([code, label]) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="form-row">
                    {(["quantity", "price", "tax"] as const).map(
                      (key, index) => (
                        <Field
                          key={key}
                          label={`${["Quantity", "Unit cost before tax", "Tax %"][index]} ${i + 1}`}
                        >
                          <input
                            required
                            inputMode="decimal"
                            value={l[key]}
                            onChange={(e) => changeLine(i, key, e.target.value)}
                          />
                        </Field>
                      ),
                    )}
                  </div>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setLines(lines.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      Remove line {i + 1}
                    </button>
                  ) : null}
                </fieldset>
              ))}
              <button
                type="button"
                disabled={lines.length >= 100}
                onClick={() => {
                  setLines([
                    ...lines,
                    {
                      description: "",
                      quantity: "1",
                      price: "",
                      tax: "0",
                      account_code: "5000",
                    },
                  ]);
                  setDirty(true);
                }}
              >
                Add bill line
              </button>
              <Field
                label="Purchase tax treatment"
                hint="Recoverable tax goes to Input tax receivable. Select it only when you have confirmed that this tax is recoverable; no statutory eligibility is inferred."
              >
                <select
                  value={taxTreatment}
                  onChange={(e) =>
                    setTaxTreatment(e.target.value as "expense" | "recoverable")
                  }
                >
                  <option value="expense">
                    Include tax in expense / asset cost
                  </option>
                  <option value="recoverable">Recoverable input tax</option>
                </select>
              </Field>
              <p>
                <strong>
                  Bill total:{" "}
                  {sum ? money(sum, currency) : "Complete the lines"}
                </strong>
              </p>
              <Field label="Notes">
                <textarea
                  name="notes"
                  maxLength={4000}
                  defaultValue={fields.notes}
                />
              </Field>
              <label className="checkbox">
                <input
                  type="checkbox"
                  name="acknowledge_duplicate"
                  defaultChecked={fields.acknowledge_duplicate}
                />{" "}
                I checked matching vendor/date/amount records and confirm this
                is a separate bill.
              </label>
              <p className="muted">
                Saving creates a draft only. An administrator must approve it
                before it posts to the books.
              </p>
            </>
          ) : kind === "pay" ? (
            <>
              <BankSelect data={data} entity={b!.entity_id} />
              <p>
                <strong>
                  {b!.vendor_name} · {b!.reference}
                </strong>
                <br />
                {b!.entity_name}
                <br />
                Outstanding: {money(String(balance(b!)), currency)}
              </p>
              {field("Payment date", "date", today(), "date")}
              {field(
                `Cash paid to vendor (${currency})`,
                "amount",
                decimal(String(balance(b!))),
              )}
              {field(`Withholding deducted (${currency})`, "wht", "0")}
              {field(
                `Bank charge (${currency})`,
                "fee",
                "0",
                "text",
                "Charged in addition to the payment; does not reduce the bill balance.",
              )}
              <Field label={`Payment FX: PKR per 1 ${currency}`}>
                <input
                  required
                  value={fx}
                  readOnly={currency === "PKR"}
                  onChange={(e) => setFx(e.target.value)}
                  inputMode="decimal"
                />
              </Field>
              {field("Payment reference", "reference")}
              <p>
                Cash + withholding settles the bill. Cash and charges post
                through the selected bank ledger. This records an existing
                payment; it does not transfer money. Do not also record it as a
                direct expense.
              </p>
            </>
          ) : (
            <>
              <p>
                {b!.reference} · {b!.vendor_name}
              </p>
              {kind !== "return"
                ? field("Reversal / cancellation date", "date", today(), "date")
                : null}
              {field("Reason", "reason")}
              <p>
                {kind === "return"
                  ? "The draft can be edited and resubmitted. No ledger entry has been posted."
                  : kind === "reverse"
                    ? "This creates a reversing journal and restores the bill balance. It does not undo an actual bank transfer."
                    : "An unpaid posted bill is reversed in the selected period. Its original entries and history remain. Draft cancellations do not post a journal."}
              </p>
            </>
          )}
        </div>
        <div className="editor-footer">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!dirty || confirm("Discard your unsaved changes?"))
                discardAndClose();
            }}
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || vendorBusy || addingVendor}
          >
            {busy
              ? "Saving…"
              : isDraft
                ? "Save bill draft"
                : kind === "pay"
                  ? "Record payment"
                  : kind === "reverse"
                    ? "Record reversal"
                    : kind === "return"
                      ? "Return to draft"
                      : "Void bill"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
