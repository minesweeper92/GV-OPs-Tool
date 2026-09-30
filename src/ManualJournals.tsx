import { useState } from "react";
import { controlledAccountCodes } from "../shared/accounting";
import { minor } from "../shared/money";
import { day, money, today, type Entity, type Report } from "./model";
import { ErrorBox } from "./components";
import { Ledger } from "./Records";

type Line = {
  account_code: string;
  debit: string;
  credit: string;
  memo: string;
};
const blank = (): Line => ({
  account_code: "",
  debit: "0",
  credit: "0",
  memo: "",
});
const amount = (value: string) => {
  try {
    return minor(value || "0");
  } catch {
    return null;
  }
};

export function ManualJournals({
  entity,
  report,
  onRun,
}: {
  entity: Entity;
  report: Report;
  onRun: (command: Record<string, unknown>) => Promise<{ id: string }>;
}) {
  const [creating, setCreating] = useState(false);
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [reviewing, setReviewing] = useState(false);
  const [reversing, setReversing] = useState("");
  const [reversalDate, setReversalDate] = useState(today());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [reversalKey, setReversalKey] = useState(() => crypto.randomUUID());
  const available = report.trial.filter(
    (a) =>
      a.active &&
      !controlledAccountCodes.has(a.code) &&
      !a.code.startsWith("10B"),
  );
  const debit = lines.reduce(
    (sum, line) => sum + (amount(line.debit) || 0n),
    0n,
  );
  const credit = lines.reduce(
    (sum, line) => sum + (amount(line.credit) || 0n),
    0n,
  );
  const editLine = (index: number, key: keyof Line, value: string) => {
    setLines((old) =>
      old.map((line, i) => (i === index ? { ...line, [key]: value } : line)),
    );
    setReviewing(false);
  };
  const dateRestriction = (on: string) => {
    if (entity.lock_date && on <= entity.lock_date)
      return `This entity is locked through ${day(entity.lock_date)}. Choose a later date.`;
    if (
      report.periods.some(
        (period) =>
          period.month.slice(0, 7) === on.slice(0, 7) &&
          period.status === "Closed",
      )
    )
      return "This accounting month is closed. Reopen it before posting a journal.";
    return "";
  };
  const validate = () => {
    if (!reference.trim() || !memo.trim())
      return "Enter a reference and explanation.";
    const restriction = dateRestriction(date);
    if (restriction) return restriction;
    for (const line of lines) {
      const dr = amount(line.debit),
        cr = amount(line.credit);
      if (!available.some((a) => a.code === line.account_code))
        return "Choose an available account for every line.";
      if (dr === null || cr === null || dr > 0n === cr > 0n)
        return "Each line needs one valid debit or credit amount.";
    }
    if (debit === 0n || debit !== credit)
      return "The debit and credit totals must match.";
    return "";
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      setReviewing(false);
      return;
    }
    setError("");
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    setBusy(true);
    try {
      await onRun({
        action: "manual-journal.create",
        entity_id: entity.id,
        date,
        reference,
        memo,
        lines,
        request_key: requestKey,
      });
      setCreating(false);
      setReviewing(false);
      setReference("");
      setMemo("");
      setLines([blank(), blank()]);
      setRequestKey(crypto.randomUUID());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reverse(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const restriction = dateRestriction(reversalDate);
    if (restriction) {
      setError(restriction);
      return;
    }
    setBusy(true);
    try {
      await onRun({
        action: "manual-journal.reverse",
        id: reversing,
        date: reversalDate,
        reason,
        request_key: reversalKey,
      });
      setReversing("");
      setReason("");
      setReversalKey(crypto.randomUUID());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="manual-journals">
      <div className="toolbar">
        <button
          className="primary"
          type="button"
          onClick={() => {
            setCreating(!creating);
            setReviewing(false);
            setError("");
          }}
        >
          {creating ? "Close journal form" : "+ New manual journal"}
        </button>
        <span className="muted">{entity.name} · PKR ledger</span>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {creating ? (
        <form className="manual-journal-form" onSubmit={submit}>
          <h2>New manual journal</h2>
          <p className="muted">
            For adjustments between general-ledger accounts. Customer, vendor,
            bank and tax control balances must use their dedicated workflows.
          </p>
          <div className="manual-journal-fields">
            <label>
              Posting date
              <input
                type="date"
                required
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setReviewing(false);
                }}
              />
            </label>
            <label>
              Reference
              <input
                required
                maxLength={200}
                value={reference}
                onChange={(e) => {
                  setReference(e.target.value);
                  setReviewing(false);
                }}
                placeholder="e.g. ADJ-2026-09-01"
              />
            </label>
          </div>
          <label>
            Explanation
            <textarea
              required
              maxLength={200}
              value={memo}
              onChange={(e) => {
                setMemo(e.target.value);
                setReviewing(false);
              }}
              placeholder="Why is this adjustment needed?"
            />
          </label>
          <div
            className="manual-journal-lines"
            role="group"
            aria-label="Journal lines"
          >
            {lines.map((line, index) => (
              <div className="manual-journal-line" key={index}>
                <strong>Line {index + 1}</strong>
                <label>
                  Account
                  <select
                    required
                    value={line.account_code}
                    onChange={(e) =>
                      editLine(index, "account_code", e.target.value)
                    }
                  >
                    <option value="">Choose an account</option>
                    {available.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Debit (PKR)
                  <input
                    inputMode="decimal"
                    value={line.debit}
                    onChange={(e) => editLine(index, "debit", e.target.value)}
                  />
                </label>
                <label>
                  Credit (PKR)
                  <input
                    inputMode="decimal"
                    value={line.credit}
                    onChange={(e) => editLine(index, "credit", e.target.value)}
                  />
                </label>
                <label>
                  Line note
                  <input
                    maxLength={400}
                    value={line.memo}
                    onChange={(e) => editLine(index, "memo", e.target.value)}
                  />
                </label>
                {lines.length > 2 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setLines((old) => old.filter((_, i) => i !== index));
                      setReviewing(false);
                    }}
                  >
                    Remove line
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setLines((old) => [...old, blank()]);
              setReviewing(false);
            }}
            disabled={lines.length >= 100}
          >
            + Add line
          </button>
          <div className="manual-journal-totals">
            <span>Debits {money(debit)}</span>
            <span>Credits {money(credit)}</span>
            <strong>
              {debit === credit && debit > 0n ? "Balanced" : "Not balanced"}
            </strong>
          </div>
          {reviewing ? (
            <p className="posting-notice">
              Posting will add {money(debit)} of debits and credits to{" "}
              {entity.name} on {day(date)}. The journal cannot be edited
              afterward; a correction requires a dated reversal.
            </p>
          ) : null}
          <div className="actions">
            <button className="primary" type="submit" disabled={busy}>
              {busy
                ? "Posting…"
                : reviewing
                  ? "Post journal"
                  : "Review journal"}
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {reversing ? (
        <form className="manual-journal-form" onSubmit={reverse}>
          <h2>Reverse manual journal</h2>
          <p className="posting-notice">
            The original stays in the ledger. A new journal will post the exact
            opposite debits and credits on the date below.
          </p>
          <div className="manual-journal-fields">
            <label>
              Reversal date
              <input
                type="date"
                required
                value={reversalDate}
                onChange={(e) => setReversalDate(e.target.value)}
              />
            </label>
            <label>
              Reason
              <input
                required
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy} type="submit">
              {busy ? "Reversing…" : "Post reversal"}
            </button>
            <button type="button" onClick={() => setReversing("")}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <Ledger
        report={report}
        mode="journals"
        onReverse={(id) => {
          setReversing(id);
          setReversalDate(today());
          setReason("");
          setReversalKey(crypto.randomUUID());
          setError("");
        }}
      />
    </div>
  );
}
