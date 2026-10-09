import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field, Drawer, ErrorBox } from "./components";
import { request, money, today, type Me } from "./model";
import { controlledAccountCodes } from "../shared/accounting";
import { bankTransactionProblem } from "../shared/banking";
import { minor } from "../shared/money";

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
  save,
  close,
}: {
  me: Me;
  account: { id: string; entity_id: string; name: string; opening_on: string };
  save: (c: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}) {
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
  const [direction, setDirection] = useState<"in" | "out">("out"),
    [amount, setAmount] = useState(""),
    [description, setDescription] = useState(""),
    [lines, setLines] = useState<Line[]>([blank()]),
    [hint, setHint] = useState(""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key] = useState(() => crypto.randomUUID());
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
    : bankTransactionProblem({ direction, amount, lines: filled });
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
    if (problem) return setError(problem);
    if (filled.some((l) => !l.account_code))
      return setError("Choose an account for every allocation.");
    setBusy(true);
    setError("");
    try {
      await save({
        action: "bank.transaction",
        bank_id: account.id,
        date: f.date,
        direction,
        amount,
        description,
        reference: f.reference,
        lines: filled.map((l) => ({ ...l, memo: l.memo.trim() })),
        request_key: key,
      });
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      title={`Record transaction · ${account.name}`}
      dirty={dirty}
      close={close}
    >
      <form
        className="editor"
        onChange={() => setDirty(true)}
        onSubmit={submit}
      >
        <div className="editor-body">
          <p className="muted">
            For money with no invoice, bill or expense behind it: drawings,
            capital, salaries net of tax, partner reimbursements, interest. It
            posts straight to the books and cannot be edited; record an opposite
            transaction to correct it.
          </p>
          {error ? <ErrorBox error={error} /> : null}
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
                defaultValue={today()}
              />
            </Field>
            <Field label="Amount · PKR">
              <input
                required
                inputMode="decimal"
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
            <input name="reference" maxLength={200} />
          </Field>
          <fieldset className="allocations">
            <legend>Allocate to accounts</legend>
            {chart.isPending ? <p role="status">Loading accounts…</p> : null}
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
                    value={l.debit}
                    placeholder={single && direction === "out" ? amount : ""}
                    onChange={(e) => edit(i, "debit", e.target.value.trim())}
                  />
                </Field>
                <Field label={`Credit ${i + 1}`}>
                  <input
                    inputMode="decimal"
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
                    onClick={() => setLines((o) => o.filter((_, n) => n !== i))}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setLines((o) => [...o, blank()])}
            >
              Add allocation
            </button>
            <p role="status" className={problem ? "muted" : ""}>
              Allocated {money(String(allocated))} of{" "}
              {valid(amount) ? money(String(minor(amount))) : "—"}
              {problem ? ` · ${problem}` : " · Balanced"}
            </p>
          </fieldset>
        </div>
        <div className="editor-footer">
          <button type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !!problem}>
            {busy ? "Posting…" : "Post transaction"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
