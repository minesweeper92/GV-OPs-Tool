import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ErrorBox, Field, Heading, Table, Empty } from "./components";
import {
  request,
  money,
  decimal,
  day,
  today,
  type Data,
  type Me,
} from "./model";
import type { PartyStatement } from "../shared/statements";

const labels: Record<string, string> = {
  invoice: "Invoice",
  invoice_void: "Invoice void",
  payment: "Payment received (including withholding)",
  credit: "Credit note",
  "credit-reversal": "Credit note reversal",
  "credit-application": "Credit applied",
  "credit-application-reversal": "Credit application reversed",
  "customer-refund": "Customer refund",
  "customer-refund-reversal": "Refund reversed",
  bill: "Bill",
  "bill-void": "Bill void",
  "vendor-payment": "Payment made (including withholding)",
  "vendor-payment-reversal": "Payment reversed",
  "vendor-credit": "Vendor credit",
  "vendor-credit-reversal": "Vendor credit reversed",
  "vendor-credit-application": "Vendor credit applied",
  "vendor-credit-application-reversal": "Vendor application reversed",
  "vendor-refund": "Refund received",
  "vendor-refund-reversal": "Vendor refund reversed",
};
function exportStatement(r: PartyStatement) {
  const rows: string[][] = [
    [`${r.filter.kind} statement`, r.company.name],
    ["From", r.filter.from, "To", r.filter.to],
    [
      "Entity",
      "Currency",
      "Date",
      "Transaction",
      "Reference",
      "Increase",
      "Decrease",
      "Balance",
      "Historical PKR balance",
    ],
  ];
  for (const g of r.groups) {
    rows.push([
      g.entity_code,
      g.currency,
      r.filter.from,
      "Opening balance",
      "",
      "",
      "",
      decimal(g.opening),
      decimal(g.openingBase),
    ]);
    for (const e of g.entries)
      rows.push([
        g.entity_code,
        g.currency,
        e.date,
        labels[e.type] || e.type,
        e.number,
        BigInt(e.amount) > 0n ? decimal(e.amount) : "",
        BigInt(e.amount) < 0n ? decimal(-BigInt(e.amount)) : "",
        decimal(e.balance),
        decimal(e.baseBalance),
      ]);
    rows.push([
      g.entity_code,
      g.currency,
      r.filter.to,
      "Closing balance",
      "",
      "",
      "",
      decimal(g.closing),
      decimal(g.closingBase),
    ]);
    rows.push([
      g.entity_code,
      g.currency,
      r.filter.to,
      "Unpaid documents",
      "",
      "",
      "",
      decimal(g.outstanding),
    ]);
    rows.push([
      g.entity_code,
      g.currency,
      r.filter.to,
      "Available credit",
      "",
      "",
      "",
      decimal(g.availableCredit),
    ]);
  }
  const cell = (v: string) =>
    `"${(/^[\s]*[=+@-]/.test(v) ? "'" + v : v).replaceAll('"', '""')}"`;
  const url = URL.createObjectURL(
    new Blob(
      ["\uFEFF", rows.map((row) => row.map(cell).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${r.filter.kind}-statement-${r.filter.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PartyStatements({
  data,
  me,
  entity,
  kind,
  initialCompanyId,
}: {
  data: Data;
  me: Me;
  entity: string;
  kind: "customer" | "vendor";
  initialCompanyId?: string;
}) {
  const [companyId, setCompanyId] = useState(initialCompanyId || "");
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const [mode, setMode] = useState("transactions");
  const valid = Boolean(companyId && from && to && from <= to);
  const query = useQuery<PartyStatement>({
    queryKey: [
      "party-statement",
      me.organization.id,
      me.user.id,
      entity,
      companyId,
      kind,
      from,
      to,
    ],
    queryFn: () =>
      request(
        `party-statement?${new URLSearchParams({ entityId: entity, companyId, kind, from, to })}`,
      ),
    enabled: valid,
  });
  const r = valid ? query.data : undefined;
  return (
    <section className="financial-reports party-statements">
      <Heading
        title={
          kind === "customer" ? "Customer statements" : "Vendor statements"
        }
        subtitle="Transactions, payments and balances together, separated by legal entity and currency."
      />
      <div className="report-controls form-row">
        <Field
          label={kind === "customer" ? "Customer company" : "Vendor company"}
        >
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
          >
            <option value="">Select a company</option>
            {data.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Statement from">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="Statement to">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Field label="Statement view">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="transactions">All transactions</option>
            <option value="outstanding">Unpaid documents</option>
          </select>
        </Field>
      </div>
      {!companyId ? (
        <Empty title="Choose a company">
          Select a company to view its statement.
        </Empty>
      ) : !valid ? (
        <ErrorBox error="Enter a valid date range; the start must not follow the end." />
      ) : query.isPending ? (
        <p role="status">Loading statement…</p>
      ) : query.error ? (
        <ErrorBox error={query.error.message} />
      ) : null}
      {r ? (
        <>
          <div className="report-actions">
            <button
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh
            </button>
            <button onClick={() => exportStatement(r)}>Export CSV</button>
            <button onClick={() => window.print()}>Print / Save PDF</button>
          </div>
          <article className="report-paper">
            <h2>
              {r.company.name} · {kind === "customer" ? "Customer" : "Vendor"}{" "}
              statement
            </h2>
            <p>
              {day(from)} – {day(to)} · generated {day(r.generatedAt)}
            </p>
            {r.company.address ? <p>{r.company.address}</p> : null}
            <p className="muted">
              Posted documents only. Drafts and quotes do not affect this
              statement. Payments include withholding; bank fees do not reduce
              the document balance. Unassigned manual control-account journals
              cannot be attributed to a company and are excluded.
            </p>
            {!r.groups.length ? (
              <Empty title="No transactions">
                No posted transactions through this end date.
              </Empty>
            ) : null}
            {r.groups.map((g) => (
              <section
                key={`${g.entity_id}/${g.currency}`}
                className="statement-group"
              >
                <h3>
                  {g.entity_name} ({g.entity_code}) · {g.currency}
                </h3>
                <div className="report-totals">
                  <p>
                    <span>Opening balance</span>
                    <strong>{money(g.opening, g.currency)}</strong>
                  </p>
                  <p>
                    <span>Closing net balance</span>
                    <strong>{money(g.closing, g.currency)}</strong>
                  </p>
                  <p>
                    <span>
                      Unpaid {kind === "customer" ? "invoices" : "bills"}
                    </span>
                    <strong>{money(g.outstanding, g.currency)}</strong>
                  </p>
                  <p>
                    <span>Available credits</span>
                    <strong>{money(g.availableCredit, g.currency)}</strong>
                  </p>
                </div>
                <p className="muted">
                  Net balance is unpaid{" "}
                  {kind === "customer" ? "invoices" : "bills"} less available
                  credits. Credits are not automatically applied. A negative
                  balance is
                  {kind === "customer"
                    ? "credit in the customer's favour."
                    : "credit owed to you by the vendor."}
                </p>
                {mode === "transactions" ? (
                  <Table
                    headers={[
                      "Date",
                      "Transaction / reference",
                      "Increase",
                      "Decrease",
                      "Running balance",
                    ]}
                  >
                    <tr>
                      <td>{day(from)}</td>
                      <td>Opening balance</td>
                      <td />
                      <td />
                      <td className="num">{money(g.opening, g.currency)}</td>
                    </tr>
                    {g.entries.map((e) => (
                      <tr key={e.id}>
                        <td>{day(e.date)}</td>
                        <td>
                          <a href={`#${e.link_type}/${e.link_id}`}>
                            {labels[e.type] || e.type} · {e.number}
                          </a>
                          <small className="muted">{e.description}</small>
                        </td>
                        <td className="num">
                          {BigInt(e.amount) > 0n
                            ? money(e.amount, g.currency)
                            : "—"}
                        </td>
                        <td className="num">
                          {BigInt(e.amount) < 0n
                            ? money(-BigInt(e.amount), g.currency)
                            : "—"}
                        </td>
                        <td className="num">{money(e.balance, g.currency)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>{day(to)}</td>
                      <td>
                        <strong>Closing balance</strong>
                      </td>
                      <td className="num">{money(g.increases, g.currency)}</td>
                      <td className="num">{money(g.decreases, g.currency)}</td>
                      <td className="num">
                        <strong>{money(g.closing, g.currency)}</strong>
                      </td>
                    </tr>
                  </Table>
                ) : g.documents.length ? (
                  <Table
                    headers={[
                      "Document",
                      "Date",
                      "Due date",
                      "Days overdue",
                      "Outstanding",
                    ]}
                  >
                    {g.documents.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <a
                            href={`#${kind === "customer" ? "invoice" : "bill"}/${d.id}`}
                          >
                            {d.number}
                          </a>
                        </td>
                        <td>{day(d.date)}</td>
                        <td>{day(d.due_date)}</td>
                        <td>{Math.max(0, d.days)}</td>
                        <td className="num">
                          {money(d.outstanding, g.currency)}
                        </td>
                      </tr>
                    ))}
                  </Table>
                ) : (
                  <Empty title="Nothing outstanding">
                    No unpaid documents as of this date.
                  </Empty>
                )}
                <p className="muted">
                  Historical carrying balance: {money(g.closingBase, "PKR")}.
                  This is not a current-rate currency conversion.
                </p>
              </section>
            ))}
          </article>
        </>
      ) : null}
    </section>
  );
}
