import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, ErrorBox, Table } from "./components";
import { request, type Entity } from "./model";

type PeriodStatus = "Open" | "Soft closed" | "Closed";
type Check = {
  key: string;
  label: string;
  count: number;
  detail: string;
  severity: "pass" | "warning" | "blocker";
};
type Preview = {
  entityId: string;
  entityName: string;
  month: string;
  start: string;
  end: string;
  status: PeriodStatus;
  version: number;
  legacyLock: string | null;
  checks: Check[];
  preflightHash: string;
  history: {
    id: string;
    from_status: PeriodStatus;
    to_status: PeriodStatus;
    reason: string;
    actor_id: string;
    actor_name: string;
    created_at: string;
    warnings: Check[];
  }[];
  legacyHistory: {
    id: string;
    lock_date: string;
    reason: string;
    actor_name: string;
    created_at: string;
  }[];
};

export function MonthEndClose({
  entity,
  canClose,
  onRun,
}: {
  entity: Entity;
  canClose: boolean;
  onRun: (command: Record<string, unknown>) => Promise<{ id: string }>;
}) {
  const [month, setMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["period-close", entity.id, month],
    queryFn: () =>
      request<Preview>(
        `period-close?entityId=${entity.id}&month=${encodeURIComponent(month)}`,
      ),
    enabled: /^\d{4}-\d{2}$/.test(month),
  });
  const preview = query.data;
  const warnings =
    preview?.checks.filter((c) => c.severity === "warning") || [];
  const blockers =
    preview?.checks.filter((c) => c.severity === "blocker") || [];
  const legacyLocked =
    !!preview?.legacyLock && preview.legacyLock >= preview.start;
  const action =
    preview?.status === "Open"
      ? "Soft closed"
      : preview?.status === "Soft closed"
        ? "Closed"
        : "Open";
  const canAct = !legacyLocked && (action === "Soft closed" || canClose);

  async function transition(to: PeriodStatus) {
    if (!preview || busy) return;
    if (
      to === "Open" &&
      !window.confirm(
        `Reopen ${month} for ${entity.name}? New postings can change earlier reports.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await onRun({
        action: "period.transition",
        entity_id: entity.id,
        month,
        to,
        version: preview.version,
        preflight_hash: preview.preflightHash,
        acknowledge_warnings: acknowledged,
        reason: reason.trim(),
        request_key: crypto.randomUUID(),
      });
      setReason("");
      setAcknowledged(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlockLegacy() {
    if (!preview?.legacyLock || !canClose || busy) return;
    if (
      !window.confirm(
        `Release the earlier lock through ${preview.legacyLock} for ${entity.name}? This allows backdated postings until months are closed again.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await onRun({
        action: "period.legacy-unlock",
        entity_id: entity.id,
        expected_lock_date: preview.legacyLock,
        reason: reason.trim(),
        request_key: crypto.randomUUID(),
      });
      setReason("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="month-close">
      <div className="toolbar">
        <label>
          Accounting month{" "}
          <input
            type="month"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value);
              setReason("");
              setAcknowledged(false);
              setError("");
            }}
          />
        </label>
        {query.isFetching ? (
          <span className="muted" aria-busy="true">
            Refreshing checks…
          </span>
        ) : null}
      </div>
      {query.error ? <ErrorBox error={query.error.message} /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {preview ? (
        <>
          <section className="settings-note">
            <h2>
              {entity.name} ·{" "}
              {new Date(`${preview.start}T12:00:00Z`).toLocaleDateString(
                undefined,
                { month: "long", year: "numeric" },
              )}
            </h2>
            <p>
              <Badge>{preview.status}</Badge> {preview.start} to {preview.end}.
              Soft-close limits new postings to finance; final close blocks all
              new postings dated in this month.
            </p>
            {legacyLocked ? (
              <p>
                This month is covered by the earlier date lock through{" "}
                {preview.legacyLock}. Review why it was set before releasing it.
              </p>
            ) : null}
          </section>
          <h2>Before you close</h2>
          <p className="muted">
            These checks are recalculated when you confirm. Warnings can be
            accepted with a recorded reason; a ledger imbalance cannot.
          </p>
          <Table
            headers={["Check", "Result", "Detail"]}
            label="Month-end close checks"
          >
            {preview.checks.map((check) => (
              <tr key={check.key}>
                <td>
                  <strong>{check.label}</strong>
                </td>
                <td>
                  {check.severity === "pass"
                    ? "Ready"
                    : check.severity === "blocker"
                      ? "Blocked"
                      : `${check.count} to review`}
                </td>
                <td>{check.detail}</td>
              </tr>
            ))}
          </Table>
          {legacyLocked && canClose ? (
            <section className="manual-journal-form month-close-actions">
              <h2>Release earlier date lock</h2>
              <p className="muted">
                This releases the old lock for every date through{" "}
                {preview.legacyLock}. Review and close the affected months again
                afterward. The release is permanently recorded.
              </p>
              <label>
                Reason for unlocking
                <textarea
                  required
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  onClick={() => void unlockLegacy()}
                >
                  {busy ? "Saving…" : "Release old lock"}
                </button>
              </div>
            </section>
          ) : canAct ? (
            <section className="manual-journal-form month-close-actions">
              <h2>
                {action === "Open"
                  ? "Reopen this month"
                  : action === "Closed"
                    ? "Final close"
                    : "Soft-close this month"}
              </h2>
              <p className="muted">
                {action === "Open"
                  ? "Only an administrator can reopen a period. Later closed months must be reopened first."
                  : action === "Closed"
                    ? "Only an administrator can finish the close. Post any adjusting entries first."
                    : "Finance can still post adjustments after soft-close; sales cannot."}
              </p>
              <label>
                Reason or review note
                <textarea
                  required
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Summarise what was checked or why this period is being reopened"
                />
              </label>
              {action !== "Open" && warnings.length ? (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  I reviewed the {warnings.length} outstanding warning
                  {warnings.length === 1 ? "" : "s"} and recorded the reason
                  above.
                </label>
              ) : null}
              <div className="actions">
                <button
                  className={action === "Open" ? "" : "primary"}
                  type="button"
                  disabled={
                    busy ||
                    query.isFetching ||
                    !reason.trim() ||
                    (action !== "Open" &&
                      (!!blockers.length ||
                        (!!warnings.length && !acknowledged)))
                  }
                  onClick={() => void transition(action)}
                >
                  {busy
                    ? "Saving…"
                    : action === "Closed"
                      ? "Close month"
                      : action === "Soft closed"
                        ? "Soft-close month"
                        : "Reopen month"}
                </button>
              </div>
            </section>
          ) : !legacyLocked ? (
            <p className="muted">
              An administrator must finish or reopen this month.
            </p>
          ) : (
            <p className="muted">
              Ask an administrator to review the earlier date lock.
            </p>
          )}
          <h2>Change history</h2>
          {preview.history.length ? (
            <Table
              headers={["When", "Change", "By", "Reason"]}
              label="Accounting period change history"
            >
              {preview.history.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.created_at).toLocaleString()}</td>
                  <td>
                    {event.from_status} → {event.to_status}
                  </td>
                  <td title={event.actor_id}>{event.actor_name}</td>
                  <td>
                    {event.reason}
                    {event.warnings.length ? (
                      <small>
                        {event.warnings.length} warning(s) acknowledged
                      </small>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="muted">No close actions recorded for this month.</p>
          )}
          {preview.legacyHistory.length ? (
            <>
              <h2>Earlier lock releases</h2>
              <Table
                headers={["When", "Locked through", "By", "Reason"]}
                label="Earlier date lock releases"
              >
                {preview.legacyHistory.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.created_at).toLocaleString()}</td>
                    <td>{event.lock_date}</td>
                    <td>{event.actor_name}</td>
                    <td>{event.reason}</td>
                  </tr>
                ))}
              </Table>
            </>
          ) : null}
        </>
      ) : !query.error ? (
        <p aria-busy="true">Loading month-end checks…</p>
      ) : null}
    </div>
  );
}
