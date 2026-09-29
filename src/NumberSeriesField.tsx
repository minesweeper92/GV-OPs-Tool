import { useState } from "react";
import { Plus, Settings2 } from "lucide-react";
import { ErrorBox, Field } from "./components";
import type { Data } from "./model";

export function NumberSeriesField({
  data,
  entityId,
  kind,
  selectedId,
  onSelect,
  create,
  canManage,
  existingNumber,
}: {
  data: Data;
  entityId: string;
  kind: "quote" | "invoice";
  selectedId: string;
  onSelect: (id: string) => void;
  create: (command: Record<string, unknown>) => Promise<{ id: string }>;
  canManage: boolean;
  existingNumber?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [nextNumber, setNextNumber] = useState("1");
  const [padding, setPadding] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const series = data.numberSeries.filter(
    (s) => s.entity_id === entityId && s.kind === kind,
  );
  const chosen =
    series.find((s) => s.id === selectedId) || series.find((s) => s.is_default);
  const proposed = chosen
    ? `${chosen.prefix}${String(chosen.next_number).padStart(chosen.padding, "0")}`
    : "Select an issuing legal entity";
  async function add() {
    if (!entityId || !name.trim() || !prefix.trim()) {
      setError("Choose the legal entity, series name and prefix.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await create({
        action: "number-series.create",
        entity_id: entityId,
        kind,
        name: name.trim(),
        prefix: prefix.trim(),
        next_number: Number(nextNumber),
        padding: Number(padding),
      });
      onSelect(result.id);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="number-series-field">
      <Field
        label={`${kind === "quote" ? "Quote" : "Invoice"} number`}
        hint={
          existingNumber
            ? "This saved number cannot be changed."
            : "Proposed number. Confirmed atomically when you save the draft."
        }
      >
        <input
          value={existingNumber || proposed}
          readOnly
          aria-label={`${kind} number preview`}
        />
      </Field>
      {!existingNumber && entityId ? (
        <div className="number-series-controls">
          <Field label="Number series">
            <select
              aria-label={`${kind} number series`}
              value={selectedId}
              onChange={(e) => onSelect(e.target.value)}
            >
              {series.map((s) => (
                <option key={s.id || "default"} value={s.id || ""}>
                  {s.name} · {s.prefix}
                </option>
              ))}
            </select>
          </Field>
          {canManage ? (
            <button
              type="button"
              className="quote-inline-add"
              onClick={() => setOpen(!open)}
            >
              <Settings2 size={16} /> {open ? "Close numbering" : "New prefix"}
            </button>
          ) : null}
        </div>
      ) : null}
      {open && canManage ? (
        <div className="quote-inline-panel number-series-panel">
          <h3>
            <Plus size={16} /> New {kind} prefix
          </h3>
          <p className="muted">
            Separate series for this legal entity. Existing document numbers
            stay unchanged.
          </p>
          <div className="quote-field-grid">
            <Field label="Series name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="International quotes"
                maxLength={200}
              />
            </Field>
            <Field label="Prefix">
              <input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="INT-QT-"
                maxLength={20}
              />
            </Field>
            <Field label="Next number">
              <input
                value={nextNumber}
                onChange={(e) => setNextNumber(e.target.value)}
                inputMode="numeric"
              />
            </Field>
            <Field label="Digits">
              <input
                value={padding}
                onChange={(e) => setPadding(e.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
          <p className="muted">
            Preview: {prefix}
            {String(nextNumber).padStart(Number(padding) || 1, "0")}
          </p>
          {error ? <ErrorBox error={error} /> : null}
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={add}
          >
            Save prefix and use it
          </button>
        </div>
      ) : null}
    </div>
  );
}
