import { useEffect, useRef, useState } from "react";
import { ErrorBox, Table } from "./components";
import { money, type Entity, type Report } from "./model";
import {
  accountEntryDraft,
  accountEntryDraftKey,
  clearBrowserDraft,
  readBrowserDraft,
  writeBrowserDraft,
} from "./browserDraft";

type Account = Report["trial"][number];
type AccountType = "Asset" | "Liability" | "Equity" | "Income" | "Expense";
const types: AccountType[] = [
  "Asset",
  "Liability",
  "Equity",
  "Income",
  "Expense",
];

export function ChartOfAccounts({
  entity,
  draftScope,
  report,
  canManage,
  onRun,
}: {
  entity: Entity;
  draftScope: { organization: string; user: string };
  report: Report;
  canManage: boolean;
  onRun: (command: Record<string, unknown>) => Promise<{ id: string }>;
}) {
  const storageKey = accountEntryDraftKey(
    draftScope.organization,
    draftScope.user,
    entity.id,
  );
  const [recovered] = useState(() =>
    canManage ? readBrowserDraft(storageKey, accountEntryDraft) : null,
  );
  const [mode, setMode] = useState<"create" | "edit" | "">(
    recovered?.mode ?? "",
  );
  const [selected, setSelected] = useState<Pick<
    Account,
    "code" | "version"
  > | null>(recovered?.selected ?? null);
  const [code, setCode] = useState(recovered?.code ?? "");
  const [name, setName] = useState(recovered?.name ?? "");
  const [type, setType] = useState<AccountType>(recovered?.type ?? "Expense");
  const [parent, setParent] = useState(recovered?.parent ?? "");
  const [description, setDescription] = useState(recovered?.description ?? "");
  const [key, setKey] = useState(
    () => recovered?.requestKey ?? crypto.randomUUID(),
  );
  const [dirty, setDirty] = useState(Boolean(recovered));
  const [formOpen, setFormOpen] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!dirty || !mode || !canManage) return;
    setStorageOk(
      writeBrowserDraft(storageKey, {
        mode,
        selected,
        code,
        name,
        type,
        parent,
        description,
        requestKey: key,
      }),
    );
  }, [
    storageKey,
    dirty,
    mode,
    selected,
    code,
    name,
    type,
    parent,
    description,
    key,
    canManage,
  ]);
  useEffect(() => {
    if (!dirty || storageOk) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, storageOk]);
  useEffect(() => {
    if (formOpen) heading.current?.focus();
  }, [formOpen]);
  function discard() {
    if (
      busy ||
      !confirm("Discard this account draft? Unsaved details will be removed.")
    )
      return false;
    clearBrowserDraft(storageKey);
    setDirty(false);
    setFormOpen(false);
    setMode("");
    setError("");
    return true;
  }
  const openCreate = () => {
    if (busy || (dirty && !discard())) return;
    setFormOpen(true);
    setMode("create");
    setSelected(null);
    setCode("");
    setName("");
    setType("Expense");
    setParent("");
    setDescription("");
    setKey(crypto.randomUUID());
    setError("");
  };
  const openEdit = (account: Account) => {
    if (busy || (dirty && !discard())) return;
    setFormOpen(true);
    setMode("edit");
    setSelected({ code: account.code, version: account.version });
    setCode(account.code);
    setName(account.name);
    setType(account.type as AccountType);
    setParent(account.parent_code || "");
    setDescription(account.description);
    setError("");
  };
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !canManage || !mode) return;
    setError("");
    setBusy(true);
    try {
      await onRun(
        mode === "create"
          ? {
              action: "account.create",
              entity_id: entity.id,
              code: code.trim().toUpperCase(),
              name,
              type,
              parent_code: parent || null,
              description,
              request_key: key,
            }
          : {
              action: "account.update",
              entity_id: entity.id,
              code: selected!.code,
              version: selected!.version,
              name,
              description,
            },
      );
      setMode("");
      setSelected(null);
      setDirty(false);
      setFormOpen(false);
      clearBrowserDraft(storageKey);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changeActive(account: Account) {
    if (
      account.active &&
      !confirm(
        `Deactivate ${account.code} · ${account.name}? Historical postings remain visible, but new manual journals cannot use it.`,
      )
    )
      return;
    setError("");
    setBusy(true);
    try {
      await onRun({
        action: "account.set-active",
        entity_id: entity.id,
        code: account.code,
        version: account.version,
        active: !account.active,
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="chart-of-accounts">
      <div className="toolbar">
        <p className="muted">
          {entity.name} · PKR chart. Existing entries remain visible when an
          account is deactivated.
        </p>
        {canManage ? (
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={openCreate}
          >
            + New account
          </button>
        ) : null}
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {error.includes("This account changed") ? (
        <p className="muted">
          Your draft is retained, but another change was saved first. Copy any
          details you need, discard this draft, then reopen the account to edit
          its latest version.
        </p>
      ) : null}
      {canManage && dirty && !formOpen ? (
        <div className="notice" role="status">
          <p>
            Unfinished account details for {entity.name}. Nothing is saved to
            the chart until you submit.
          </p>
          <div className="actions">
            <button type="button" onClick={() => setFormOpen(true)}>
              Resume account draft
            </button>
            <button type="button" onClick={discard}>
              Discard account draft
            </button>
          </div>
        </div>
      ) : null}
      {canManage && mode && formOpen ? (
        <form
          className="manual-journal-form account-form"
          onSubmit={save}
          onChange={() => setDirty(true)}
        >
          <h2 ref={heading} tabIndex={-1}>
            {mode === "create"
              ? "New ledger account"
              : `Edit ${selected?.code}`}
          </h2>
          <p className="muted">
            The account code, type and parent cannot be changed after creation.
            Choose the correct classification before saving.
          </p>
          <p className="muted" role="status">
            {storageOk
              ? "Unsaved details are kept in this browser tab for up to 24 hours. Closing the tab may remove them."
              : "Draft recovery is unavailable in this browser. Keep this page open or save before navigating away."}
          </p>
          <fieldset className="financial-entry-fields" disabled={busy}>
            <div className="manual-journal-fields">
              <label>
                Account code
                <input
                  required
                  maxLength={8}
                  pattern="[A-Z0-9]{4,8}"
                  value={code}
                  disabled={mode === "edit"}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="e.g. 5400"
                />
              </label>
              <label>
                Account name
                <input
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Type
                <select
                  value={type}
                  disabled={mode === "edit"}
                  onChange={(e) => {
                    setType(e.target.value as AccountType);
                    setParent("");
                  }}
                >
                  {types.map((choice) => (
                    <option key={choice}>{choice}</option>
                  ))}
                </select>
              </label>
              <label>
                Parent account
                <select
                  value={parent}
                  disabled={mode === "edit"}
                  onChange={(e) => setParent(e.target.value)}
                >
                  <option value="">None · top-level account</option>
                  {report.trial
                    .filter(
                      (a) => a.active && a.type === type && a.code !== code,
                    )
                    .map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label>
              Description
              <textarea
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What belongs in this account?"
              />
            </label>
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                {busy
                  ? "Saving…"
                  : mode === "create"
                    ? "Create account"
                    : "Save changes"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    !dirty ||
                    storageOk ||
                    confirm(
                      "Draft recovery is unavailable. Close and lose unsaved details?",
                    )
                  )
                    setFormOpen(false);
                }}
              >
                {dirty && storageOk ? "Close · keep account draft" : "Cancel"}
              </button>
              {dirty ? (
                <button type="button" onClick={discard}>
                  Discard account draft
                </button>
              ) : null}
            </div>
          </fieldset>
        </form>
      ) : null}
      <Table
        headers={[
          "Code & account",
          "Type",
          "Parent",
          "Status",
          "Period debit",
          "Period credit",
          "Actions",
        ]}
        label={`${entity.name} chart of accounts`}
      >
        {report.trial.map((account) => (
          <tr key={account.code}>
            <td>
              <strong>
                {account.code} · {account.name}
              </strong>
              {account.description ? (
                <small>{account.description}</small>
              ) : null}
            </td>
            <td>{account.type}</td>
            <td>{account.parent_code || "—"}</td>
            <td>
              {account.system
                ? "System"
                : account.active
                  ? "Active"
                  : "Inactive"}
            </td>
            <td className="num">{money(account.debit)}</td>
            <td className="num">{money(account.credit)}</td>
            <td>
              {canManage && !account.system ? (
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openEdit(account)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void changeActive(account)}
                  >
                    {account.active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              ) : (
                "—"
              )}
            </td>
          </tr>
        ))}
      </Table>
      <p className="muted small">
        Amounts are movements for the selected dates, not lifetime balances.
        Customer, vendor, tax and bank accounts are managed by their dedicated
        workflows.
      </p>
    </div>
  );
}
