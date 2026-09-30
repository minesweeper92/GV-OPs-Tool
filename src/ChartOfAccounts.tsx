import { useState } from "react";
import { ErrorBox, Table } from "./components";
import { money, type Entity, type Report } from "./model";

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
  report,
  canManage,
  onRun,
}: {
  entity: Entity;
  report: Report;
  canManage: boolean;
  onRun: (command: Record<string, unknown>) => Promise<{ id: string }>;
}) {
  const [mode, setMode] = useState<"create" | "edit" | "">("");
  const [selected, setSelected] = useState<Account | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("Expense");
  const [parent, setParent] = useState("");
  const [description, setDescription] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const openCreate = () => {
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
    setMode("edit");
    setSelected(account);
    setCode(account.code);
    setName(account.name);
    setType(account.type as AccountType);
    setParent(account.parent_code || "");
    setDescription(account.description);
    setError("");
  };
  async function save(event: React.FormEvent) {
    event.preventDefault();
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
          <button className="primary" type="button" onClick={openCreate}>
            + New account
          </button>
        ) : null}
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {mode ? (
        <form className="manual-journal-form account-form" onSubmit={save}>
          <h2>
            {mode === "create"
              ? "New ledger account"
              : `Edit ${selected?.code}`}
          </h2>
          <p className="muted">
            The account code, type and parent cannot be changed after creation.
            Choose the correct classification before saving.
          </p>
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
                  .filter((a) => a.active && a.type === type && a.code !== code)
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
            <button type="button" onClick={() => setMode("")}>
              Cancel
            </button>
          </div>
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
                  <button type="button" onClick={() => openEdit(account)}>
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
