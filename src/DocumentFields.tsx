import { Field } from "./components";
import { CustomFields } from "./ProfileFields";
import type { DocumentDetails } from "../shared/documents";

export function DocumentFields({
  value,
  onChange,
  quote = false,
}: {
  value: DocumentDetails;
  onChange: (v: DocumentDetails) => void;
  quote?: boolean;
}) {
  const set = (key: keyof DocumentDetails, v: unknown) =>
    onChange({ ...value, [key]: v });
  const text = (key: keyof DocumentDetails, label: string, area = false) => (
    <Field key={key} label={label}>
      {area ? (
        <textarea
          value={String(value[key] || "")}
          maxLength={4000}
          onChange={(e) => set(key, e.target.value)}
        />
      ) : (
        <input
          value={String(value[key] || "")}
          maxLength={200}
          onChange={(e) => set(key, e.target.value)}
        />
      )}
    </Field>
  );
  return (
    <div className="document-fields">
      <h3>Document details</h3>
      <div className="form-row">
        {text("subject", "Subject / project description")}
        {text("reference", "Customer reference")}
        {text("purchase_order", "Purchase order number")}
      </div>
      {quote ? (
        <div className="form-row">
          <Field label="Quote date">
            <input
              type="date"
              required
              value={value.quote_date || ""}
              onChange={(e) => set("quote_date", e.target.value || null)}
            />
          </Field>
          <Field label="Valid until">
            <input
              type="date"
              value={value.valid_until || ""}
              min={value.quote_date || undefined}
              onChange={(e) => set("valid_until", e.target.value || null)}
            />
          </Field>
        </div>
      ) : null}
      <details open>
        <summary>Customer and delivery details</summary>
        <div className="form-row">
          {text("billing_address", "Customer billing address", true)}
          {text("shipping_address", "Delivery / shipping address", true)}
        </div>
        <div className="form-row">
          {text("attention", "Attention / contact person")}
          {text("customer_tax_id", "Customer tax registration")}
        </div>
        <Field
          label="Document recipients (comma separated)"
          hint="Saved for reference. This does not send an email."
        >
          <input
            defaultValue={value.recipients.join(", ")}
            onChange={(e) =>
              set(
                "recipients",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </Field>
      </details>
      <details>
        <summary>Scope, delivery and payment</summary>
        {text("payment_terms", "Payment terms label")}
        <div className="form-row">
          {text("inclusions", "Scope / inclusions", true)}
          {text("exclusions", "Exclusions", true)}
        </div>
        <div className="form-row">
          {text("delivery_schedule", "Delivery schedule", true)}
          {text("payment_schedule", "Payment schedule", true)}
        </div>
        {text("payment_instructions", "Payment instructions", true)}
        {text("customer_notes", "Customer-facing notes", true)}
      </details>
      <details>
        <summary>Presentation and custom fields</summary>
        <Field label="Document layout">
          <select
            value={value.template}
            onChange={(e) => set("template", e.target.value)}
          >
            <option>Standard</option>
            <option>Compact</option>
          </select>
        </Field>
        <CustomFields
          value={value.custom_fields}
          onChange={(v) => set("custom_fields", v)}
        />
      </details>
      <details>
        <summary>Supporting document links</summary>
        <p className="muted">
          Link files already stored in your document system. Access permissions
          remain with that system; files are not uploaded here.
        </p>
        {value.references.map((r, i) => (
          <div className="form-row" key={i}>
            <Field label={`Document link ${i + 1} name`}>
              <input
                required
                value={r.name}
                onChange={(e) =>
                  set(
                    "references",
                    value.references.map((x, n) =>
                      n === i ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
              />
            </Field>
            <Field label={`Document link ${i + 1} URL`}>
              <input
                type="url"
                required
                value={r.url}
                onChange={(e) =>
                  set(
                    "references",
                    value.references.map((x, n) =>
                      n === i ? { ...x, url: e.target.value } : x,
                    ),
                  )
                }
              />
            </Field>
            <button
              type="button"
              onClick={() =>
                set(
                  "references",
                  value.references.filter((_, n) => n !== i),
                )
              }
            >
              Remove link
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={value.references.length >= 20}
          onClick={() =>
            set("references", [...value.references, { name: "", url: "" }])
          }
        >
          Add document link
        </button>
      </details>
    </div>
  );
}

export function DocumentExtras({
  details,
}: {
  details: Partial<DocumentDetails>;
}) {
  const fields: [keyof DocumentDetails, string][] = [
    ["subject", "Subject"],
    ["reference", "Reference"],
    ["purchase_order", "Purchase order"],
    ["attention", "Attention"],
    ["customer_tax_id", "Customer tax ID"],
    ["billing_address", "Billing address"],
    ["shipping_address", "Delivery address"],
    ["quote_date", "Quote date"],
    ["valid_until", "Valid until"],
    ["payment_terms", "Payment terms"],
    ["inclusions", "Scope / inclusions"],
    ["exclusions", "Exclusions"],
    ["delivery_schedule", "Delivery schedule"],
    ["payment_schedule", "Payment schedule"],
    ["payment_instructions", "Payment instructions"],
    ["customer_notes", "Notes"],
  ];
  return (
    <section className="document-extras">
      <dl>
        {fields
          .filter(([key]) => details[key])
          .map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd className="preserve">{String(details[key])}</dd>
            </div>
          ))}
      </dl>
      {details.custom_fields?.map((f) => (
        <p className="preserve" key={f.label}>
          <strong>{f.label}: </strong>
          {f.value}
        </p>
      ))}
      {details.references?.length ? (
        <>
          <h3>Supporting documents</h3>
          {details.references.map((r, i) => (
            <p key={i}>
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.name} ↗
              </a>
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}
