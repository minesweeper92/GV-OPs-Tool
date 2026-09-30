import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cutoverInput, tableCsv, type CutoverInput } from "../shared/cutover";
import { ErrorBox } from "./components";
import { money, request, type Entity, type Me } from "./model";

type Preview = {
  entity: { id: string; code: string; name: string };
  date: string;
  checks: { label: string; ok: boolean; detail: string }[];
  canCommit: boolean;
  totals: {
    debit: string;
    credit: string;
    receivables: string;
    payables: string;
  };
  counts: { accounts: number; receivables: number; payables: number };
  preflightHash: string;
};
type Batch = {
  id: string;
  cutover_date: string;
  account_count: number;
  receivable_count: number;
  payable_count: number;
  posted_at: string;
  posted_by: string;
  payload_hash: string;
  source_data: CutoverInput | null;
};
const columns = {
  accounts: ["code", "name", "type", "debit", "credit"],
  receivables: ["company", "number", "issue_date", "due_date", "amount"],
  payables: ["company", "number", "bill_date", "due_date", "amount"],
} as const;
const examples = {
  accounts:
    "code,name,type,debit,credit\n1000,Bank and cash,Asset,1000.00,0\n1100,Accounts receivable,Asset,500.00,0\n2000,Accounts payable,Liability,0,200.00\n3000,Owner equity,Equity,0,1300.00\n",
  receivables:
    "company,number,issue_date,due_date,amount\nExample Customer,INV-001,2026-09-01,2026-10-01,500.00\n",
  payables:
    "company,number,bill_date,due_date,amount\nExample Vendor,BILL-001,2026-09-01,2026-10-01,200.00\n",
};
const labels = {
  accounts: "Opening trial balance and account chart",
  receivables: "Unpaid customer invoices",
  payables: "Unpaid vendor bills",
};
export function OpeningBalances({ entity, me }: { entity: Entity; me: Me }) {
  const cache = useQueryClient();
  const history = useQuery({
    queryKey: ["cutover", entity.id],
    queryFn: () => request<Batch[]>(`cutover?entityId=${entity.id}`),
  });
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [tables, setTables] = useState<
    Record<keyof typeof columns, Record<string, string>[]>
  >({ accounts: [], receivables: [], payables: [] });
  const [fileNames, setFileNames] = useState<
    Record<keyof typeof columns, string>
  >({ accounts: "", receivables: "", payables: "" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(false);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());

  const payload = (): CutoverInput =>
    cutoverInput.parse({
      entity_id: entity.id,
      cutover_date: date,
      accounts: tables.accounts,
      receivables: tables.receivables,
      payables: tables.payables,
    });
  const change = async (kind: keyof typeof columns, file?: File) => {
    setError("");
    setPreview(null);
    setConfirmation("");
    if (!file) {
      setTables((old) => ({ ...old, [kind]: [] }));
      setFileNames((old) => ({ ...old, [kind]: "" }));
      return;
    }
    try {
      if (file.size > 200_000)
        throw new Error(
          "Use a CSV under 200 KB. Split larger imports into a reviewed migration batch.",
        );
      const rows = tableCsv(await file.text(), columns[kind]);
      if (rows.length > 500)
        throw new Error("Each CSV can contain at most 500 data rows.");
      setTables((old) => ({ ...old, [kind]: rows }));
      setFileNames((old) => ({ ...old, [kind]: file.name }));
    } catch (cause) {
      setTables((old) => ({ ...old, [kind]: [] }));
      setFileNames((old) => ({ ...old, [kind]: "" }));
      setError(`${labels[kind]}: ${(cause as Error).message}`);
    }
  };
  const download = (kind: keyof typeof columns) => {
    const url = URL.createObjectURL(
      new Blob([examples[kind]], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `gv-${kind}-template.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const downloadEvidence = (batch: Batch) => {
    if (!batch.source_data) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              batch_id: batch.id,
              posted_at: batch.posted_at,
              payload_hash: batch.payload_hash,
              source: batch.source_data,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `gv-cutover-${entity.code}-${batch.cutover_date}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const review = async () => {
    setBusy(true);
    setError("");
    setPreview(null);
    setConfirmation("");
    try {
      const input = payload();
      setPreview(
        await request<Preview>("cutover/preview", "POST", input, me.csrf),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview || !preview.canCommit || confirmation !== entity.code || busy)
      return;
    setBusy(true);
    setError("");
    try {
      await request(
        "cutover/commit",
        "POST",
        {
          input: payload(),
          preflightHash: preview.preflightHash,
          requestKey,
          confirmation,
        },
        me.csrf,
      );
      setPosted(true);
      setPreview(null);
      setRequestKey(crypto.randomUUID());
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["cutover", entity.id] }),
        cache.invalidateQueries({ queryKey: ["data"] }),
        cache.invalidateQueries({ queryKey: ["report"] }),
        cache.invalidateQueries({ queryKey: ["financial-report"] }),
      ]);
    } catch (cause) {
      setError((cause as Error).message);
      setPreview(null); // A failed commit may mean state changed; force a fresh preview.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cutover-flow">
      <section className="settings-note">
        <h2>{entity.name} · opening balances</h2>
        <p>
          Use this once for a new legal entity. The cutover date is the final
          closing day in the old books; record new activity from the following
          day. Nothing posts during preview. Import PKR balances only;
          foreign-currency opening documents need a separate reviewed migration.
        </p>
        <p>
          First create customer and vendor companies in CRM and any named bank
          accounts in Banking. Include each bank account code and its existing
          opening balance in the trial balance. Existing operational entries
          block this workflow.
        </p>
      </section>
      {history.error ? <ErrorBox error={history.error.message} /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {posted ? (
        <p role="status">
          Cutover posted. Review the trial balance, ageing and document lists
          before using these books.
        </p>
      ) : null}
      {history.data?.length ? (
        <section className="settings-note">
          <h2>Posted cutover</h2>
          <p>
            {history.data[0].cutover_date} · {history.data[0].account_count}{" "}
            accounts · {history.data[0].receivable_count} customer invoices ·{" "}
            {history.data[0].payable_count} vendor bills.
          </p>
          <p>
            This is immutable. Do not upload the same source balances again.
          </p>
          {history.data[0].source_data ? (
            <button
              type="button"
              onClick={() => downloadEvidence(history.data![0])}
            >
              Download reviewed import record
            </button>
          ) : null}
        </section>
      ) : (
        <>
          <div className="toolbar">
            <label>
              Old books closing date{" "}
              <input
                aria-label="Old books closing date"
                type="date"
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                  setPreview(null);
                  setConfirmation("");
                }}
              />
            </label>
          </div>
          {(Object.keys(columns) as (keyof typeof columns)[]).map(
            (kind, index) => (
              <section className="settings-note cutover-upload" key={kind}>
                <h2>
                  {index + 1}. {labels[kind]}
                </h2>
                <p>
                  Columns: {columns[kind].join(", ")}.{" "}
                  {kind === "accounts"
                    ? "Use account codes from this entity; new codes create custom accounts. Debits and credits must balance."
                    : "Company names must exactly match existing CRM companies with the correct customer/vendor flag."}
                </p>
                <div className="toolbar cutover-upload-actions">
                  <label>
                    <span className="sr-only">{labels[kind]} CSV</span>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      aria-label={`${labels[kind]} CSV`}
                      onChange={(event) =>
                        void change(kind, event.target.files?.[0])
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="subtle"
                    onClick={() => download(kind)}
                  >
                    Download template
                  </button>
                </div>
                <p className="muted">
                  {fileNames[kind]
                    ? `${fileNames[kind]} · ${tables[kind].length} rows loaded`
                    : kind === "accounts"
                      ? "Required"
                      : "Optional if there are no open documents"}
                </p>
              </section>
            ),
          )}
          <div className="toolbar">
            <button
              type="button"
              className="primary"
              onClick={() => void review()}
              disabled={busy || !tables.accounts.length}
            >
              Review cutover
            </button>
          </div>
          {preview ? (
            <section className="settings-note" aria-label="Cutover review">
              <h2>Review before posting</h2>
              <p>
                {preview.entity.name} · {preview.date} ·{" "}
                {preview.counts.accounts} accounts ·{" "}
                {preview.counts.receivables} invoices ·{" "}
                {preview.counts.payables} bills
              </p>
              <p>
                Trial balance: {money(preview.totals.debit)} debits /{" "}
                {money(preview.totals.credit)} credits. Open AR{" "}
                {money(preview.totals.receivables)}; open AP{" "}
                {money(preview.totals.payables)}.
              </p>
              <ul className="cutover-checks">
                {preview.checks.map((check, index) => (
                  <li
                    key={index}
                    className={check.ok ? "cutover-pass" : "cutover-error"}
                  >
                    <strong>
                      {check.ok ? "✓" : "×"} {check.label}
                    </strong>
                    <span>{check.detail}</span>
                  </li>
                ))}
              </ul>
              {preview.canCommit ? (
                <>
                  <p>
                    All checks pass. Confirm the correct legal entity and source
                    files with your accountant before posting.
                  </p>
                  <label>
                    Type {entity.code} to confirm{" "}
                    <input
                      aria-label="Entity code confirmation"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <div className="toolbar">
                    <button
                      className="primary"
                      type="button"
                      disabled={
                        busy ||
                        me.user.role !== "admin" ||
                        confirmation !== entity.code
                      }
                      onClick={() => void commit()}
                    >
                      Post opening balances
                    </button>
                  </div>
                  {me.user.role !== "admin" ? (
                    <p>Only an administrator can post the reviewed cutover.</p>
                  ) : null}
                </>
              ) : (
                <p>
                  Fix the failed checks in the source files, upload them again
                  and review a fresh preview.
                </p>
              )}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
