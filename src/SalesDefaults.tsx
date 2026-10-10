import { useEffect, useState } from "react";
import { z } from "zod";
import { Plus, Trash2 } from "lucide-react";
import { Field, ErrorBox, Table } from "./components";
import { day, type Data, type Me } from "./model";
import {
  initialSalesDefaults,
  salesDefaults,
  paymentTerm,
  type SalesDefaults as Settings,
} from "../shared/document-defaults";
import {
  clearBrowserDraft,
  readBrowserDraft,
  writeBrowserDraft,
} from "./browserDraft";
import { useLeaveGuard, useNavigationSafety } from "./NavigationSafety";
import { hasCapability } from "../shared/permissions";

const draftSchema = z.object({
  savedAt: z.number(),
  version: z.number().int().min(0),
  requestKey: z.uuid(),
  settings: z.object({
    ...salesDefaults.shape,
    quote_valid_days: z.number().nullable(),
    terms: z
      .array(
        z.object({
          ...paymentTerm.shape,
          name: z.string(),
          days: z
            .number()
            .nullable()
            .transform((n) => n ?? Number.NaN),
        }),
      )
      .max(50),
  }),
});
export function SalesDefaults({
  data,
  me,
  entity,
  setEntity,
  save,
}: {
  data: Data;
  me: Me;
  entity: string;
  setEntity: (id: string) => void;
  save: (command: Record<string, unknown>) => Promise<unknown>;
}) {
  const { canLeave } = useNavigationSafety();
  return (
    <section
      className="settings-note document-defaults"
      aria-label="Document defaults"
    >
      <h2>Document defaults</h2>
      <p>
        Choose payment terms and reusable wording for each legal entity.
        Customer overrides take priority; existing documents stay unchanged.
      </p>
      <Field label="Defaults for legal entity">
        <select
          value={entity}
          onChange={(e) => {
            if (canLeave()) setEntity(e.target.value);
          }}
        >
          <option value="all">Choose a legal entity</option>
          {data.entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      {entity === "all" ? (
        <p className="muted">
          Defaults are separate for each legal entity. Choose one to continue.
        </p>
      ) : !data.documentDefaults ? (
        <ErrorBox error="Document defaults are unavailable. Refresh after the server update." />
      ) : (
        <DefaultsEditor
          key={`${me.organization.id}/${me.user.id}/${entity}`}
          data={data}
          me={me}
          entity={entity}
          save={save}
        />
      )}
    </section>
  );
}
function DefaultsEditor({
  data,
  me,
  entity,
  save,
}: {
  data: Data;
  me: Me;
  entity: string;
  save: (command: Record<string, unknown>) => Promise<unknown>;
}) {
  const record = data.documentDefaults.find((d) => d.entity_id === entity);
  const key = `gv-document-defaults-v1:${me.organization.id}:${me.user.id}:${entity}`;
  const [restored] = useState(() => readBrowserDraft(key, draftSchema));
  const [settings, setSettings] = useState<Settings>(
    () => restored?.settings ?? record?.settings ?? initialSalesDefaults(),
  );
  const [version, setVersion] = useState(
    restored?.version ?? record?.version ?? 0,
  );
  const [requestKey, setRequestKey] = useState(
    () => restored?.requestKey ?? crypto.randomUUID(),
  );
  const [dirty, setDirty] = useState(!!restored);
  const [stored, setStored] = useState(!!restored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(
    restored
      ? "Recovered your unsaved settings. Review them before saving."
      : "",
  );
  const editable =
    me.user.role === "admin" && hasCapability(me.user, "team.manage");
  useEffect(() => {
    if (dirty)
      setStored(writeBrowserDraft(key, { settings, version, requestKey }));
  }, [key, dirty, settings, version, requestKey]);
  useLeaveGuard({
    label: "document defaults",
    dirty,
    recoverable: stored,
    busy,
  });
  const change = (next: Settings) => {
    setSettings(next);
    setDirty(true);
    setNotice("");
  };
  function discard() {
    if (
      dirty &&
      !window.confirm(
        "Discard your unsaved document defaults and load the latest saved settings?",
      )
    )
      return;
    clearBrowserDraft(key);
    setSettings(record?.settings ?? initialSalesDefaults());
    setVersion(record?.version ?? 0);
    setRequestKey(crypto.randomUUID());
    setDirty(false);
    setStored(false);
    setError("");
    setNotice("Latest saved settings loaded.");
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !editable) return;
    const parsed = salesDefaults.safeParse(settings);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" "));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await save({
        action: "settings.sales-defaults",
        entity_id: entity,
        version,
        request_key: requestKey,
        settings: parsed.data,
      });
      clearBrowserDraft(key);
      setSettings(parsed.data);
      setVersion(version + 1);
      setDirty(false);
      setStored(false);
      setRequestKey(crypto.randomUUID());
      setNotice("Document defaults saved. Existing documents are unchanged.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Document defaults form">
      {!editable ? (
        <p className="muted">
          You can view defaults. An administrator must save changes.
        </p>
      ) : null}
      {(record?.version ?? 0) !== version ? (
        <p role="status">
          Another session saved newer defaults. Your draft is retained; discard
          and reload before saving.
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {dirty ? (
        <p className="small">
          {stored
            ? "Unsaved settings are saved in this browser tab for up to 24 hours."
            : "Draft recovery is unavailable. Keep this page open until you save."}
        </p>
      ) : null}
      <ErrorBox error={error} />
      <fieldset disabled={!editable || busy}>
        <legend>Payment terms</legend>
        <Field label="Default payment term">
          <select
            value={settings.default_term_id}
            onChange={(e) =>
              change({ ...settings, default_term_id: e.target.value })
            }
          >
            {settings.terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name || "Unnamed term"}
              </option>
            ))}
          </select>
        </Field>
        <p className="small">
          Due on receipt uses the document date. End of month uses the last
          calendar day of that month. Custom terms add a number of calendar
          days.
        </p>
        <Table headers={["Name", "Due rule", "Days", "Actions"]}>
          {settings.terms.map((term, index) => {
            const update = (values: Partial<typeof term>) =>
              change({
                ...settings,
                terms: settings.terms.map((t, i) =>
                  i === index ? { ...t, ...values } : t,
                ),
              });
            return (
              <tr key={term.id}>
                <td>
                  <input
                    aria-label={`Term ${index + 1} name`}
                    value={term.name}
                    maxLength={100}
                    required
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </td>
                <td>
                  <select
                    aria-label={`Term ${index + 1} rule`}
                    value={term.kind}
                    onChange={(e) =>
                      update({
                        kind: e.target.value as typeof term.kind,
                        days: e.target.value === "end-month" ? 0 : term.days,
                      })
                    }
                  >
                    <option value="days">Days from document date</option>
                    <option value="end-month">End of month</option>
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`Term ${index + 1} days`}
                    type="number"
                    min={0}
                    max={365}
                    required
                    disabled={term.kind === "end-month"}
                    value={Number.isNaN(term.days) ? "" : term.days}
                    onChange={(e) =>
                      update({
                        days:
                          e.target.value === ""
                            ? Number.NaN
                            : Number(e.target.value),
                      })
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    aria-label={`Remove term ${term.name}`}
                    disabled={
                      settings.terms.length === 1 ||
                      term.id === settings.default_term_id
                    }
                    onClick={() =>
                      change({
                        ...settings,
                        terms: settings.terms.filter((t) => t.id !== term.id),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </Table>
        <button
          type="button"
          disabled={settings.terms.length >= 50}
          onClick={() =>
            change({
              ...settings,
              terms: [
                ...settings.terms,
                { id: crypto.randomUUID(), name: "", kind: "days", days: 30 },
              ],
            })
          }
        >
          <Plus size={16} /> Add payment term
        </button>
        <h3>Quotes and invoices</h3>
        <Field
          label="Quote validity (days)"
          hint="Leave blank for no automatic expiry. Zero means valid through the quote date."
        >
          <input
            type="number"
            min={0}
            max={365}
            value={settings.quote_valid_days ?? ""}
            onChange={(e) =>
              change({
                ...settings,
                quote_valid_days:
                  e.target.value === "" ? null : Number(e.target.value),
              })
            }
          />
        </Field>
        {(
          [
            ["quote_notes", "Default quote customer notes"],
            ["quote_terms", "Default quote terms and conditions"],
            ["invoice_notes", "Default invoice customer notes"],
            ["invoice_terms", "Default invoice terms and conditions"],
            ["payment_instructions", "Default payment instructions"],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <textarea
              rows={3}
              value={settings[key]}
              maxLength={4000}
              onChange={(e) => change({ ...settings, [key]: e.target.value })}
            />
          </Field>
        ))}
      </fieldset>
      {editable ? (
        <div className="form-actions">
          <button className="primary" disabled={busy || !dirty} type="submit">
            {busy ? "Saving defaults…" : "Save document defaults"}
          </button>
          <button type="button" disabled={busy} onClick={discard}>
            Discard and reload
          </button>
        </div>
      ) : null}
      <h3>Recent saved changes</h3>
      {data.documentDefaultsHistory.filter((h) => h.entity_id === entity)
        .length ? (
        <ul>
          {data.documentDefaultsHistory
            .filter((h) => h.entity_id === entity)
            .map((h) => (
              <li key={h.version}>
                Version {h.version} · {h.actor_name} · {day(h.created_at)}
              </li>
            ))}
        </ul>
      ) : (
        <p className="muted">
          {editable
            ? "No saved changes yet."
            : "Change history is available to administrators."}
        </p>
      )}
    </form>
  );
}
