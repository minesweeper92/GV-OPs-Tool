import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Drawer, ErrorBox, Field, Heading, Table } from "./components";
import { request, money, decimal, day, today, type Me } from "./model";
import {
  ageingLabels,
  type FinancialReport,
  type AccountBalance,
  type AgeingReport,
  type AccountDetail,
} from "../shared/reporting";

type Kind = "profit" | "balance" | "cash" | "ar" | "ap" | "trial";
const titles: Record<Kind, string> = {
  profit: "Profit and loss",
  balance: "Balance sheet",
  cash: "Cash flow",
  ar: "Receivable ageing",
  ap: "Payable ageing",
  trial: "Trial balance",
};
type Selection = {
  entityId: string;
  code: string;
  from: string;
  to: string;
  name: string;
};
const net = (a: AccountBalance) => BigInt(a.debit) - BigInt(a.credit);
const total = (a: AccountBalance[], field: "opening" | "closing") =>
  a.reduce((n, r) => n + BigInt(r[field]), 0n);

function csvCell(value: string) {
  // Spreadsheet applications must never execute names or descriptions as formulas.
  const safe = /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function downloadCsv(rows: string[][], name: string) {
  const url = URL.createObjectURL(
    new Blob(
      ["\uFEFF", rows.map((r) => r.map(csvCell).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function currencySummary(r: AgeingReport) {
  const groups = new Map<
    string,
    { entity: string; party: string; currency: string; buckets: bigint[] }
  >();
  for (const d of r.documents) {
    const key = `${d.entity_id}/${d.party_id}/${d.currency}`;
    const group = groups.get(key) || {
      entity: d.entity_code,
      party: d.party,
      currency: d.currency,
      buckets: [0n, 0n, 0n, 0n, 0n],
    };
    group.buckets[d.bucket] += BigInt(d.outstanding);
    groups.set(key, group);
  }
  return [...groups.values()];
}
function Ageing({
  report,
  payable,
}: {
  report: AgeingReport;
  payable: boolean;
}) {
  const [mode, setMode] = useState("detail");
  return (
    <>
      <div className="report-totals">
        <p>
          <span>Outstanding · historical PKR</span>
          <strong>{money(report.total)}</strong>
        </p>
        <p>
          <span>Ledger control balance</span>
          <strong>{money(report.control)}</strong>
        </p>
        <p>
          <span>Reconciliation difference</span>
          <strong>{money(report.difference)}</strong>
        </p>
      </div>
      {report.difference !== "0" ? (
        <ErrorBox error="The document balances do not match the ledger. Review the control account before using this report." />
      ) : null}
      <Table headers={[...ageingLabels, "Total · PKR"]}>
        <tr>
          {report.buckets.map((b, i) => (
            <td className="num" key={i}>
              {money(b)}
            </td>
          ))}
          <td className="num">
            <strong>{money(report.total)}</strong>
          </td>
        </tr>
      </Table>
      <Field label="Ageing view">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="detail">Document detail</option>
          <option value="summary">By company and currency</option>
        </select>
      </Field>
      {mode === "detail" ? (
        <Table
          headers={[
            "Entity",
            payable ? "Vendor / bill" : "Customer / invoice",
            "Date",
            "Due",
            "Days overdue",
            "Age band",
            "Balance · transaction currency",
            "Balance · PKR",
          ]}
        >
          {report.documents.map((d) => (
            <tr key={d.id}>
              <td>{d.entity_code}</td>
              <td>
                <a href={`#${payable ? "bill" : "invoice"}/${d.id}`}>
                  {d.number}
                </a>
                <small>{d.party}</small>
              </td>
              <td>{day(d.date)}</td>
              <td>{day(d.due_date)}</td>
              <td>{Math.max(0, d.days)}</td>
              <td>{ageingLabels[d.bucket]}</td>
              <td className="num">{money(d.outstanding, d.currency)}</td>
              <td className="num">{money(d.base)}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Table
          headers={["Entity", "Company", "Currency", ...ageingLabels, "Total"]}
        >
          {currencySummary(report).map((g, i) => (
            <tr key={i}>
              <td>{g.entity}</td>
              <td>{g.party}</td>
              <td>{g.currency}</td>
              {g.buckets.map((b, n) => (
                <td className="num" key={n}>
                  {money(b, g.currency)}
                </td>
              ))}
              <td className="num">
                {money(
                  g.buckets.reduce((a, b) => a + b, 0n),
                  g.currency,
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {!report.documents.length ? (
        <p className="muted">No outstanding posted documents at this date.</p>
      ) : null}
      <p className="muted">
        A document due on the report date is current. Later payments and
        reversals are excluded. Transaction currencies remain separate; PKR uses
        recorded carrying amounts, without period-end FX revaluation.
      </p>
    </>
  );
}
function AccountDrawer({
  selected,
  me,
  close,
}: {
  selected: Selection;
  me: Me;
  close: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: [
      "financial-detail",
      me.organization.id,
      me.user.id,
      selected,
      offset,
    ],
    queryFn: () =>
      request<AccountDetail>(
        `account-detail?${new URLSearchParams({ entityId: selected.entityId, code: selected.code, from: selected.from, to: selected.to, offset: String(offset) })}`,
      ),
  });
  return (
    <Drawer
      title={`${selected.code} · ${selected.name}`}
      dirty={false}
      close={close}
    >
      <div className="editor-body">
        <p>
          {day(selected.from)} – {day(selected.to)} · PKR · debit-positive
          balances
        </p>
        {q.isPending ? (
          <p role="status">Loading account transactions…</p>
        ) : null}
        {q.error ? (
          <>
            <ErrorBox error={q.error.message} />
            <button onClick={() => q.refetch()}>Retry</button>
          </>
        ) : null}
        {q.data ? (
          <>
            <p>
              {q.data.account.entity_code} · Opening {money(q.data.opening)} ·
              Closing {money(q.data.closing)}
            </p>
            <Table
              headers={["Date", "Transaction", "Debit", "Credit", "Balance"]}
            >
              {q.data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{day(l.posted_on)}</td>
                  <td>
                    {l.description}
                    <small>{l.source_type}</small>
                  </td>
                  <td className="num">{money(l.debit)}</td>
                  <td className="num">{money(l.credit)}</td>
                  <td className="num">{money(l.balance)}</td>
                </tr>
              ))}
            </Table>
            <div className="toolbar">
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              >
                Previous 100
              </button>
              <span>
                {q.data.total ? offset + 1 : 0}–
                {Math.min(offset + 100, q.data.total)} of {q.data.total}
              </span>
              <button
                disabled={offset + 100 >= q.data.total}
                onClick={() => setOffset(offset + 100)}
              >
                Next 100
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
export function FinancialReports({ me, entity }: { me: Me; entity: string }) {
  const [kind, setKind] = useState<Kind>("profit");
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`),
    [to, setTo] = useState(today());
  const [filter, setFilter] = useState({ from, to });
  const [selected, setSelected] = useState<Selection | null>(null);
  useEffect(() => setSelected(null), [entity]);
  const [validation, setValidation] = useState("");
  const q = useQuery({
    queryKey: [
      "financial-report",
      me.organization.id,
      me.user.id,
      entity,
      filter,
    ],
    queryFn: () =>
      request<FinancialReport>(
        `financial-reports?${new URLSearchParams({ entityId: entity, ...filter })}`,
      ),
  });
  const r = q.data;
  const period = ["profit", "cash", "trial"].includes(kind);
  const changed = from !== filter.from || to !== filter.to;
  function select(a: AccountBalance) {
    setSelected({
      entityId: a.entity_id,
      code: a.code,
      name: a.name,
      from: period ? filter.from : "1900-01-01",
      to: filter.to,
    });
  }
  function accountRows(
    accounts: AccountBalance[],
    closing: boolean,
    creditPositive: boolean,
  ) {
    return accounts.map((a) => (
      <tr key={a.entity_id + a.code}>
        <td>{a.entity_code}</td>
        <td>
          <button className="report-account" onClick={() => select(a)}>
            {a.code} · {a.name}
          </button>
        </td>
        <td className="num">
          {money(
            (closing ? BigInt(a.closing) : net(a)) *
              (creditPositive ? -1n : 1n),
          )}
        </td>
      </tr>
    ));
  }
  function exportReport() {
    if (!r) return;
    const rows: string[][] = [
      [titles[kind]],
      ["Entity scope", r.entities.map((e) => e.code).join(" / ")],
      ["From", period ? filter.from : "Inception"],
      ["As at", filter.to],
      ["Basis", "Accrual; PKR carrying amounts; no consolidation eliminations"],
    ];
    if (kind === "ar" || kind === "ap") {
      rows.push([
        "Entity",
        "Company",
        "Document",
        "Date",
        "Due",
        "Age band",
        "Currency",
        "Outstanding",
        "PKR carrying amount",
      ]);
      for (const d of (kind === "ar" ? r.receivables : r.payables).documents)
        rows.push([
          d.entity_code,
          d.party,
          d.number,
          d.date,
          d.due_date,
          ageingLabels[d.bucket],
          d.currency,
          decimal(d.outstanding),
          decimal(d.base),
        ]);
    } else if (kind === "cash") {
      rows.push(
        ["Line", "PKR"],
        ...[
          ["Opening cash", r.cash.opening],
          ["Net profit", r.profit],
          ["Working capital adjustments", r.cash.workingCapital],
          ["Capital and financing reclassification", r.cash.capitalAdjustment],
          ["Operating cash", r.cash.operating],
          ["Investing cash", r.cash.investing],
          ["Financing cash", r.cash.financing],
          ["Closing cash", r.cash.closing],
        ].map(([a, b]) => [a, decimal(b)]),
      );
    } else if (kind === "profit" || kind === "balance") {
      rows.push(["Entity", "Code", "Account", "Type", "Amount · PKR"]);
      for (const a of r.accounts.filter((a) =>
        kind === "profit"
          ? ["Income", "Expense"].includes(a.type)
          : ["Asset", "Liability", "Equity"].includes(a.type),
      )) {
        const debitPositive = kind === "profit" ? net(a) : BigInt(a.closing);
        const value = ["Income", "Liability", "Equity"].includes(a.type)
          ? -debitPositive
          : debitPositive;
        rows.push([a.entity_code, a.code, a.name, a.type, decimal(value)]);
      }
      if (kind === "profit")
        rows.push(
          ["Total income", decimal(r.income)],
          ["Total expenses", decimal(r.expenses)],
          ["Net profit / (loss)", decimal(r.profit)],
        );
      else
        rows.push(
          ["Total assets", decimal(r.assets)],
          ["Total liabilities", decimal(r.liabilities)],
          ["Posted equity", decimal(r.equity)],
          ["Unclosed earnings", decimal(r.earnings)],
          [
            "Liabilities and equity",
            decimal(
              BigInt(r.liabilities) + BigInt(r.equity) + BigInt(r.earnings),
            ),
          ],
          ["Reconciliation difference", decimal(r.balanceDifference)],
        );
    } else {
      rows.push([
        "Entity",
        "Code",
        "Account",
        "Type",
        "Opening debit-positive",
        "Period debits",
        "Period credits",
        "Closing debit-positive",
      ]);
      for (const a of r.accounts)
        rows.push([
          a.entity_code,
          a.code,
          a.name,
          a.type,
          decimal(a.opening),
          decimal(a.debit),
          decimal(a.credit),
          decimal(a.closing),
        ]);
      rows.push(
        ["Net profit for period", decimal(r.profit)],
        ["Accumulated unclosed earnings", decimal(r.earnings)],
      );
    }
    downloadCsv(rows, `gv-${kind}-${filter.to}.csv`);
  }
  return (
    <div className="financial-reports">
      <Heading
        title="Financial reports"
        subtitle="Posted books, with transaction drill-down and historical balances."
      />
      <form
        className="report-controls"
        onSubmit={(e) => {
          e.preventDefault();
          if (from > to || from < "1900-01-01") {
            setValidation("Choose a valid range from 1900 onwards.");
            return;
          }
          setValidation("");
          if (from === filter.from && to === filter.to) void q.refetch();
          setFilter({ from, to });
        }}
      >
        <Field label="Report">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {Object.entries(titles).map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="From"
          hint={
            period
              ? undefined
              : "Balance and ageing reports include all history through As at."
          }
        >
          <input
            type="date"
            required
            min="1900-01-01"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="As at">
          <input
            type="date"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <button className="primary" type="submit">
          Run report
        </button>
      </form>
      {validation ? <ErrorBox error={validation} /> : null}
      {changed ? (
        <p role="status">
          Dates changed. Run report to apply them; results below retain their
          displayed dates.
        </p>
      ) : null}
      {q.isPending ? (
        <p aria-busy="true" role="status">
          Calculating from the ledger…
        </p>
      ) : null}
      {q.error ? (
        <>
          <ErrorBox error={q.error.message} />
          <button onClick={() => q.refetch()}>Retry report</button>
        </>
      ) : null}
      {r ? (
        <section className="report-paper">
          <div className="section-title">
            <div>
              <h2>{titles[kind]}</h2>
              <p>
                {r.entities.map((e) => e.code).join(" · ")} ·{" "}
                {period ? `${day(filter.from)} – ` : "As at "}
                {day(filter.to)}
              </p>
            </div>
            <div className="report-actions">
              <button
                disabled={kind === "cash" && r.cash.unsupported.length > 0}
                onClick={exportReport}
              >
                Export CSV
              </button>
              <button onClick={() => window.print()}>Print / Save PDF</button>
            </div>
          </div>
          <p className="muted">
            Accrual basis · PKR.{" "}
            {entity === "all"
              ? "Combined legal entities; not consolidated accounts—no intercompany eliminations."
              : "Single legal entity."}
          </p>
          {r.balanceDifference !== "0" ? (
            <ErrorBox
              error={`Ledger imbalance: ${money(r.balanceDifference)}. Review before relying on these reports.`}
            />
          ) : null}
          {kind === "profit" ? (
            <>
              <Table headers={["Entity", "Income account", "Amount · PKR"]}>
                {accountRows(
                  r.accounts.filter((a) => a.type === "Income"),
                  false,
                  true,
                )}
              </Table>
              <p className="report-total">
                Total income <strong>{money(r.income)}</strong>
              </p>
              <Table headers={["Entity", "Expense account", "Amount · PKR"]}>
                {accountRows(
                  r.accounts.filter((a) => a.type === "Expense"),
                  false,
                  false,
                )}
              </Table>
              <p className="report-total">
                Total expenses <strong>{money(r.expenses)}</strong>
              </p>
              <p className="report-total strong">
                Net profit / (loss) <strong>{money(r.profit)}</strong>
              </p>
            </>
          ) : null}
          {kind === "balance" ? (
            <>
              {(
                [
                  ["Asset", "Assets", r.assets, false],
                  ["Liability", "Liabilities", r.liabilities, true],
                  ["Equity", "Contributed and posted equity", r.equity, true],
                ] as const
              ).map(([type, title, value, credit]) => (
                <section key={type}>
                  <h3>{title}</h3>
                  <Table headers={["Entity", "Account", "Balance · PKR"]}>
                    {accountRows(
                      r.accounts.filter((a) => a.type === type),
                      true,
                      credit,
                    )}
                  </Table>
                  <p className="report-total">
                    {title}
                    <strong>{money(value)}</strong>
                  </p>
                </section>
              ))}
              <p className="report-total">
                Unclosed earnings · all posted periods
                <strong>{money(r.earnings)}</strong>
              </p>
              <p className="report-total strong">
                Liabilities and equity
                <strong>
                  {money(
                    BigInt(r.liabilities) +
                      BigInt(r.equity) +
                      BigInt(r.earnings),
                  )}
                </strong>
              </p>
              <p>
                Assets less liabilities and equity: {money(r.balanceDifference)}
              </p>
            </>
          ) : null}
          {kind === "trial" ? (
            <>
              <Table
                headers={[
                  "Entity",
                  "Account",
                  "Opening · Dr / (Cr)",
                  "Debit",
                  "Credit",
                  "Closing · Dr / (Cr)",
                ]}
              >
                {r.accounts.map((a) => (
                  <tr key={a.entity_id + a.code}>
                    <td>{a.entity_code}</td>
                    <td>
                      <button
                        className="report-account"
                        onClick={() => select(a)}
                      >
                        {a.code} · {a.name}
                      </button>
                    </td>
                    <td className="num">{money(a.opening)}</td>
                    <td className="num">{money(a.debit)}</td>
                    <td className="num">{money(a.credit)}</td>
                    <td className="num">{money(a.closing)}</td>
                  </tr>
                ))}
              </Table>
              <p>
                Opening net: {money(total(r.accounts, "opening"))} · Closing
                net: {money(total(r.accounts, "closing"))}
              </p>
            </>
          ) : null}
          {kind === "cash" ? (
            r.cash.unsupported.length ? (
              <ErrorBox
                error={`Cash-flow classification needs review for: ${r.cash.unsupported.join(", ")}. No cash-flow statement is presented until these movements are classified.`}
              />
            ) : (
              <>
                <h3>Operating activities · indirect method</h3>
                {[
                  ["Net profit / (loss)", r.profit],
                  [
                    "Changes in operating assets and liabilities",
                    r.cash.workingCapital,
                  ],
                  [
                    "Capital and financing movements excluded from operating cash",
                    r.cash.capitalAdjustment,
                  ],
                  ["Net operating cash", r.cash.operating],
                  [
                    "Investing cash · equipment payments net of reversals",
                    r.cash.investing,
                  ],
                  ["Financing cash", r.cash.financing],
                  [
                    "Net cash movement",
                    String(BigInt(r.cash.closing) - BigInt(r.cash.opening)),
                  ],
                  ["Opening bank and cash", r.cash.opening],
                  ["Closing bank and cash", r.cash.closing],
                ].map(([label, value]) => (
                  <p className="report-total" key={label}>
                    {label}
                    <strong>{money(value)}</strong>
                  </p>
                ))}
                <p className="muted">
                  Unpaid equipment purchases are non-cash. Mixed
                  equipment/operating bill settlements allocate the actual
                  vendor cash by the original posted bill proportions; bank fees
                  remain operating. Cash is the recorded bank/cash ledger, not a
                  bank-confirmed balance.
                </p>
                {r.cash.difference !== "0" ? (
                  <ErrorBox
                    error={`Cash bridge differs by ${money(r.cash.difference)}.`}
                  />
                ) : null}
              </>
            )
          ) : null}
          {kind === "ar" || kind === "ap" ? (
            <Ageing
              key={kind + filter.to + entity}
              payable={kind === "ap"}
              report={kind === "ar" ? r.receivables : r.payables}
            />
          ) : null}
        </section>
      ) : null}
      {selected ? (
        <AccountDrawer
          key={JSON.stringify(selected)}
          selected={selected}
          me={me}
          close={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
