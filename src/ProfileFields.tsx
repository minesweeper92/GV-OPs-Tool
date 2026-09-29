import { Field } from "./components";
import type { Data } from "./model";
export type ProfileValue = Record<string, any>;
export function CustomFields({
  value,
  onChange,
}: {
  value: ProfileValue[];
  onChange: (v: ProfileValue[]) => void;
}) {
  const update = (i: number, k: string, v: string) =>
    onChange(value.map((f, n) => (n === i ? { ...f, [k]: v } : f)));
  return (
    <section>
      <h3>Custom fields</h3>
      {value.map((f, i) => (
        <div className="form-row" key={i}>
          <Field label={`Custom field ${i + 1} name`}>
            <input
              value={f.label}
              required
              maxLength={80}
              onChange={(e) => update(i, "label", e.target.value)}
            />
          </Field>
          <Field label={`Custom field ${i + 1} type`}>
            <select
              value={f.type}
              onChange={(e) => update(i, "type", e.target.value)}
            >
              {["Text", "Number", "Date", "Yes/No"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label={`Custom field ${i + 1} value`}>
            {f.type === "Yes/No" ? (
              <select
                value={f.value}
                onChange={(e) => update(i, "value", e.target.value)}
              >
                <option value="">Not set</option>
                <option>Yes</option>
                <option>No</option>
              </select>
            ) : (
              <input
                value={f.value}
                type={
                  f.type === "Date"
                    ? "date"
                    : f.type === "Number"
                      ? "number"
                      : "text"
                }
                step="any"
                maxLength={1000}
                onChange={(e) => update(i, "value", e.target.value)}
              />
            )}
          </Field>
          <button
            type="button"
            onClick={() => onChange(value.filter((_, n) => n !== i))}
            aria-label={`Remove custom field ${i + 1}`}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={value.length >= 30}
        onClick={() =>
          onChange([...value, { label: "", type: "Text", value: "" }])
        }
      >
        Add custom field
      </button>
    </section>
  );
}
export function ProfileFields({
  kind,
  value,
  onChange,
  data,
}: {
  kind: string;
  value: ProfileValue;
  onChange: (v: ProfileValue) => void;
  data: Data;
}) {
  const set = (k: string, v: any) => onChange({ ...value, [k]: v });
  const field = (key: string, label: string, type = "text") => (
    <Field key={key} label={label}>
      {type === "textarea" ? (
        <textarea
          value={value[key] || ""}
          maxLength={4000}
          onChange={(e) => set(key, e.target.value)}
        />
      ) : (
        <input
          type={type}
          step={type === "number" ? "any" : undefined}
          value={value[key] ?? ""}
          maxLength={200}
          onChange={(e) =>
            set(
              key,
              key === "payment_days" || key === "probability"
                ? Number(e.target.value)
                : type === "date"
                  ? e.target.value || null
                  : e.target.value,
            )
          }
        />
      )}
    </Field>
  );
  const select = (key: string, label: string, options: string[]) => (
    <Field label={label}>
      <select
        value={value[key] || ""}
        onChange={(e) => set(key, e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o || "Not set"}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <>
      {kind === "contact" ? (
        <>
          <h3>Personal and employment details</h3>
          <div className="form-row">
            {field("salutation", "Salutation")}
            {field("department", "Department")}
            {field("seniority", "Seniority")}
          </div>
          <div className="form-row">
            {select("preferred_channel", "Preferred channel", [
              "",
              "Email",
              "Phone",
              "WhatsApp",
              "Meeting",
            ])}
            {field("language", "Preferred language")}
            {field("timezone", "Time zone (e.g. Asia/Karachi)")}
          </div>
          {field("referrer", "Referred by")}
          <h3>Structured address</h3>
          <div className="form-row">
            {["street", "city", "region", "postal_code", "country"].map((k) => (
              <Field label={k.replace("_", " ")} key={k}>
                <input
                  value={value.location?.[k] || ""}
                  onChange={(e) =>
                    set("location", { ...value.location, [k]: e.target.value })
                  }
                />
              </Field>
            ))}
          </div>
        </>
      ) : kind === "company" ? (
        <>
          <h3>Business profile</h3>
          <div className="form-row">
            {select("customer_type", "Customer type", [
              "Business",
              "Individual",
            ])}
            {field("phone", "Company phone")}
            {field("source", "Company source")}
          </div>
          <Field label="Parent company">
            <select
              value={value.parent_company_id || ""}
              onChange={(e) => set("parent_company_id", e.target.value || null)}
            >
              <option value="">None</option>
              {data.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {field("notes", "Internal company notes", "textarea")}
          <h3>Financial defaults</h3>
          <div className="form-row">
            {select("currency", "Default customer currency", [
              "PKR",
              "USD",
              "AED",
              "EUR",
              "GBP",
            ])}
            {field("payment_days", "Payment terms (days)", "number")}
            {field("credit_limit", "Advisory credit limit (customer currency)")}
          </div>
          <Field label="Billing recipients (comma separated)">
            <input
              defaultValue={(value.billing_recipients || []).join(", ")}
              onChange={(e) =>
                set(
                  "billing_recipients",
                  e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
            />
          </Field>
          {field("document_notes", "Default customer-facing notes", "textarea")}
          {field(
            "payment_instructions",
            "Customer billing instructions",
            "textarea",
          )}
          <h3>Our vendor registrations with this company</h3>
          <p className="muted">
            One registration for each of your legal entities. This does not
            choose the issuing entity for a transaction.
          </p>
          {(value.registrations || []).map((r: ProfileValue, i: number) => {
            const update = (k: string, v: string) =>
              set(
                "registrations",
                value.registrations.map((x: ProfileValue, n: number) =>
                  n === i ? { ...x, [k]: v } : x,
                ),
              );
            return (
              <fieldset className="profile-group" key={i}>
                <legend>Registration {i + 1}</legend>
                <Field label={`Registration ${i + 1} legal entity`}>
                  <select
                    required
                    value={r.entity_id}
                    onChange={(e) => update("entity_id", e.target.value)}
                  >
                    <option value="">Choose explicitly</option>
                    {data.entities.map((e) => (
                      <option value={e.id} key={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Registration ${i + 1} vendor code`}>
                  <input
                    value={r.code}
                    onChange={(e) => update("code", e.target.value)}
                  />
                </Field>
                <Field label={`Registration ${i + 1} status`}>
                  <select
                    value={r.status}
                    onChange={(e) => update("status", e.target.value)}
                  >
                    {["Pending", "Active", "Expired", "Inactive"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`Registration ${i + 1} instructions`}>
                  <textarea
                    value={r.instructions}
                    onChange={(e) => update("instructions", e.target.value)}
                  />
                </Field>
                <Field label={`Registration ${i + 1} supporting document link`}>
                  <input
                    type="url"
                    value={r.reference_url}
                    onChange={(e) => update("reference_url", e.target.value)}
                  />
                </Field>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "registrations",
                      value.registrations.filter(
                        (_: any, n: number) => n !== i,
                      ),
                    )
                  }
                >
                  Remove registration
                </button>
              </fieldset>
            );
          })}
          <button
            type="button"
            onClick={() =>
              set("registrations", [
                ...(value.registrations || []),
                {
                  entity_id: "",
                  code: "",
                  status: "Pending",
                  instructions: "",
                  reference_url: "",
                },
              ])
            }
          >
            Add entity registration
          </button>
        </>
      ) : (
        <>
          <h3>Project and qualification</h3>
          {field("brief", "Project brief", "textarea")}
          <div className="form-row">
            {field("service", "Service category")}
            {select("priority", "Priority", ["Low", "Normal", "High"])}
          </div>
          <div className="form-row">
            {field("estimated_value", "Estimated value / budget")}
            {select("currency", "Budget currency", [
              "PKR",
              "USD",
              "AED",
              "EUR",
              "GBP",
            ])}
            {field("expected_close", "Expected decision date", "date")}
          </div>
          <Field label="End client / brand">
            <select
              value={value.end_client_id || ""}
              onChange={(e) => set("end_client_id", e.target.value || null)}
            >
              <option value="">Same as contracting customer</option>
              {data.companies.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {field("qualification_notes", "Qualification notes", "textarea")}
          {field("decision_process", "Decision process", "textarea")}
          <h3>Stakeholders</h3>
          <p className="muted">
            Roles apply to this project—not every project involving this person.
          </p>
          {(value.stakeholders || []).map((r: ProfileValue, i: number) => (
            <div className="form-row" key={i}>
              <Field label={`Stakeholder ${i + 1}`}>
                <select
                  required
                  value={r.contact_id}
                  onChange={(e) =>
                    set(
                      "stakeholders",
                      value.stakeholders.map((x: ProfileValue, n: number) =>
                        n === i ? { ...x, contact_id: e.target.value } : x,
                      ),
                    )
                  }
                >
                  <option value="">Choose contact</option>
                  {data.contacts.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.first_name} {c.last_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Stakeholder ${i + 1} role`}>
                <input
                  required
                  placeholder="Decision maker, approver, billing contact…"
                  value={r.role}
                  onChange={(e) =>
                    set(
                      "stakeholders",
                      value.stakeholders.map((x: ProfileValue, n: number) =>
                        n === i ? { ...x, role: e.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
              <button
                type="button"
                onClick={() =>
                  set(
                    "stakeholders",
                    value.stakeholders.filter((_: any, n: number) => n !== i),
                  )
                }
              >
                Remove stakeholder
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              set("stakeholders", [
                ...(value.stakeholders || []),
                { contact_id: "", role: "" },
              ])
            }
          >
            Add stakeholder
          </button>
          <details>
            <summary>Forecasting</summary>
            {field("pipeline", "Pipeline label")}
            {field("probability", "Win probability (%)", "number")}
            {select("forecast", "Forecast category", [
              "Not forecasted",
              "Pipeline",
              "Best case",
              "Commit",
              "Closed won",
            ])}
            {field("won_reason", "Won reason")}
          </details>
        </>
      )}
      <CustomFields
        value={value.custom_fields || []}
        onChange={(v) => set("custom_fields", v)}
      />
    </>
  );
}
export function ProfileSummary({
  value,
  data,
}: {
  value: ProfileValue;
  data: Data;
}) {
  const readable = (key: string, v: any): string => {
    if (key === "end_client_id" || key === "parent_company_id")
      return (
        data.companies.find((c) => c.id === v)?.name || "Unavailable company"
      );
    if (key === "stakeholders")
      return v
        .map(
          (s: any) =>
            `${data.contacts.find((c) => c.id === s.contact_id)?.first_name || "Contact"}: ${s.role}`,
        )
        .join("; ");
    if (key === "registrations")
      return v
        .map(
          (r: any) =>
            `${data.entities.find((e) => e.id === r.entity_id)?.code || "Entity"} · ${r.code} · ${r.status} · ${r.instructions}`,
        )
        .join("\n");
    if (key === "custom_fields")
      return v.map((f: any) => `${f.label}: ${f.value}`).join("\n");
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object")
      return Object.values(v).filter(Boolean).join(", ");
    return String(v);
  };
  return (
    <details className="panel space-top">
      <summary>Full profile details</summary>
      <dl className="profile-summary">
        {Object.entries(value)
          .filter(
            ([, v]) =>
              v !== null && v !== "" && (!Array.isArray(v) || v.length),
          )
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k.replaceAll("_", " ")}</dt>
              <dd className="preserve">{readable(k, v)}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}
