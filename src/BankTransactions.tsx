import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLeaveGuard } from "./NavigationSafety";
import { useQuery } from "@tanstack/react-query";
import { Field, Drawer, ErrorBox } from "./components";
import { request, money, today, type Me } from "./model";
import { controlledAccountCodes } from "../shared/accounting";
import { bankTransactionProblem } from "../shared/banking";
import { minor } from "../shared/money";
import {
  bankTransactionDraft,
  bankTransactionDraftKey,
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
} from "./browserDraft";

type Line = {
  account_code: string;
  debit: string;
  credit: string;
  memo: string;
};
const blank = (): Line => ({
  account_code: "",
  debit: "",
  credit: "",
  memo: "",
});
const valid = (v: string) => /^\d{1,13}(\.\d{1,2})?$/.test(v);

// Common reasons money moves with no invoice or bill behind it. Each preset
// only fills the allocation; people still choose the exact accounts.
const presets = [
  {
    label: "Owner drawing",
    direction: "out",
    hint: "Debit the drawings account.",
  },
  {
    label: "Owner capital introduced",
    direction: "in",
    hint: "Credit the owner equity account.",
  },
  {
    label: "Salary paid net of tax",
    direction: "out",
    hint: "Debit salaries (gross); credit the salary tax payable account.",
  },
  {
    label: "Partner reimbursement settled",
    direction: "out",
    hint: "Debit the amount owed to the partner.",
  },
  {
    label: "Bank interest or charges",
    direction: "in",
    hint: "Credit interest income, or choose Money out for charges.",
  },
] as const;

