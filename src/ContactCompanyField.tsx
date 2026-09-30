import { useId, useRef, useState } from "react";
import { Plus, Building2, ArrowLeft, Check } from "lucide-react";
import type { Company } from "./model";
import { Field, ErrorBox } from "./components";

type Props = {
  companies: Company[];
  create: (command: Record<string, unknown>) => Promise<{ id: string }>;
  onOpenChange: (open: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onChange: () => void;
  onSelectionChange?: (companyId: string) => void;
};
const normalized = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
export function ContactCompanyField({
  companies,
  create,
  onOpenChange,
  onBusyChange,
  onChange,
  onSelectionChange,
}: Props) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [selected, setSelected] = useState(""),
    [name, setName] = useState(""),
    [domain, setDomain] = useState("");
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );
  const retry = useRef<{ key: string; payload: string } | null>(null);
  const nameInput = useRef<HTMLInputElement>(null),
    picker = useRef<HTMLSelectElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId(),
    titleId = useId();
  const matches =
    name.trim().length >= 1
      ? companies
          .filter((c) => normalized(c.name).includes(normalized(name)))
          .sort(
            (a, b) =>
              Number(normalized(b.name) === normalized(name)) -
              Number(normalized(a.name) === normalized(name)),
          )
          .slice(0, 5)
      : [];
  const exact = companies.some((c) => normalized(c.name) === normalized(name));
  const options =
    created && !companies.some((c) => c.id === created.id)
      ? [...companies, created]
      : companies;
  const toggle = (value: boolean) => {
    setOpen(value);
    onOpenChange(value);
  };
  function finish(id: string, message: string) {
    setSelected(id);
    onSelectionChange?.(id);
    setNotice(message);
    setError("");
    toggle(false);
    onChange();
    // The picker stays mounted, preserving the contact and restoring keyboard context.
    picker.current?.focus();
  }
  async function add() {
    if (busy) return;
    if (!name.trim()) {
      setError("Enter the company name.");
      nameInput.current?.focus();
      return;
    }
    if (exact) {
      setError(
        "This company is already listed. Select it below to avoid a duplicate.",
      );
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setError("");
    const payload = {
      action: "company.create",
      name: name.trim(),
      domain: domain.trim(),
      customer: false,
      vendor: false,
      service_entity_id: null,
    };
    const fingerprint = JSON.stringify(payload);
    if (retry.current?.payload !== fingerprint)
      retry.current = { key: crypto.randomUUID(), payload: fingerprint };
    try {
      const result = await create({
        ...payload,
        request_key: retry.current!.key,
      });
      setCreated({ id: result.id, name: payload.name });
      finish(
        result.id,
        `${payload.name} created and selected. Continue adding your contact.`,
      );
      setName("");
      setDomain("");
      retry.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <section className="contact-company-field">
      <div className="company-picker-row">
        <Field label="Company">
          <select
            ref={picker}
            name="company_id"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              onSelectionChange?.(e.target.value);
              setNotice("");
              onChange();
            }}
          >
            <option value="">No company yet</option>
            {options.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          ref={trigger}
          type="button"
          className="add-company-button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={busy}
          onClick={() => {
            if (open) {
              nameInput.current?.focus();
              return;
            }
            setError("");
            setNotice("");
            toggle(true);
          }}
        >
          <Plus size={16} />
          Add company
        </button>
      </div>
      {notice ? (
        <p className="company-selected-notice" role="status">
          <Check size={16} />
          {notice}
        </p>
      ) : null}
      {open ? (
        <section
          id={panelId}
          className="inline-company-panel"
          aria-labelledby={titleId}
          aria-busy={busy}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (!busy) {
                toggle(false);
                setError("");
                trigger.current?.focus();
              }
            } else if (
              e.key === "Enter" &&
              e.target instanceof HTMLInputElement
            ) {
              e.preventDefault();
              void add();
            }
          }}
        >
          <div className="inline-company-title">
            <Building2 size={19} />
            <h3 id={titleId}>Add a company</h3>
          </div>
          <p className="muted">
            Your contact details stay here. Create the company, then pick up
            where you left off.
          </p>
          <Field label="New company name">
            <input
              ref={nameInput}
              autoFocus
              value={name}
              maxLength={200}
              disabled={busy}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
                onChange();
              }}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Company website (optional)"
            hint="For example, example.com. You can add other company details later."
          >
            <input
              value={domain}
              maxLength={200}
              disabled={busy}
              onChange={(e) => {
                setDomain(e.target.value);
                onChange();
              }}
              placeholder="example.com"
              autoComplete="off"
            />
          </Field>
          {matches.length ? (
            <div className="company-matches">
              <p>
                {exact
                  ? "This company may already exist:"
                  : "Similar companies already in your workspace:"}
              </p>
              {matches.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    finish(
                      c.id,
                      `${c.name} selected. No new company was created.`,
                    )
                  }
                >
                  Use {c.name}
                  {c.domain ? <small>{c.domain}</small> : null}
                </button>
              ))}
            </div>
          ) : null}
          {error ? <ErrorBox error={error} /> : null}
          <div className="inline-company-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                toggle(false);
                setError("");
                trigger.current?.focus();
              }}
            >
              <ArrowLeft size={15} />
              Back to contact
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || exact}
              onClick={() => void add()}
            >
              {busy ? "Creating company…" : "Create & select company"}
            </button>
          </div>
          <p className="small muted">
            Creating saves the company independently. Your contact is saved only
            when you save the contact form.
          </p>
        </section>
      ) : null}
    </section>
  );
}
