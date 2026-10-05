import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { ContactCompanyField } from "./ContactCompanyField";
import { NumberSeriesField } from "./NumberSeriesField";
import {
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
  draftLines,
} from "./browserDraft";
import { useQueryClient } from "@tanstack/react-query";
import { Heading, Table, Field, ErrorBox, Badge } from "./components";
import { request, today, money, rate, type Data, type Me } from "./model";
import { totals, scaled } from "../shared/money";
import type { PurchaseOrder } from "../shared/purchase-orders";

const blankLine = () => ({
  description: "",
  quantity: "1",
  price: "0",
  tax: "0",
  account_code: "5000",
});
const quantity = (n: bigint) =>
  `${n / 1000n}.${String(n % 1000n).padStart(3, "0")}`;
function used(po: PurchaseOrder, index: number, posted = false) {
  return po.allocations
    .filter(
      (a) =>
        a.line_index === index &&
        a.status !== "Voided" &&
        (!posted || ["Open", "Paid"].includes(a.status)),
    )
    .reduce((n, a) => n + BigInt(a.quantity_millis), 0n);
}
export function PurchaseOrders({
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
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false),
    [billing, setBilling] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const po = data.purchaseOrders.find((p) => p.id === id);
  async function save(c: unknown) {
    const result = await request<{ id: string }>(
      "commands",
      "POST",
      c,
      me.csrf,
    );
    await cache.invalidateQueries({ queryKey: ["data"] });
    return result;
  }
  async function status(value: "Issued" | "Closed" | "Cancelled") {
    const reason = prompt(
      value === "Issued"
        ? "Reason for issuing/reopening this purchase order (this does not email the vendor):"
        : `Reason to mark this purchase order ${value.toLowerCase()}:`,
    );
    if (!reason?.trim() || !po) return;
    setBusy(true);
    setError("");
    try {
      await save({
        action: "purchase-order.status",
        id: po.id,
        version: po.version,
        status: value,
        reason,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (editing)
    return (
      <OrderForm
        data={data}
        me={me}
        entity={entity}
        po={po}
        save={save}
        close={() => setEditing(false)}
      />
    );
  if (billing && po)
    return (
      <BillConversion
        po={po}
        me={me}
        save={save}
        close={() => setBilling(false)}
      />
    );
  if (id && !po)
    return <ErrorBox error="Purchase order not found in this organization." />;
  if (po)
    return (
      <>
        <a href="#purchase-orders">← All purchase orders</a>
        <Heading
          title={po.number}
          subtitle={`${po.vendor_name} · ${po.entity_name}`}
        />
        <ErrorBox error={error} />
        <div className="toolbar">
          <Badge>{po.status}</Badge>
          <div className="row-actions">
            {po.status === "Draft" && (
              <button onClick={() => setEditing(true)}>Edit draft</button>
            )}
            {["Draft", "Closed"].includes(po.status) && (
              <button disabled={busy} onClick={() => void status("Issued")}>
                {po.status === "Closed" ? "Reopen" : "Issue purchase order"}
              </button>
            )}
            {po.status === "Issued" && (
              <>
                <button className="primary" onClick={() => setBilling(true)}>
                  Convert to bill
                </button>
                <button disabled={busy} onClick={() => void status("Closed")}>
                  Close remaining order
                </button>
              </>
            )}
            {["Draft", "Issued"].includes(po.status) &&
              !po.allocations.some((a) => a.status !== "Voided") && (
                <button
                  disabled={busy}
                  onClick={() => void status("Cancelled")}
                >
                  Cancel order
                </button>
              )}
          </div>
        </div>
        <p>
          Ordered {po.order_date}
          {po.delivery_date ? ` · Delivery ${po.delivery_date}` : ""} ·{" "}
          {money(po.total_minor, po.currency)} ·{" "}
          {po.reference || "No vendor reference"}
        </p>
        <p>
          Purchase orders do not affect your books. Draft and pending bills
          reserve quantities; only approved bills count as billed.
        </p>
        {po.deal_id && (
          <p>
            Project:{" "}
            <a href={`#deal/${po.deal_id}`}>
              {data.deals.find((d) => d.id === po.deal_id)?.name ||
                "View project"}
            </a>
          </p>
        )}
        <Table
          headers={[
            "Item",
            "Ordered",
            "Reserved / billed",
            "Approved",
            "Remaining",
            "Rate",
          ]}
        >
          {po.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.description}</td>
              <td>{l.quantity}</td>
              <td>{quantity(used(po, i))}</td>
              <td>{quantity(used(po, i, true))}</td>
              <td>{quantity(scaled(l.quantity, 3) - used(po, i))}</td>
              <td>
                {l.price} {po.currency}
              </td>
            </tr>
          ))}
        </Table>
        <h2>Linked bills</h2>
        {data.bills
          .filter((b) => b.purchase_order_id === po.id)
          .map((b) => (
            <p key={b.id}>
              <a href={`#bill/${b.id}`}>{b.reference}</a> · {b.status} ·{" "}
              {money(b.total_minor, b.currency)}
            </p>
          ))}
        {!data.bills.some((b) => b.purchase_order_id === po.id) && (
          <p>No bills yet.</p>
        )}
        {po.delivery_address && <p>Delivery: {po.delivery_address}</p>}
        {po.notes && <p>{po.notes}</p>}
        {po.terms && <p>Terms: {po.terms}</p>}
      </>
    );
  return (
    <>
      <Heading
        title="Purchase orders"
        subtitle="Order from vendors, then convert selected quantities into bills."
        action="New purchase order"
        onAction={() => setEditing(true)}
      />
      <Field label="Search purchase orders">
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      <Table
        headers={["Order", "Vendor", "Legal entity", "Date", "Status", "Total"]}
      >
        {data.purchaseOrders
          .filter(
            (p) =>
              (entity === "all" || p.entity_id === entity) &&
              `${p.number} ${p.vendor_name} ${p.reference}`
                .toLowerCase()
                .includes(search.toLowerCase()),
          )
          .map((p) => (
            <tr key={p.id}>
              <td>
                <a href={`#purchase-orders/${p.id}`}>{p.number}</a>
              </td>
              <td>{p.vendor_name}</td>
              <td>{p.entity_name}</td>
              <td>{p.order_date}</td>
              <td>
                <Badge>{p.status}</Badge>
              </td>
              <td>{money(p.total_minor, p.currency)}</td>
            </tr>
          ))}
      </Table>
      {!data.purchaseOrders.length && (
        <p>No purchase orders yet. Create your first vendor order above.</p>
      )}
    </>
  );
}
function OrderForm({
  data,
  me,
  entity,
  po,
  save,
  close,
}: {
  data: Data;
  me: Me;
  entity: string;
  po?: PurchaseOrder;
  save: (c: unknown) => Promise<{ id: string }>;
  close: () => void;
}) {
  const draftKey = `purchase-order/${me.organization.id}/${me.user.id}/${po?.id || "new"}/${po?.version || 0}`;
  const [restored] = useState(() =>
    readBrowserDraft(
      draftKey,
      z.object({
        savedAt: z.number(),
        lines: z.array(draftLines.element.extend({ account_code: z.string() })),
        entity: z.string(),
        currency: z.string(),
        vendor: z.string(),
        requestKey: z.uuid(),
        fields: z.record(z.string(), z.string()),
      }),
    ),
  );
  const form = useRef<HTMLFormElement>(null);
  const [vendor, setVendor] = useState(restored?.vendor || po?.vendor_id || "");
  const [inlineOpen, setInlineOpen] = useState(false),
    [inlineBusy, setInlineBusy] = useState(false);
  const [lines, setLines] = useState(
    () =>
      restored?.lines ||
      po?.lines.map(({ description, quantity, price, tax, account_code }) => ({
        description,
        quantity,
        price,
        tax,
        account_code,
      })) || [blankLine()],
  );
  const [selectedEntity, setEntity] = useState(
    restored?.entity || po?.entity_id || (entity === "all" ? "" : entity),
  );
  const [currency, setCurrency] = useState(
    restored?.currency || po?.currency || "PKR",
  );
  const [series, setSeries] = useState(restored?.fields.number_series_id || "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [requestKey] = useState(
    () => restored?.requestKey || crypto.randomUUID(),
  );
  function persist() {
    if (form.current)
      writeBrowserDraft(draftKey, {
        lines,
        entity: selectedEntity,
        currency,
        vendor,
        requestKey,
        fields: Object.fromEntries(new FormData(form.current)),
      });
  }
  useEffect(() => {
    persist();
  }, [lines, selectedEntity, currency, vendor, series]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  let total = "0";
  try {
    total = totals(lines).total;
  } catch {
    /* Incomplete line inputs are allowed until save. */
  }
  return (
    <form
      ref={form}
      onChange={persist}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const f = new FormData(e.currentTarget);
        try {
          const fields = {
            vendor_id: vendor,
            deal_id: f.get("project") || null,
            order_date: f.get("date"),
            delivery_date: f.get("delivery") || null,
            currency,
            fx: currency === "PKR" ? "1" : f.get("fx"),
            lines,
            tax_treatment: f.get("tax_treatment"),
            reference: f.get("reference"),
            notes: f.get("notes"),
            terms: f.get("terms"),
            delivery_address: f.get("address"),
          };
          const result = await save(
            po
              ? {
                  action: "purchase-order.edit",
                  id: po.id,
                  version: po.version,
                  ...fields,
                }
              : {
                  action: "purchase-order.create",
                  entity_id: selectedEntity,
                  request_key: requestKey,
                  ...(series ? { number_series_id: series } : {}),
                  ...fields,
                },
          );
          clearBrowserDraft(draftKey);
          close();
          location.hash = `purchase-orders/${result.id}`;
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Heading
        title={po ? `Edit ${po.number}` : "New purchase order"}
        subtitle="Save a draft first. Issue when ready; no accounting entries are created."
      />
      <ErrorBox error={error} />
      <Field label="Legal entity">
        <select
          required
          value={selectedEntity}
          disabled={!!po}
          onChange={(e) => {
            setEntity(e.target.value);
            setSeries("");
          }}
        >
          <option value="">Select legal entity</option>
          {data.entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      <p>
        {restored ? "Recovered your unsaved order. " : ""}Changes are kept in
        this browser tab for 24 hours.
      </p>
      <ContactCompanyField
        companies={data.companies.filter((c) => c.vendor)}
        create={save}
        initialCompanyId={vendor}
        onSelectionChange={setVendor}
        onOpenChange={setInlineOpen}
        onBusyChange={setInlineBusy}
        onChange={() => {}}
        required
        vendor
        draftKey={`${draftKey}/vendor`}
      />
      <NumberSeriesField
        data={data}
        entityId={selectedEntity}
        kind="purchase-order"
        selectedId={series}
        onSelect={setSeries}
        create={save}
        canManage
        existingNumber={po?.number}
      />
      <input type="hidden" name="number_series_id" value={series} />
      <Field label="Project">
        <select
          name="project"
          key={selectedEntity}
          defaultValue={restored?.fields.project || po?.deal_id || ""}
        >
          <option value="">No project — company expense</option>
          {data.deals
            .filter((d) => d.entity_id === selectedEntity)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Order date">
        <input
          type="date"
          name="date"
          required
          defaultValue={restored?.fields.date || po?.order_date || today()}
        />
      </Field>
      <Field label="Expected delivery">
        <input
          type="date"
          name="delivery"
          defaultValue={restored?.fields.delivery || po?.delivery_date || ""}
        />
      </Field>
      <Field label="Currency">
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {["PKR", "USD", "AED", "EUR", "GBP"].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      {currency !== "PKR" && (
        <Field label="PKR per currency unit">
          <input
            name="fx"
            required
            defaultValue={
              restored?.fields.fx || (po ? rate(po.fx_micros) : "1")
            }
          />
        </Field>
      )}
      <Field label="Tax treatment">
        <select
          name="tax_treatment"
          defaultValue={
            restored?.fields.tax_treatment || po?.tax_treatment || "expense"
          }
        >
          <option value="expense">Include tax in expense</option>
          <option value="recoverable">Recoverable input tax</option>
        </select>
      </Field>
      <Table
        headers={[
          "Description",
          "Quantity",
          "Rate",
          "Tax %",
          "Account",
          "Remove",
        ]}
      >
        {lines.map((l, i) => (
          <tr key={i}>
            {(["description", "quantity", "price", "tax"] as const).map((k) => (
              <td key={k}>
                <input
                  aria-label={`${k} ${i + 1}`}
                  required
                  value={l[k]}
                  onChange={(e) =>
                    setLines(
                      lines.map((r, j) =>
                        i === j ? { ...r, [k]: e.target.value } : r,
                      ),
                    )
                  }
                />
              </td>
            ))}
            <td>
              <select
                aria-label={`Account ${i + 1}`}
                value={l.account_code}
                onChange={(e) =>
                  setLines(
                    lines.map((r, j) =>
                      i === j
                        ? {
                            ...r,
                            account_code: e.target
                              .value as typeof r.account_code,
                          }
                        : r,
                    ),
                  )
                }
              >
                <option value="5000">Operating expenses</option>
                <option value="5200">Project costs</option>
                <option value="1400">Prepayments</option>
                <option value="1500">Equipment</option>
              </select>
            </td>
            <td>
              <button
                type="button"
                disabled={lines.length === 1}
                onClick={() => setLines(lines.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </td>
          </tr>
        ))}
      </Table>
      <button
        type="button"
        disabled={lines.length >= 100}
        onClick={() => setLines([...lines, blankLine()])}
      >
        Add item
      </button>
      <p>Total: {money(total, currency)}</p>
      <details>
        <summary>Reference, delivery address, notes and terms</summary>
        {[
          ["reference", "Vendor reference", po?.reference],
          ["address", "Delivery address", po?.delivery_address],
          ["notes", "Notes", po?.notes],
          ["terms", "Terms", po?.terms],
        ].map(([name, label, value]) => (
          <Field key={name} label={label!}>
            <textarea
              name={name}
              defaultValue={restored?.fields[name!] || value || ""}
            />
          </Field>
        ))}
      </details>
      <div className="toolbar">
        <button className="primary" disabled={busy || inlineOpen || inlineBusy}>
          Save draft
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (confirm("Discard unsaved purchase order changes?")) {
              clearBrowserDraft(draftKey);
              close();
            }
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || inlineBusy}
          onClick={() => {
            persist();
            close();
          }}
        >
          Keep draft and close
        </button>
      </div>
    </form>
  );
}
function BillConversion({
  po,
  me,
  save,
  close,
}: {
  po: PurchaseOrder;
  me: Me;
  save: (c: unknown) => Promise<{ id: string }>;
  close: () => void;
}) {
  const draftKey = `purchase-order-bill/${me.organization.id}/${me.user.id}/${po.id}/${po.version}`;
  const [restored] = useState(() =>
    readBrowserDraft(
      draftKey,
      z.object({
        savedAt: z.number(),
        amounts: z.array(z.string()),
        key: z.uuid(),
        fields: z.record(z.string(), z.string()),
      }),
    ),
  );
  const form = useRef<HTMLFormElement>(null);
  const [amounts, setAmounts] = useState(
    () =>
      restored?.amounts ||
      po.lines.map((l, i) => quantity(scaled(l.quantity, 3) - used(po, i))),
  );
  const [key] = useState(() => restored?.key || crypto.randomUUID()),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  function persist() {
    if (form.current)
      writeBrowserDraft(draftKey, {
        amounts,
        key,
        fields: Object.fromEntries(new FormData(form.current)),
      });
  }
  useEffect(() => {
    persist();
  }, [amounts]);
  return (
    <form
      ref={form}
      onChange={persist}
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        try {
          const allocations = amounts
            .map((quantity, index) => ({ index, quantity }))
            .filter((a) => scaled(a.quantity, 3) > 0n);
          const r = await save({
            action: "purchase-order.bill",
            id: po.id,
            version: po.version,
            reference: f.get("reference"),
            bill_date: f.get("date"),
            due_date: f.get("due"),
            fx: po.currency === "PKR" ? "1" : f.get("fx"),
            allocations,
            acknowledge_duplicate: f.get("duplicate") === "on",
            request_key: key,
          });
          clearBrowserDraft(draftKey);
          close();
          location.hash = `bill/${r.id}`;
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Heading
        title={`Bill ${po.number}`}
        subtitle="Choose quantities from the vendor's bill. Zero skips an item. The new bill remains a draft until reviewed and approved."
      />
      <ErrorBox error={error} />
      <Field label="Vendor bill reference">
        <input
          required
          name="reference"
          maxLength={200}
          defaultValue={restored?.fields.reference || ""}
        />
      </Field>
      <Field label="Bill date">
        <input
          required
          type="date"
          name="date"
          defaultValue={restored?.fields.date || today()}
          min={po.order_date}
        />
      </Field>
      <Field label="Due date">
        <input
          required
          type="date"
          name="due"
          defaultValue={restored?.fields.due || today()}
        />
      </Field>
      {po.currency !== "PKR" && (
        <Field label="Bill exchange rate — PKR per currency unit">
          <input
            name="fx"
            required
            defaultValue={restored?.fields.fx || rate(po.fx_micros)}
          />
        </Field>
      )}
      <Table headers={["Item", "Remaining", "Bill quantity"]}>
        {po.lines.map((l, i) => (
          <tr key={i}>
            <td>{l.description}</td>
            <td>{quantity(scaled(l.quantity, 3) - used(po, i))}</td>
            <td>
              <input
                aria-label={`Bill quantity ${i + 1}`}
                required
                value={amounts[i]}
                onChange={(e) =>
                  setAmounts(
                    amounts.map((v, j) => (j === i ? e.target.value : v)),
                  )
                }
              />
            </td>
          </tr>
        ))}
      </Table>
      <label>
        <input
          type="checkbox"
          name="duplicate"
          defaultChecked={restored?.fields.duplicate === "on"}
        />{" "}
        I checked this is a separate bill if the vendor reference already
        exists.
      </label>
      <div className="toolbar">
        <button className="primary" disabled={busy}>
          Create draft bill
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            clearBrowserDraft(draftKey);
            close();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            persist();
            close();
          }}
        >
          Keep draft and close
        </button>
      </div>
    </form>
  );
}
