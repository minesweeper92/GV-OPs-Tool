import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Heading, Table, Field, Drawer, ErrorBox, Badge } from "./components";
import { BankSelect } from "./Banking";
import {
  request,
  money,
  decimal,
  rate,
  today,
  type Data,
  type Me,
  type Bill,
} from "./model";
import { minor, round } from "../shared/money";
import {
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
} from "./browserDraft";
import type { VendorCredit } from "../shared/vendor-credits";
import { hasCapability } from "../shared/permissions";
type Editor = {
  kind: "create" | "apply" | "refund";
  credit?: VendorCredit;
  billId?: string;
};
function remaining(data: Data, b: Bill, index: number) {
  const used = data.vendorCredits
    .filter((c) => c.bill_id === b.id && !c.reversal_date)
    .flatMap((c) => c.lines)
    .filter((l) => l.billLine === index);
  return {
    net:
      BigInt(b.lines[index].subtotal || "0") -
      used.reduce((n, l) => n + BigInt(l.subtotal), 0n),
    tax:
      BigInt(b.lines[index].taxMinor || "0") -
      used.reduce((n, l) => n + BigInt(l.taxMinor), 0n),
  };
}
export function VendorCredits({
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
    credit = data.vendorCredits.find((c) => c.id === id),
    canPost = hasCapability(me.user, "books.post");
  const [editor, setEditor] = useState<Editor | null>(() =>
    canPost && id && data.bills.some((b) => b.id === id)
      ? { kind: "create", billId: id }
      : null,
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState("");
  async function save(c: unknown) {
    const result = await request<{ id: string }>(
      "commands",
      "POST",
      c,
      me.csrf,
    );
    await Promise.all(
      [
        "data",
        "report",
        "financial-report",
        "financial-detail",
        "banking",
        "party-statement",
      ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
    );
    return result;
  }
  async function reverse(
    kind: "reverse" | "unapply" | "reverse-refund",
    id: string,
  ) {
    const date = prompt("Reversal date (YYYY-MM-DD)", today());
    if (!date) return;
    const reason = prompt("Reason for this reversal");
    if (!reason?.trim()) return;
    setBusy(true);
    setError("");
    try {
      await save({ action: `vendor-credit.${kind}`, id, date, reason });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const credits = data.vendorCredits.filter(
    (c) =>
      (entity === "all" || c.entity_id === entity) &&
      `${c.number} ${c.reference} ${c.vendor_name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      {credit ? (
        <>
          <a href="#vendor-credits">← All vendor credits</a>
          <Heading
            title={credit.number}
            subtitle={`${credit.vendor_name} · ${credit.entity_name}`}
          />
          <div className="toolbar">
            <Badge>
              {credit.reversal_date
                ? "Reversed"
                : BigInt(credit.available) > 0n
                  ? "Available"
                  : "Used"}
            </Badge>
            <div className="row-actions">
              {canPost && !credit.reversal_date && (
                <>
                  {BigInt(credit.available) > 0n && (
                    <>
                      <button
                        onClick={() => setEditor({ kind: "apply", credit })}
                      >
                        Apply to bill
                      </button>
                      <button
                        onClick={() => setEditor({ kind: "refund", credit })}
                      >
                        Record refund received
                      </button>
                    </>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => void reverse("reverse", credit.id)}
                  >
                    Reverse credit
                  </button>
                </>
              )}
            </div>
          </div>
          <p>
            Vendor reference: {credit.reference} · {credit.credit_date} ·{" "}
            <a href={`#bill/${credit.bill_id}`}>Source bill</a>
          </p>
          <p>
            Total {money(credit.total_minor, credit.currency)} · Available{" "}
            {money(credit.available, credit.currency)}
          </p>
          <p>{credit.reason}</p>
          <Table headers={["Item", "Credited subtotal", "Tax"]}>
            {credit.lines.map((l) => (
              <tr key={l.billLine}>
                <td>{l.description}</td>
                <td>{money(l.subtotal, credit.currency)}</td>
                <td>{money(l.taxMinor, credit.currency)}</td>
              </tr>
            ))}
          </Table>
          <h2>Applications and refunds</h2>
          <Table headers={["Type", "Date", "Amount", "Status", "Action"]}>
            {data.vendorCreditApplications
              .filter((a) => a.credit_id === credit.id)
              .map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`#bill/${a.bill_id}`}>Bill application</a>
                  </td>
                  <td>{a.application_date}</td>
                  <td>{money(a.amount_minor, credit.currency)}</td>
                  <td>{a.reversal_date ? "Reversed" : "Applied"}</td>
                  <td>
                    {canPost && !a.reversal_date && (
                      <button
                        disabled={busy}
                        onClick={() => void reverse("unapply", a.id)}
                      >
                        Reverse application
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            {data.vendorRefunds
              .filter((f) => f.credit_id === credit.id)
              .map((f) => (
                <tr key={f.id}>
                  <td>Refund received · {f.reference}</td>
                  <td>{f.refund_date}</td>
                  <td>{money(f.amount_minor, credit.currency)}</td>
                  <td>{f.reversal_date ? "Reversed" : "Recorded"}</td>
                  <td>
                    {canPost && !f.reversal_date && (
                      <button
                        disabled={busy}
                        onClick={() => void reverse("reverse-refund", f.id)}
                      >
                        Reverse refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </Table>
        </>
      ) : (
        <>
          <Heading
            title="Vendor credits"
            subtitle="Record vendor credit notes, apply them to bills, or record refunds received."
            action={canPost ? "New vendor credit" : undefined}
            onAction={() => setEditor({ kind: "create" })}
          />
          <Field label="Search vendor credits">
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Table
            headers={[
              "Credit",
              "Vendor reference",
              "Vendor",
              "Legal entity",
              "Total",
              "Available",
              "Status",
            ]}
          >
            {credits.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`#vendor-credits/${c.id}`}>{c.number}</a>
                </td>
                <td>{c.reference}</td>
                <td>{c.vendor_name}</td>
                <td>{c.entity_name}</td>
                <td>{money(c.total_minor, c.currency)}</td>
                <td>{money(c.available, c.currency)}</td>
                <td>
                  {c.reversal_date
                    ? "Reversed"
                    : BigInt(c.available) > 0n
                      ? "Available"
                      : "Used"}
                </td>
              </tr>
            ))}
          </Table>
          {!credits.length && (
            <p>No matching vendor credits. Start from an approved bill.</p>
          )}
        </>
      )}
      <ErrorBox error={error} />
      {editor && (
        <CreditForm
          key={`${editor.kind}/${editor.credit?.id || editor.billId || "new"}`}
          data={data}
          me={me}
          entity={entity}
          editor={editor}
          save={save}
          close={() => setEditor(null)}
        />
      )}
    </>
  );
}
function CreditForm({
  data,
  me,
  entity,
  editor,
  save,
  close,
}: {
  data: Data;
  me: Me;
  entity: string;
  editor: Editor;
  save: (c: unknown) => Promise<{ id: string }>;
  close: () => void;
}) {
  const v = editor.credit,
    key = `vendor-credit/${me.organization.id}/${me.user.id}/${editor.kind}/${v?.id || editor.billId || "new"}`;
  const [restored] = useState(() =>
    readBrowserDraft(
      key,
      z.object({
        savedAt: z.number(),
        bill: z.string(),
        amounts: z.record(z.string(), z.string()),
        fields: z.record(z.string(), z.string()),
        requestKey: z.uuid(),
      }),
    ),
  );
  const [billId, setBill] = useState(restored?.bill || editor.billId || ""),
    [amounts, setAmounts] = useState<Record<string, string>>(
      restored?.amounts || {},
    ),
    [requestKey] = useState(() => restored?.requestKey || crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null),
    b = data.bills.find((b) => b.id === billId);
  function persist() {
    if (form.current)
      writeBrowserDraft(key, {
        bill: billId,
        amounts,
        requestKey,
        fields: Object.fromEntries(new FormData(form.current)),
      });
  }
  useEffect(() => {
    persist();
  }, [billId, amounts]);
  let preview = 0n;
  try {
    if (b)
      for (const [index, value] of Object.entries(amounts)) {
        const r = remaining(data, b, Number(index)),
          a = minor(value);
        if (a > 0n && a <= r.net) preview += a + round(r.tax * a, r.net);
      }
  } catch {
    /* Preserve incomplete amounts until submission. */
  }
  const choices = data.bills.filter((b) =>
    editor.kind === "create"
      ? ["Open", "Paid"].includes(b.status) &&
        (entity === "all" || b.entity_id === entity)
      : b.status === "Open" &&
        b.entity_id === v!.entity_id &&
        b.vendor_id === v!.vendor_id &&
        b.currency === v!.currency,
  );
  return (
    <Drawer
      title={
        editor.kind === "create"
          ? "New vendor credit"
          : editor.kind === "apply"
            ? "Apply vendor credit"
            : "Record vendor refund received"
      }
      wide
      dirty
      close={() => {
        clearBrowserDraft(key);
        close();
      }}
    >
      <form
        ref={form}
        onChange={persist}
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            !confirm(
              editor.kind === "create"
                ? "Issue this vendor credit and post the cost/tax correction to the books?"
                : editor.kind === "apply"
                  ? "Apply this credit to the selected bill? No cash will move."
                  : "Record money already received from the vendor in your books? This does not request or transfer a refund.",
            )
          )
            return;
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            const base = { date: f.get("date"), request_key: requestKey };
            const result = await save(
              editor.kind === "create"
                ? {
                    action: "vendor-credit.create",
                    bill_id: billId,
                    ...base,
                    reference: f.get("reference"),
                    reason: f.get("reason"),
                    lines: Object.entries(amounts)
                      .filter(([, a]) => minor(a) > 0n)
                      .map(([i, amount]) => ({ index: Number(i), amount })),
                  }
                : editor.kind === "apply"
                  ? {
                      action: "vendor-credit.apply",
                      credit_id: v!.id,
                      bill_id: billId,
                      ...base,
                      amount: f.get("amount"),
                    }
                  : {
                      action: "vendor-credit.refund",
                      credit_id: v!.id,
                      ...base,
                      amount: f.get("amount"),
                      fx: v!.currency === "PKR" ? "1" : f.get("fx"),
                      bank_account_id: f.get("bank_account_id") || null,
                      reference: f.get("reference"),
                    },
            );
            clearBrowserDraft(key);
            close();
            location.hash = `vendor-credits/${v?.id || result.id}`;
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {restored ? "Recovered your unsaved fields. " : ""}This posts a
          financial transaction when confirmed. Changes are kept in this tab for
          24 hours.
        </p>
        {editor.kind !== "refund" && (
          <Field
            label={editor.kind === "create" ? "Source bill" : "Bill to credit"}
          >
            <select
              required
              value={billId}
              onChange={(e) => {
                setBill(e.target.value);
                setAmounts({});
              }}
            >
              <option value="">Select an approved bill</option>
              {choices.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.reference} · {b.vendor_name} · {b.entity_name} ·{" "}
                  {b.currency}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Transaction date">
          <input
            required
            type="date"
            name="date"
            defaultValue={restored?.fields.date || today()}
          />
        </Field>
        {editor.kind !== "apply" && (
          <Field
            label={
              editor.kind === "create"
                ? "Vendor credit reference"
                : "Refund reference"
            }
          >
            <input
              required
              name="reference"
              maxLength={200}
              defaultValue={restored?.fields.reference || ""}
            />
          </Field>
        )}
        {editor.kind === "create" ? (
          <>
            <Field label="Reason">
              <input
                required
                name="reason"
                maxLength={200}
                defaultValue={restored?.fields.reason || ""}
              />
            </Field>
            {b && (
              <>
                <p>
                  Tax treatment: {b.tax_treatment}. Enter the credited subtotal
                  before tax; proportional tax is calculated from the original
                  bill.
                </p>
                <Table
                  headers={["Item", "Remaining subtotal", "Credit subtotal"]}
                >
                  {b.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.description}</td>
                      <td>{money(remaining(data, b, i).net, b.currency)}</td>
                      <td>
                        <input
                          aria-label={`Credit subtotal ${i + 1}`}
                          value={amounts[i] || "0"}
                          onChange={(e) =>
                            setAmounts({ ...amounts, [i]: e.target.value })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </Table>
                <p>Credit total including tax: {money(preview, b.currency)}</p>
              </>
            )}
          </>
        ) : (
          <>
            <p>
              {v!.vendor_name} · {v!.entity_name} · Available{" "}
              {money(v!.available, v!.currency)}
            </p>
            <Field label="Amount">
              <input
                required
                name="amount"
                inputMode="decimal"
                defaultValue={restored?.fields.amount || decimal(v!.available)}
              />
            </Field>
            {editor.kind === "refund" && (
              <>
                {v!.currency !== "PKR" && (
                  <Field label="PKR per currency unit">
                    <input
                      required
                      name="fx"
                      defaultValue={restored?.fields.fx || rate(v!.fx_micros)}
                    />
                  </Field>
                )}
                <BankSelect
                  data={data}
                  entity={v!.entity_id}
                  defaultValue={restored?.fields.bank_account_id || ""}
                />
              </>
            )}
          </>
        )}
        <ErrorBox error={error} />
        <div className="editor-actions">
          <button className="primary" disabled={busy}>
            {editor.kind === "create"
              ? "Issue vendor credit"
              : editor.kind === "apply"
                ? "Apply credit"
                : "Record refund"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              persist();
              close();
            }}
          >
            Keep draft & close
          </button>
        </div>
      </form>
    </Drawer>
  );
}
