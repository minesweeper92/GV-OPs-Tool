import { useEffect, useState } from "react";
import { useLeaveGuard } from "./NavigationSafety";
import { controlledAccountCodes } from "../shared/accounting";
import { minor } from "../shared/money";
import {
  day,
  money,
  today,
  type Data,
  type Entity,
  type Report,
  type Me,
} from "./model";
import { ErrorBox } from "./components";
import { Ledger } from "./Records";
import {
  journalEntryDraft,
  journalEntryDraftKey,
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
} from "./browserDraft";

type Line = {
  account_code: string;
  debit: string;
  credit: string;
  memo: string;
};
const blank = (): Line => ({
  account_code: "",
  debit: "0",
  credit: "0",
  memo: "",
});
const amount = (value: string) => {
  try {
    return minor(value || "0");
  } catch {
    return null;
  }
};

export function ManualJournals({
  entity,
  me,
  report,
  data,
  focus,
  onRun,
  canPost,
}: {
  entity: Entity;
  me: Me;
  report: Report;
  data: Data;
  focus: "manual" | "schedules";
  onRun: (command: Record<string, unknown>) => Promise<{ id: string }>;
  canPost: boolean;
}) {
  const draftKey = journalEntryDraftKey(
    me.organization.id,
    me.user.id,
    entity.id,
    focus,
  );
  const [restored] = useState(() =>
    readBrowserDraft(draftKey, journalEntryDraft),
  );
  const [dirty, setDirty] = useState(!!restored);
  const [draftSaved, setDraftSaved] = useState(!!restored);
  const [creating, setCreating] = useState(false);
  const [scheduleMode, setScheduleMode] = useState(focus === "schedules");
  const [date, setDate] = useState(restored?.date ?? today());
  const [autoReverseOn, setAutoReverseOn] = useState(
    restored?.autoReverseOn ?? "",
  );
  const [scheduleName, setScheduleName] = useState(
    restored?.scheduleName ?? "",
  );
  const [frequency, setFrequency] = useState(restored?.frequency ?? "monthly");
  const [timezone, setTimezone] = useState(
    restored?.timezone ?? "Asia/Karachi",
  );
  const [endDate, setEndDate] = useState(restored?.endDate ?? "");
  const [occurrences, setOccurrences] = useState(restored?.occurrences ?? "");
  const [reverseNextMonth, setReverseNextMonth] = useState(
    restored?.reverseNextMonth ?? false,
  );
  const [reference, setReference] = useState(restored?.reference ?? "");
  const [memo, setMemo] = useState(restored?.memo ?? "");
  const [lines, setLines] = useState<Line[]>(
    restored?.lines ?? [blank(), blank()],
  );
  const [reviewing, setReviewing] = useState(false);
  const [reversing, setReversing] = useState("");
  const [reversalDate, setReversalDate] = useState(today());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestKey, setRequestKey] = useState(
    () => restored?.requestKey ?? crypto.randomUUID(),
  );
  const [reversalKey, setReversalKey] = useState(() => crypto.randomUUID());
  const [skipId, setSkipId] = useState("");
  const [skipReason, setSkipReason] = useState("");
  const [reviewingOccurrenceId, setReviewingOccurrenceId] = useState("");
  const [scheduledReversalId, setScheduledReversalId] = useState("");
  useLeaveGuard({
    label: "journal details",
    dirty,
    recoverable: draftSaved,
    busy,
  });
  useEffect(() => {
    if (!dirty) return;
    setDraftSaved(
      writeBrowserDraft(draftKey, {
        date,
        autoReverseOn,
        scheduleName,
        frequency,
        timezone,
        endDate,
        occurrences,
        reverseNextMonth,
        reference,
        memo,
        lines,
        requestKey,
      }),
    );
  }, [
    draftKey,
    dirty,
    date,
    autoReverseOn,
    scheduleName,
    frequency,
    timezone,
    endDate,
    occurrences,
    reverseNextMonth,
    reference,
    memo,
    lines,
    requestKey,
  ]);
  function closeForm() {
    if (busy) return;
    if (
      !dirty ||
      draftSaved ||
      window.confirm(
        "Draft storage is unavailable. Discard your unsaved changes?",
      )
    ) {
      setCreating(false);
      setReviewing(false);
    }
  }
  function discardDraft() {
    if (!window.confirm("Discard this journal draft? This cannot be undone."))
      return;
    clearBrowserDraft(draftKey);
    setDirty(false);
    setDraftSaved(false);
    setReviewing(false);
    setError("");
    setDate(today());
    setAutoReverseOn("");
    setScheduleName("");
    setFrequency("monthly");
    setTimezone("Asia/Karachi");
    setEndDate("");
    setOccurrences("");
    setReverseNextMonth(false);
    setReference("");
    setMemo("");
    setLines([blank(), blank()]);
    setRequestKey(crypto.randomUUID());
  }
  const schedules = data.journalSchedules.filter(
    (p) => p.entity_id === entity.id,
  );
  const occurrencesDue = data.journalOccurrences.filter(
    (o) => o.entity_id === entity.id,
  );
  const reversalTasks = data.journalReversalTasks.filter(
    (t) => t.entity_id === entity.id,
  );
  const available = report.trial.filter(
    (a) =>
      a.active &&
      !controlledAccountCodes.has(a.code) &&
      !a.code.startsWith("10B"),
  );
  const debit = lines.reduce(
    (sum, line) => sum + (amount(line.debit) || 0n),
    0n,
  );
  const credit = lines.reduce(
    (sum, line) => sum + (amount(line.credit) || 0n),
    0n,
  );
  const editLine = (index: number, key: keyof Line, value: string) => {
    setDirty(true);
    setLines((old) =>
      old.map((line, i) => (i === index ? { ...line, [key]: value } : line)),
    );
    setReviewing(false);
  };
  const dateRestriction = (on: string) => {
    if (entity.lock_date && on <= entity.lock_date)
      return `This entity is locked through ${day(entity.lock_date)}. Choose a later date.`;
    if (
      report.periods.some(
        (period) =>
          period.month.slice(0, 7) === on.slice(0, 7) &&
          period.status === "Closed",
      )
    )
      return "This accounting month is closed. Reopen it before posting a journal.";
    return "";
  };
  const validate = () => {
    if (!reference.trim() || !memo.trim())
      return "Enter a reference and explanation.";
    if (!scheduleMode) {
      const restriction = dateRestriction(date);
      if (restriction) return restriction;
      if (autoReverseOn && autoReverseOn <= date)
        return "The automatic reversal must be after the posting date.";
    } else {
      if (!scheduleName.trim()) return "Name this recurring journal.";
      if (endDate && endDate < date)
        return "End date cannot precede the start date.";
      if (
        occurrences &&
        (!Number.isInteger(Number(occurrences)) ||
          Number(occurrences) < 1 ||
          Number(occurrences) > 1200)
      )
        return "Choose between 1 and 1200 occurrences.";
    }
    for (const line of lines) {
      const dr = amount(line.debit),
        cr = amount(line.credit);
      if (!available.some((a) => a.code === line.account_code))
        return "Choose an available account for every line.";
      if (dr === null || cr === null || dr > 0n === cr > 0n)
        return "Each line needs one valid debit or credit amount.";
    }
    if (debit === 0n || debit !== credit)
      return "The debit and credit totals must match.";
    return "";
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      setReviewing(false);
      return;
    }
    setError("");
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    setBusy(true);
    try {
      await onRun(
        scheduleMode
          ? {
              action: "journal-schedule.create",
              entity_id: entity.id,
              name: scheduleName,
              reference,
              memo,
              lines,
              start_date: date,
              end_date: endDate || null,
              frequency,
              timezone,
              occurrences: occurrences ? Number(occurrences) : null,
              reverse_next_month: reverseNextMonth,
              request_key: requestKey,
            }
          : {
              action: "manual-journal.create",
              entity_id: entity.id,
              date,
              reference,
              memo,
              lines,
              auto_reverse_on: autoReverseOn || null,
              request_key: requestKey,
            },
      );
      setCreating(false);
      clearBrowserDraft(draftKey);
      setDirty(false);
      setDraftSaved(false);
      setReviewing(false);
      setReference("");
      setMemo("");
      setScheduleName("");
      setAutoReverseOn("");
      setEndDate("");
      setOccurrences("");
      setReverseNextMonth(false);
      setLines([blank(), blank()]);
      setRequestKey(crypto.randomUUID());
    } catch (cause) {
      setError(
        `${(cause as Error).message} If the connection failed, saving may already have completed. Retry this unchanged entry to confirm safely.`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function reverse(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const restriction = dateRestriction(reversalDate);
    if (restriction) {
      setError(restriction);
      return;
    }
    setBusy(true);
    try {
      await onRun({
        action: "manual-journal.reverse",
        id: reversing,
        date: reversalDate,
        reason,
        request_key: reversalKey,
      });
      setReversing("");
      setReason("");
      setReversalKey(crypto.randomUUID());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function scheduleCommand(command: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await onRun(command);
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="manual-journals">
      <div className="toolbar">
        {canPost && focus === "manual" ? (
          <button
            className="primary"
            type="button"
            onClick={() => {
              if (busy) return;
              if (creating) {
                closeForm();
                return;
              }
              setCreating(true);
              setScheduleMode(false);
              setReviewing(false);
              setError("");
            }}
          >
            {creating ? "Close journal form" : "+ New manual journal"}
          </button>
        ) : null}
        {canPost && focus === "schedules" ? (
          <button
            type="button"
            onClick={() => {
              if (busy) return;
              if (creating) {
                closeForm();
                return;
              }
              setCreating(true);
              setScheduleMode(true);
              setReviewing(false);
              setError("");
            }}
          >
            + New recurring journal
          </button>
        ) : null}
        <span className="muted">{entity.name} · PKR ledger</span>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {dirty && canPost ? (
        <div className="posting-notice">
          <p>
            {draftSaved
              ? "Entry draft retained in this tab for up to 24 hours. You can close or reload and return to it; closing the tab will not keep it."
              : "Draft storage is unavailable. Keep this page open to avoid losing your work."}
          </p>
          {!creating ? (
            <button
              type="button"
              onClick={() => {
                setCreating(true);
                setReviewing(false);
              }}
            >
              Resume draft
            </button>
          ) : null}
          <button type="button" onClick={discardDraft} disabled={busy}>
            Discard draft
          </button>
        </div>
      ) : null}
      {creating ? (
        <form
          className="manual-journal-form"
          onSubmit={submit}
          onChange={() => setDirty(true)}
        >
          <fieldset className="financial-entry-fields" disabled={busy}>
            <h2>
              {scheduleMode ? "New recurring journal" : "New manual journal"}
            </h2>
            <p className="muted">
              {scheduleMode
                ? "Set the pattern once. Due entries are generated as drafts for review; no journal posts automatically."
                : "For adjustments between general-ledger accounts. Customer, vendor, bank and tax control balances must use their dedicated workflows."}
            </p>
            <div className="manual-journal-fields">
              <label>
                {scheduleMode ? "First occurrence date" : "Posting date"}
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setReviewing(false);
                  }}
                />
              </label>
              <label>
                Reference
                <input
                  required
                  maxLength={200}
                  value={reference}
                  onChange={(e) => {
                    setReference(e.target.value);
                    setReviewing(false);
                  }}
                  placeholder="e.g. ADJ-2026-09-01"
                />
              </label>
            </div>
            {scheduleMode ? (
              <>
                <div className="manual-journal-fields">
                  <label>
                    Schedule name
                    <input
                      required
                      maxLength={200}
                      value={scheduleName}
                      onChange={(e) => {
                        setScheduleName(e.target.value);
                        setReviewing(false);
                      }}
                      placeholder="e.g. Monthly depreciation"
                    />
                  </label>
                  <label>
                    Frequency
                    <select
                      value={frequency}
                      onChange={(e) => {
                        setFrequency(e.target.value as typeof frequency);
                        setReviewing(false);
                      }}
                    >
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </label>
                  <label>
                    Time zone
                    <select
                      value={timezone}
                      onChange={(e) => {
                        setTimezone(e.target.value as typeof timezone);
                        setReviewing(false);
                      }}
                    >
                      <option value="Asia/Karachi">Asia/Karachi</option>
                      <option value="UTC">UTC</option>
                    </select>
                  </label>
                  <label>
                    End date (optional)
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => {
                        setEndDate(e.target.value);
                        setReviewing(false);
                      }}
                    />
                  </label>
                  <label>
                    Number of occurrences (optional)
                    <input
                      type="number"
                      min="1"
                      max="1200"
                      value={occurrences}
                      onChange={(e) => {
                        setOccurrences(e.target.value);
                        setReviewing(false);
                      }}
                    />
                  </label>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={reverseNextMonth}
                    onChange={(e) => {
                      setReverseNextMonth(e.target.checked);
                      setReviewing(false);
                    }}
                  />
                  Prepare a reversal for the first day of the following month
                </label>
              </>
            ) : (
              <label>
                Scheduled reversal (optional)
                <input
                  type="date"
                  value={autoReverseOn}
                  onChange={(e) => {
                    setAutoReverseOn(e.target.value);
                    setReviewing(false);
                  }}
                />
                <small className="muted">
                  A review task will appear under Recurring journals. It will
                  not post automatically.
                </small>
              </label>
            )}
            <label>
              Explanation
              <textarea
                required
                maxLength={200}
                value={memo}
                onChange={(e) => {
                  setMemo(e.target.value);
                  setReviewing(false);
                }}
                placeholder="Why is this adjustment needed?"
              />
            </label>
            <div
              className="manual-journal-lines"
              role="group"
              aria-label="Journal lines"
            >
              {lines.map((line, index) => (
                <div className="manual-journal-line" key={index}>
                  <strong>Line {index + 1}</strong>
                  <label>
                    Account
                    <select
                      required
                      value={line.account_code}
                      onChange={(e) =>
                        editLine(index, "account_code", e.target.value)
                      }
                    >
                      <option value="">Choose an account</option>
                      {available.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Debit (PKR)
                    <input
                      inputMode="decimal"
                      maxLength={100}
                      value={line.debit}
                      onChange={(e) => editLine(index, "debit", e.target.value)}
                    />
                  </label>
                  <label>
                    Credit (PKR)
                    <input
                      inputMode="decimal"
                      maxLength={100}
                      value={line.credit}
                      onChange={(e) =>
                        editLine(index, "credit", e.target.value)
                      }
                    />
                  </label>
                  <label>
                    Line note
                    <input
                      maxLength={400}
                      value={line.memo}
                      onChange={(e) => editLine(index, "memo", e.target.value)}
                    />
                  </label>
                  {lines.length > 2 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setLines((old) => old.filter((_, i) => i !== index));
                        setDirty(true);
                        setReviewing(false);
                      }}
                    >
                      Remove line
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setLines((old) => [...old, blank()]);
                setDirty(true);
                setReviewing(false);
              }}
              disabled={lines.length >= 100}
            >
              + Add line
            </button>
            <div className="manual-journal-totals">
              <span>Debits {money(debit)}</span>
              <span>Credits {money(credit)}</span>
              <strong>
                {debit === credit && debit > 0n ? "Balanced" : "Not balanced"}
              </strong>
            </div>
            {reviewing ? (
              <p className="posting-notice">
                {scheduleMode ? (
                  `This creates a ${frequency} schedule for ${entity.name}, starting ${day(date)}. Each ${money(debit)} occurrence awaits review before posting.`
                ) : (
                  <>
                    Posting will add {money(debit)} of debits and credits to{" "}
                    {entity.name} on {day(date)}. The journal cannot be edited
                    afterward; a correction requires a dated reversal.
                  </>
                )}
              </p>
            ) : null}
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                {busy
                  ? "Saving…"
                  : reviewing
                    ? scheduleMode
                      ? "Create schedule"
                      : "Post journal"
                    : scheduleMode
                      ? "Review schedule"
                      : "Review journal"}
              </button>
              <button type="button" onClick={closeForm} disabled={busy}>
                {dirty && draftSaved ? "Close · keep draft" : "Cancel"}
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}
      {focus === "schedules" ? (
        <section className="manual-journal-form">
          <h2>Recurring journals</h2>
          <p className="muted">
            A due occurrence is a draft until finance reviews and posts it.
            Pausing a schedule does not erase earlier drafts.
          </p>
          {schedules.length ? (
            schedules.map((p) => (
              <div className="journal-schedule-row" key={p.id}>
                <div>
                  <strong>{p.name}</strong> <small>{p.status}</small>
                  <p className="muted">
                    {p.frequency} from {day(p.start_date)} · {p.reference}
                    {p.reverse_next_month ? " · reverses next month" : ""}
                  </p>
                  {p.last_error ? (
                    <small className="warning">{p.last_error}</small>
                  ) : null}
                </div>
                {canPost ? (
                  <div className="actions">
                    {p.status === "Active" ? (
                      <>
                        <button
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            scheduleCommand({
                              action: "journal-schedule.run",
                              id: p.id,
                            })
                          }
                        >
                          Generate due drafts
                        </button>
                        <button
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            scheduleCommand({
                              action: "journal-schedule.status",
                              id: p.id,
                              version: p.version,
                              status: "Paused",
                            })
                          }
                        >
                          Pause
                        </button>
                      </>
                    ) : p.status === "Paused" ? (
                      <button
                        disabled={busy}
                        type="button"
                        onClick={() =>
                          scheduleCommand({
                            action: "journal-schedule.status",
                            id: p.id,
                            version: p.version,
                            status: "Active",
                          })
                        }
                      >
                        Resume
                      </button>
                    ) : null}
                    {["Active", "Paused"].includes(p.status) ? (
                      <button
                        disabled={busy}
                        type="button"
                        onClick={() =>
                          scheduleCommand({
                            action: "journal-schedule.status",
                            id: p.id,
                            version: p.version,
                            status: "Stopped",
                          })
                        }
                      >
                        Stop future drafts
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <p className="muted">No recurring journals for this entity.</p>
          )}
          <h3>Occurrences</h3>
          {occurrencesDue.length ? (
            occurrencesDue.map((o) => (
              <div className="journal-schedule-row" key={o.id}>
                <div>
                  <strong>{o.reference}</strong> <small>{o.status}</small>
                  <p className="muted">
                    {day(o.scheduled_date)} · {o.memo}
                    {o.reverse_next_month ? " · reversal due next month" : ""}
                  </p>
                  <details
                    className="journal-draft-detail"
                    open={reviewingOccurrenceId === o.id}
                  >
                    <summary>Review journal lines</summary>
                    <ul>
                      {o.lines.map((line, index) => (
                        <li key={index}>
                          {line.account_code} ·{" "}
                          {report.trial.find(
                            (a) => a.code === line.account_code,
                          )?.name || "Account"}
                          {" — "}
                          {amount(line.debit) && amount(line.debit)! > 0n
                            ? `Debit ${line.debit}`
                            : `Credit ${line.credit}`}
                          {line.memo ? ` · ${line.memo}` : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                  {o.reason ? <small>{o.reason}</small> : null}
                </div>
                {canPost && o.status === "Pending review" ? (
                  <div className="actions">
                    {reviewingOccurrenceId === o.id ? (
                      <>
                        <button
                          className="primary"
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            void scheduleCommand({
                              action: "journal-schedule.post",
                              id: o.id,
                            }).then((ok) => {
                              if (ok) setReviewingOccurrenceId("");
                            })
                          }
                        >
                          Post reviewed journal
                        </button>
                        <button
                          type="button"
                          onClick={() => setReviewingOccurrenceId("")}
                        >
                          Cancel review
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={busy}
                        type="button"
                        onClick={() => setReviewingOccurrenceId(o.id)}
                      >
                        Review before posting
                      </button>
                    )}
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => {
                        setSkipId(o.id);
                        setSkipReason("");
                      }}
                    >
                      Skip
                    </button>
                  </div>
                ) : null}
                {skipId === o.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void scheduleCommand({
                        action: "journal-schedule.skip",
                        id: o.id,
                        reason: skipReason,
                      }).then((ok) => {
                        if (ok) setSkipId("");
                      });
                    }}
                  >
                    <label>
                      Reason for skipping
                      <input
                        required
                        maxLength={200}
                        value={skipReason}
                        onChange={(e) => setSkipReason(e.target.value)}
                      />
                    </label>
                    <button disabled={busy} type="submit">
                      Confirm skip
                    </button>
                    <button type="button" onClick={() => setSkipId("")}>
                      Cancel
                    </button>
                  </form>
                ) : null}
              </div>
            ))
          ) : (
            <p className="muted">No occurrences generated yet.</p>
          )}
        </section>
      ) : null}
      {focus === "schedules" ? (
        <section className="manual-journal-form">
          <h2>Scheduled reversals</h2>
          <p className="muted">
            The original remains posted. Review and post its exact inverse when
            due.
          </p>
          {reversalTasks.length ? (
            reversalTasks.map((task) => (
              <div className="journal-schedule-row" key={task.id}>
                <div>
                  <strong>{task.external_reference}</strong>{" "}
                  <small>{task.status}</small>
                  <p className="muted">
                    Due {day(task.due_date)} · {task.description}
                  </p>
                  <a href="#journals">Open journal entries</a>
                </div>
                {canPost &&
                task.status === "Pending review" &&
                task.due_date <= new Date().toISOString().slice(0, 10) ? (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => {
                      setScheduledReversalId(task.id);
                      setReversalDate(task.due_date);
                      setReason("");
                    }}
                  >
                    Review reversal
                  </button>
                ) : task.status === "Pending review" ? (
                  <small className="muted">Not due yet</small>
                ) : null}
                {scheduledReversalId === task.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void scheduleCommand({
                        action: "journal-reversal.post",
                        id: task.id,
                        date: reversalDate,
                        reason,
                      }).then((ok) => {
                        if (ok) setScheduledReversalId("");
                      });
                    }}
                  >
                    <div className="manual-journal-fields">
                      <label>
                        Reversal posting date
                        <input
                          required
                          type="date"
                          value={reversalDate}
                          onChange={(e) => setReversalDate(e.target.value)}
                        />
                      </label>
                      <label>
                        Reason
                        <input
                          required
                          maxLength={200}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </label>
                    </div>
                    <button className="primary" disabled={busy} type="submit">
                      Post exact reversal
                    </button>
                    <button
                      type="button"
                      onClick={() => setScheduledReversalId("")}
                    >
                      Cancel
                    </button>
                  </form>
                ) : null}
              </div>
            ))
          ) : (
            <p className="muted">No scheduled reversals for this entity.</p>
          )}
        </section>
      ) : null}
      {reversing ? (
        <form className="manual-journal-form" onSubmit={reverse}>
          <h2>Reverse manual journal</h2>
          <p className="posting-notice">
            The original stays in the ledger. A new journal will post the exact
            opposite debits and credits on the date below.
          </p>
          <div className="manual-journal-fields">
            <label>
              Reversal date
              <input
                type="date"
                required
                value={reversalDate}
                onChange={(e) => setReversalDate(e.target.value)}
              />
            </label>
            <label>
              Reason
              <input
                required
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy} type="submit">
              {busy ? "Reversing…" : "Post reversal"}
            </button>
            <button type="button" onClick={() => setReversing("")}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {focus === "manual" ? (
        <Ledger
          report={report}
          mode="journals"
          onReverse={
            canPost
              ? (id) => {
                  setReversing(id);
                  setReversalDate(today());
                  setReason("");
                  setReversalKey(crypto.randomUUID());
                  setError("");
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
