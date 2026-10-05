import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Heading, Field, Drawer, ErrorBox, Table, Empty } from "./components";
import {
  request,
  money,
  day,
  today,
  decimal,
  type Data,
  type Me,
} from "./model";
import {
  parseStatementCsv,
  signedMinor,
  type BankDetail,
} from "../shared/banking";

export function BankSelect({
  data,
  entity,
  defaultValue = "",
}: {
  data: Data;
  entity: string;
  defaultValue?: string;
}) {
  return (
    <Field
      label="Bank account"
      hint="PKR ledger. Foreign payments use the recorded FX rate. Unassigned cash cannot be reconciled to a named bank."
    >
      <select name="bank_account_id" key={entity} defaultValue={defaultValue}>
        <option value="">Unassigned bank and cash (1000)</option>
        {(data.bankAccounts || [])
          .filter((b) => b.entity_id === entity)
          .map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} · PKR
            </option>
          ))}
      </select>
    </Field>
  );
}
function BankEditor({
  mode,
  data,
  entity,
  detail,
  save,
  close,
}: {
  mode: "account" | "import";
  data: Data;
  entity: string;
  detail?: BankDetail;
  save: (c: Record<string, unknown>) => Promise<void>;
  close: () => void;
}) {
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [key] = useState(() => crypto.randomUUID()),
    [csv, setCsv] = useState("");
  const [rows, setRows] = useState<ReturnType<typeof parseStatementCsv> | null>(
    null,
  );
  const latest = detail?.statements.find((s) => s.status === "Reconciled");
  const previous = latest?.to_date || detail?.account.opening_on;
  const next = previous
    ? new Date(Date.parse(previous + "T00:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10)
    : today();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
    try {
      if (mode === "import" && !rows)
        throw new Error("Preview the CSV rows before importing.");
      await save(
        mode === "account"
          ? { action: "bank.create", ...f, request_key: key }
          : {
              action: "bank.import",
              ...f,
              bank_id: detail!.account.id,
              lines: rows,
              request_key: key,
            },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = (name: string, label: string, value = "", type = "text") => (
    <Field label={label}>
      <input required name={name} type={type} defaultValue={value} />
    </Field>
  );
  return (
    <Drawer
      title={mode === "account" ? "Add bank account" : "Import bank statement"}
      dirty={dirty}
      close={close}
    >
      <form
        className="editor"
        onChange={() => setDirty(true)}
        onSubmit={submit}
      >
        <div className="editor-body">
          {error ? <ErrorBox error={error} /> : null}
          {mode === "account" ? (
            <>
              <Field label="Legal entity">
                <select
                  name="entity_id"
                  required
                  defaultValue={entity === "all" ? "" : entity}
                >
                  <option value="">Choose an entity</option>
                  {data.entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.code} · {e.name}
                    </option>
                  ))}
                </select>
              </Field>
              {field("name", "Account name")}
              {field("reference", "Account label / last four digits")}
              {field("opening_on", "Opening balance date", today(), "date")}
              {field("opening", "Verified opening balance (PKR)", "0")}
              <Field
                label="Opening balance offset"
                hint="Choose explicitly. Clearing must be resolved during checked opening-balance migration; it is not income."
              >
                <select name="offset_code" required defaultValue="">
                  <option value="">Choose offset account</option>
                  <option value="3900">3900 · Opening balance clearing</option>
                  <option value="3000">3000 · Owner equity</option>
                </select>
              </Field>
              <p className="posting-notice">
                Creates a PKR ledger account, not a bank connection. Enter a
                verified balance at the end of the opening date. Transactions
                begin the following day. Existing unassigned cash is not moved.
              </p>
            </>
          ) : (
            <>
              <p>
                {detail!.account.entity_code} · {detail!.account.name} · PKR
              </p>
              {field("reference", "Statement reference")}
              <div className="form-row">
                {field("from", "Statement from", next, "date")}
                {field(
                  "to",
                  "Statement to",
                  next > today() ? next : today(),
                  "date",
                )}
              </div>
              {field(
                "opening",
                "Statement opening balance (PKR)",
                decimal(latest?.closing_minor || detail!.account.opening_minor),
              )}
              {field("closing", "Statement closing balance (PKR)")}
              <Field
                label="CSV file (optional)"
                hint="Date,Description,Reference,Amount. ISO dates; positive receipts, negative withdrawals. Up to 500 rows, 100 KB."
              >
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setRows(null);
                    if (file.size > 100000) {
                      setError("CSV must be smaller than 100 KB.");
                      return;
                    }
                    setCsv(await file.text());
                  }}
                />
              </Field>
              <Field label="Statement CSV">
                <textarea
                  rows={7}
                  value={csv}
                  placeholder={
                    "Date,Description,Reference,Amount\n2026-10-01,Studio payment,REF-1,-1000.00"
                  }
                  onChange={(e) => {
                    setCsv(e.target.value);
                    setRows(null);
                  }}
                />
              </Field>
              <button
                type="button"
                onClick={() => {
                  try {
                    setRows(parseStatementCsv(csv));
                    setError("");
                  } catch (e) {
                    setRows(null);
                    setError((e as Error).message);
                  }
                }}
              >
                Preview rows
              </button>
              {rows ? (
                <>
                  <p>
                    {rows.length} rows · Net movement{" "}
                    {money(
                      rows.reduce((n, r) => n + signedMinor(r.amount), 0n),
                    )}
                  </p>
                  <Table
                    headers={["Date", "Description", "Reference", "Amount"]}
                  >
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.date}</td>
                        <td>{r.description}</td>
                        <td>{r.reference}</td>
                        <td className="num">{money(signedMinor(r.amount))}</td>
                      </tr>
                    ))}
                  </Table>
                </>
              ) : null}
              <p className="muted">
                Import records statement evidence only. No income, expense or
                payment is created. Opening plus row movements must equal
                closing.
              </p>
            </>
          )}
        </div>
        <div className="editor-footer">
          <button
            type="button"
            onClick={() => {
              if (!dirty || window.confirm("Discard unsaved changes?")) close();
            }}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || (mode === "import" && !rows)}
          >
            {busy
              ? "Saving…"
              : mode === "account"
                ? "Create bank account"
                : "Import statement"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export function Banking({
  data,
  me,
  entity,
  id,
}: {
  data: Data;
  me: Me;
  entity: string;
  id?: string;
}) {
  const cache = useQueryClient(),
    [statementId, setStatementId] = useState("");
  const [modal, setModal] = useState<"account" | "import" | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [selectedBank, setSelectedBank] = useState<string[]>([]),
    [selectedBook, setSelectedBook] = useState<string[]>([]);
  const q = useQuery({
    queryKey: ["banking", me.organization.id, me.user.id, id, statementId],
    queryFn: () =>
      request<BankDetail>(
        `banking?${new URLSearchParams({ bankId: id!, ...(statementId ? { statementId } : {}) })}`,
      ),
    enabled: !!id,
  });
  async function run(c: Record<string, unknown>) {
    setError("");
    setBusy(true);
    try {
      const result = await request<{ id: string }>(
        "commands",
        "POST",
        c,
        me.csrf,
      );
      await Promise.all(
        [
          "data",
          "banking",
          "financial-report",
          "financial-detail",
          "report",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
      setSelectedBank([]);
      setSelectedBook([]);
      return result;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const invoke = (c: Record<string, unknown>) => void run(c).catch(() => {}),
    d = q.data;
  const matches = d?.matches || [];
  const bankMatch = new Map(
      matches.flatMap((m) =>
        m.statement_line_ids.map((id) => [id, m.id] as const),
      ),
    ),
    bookMatch = new Map(
      matches.flatMap((m) =>
        m.journal_line_ids.map((id) => [id, m.id] as const),
      ),
    );
  const bankTotal = (d?.lines || [])
    .filter((l) => selectedBank.includes(l.id))
    .reduce((n, l) => n + BigInt(l.amount_minor), 0n);
  const bookTotal = (d?.books || [])
    .filter((l) => selectedBook.includes(l.id))
    .reduce((n, l) => n + BigInt(l.amount), 0n);
  const change = (id: string, selected: string[], set: (x: string[]) => void) =>
    set(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  const draft = d?.statement?.status === "Draft";
  return (
    <>
      {id ? <a href="#banking">← All bank accounts</a> : null}
      <Heading
        title={id ? d?.account.name || "Bank account" : "Banking"}
        subtitle={
          id
            ? `${d?.account.entity_code || ""} · PKR · Statement matching and reconciliation`
            : "Named bank ledgers, statement imports and reconciled balances."
        }
        action={id ? undefined : "Add bank account"}
        onAction={() => setModal("account")}
      />
      {error ? <ErrorBox error={error} /> : null}
      {!id ? (
        <>
          <Table
            headers={[
              "Entity",
              "Bank account",
              "Ledger balance · PKR",
              "Reconciled through",
            ]}
          >
            {(data.bankAccounts || [])
              .filter((b) => entity === "all" || b.entity_id === entity)
              .map((b) => (
                <tr key={b.id}>
                  <td>{b.entity_code}</td>
                  <td>
                    <a href={`#bank/${b.id}`}>{b.name}</a>
                    <small>
                      {b.reference} · {b.account_code}
                    </small>
                  </td>
                  <td className="num">{money(b.balance)}</td>
                  <td>{day(b.last_reconciled_on)}</td>
                </tr>
              ))}
          </Table>
          <p className="muted">
            Bank accounts currently use PKR. Foreign documents settle at their
            payment rate. Existing Bank and cash (1000) remains unassigned;
            balances are not automatically migrated.
          </p>
        </>
      ) : (
        <>
          {q.isPending ? <p role="status">Loading bank account…</p> : null}
          {q.error ? <ErrorBox error={q.error.message} /> : null}
          {d ? (
            <>
              <div className="toolbar">
                <Field label="Statement">
                  <select
                    value={d.statement?.id || ""}
                    onChange={(e) => {
                      setStatementId(e.target.value);
                      setSelectedBank([]);
                      setSelectedBook([]);
                    }}
                  >
                    <option value="" disabled>
                      {d.statements.length
                        ? "Choose statement"
                        : "No imported statements"}
                    </option>
                    {d.statements.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.reference} · {s.to_date} · {s.status}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  disabled={
                    busy || d.statements.some((s) => s.status === "Draft")
                  }
                  onClick={() => setModal("import")}
                >
                  Import statement
                </button>
              </div>
              {!d.statement ? (
                <Empty title="Start with a statement">
                  Import beginning the day after {day(d.account.opening_on)}.
                  Verified opening: {money(d.account.opening_minor)}.
                </Empty>
              ) : (
                <>
                  <h2>
                    {d.statement.reference} · {d.statement.status}
                  </h2>
                  <p>
                    {day(d.statement.from_date)} – {day(d.statement.to_date)} ·
                    Opening {money(d.statement.opening_minor)}
                  </p>
                  <div className="report-totals">
                    <p>
                      <span>Statement closing</span>
                      <strong>{money(d.statement.closing_minor)}</strong>
                    </p>
                    <p>
                      <span>Ledger at closing date</span>
                      <strong>{money(d.bookBalance)}</strong>
                    </p>
                    <p>
                      <span>Outstanding ledger movement</span>
                      <strong>{money(d.unmatchedBookBalance)}</strong>
                    </p>
                    <p>
                      <span>Adjusted ledger less statement</span>
                      <strong>{money(d.difference)}</strong>
                    </p>
                  </div>
                  <p className="muted">
                    Adjusted ledger = ledger balance minus signed outstanding
                    movements. All statement rows must be matched; uncleared
                    ledger items may carry forward.
                  </p>
                  {draft ? (
                    <div className="bank-match-toolbar">
                      <span>
                        Selected statement: {money(bankTotal)} · Ledger:{" "}
                        {money(bookTotal)}
                      </span>
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          !selectedBank.length ||
                          !selectedBook.length ||
                          bankTotal !== bookTotal
                        }
                        onClick={() =>
                          invoke({
                            action: "bank.match",
                            statement_id: d.statement!.id,
                            statement_line_ids: selectedBank,
                            journal_line_ids: selectedBook,
                          })
                        }
                      >
                        Match selected
                      </button>
                    </div>
                  ) : null}
                  <h3>Statement transactions</h3>
                  <Table
                    headers={[
                      "Select",
                      "Date",
                      "Description / reference",
                      "Amount",
                      "Match",
                    ]}
                  >
                    {d.lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {draft && !bankMatch.has(l.id) ? (
                            <input
                              type="checkbox"
                              aria-label={`Statement row ${l.line_no}`}
                              checked={selectedBank.includes(l.id)}
                              onChange={() =>
                                change(l.id, selectedBank, setSelectedBank)
                              }
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{day(l.posted_on)}</td>
                        <td>
                          {l.description}
                          <small>{l.reference}</small>
                        </td>
                        <td className="num">{money(l.amount_minor)}</td>
                        <td>{bankMatch.has(l.id) ? "Matched" : "Unmatched"}</td>
                      </tr>
                    ))}
                  </Table>
                  <h3 className="space-top">Ledger transactions</h3>
                  <Table
                    headers={[
                      "Select",
                      "Date",
                      "Transaction",
                      "Amount",
                      "Match",
                    ]}
                  >
                    {d.books.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {draft && !bookMatch.has(l.id) ? (
                            <input
                              type="checkbox"
                              aria-label={`Ledger ${l.description}`}
                              checked={selectedBook.includes(l.id)}
                              onChange={() =>
                                change(l.id, selectedBook, setSelectedBook)
                              }
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{day(l.posted_on)}</td>
                        <td>
                          {l.description}
                          <small>{l.source_type}</small>
                        </td>
                        <td className="num">{money(l.amount)}</td>
                        <td>
                          {bookMatch.has(l.id) ? "Matched here" : "Outstanding"}
                        </td>
                      </tr>
                    ))}
                  </Table>
                  <h3 className="space-top">Matched groups</h3>
                  {d.matches.map((m, i) => (
                    <div className="work-item" key={m.id}>
                      <span>
                        Group {i + 1}: {m.statement_line_ids.length} statement
                        rows ↔ {m.journal_line_ids.length} ledger rows
                      </span>
                      {draft ? (
                        <button
                          disabled={busy}
                          onClick={() => {
                            const reason = window.prompt(
                              "Reason for releasing this match",
                            );
                            if (reason)
                              invoke({
                                action: "bank.unmatch",
                                id: m.id,
                                reason,
                              });
                          }}
                        >
                          Undo match {i + 1}
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {draft ? (
                    <div className="toolbar space-top">
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          d.difference !== "0" ||
                          d.lines.some((l) => !bankMatch.has(l.id))
                        }
                        onClick={() => {
                          if (
                            window.confirm(
                              `Complete reconciliation through ${d.statement!.to_date}? This locks bank postings through that date.`,
                            )
                          )
                            invoke({
                              action: "bank.close",
                              id: d.statement!.id,
                            });
                        }}
                      >
                        Complete reconciliation
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt(
                            "Reason for cancelling this draft statement",
                          );
                          if (reason)
                            invoke({
                              action: "bank.cancel",
                              id: d.statement!.id,
                              reason,
                            });
                        }}
                      >
                        Cancel draft statement
                      </button>
                    </div>
                  ) : (
                    <p>
                      Statement history retained. Matching and reconciliation do
                      not create ledger entries.
                    </p>
                  )}
                </>
              )}
            </>
          ) : null}
        </>
      )}
      {modal ? (
        <BankEditor
          mode={modal}
          data={data}
          entity={entity}
          detail={d}
          close={() => setModal(null)}
          save={async (c) => {
            const result = await run(c);
            setModal(null);
            if (c.action === "bank.create") location.hash = `bank/${result.id}`;
            else setStatementId(result.id);
          }}
        />
      ) : null}
    </>
  );
}