export function BankTransactionEditor({
  me,
  account,
  entityName,
  save,
  close,
}: {
  me: Me;
  account: { id: string; entity_id: string; name: string; opening_on: string };
  entityName: string;
  save: (c: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}) {
  const draftKey = bankTransactionDraftKey(
    me.organization.id,
    me.user.id,
    account.entity_id,
    account.id,
  );
  const [restored] = useState(() =>
    readBrowserDraft(draftKey, bankTransactionDraft),
  );
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const chart = useQuery({
    queryKey: [
      "report",
      me.organization.id,
      account.entity_id,
      "bank-transaction-chart",
    ],
    queryFn: () =>
      request<{
        trial: { code: string; name: string; type: string; active: boolean }[];
      }>(`reports?entityId=${account.entity_id}&from=2000-01-01&to=${today()}`),
  });
  const accounts = (chart.data?.trial || []).filter(
    (a) =>
      a.active &&
      !controlledAccountCodes.has(a.code) &&
      !a.code.startsWith("10B"),
  );
  const [direction, setDirection] = useState<"in" | "out">(
      restored?.direction ?? "out",
    ),
    [amount, setAmount] = useState(restored?.amount ?? ""),
    [description, setDescription] = useState(restored?.description ?? ""),
    [lines, setLines] = useState<Line[]>(restored?.lines ?? [blank()]),
    [hint, setHint] = useState(restored?.hint ?? ""),
    [date, setDate] = useState(restored?.date ?? today()),
    [reference, setReference] = useState(restored?.reference ?? ""),
    [dirty, setDirty] = useState(!!restored),
    [draftSaved, setDraftSaved] = useState(!!restored),
    [reviewing, setReviewing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key, setKey] = useState(() => restored?.requestKey ?? crypto.randomUUID());
  useLeaveGuard({
    label: "bank transaction details",
    dirty,
    recoverable: draftSaved,
    busy,
  });
  useEffect(() => {
    if (reviewing) reviewHeading.current?.focus();
  }, [reviewing]);
  useEffect(() => {
    if (!dirty) return;
    setDraftSaved(
      writeBrowserDraft(draftKey, {
        direction,
        amount,
        description,
        lines,
        hint,
        date,
        reference,
        requestKey: key,
      }),
    );
  }, [
    draftKey,
    dirty,
    direction,
    amount,
    description,
    lines,
    hint,
    date,
    reference,
    key,
  ]);
  function discard() {
    if (
      !window.confirm("Discard this transaction draft? This cannot be undone.")
    )
      return;
    clearBrowserDraft(draftKey);
    setDirection("out");
    setAmount("");
    setDescription("");
    setLines([blank()]);
    setHint("");
    setDate(today());
    setReference("");
    setKey(crypto.randomUUID());
    setDirty(false);
    setDraftSaved(false);
    setReviewing(false);
    setError("");
  }
  const attemptClose = () => {
    if (busy) return;
    if (
      !dirty ||
      draftSaved ||
      window.confirm(
        "Draft storage is unavailable. Discard your unsaved changes?",
      )
    )
      close();
  };
  const edit = (i: number, k: keyof Line, v: string) => {
    setDirty(true);
    setLines((old) => old.map((l, n) => (n === i ? { ...l, [k]: v } : l)));
  };
  // A single allocation mirrors the amount on the side that balances the bank.
  const single = lines.length === 1 && !lines[0].debit && !lines[0].credit;
  const effective =
    single && valid(amount)
      ? [{ ...lines[0], [direction === "out" ? "debit" : "credit"]: amount }]
      : lines;
  const filled = effective.map((l) => ({
    ...l,
    debit: valid(l.debit) ? l.debit : "0",
    credit: valid(l.credit) ? l.credit : "0",
  }));
  const allocated = filled.reduce(
    (n, l) =>
      n +
      (direction === "out"
        ? minor(l.debit) - minor(l.credit)
        : minor(l.credit) - minor(l.debit)),
    0n,
  );
  const problem = !valid(amount)
    ? "Enter the amount that moved through the bank."
    : lines.some(
          (l) => (l.debit && !valid(l.debit)) || (l.credit && !valid(l.credit)),
        )
      ? "Use positive amounts with up to two decimal places in every allocation."
      : bankTransactionProblem({ direction, amount, lines: filled });
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (problem) return setError(problem);
    if (
      chart.isError ||
      chart.isPending ||
      filled.some((l) => !accounts.some((a) => a.code === l.account_code))
    )
      return setError("Choose an available account for every allocation.");
    if (!reviewing) {
      setError("");
      setReviewing(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await save({
        action: "bank.transaction",
        bank_id: account.id,
        date,
        direction,
        amount,
        description,
        reference,
        lines: filled.map((l) => ({ ...l, memo: l.memo.trim() })),
        request_key: key,
      });
      clearBrowserDraft(draftKey);
      close();
    } catch (err) {
      setError(
        `${(err as Error).message} If the connection failed, posting may already have completed. Retry this unchanged entry to confirm safely.`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      title={`${reviewing ? "Review transaction" : "Record transaction"} · ${account.name}`}
      dirty={false}
      close={attemptClose}
    >
      <form
        className="editor"
        onChange={() => {
          setDirty(true);
          setReviewing(false);
        }}
        onSubmit={submit}
      >
        <div className="editor-body">
          {dirty ? (
            <div className="posting-notice">
              <p>
                {draftSaved
                  ? "Draft retained in this tab for up to 24 hours. Closing or reloading will keep it; closing the tab will not. Review is required before submitting."
                  : "Draft storage is unavailable. Keep this form open to avoid losing your work."}
              </p>
              <button type="button" onClick={discard} disabled={busy}>
                Discard draft
              </button>
            </div>
          ) : null}
          <p className="muted">
            For money with no invoice, bill or expense behind it: drawings,
            capital, salaries net of tax, partner reimbursements, interest. It
            posts straight to the books and cannot be edited; record an opposite
            transaction to correct it.
          </p>
          {error ? <ErrorBox error={error} /> : null}
          {reviewing ? (
            <section aria-labelledby="bank-review-heading">
              <h3 id="bank-review-heading" ref={reviewHeading} tabIndex={-1}>
                Review before posting
              </h3>
              <dl className="bank-review-details">
                <div>
                  <dt>Legal entity</dt>
                  <dd>{entityName}</dd>
                </div>
                <div>
                  <dt>Bank account</dt>
                  <dd>{account.name}</dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>{date}</dd>
                </div>
                <div>
                  <dt>Direction</dt>
                  <dd>{direction === "out" ? "Money out" : "Money in"}</dd>
                </div>
                <div>
                  <dt>Amount · PKR</dt>
                  <dd>{money(String(minor(amount)))}</dd>
                </div>
                <div>
                  <dt>Description</dt>
                  <dd>{description}</dd>
                </div>
                <div>
                  <dt>Reference</dt>
                  <dd>{reference || "—"}</dd>
                </div>
              </dl>
              <h3>Account allocations</h3>
              {filled.map((line, i) => (
                <p key={i}>
                  {line.account_code} ·{" "}
                  {accounts.find((a) => a.code === line.account_code)?.name}
                  {" — Debit "}
                  {money(String(minor(line.debit)))}
                  {" · Credit "}
                  {money(String(minor(line.credit)))}
                  {line.memo ? ` · ${line.memo}` : ""}
                </p>
              ))}
              <p className="posting-notice">
                Posting updates the books immediately. This transaction cannot
                be edited; corrections require an opposite transaction.
              </p>
            </section>
          ) : null}
          <fieldset
            hidden={reviewing}
            disabled={busy}
            className="financial-entry-fields"
          >
            <fieldset className="choice-row">
              <legend>Direction</legend>
              {(["out", "in"] as const).map((d) => (
                <label key={d} className="check">
                  <input
                    type="radio"
                    name="direction"
                    checked={direction === d}
                    onChange={() => setDirection(d)}
                  />
                  {d === "out" ? "Money out" : "Money in"}
                </label>
              ))}
            </fieldset>
            <Field
              label="Common purpose"
              hint={hint || "Optional. Fills the description and direction."}
            >
              <select
                defaultValue=""
                onChange={(e) => {
                  const p = presets.find((x) => x.label === e.target.value);
                  if (!p) return;
                  setDirection(p.direction);
                  setDescription(p.label);
                  setHint(p.hint);
                }}
              >
                <option value="">Choose…</option>
                {presets.map((p) => (
                  <option key={p.label}>{p.label}</option>
                ))}
              </select>
            </Field>
            <div className="form-row">
              <Field label="Date">
                <input
                  required
                  name="date"
                  type="date"
                  min={account.opening_on}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>
              <Field label="Amount · PKR">
                <input
                  required
                  inputMode="decimal"
                  maxLength={100}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.trim())}
                />
              </Field>
            </div>
            <Field label="Description">
              <input
                required
                maxLength={200}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Reference" hint="Bank or transfer reference, if any.">
              <input
                name="reference"
                maxLength={200}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
            <fieldset className="allocations">
              <legend>Allocate to accounts</legend>
              {chart.isPending ? <p role="status">Loading accounts…</p> : null}
              {chart.isError ? (
                <div>
                  <ErrorBox error="Could not load accounts. Your entry is retained; retry before posting." />
                  <button type="button" onClick={() => void chart.refetch()}>
                    Retry accounts
                  </button>
                </div>
              ) : null}
              {lines.map((l, i) => (
                <div key={i} className="allocation-row">
                  <Field label={`Account ${i + 1}`}>
                    <select
                      required
                      value={l.account_code}
                      onChange={(e) => edit(i, "account_code", e.target.value)}
                    >
                      <option value="">Choose account…</option>
                      {accounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={`Debit ${i + 1}`}>
                    <input
                      inputMode="decimal"
                      maxLength={100}
                      value={l.debit}
                      placeholder={single && direction === "out" ? amount : ""}
                      onChange={(e) => edit(i, "debit", e.target.value.trim())}
                    />
                  </Field>
                  <Field label={`Credit ${i + 1}`}>
                    <input
                      inputMode="decimal"
                      maxLength={100}
                      value={l.credit}
                      placeholder={single && direction === "in" ? amount : ""}
                      onChange={(e) => edit(i, "credit", e.target.value.trim())}
                    />
                  </Field>
                  <Field label={`Note ${i + 1}`}>
                    <input
                      maxLength={400}
                      value={l.memo}
                      onChange={(e) => edit(i, "memo", e.target.value)}
                    />
                  </Field>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      aria-label={`Remove allocation ${i + 1}`}
                      onClick={() => {
                        setDirty(true);
                        setLines((o) => o.filter((_, n) => n !== i));
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                disabled={lines.length >= 100}
                onClick={() => {
                  setDirty(true);
                  setLines((o) => [...o, blank()]);
                }}
              >
                Add allocation
              </button>
              <p role="status" className={problem ? "muted" : ""}>
                Allocated {money(String(allocated))} of{" "}
                {valid(amount) ? money(String(minor(amount))) : "—"}
                {problem ? ` · ${problem}` : " · Balanced"}
              </p>
            </fieldset>
          </fieldset>
        </div>
        <div className="editor-footer">
          <button type="button" onClick={attemptClose} disabled={busy}>
            {dirty && draftSaved ? "Close · keep draft" : "Cancel"}
          </button>
          {reviewing ? (
            <button
              type="button"
              onClick={() => setReviewing(false)}
              disabled={busy}
            >
              Back to edit
            </button>
          ) : null}
          <button
            className="primary"
            disabled={busy || !!problem || chart.isPending || chart.isError}
          >
            {busy
              ? "Posting…"
              : reviewing
                ? "Post transaction"
                : "Review transaction"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
