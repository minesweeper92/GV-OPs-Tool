import { useState, useEffect } from "react";
import { z } from "zod";
import {
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
} from "./browserDraft";
import { useQueryClient } from "@tanstack/react-query";
import { Heading, Field, ErrorBox } from "./components";
import { request, type Data, type Me } from "./model";
import {
  workflowProgress,
  workflowStep,
  type WorkflowStep,
  type ApprovalRun,
} from "../shared/approval-workflows";
export function ApprovalTimeline({ run }: { run: ApprovalRun }) {
  const p = workflowProgress(run, "");
  return (
    <section className="panel" aria-label="Saved approval workflow">
      <h2>Approval steps · {run.outcome}</h2>
      <p className="muted">
        Rules version {run.rule_version} · reviewers retained on submission.
      </p>
      <ol>
        {run.steps.map((s, i) => (
          <li key={i}>
            <strong>{s.label}</strong> ·{" "}
            {s.mode === "any" ? "Any one" : "Everyone"} ·{" "}
            {run.outcome === "Returned"
              ? "Returned"
              : i < p.at || p.at === -1
                ? "Complete"
                : i === p.at
                  ? "Waiting"
                  : "Not started"}
            <ul>
              {s.people.map((person) => {
                const vote = run.votes.find(
                  (v) => v.step === i && v.user_id === person.id,
                );
                return (
                  <li key={person.id}>
                    {person.name}
                    {vote
                      ? ` — Approved${vote.comment ? `: ${vote.comment}` : ""}`
                      : run.outcome === "Returned"
                        ? " — Review ended"
                        : i < p.at || p.at === -1
                          ? " — Not needed; step complete"
                          : i === p.at
                            ? " — Awaiting review"
                            : " — Eligible reviewer"}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
      <p className="small">
        {run.kind === "bill"
          ? "Final approval posts the bill to the books."
          : "Final approval issues the order; no ledger entry is posted or email sent."}{" "}
        Returning and resubmitting starts a new review. Saved reviewers do not
        change when rules are edited.
      </p>
    </section>
  );
}
const blank = (): WorkflowStep => ({
  label: "Approval",
  minimum: "0",
  mode: "any",
  approvers: [{ kind: "role", id: "admin" }],
});
export function ApprovalWorkflows({
  data,
  me,
  entity,
  setEntity,
}: {
  data: Data;
  me: Me;
  entity: string;
  setEntity: (id: string) => void;
}) {
  const [kind, setKind] = useState<"bill" | "purchase-order">("bill");
  if (!data.approvalRules || !data.approvalPeople || !data.approvalProfiles)
    return (
      <ErrorBox error="Approval settings are unavailable. Refresh after the server update; no rules have been changed." />
    );
  return (
    <>
      <Heading
        title="Approval workflows"
        subtitle="Purchasing reviews by legal entity. Saved submissions keep their reviewers."
      />
      <div className="toolbar">
        <Field label="Legal entity">
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="all">Choose a legal entity</option>
            {data.entities.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Document type">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="bill">Vendor bills</option>
            <option value="purchase-order">Purchase orders</option>
          </select>
        </Field>
      </div>
      {entity === "all" || !data.entities.some((x) => x.id === entity) ? (
        <p className="empty">
          Choose the legal entity whose purchasing rules you want to manage.
          Rules do not apply across entities.
        </p>
      ) : (
        <WorkflowEditor
          key={`${entity}/${kind}/${data.approvalRules.find((r) => r.entity_id === entity && r.kind === kind)?.version || 0}`}
          data={data}
          me={me}
          entity={entity}
          kind={kind}
        />
      )}
    </>
  );
}
function WorkflowEditor({
  data,
  me,
  entity,
  kind,
}: {
  data: Data;
  me: Me;
  entity: string;
  kind: "bill" | "purchase-order";
}) {
  const rule = data.approvalRules.find(
    (r) => r.entity_id === entity && r.kind === kind,
  );
  const draftKey = `approval/${me.organization.id}/${me.user.id}/${entity}/${kind}/${rule?.version || 0}`;
  const [restored] = useState(() =>
    readBrowserDraft(
      draftKey,
      z.object({
        savedAt: z.number(),
        separate: z.boolean(),
        steps: z
          .array(
            workflowStep.extend({
              label: z.string(),
              minimum: z.string(),
              approvers: z.array(workflowStep.shape.approvers.element),
            }),
          )
          .min(1)
          .max(10),
      }),
    ),
  );
  const [steps, setSteps] = useState<WorkflowStep[]>(
    restored?.steps || rule?.steps || [blank()],
  );
  const [separate, setSeparate] = useState(
    restored?.separate ?? rule?.separate ?? true,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const cache = useQueryClient();
  const dirty =
    JSON.stringify({ steps, separate }) !==
    JSON.stringify({
      steps: rule?.steps || [blank()],
      separate: rule?.separate ?? true,
    });
  useEffect(() => {
    if (dirty) writeBrowserDraft(draftKey, { steps, separate });
    else clearBrowserDraft(draftKey);
  }, [draftKey, steps, separate, dirty]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const update = (i: number, patch: Partial<WorkflowStep>) =>
    setSteps(steps.map((s, j) => (i === j ? { ...s, ...patch } : s)));
  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await request(
            "commands",
            "POST",
            {
              action: "approval.rules",
              entity_id: entity,
              kind,
              version: rule?.version || 0,
              separate,
              steps,
            },
            me.csrf,
          );
          clearBrowserDraft(draftKey);
          await cache.invalidateQueries({ queryKey: ["data"] });
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      <p role="status">
        {rule
          ? `Saved rules · version ${rule.version}`
          : "Not configured. Existing bill rules and purchase-order issuing behaviour remain until saved."}
        {dirty ? " · Unsaved changes retained in this browser tab." : ""}
      </p>
      <h2>
        {data.entities.find((x) => x.id === entity)?.name} ·{" "}
        {kind === "bill" ? "Vendor bills" : "Purchase orders"}
      </h2>
      <p>
        Steps run top to bottom. Minimum amounts skip steps for smaller
        documents. Amounts include tax and use the document’s saved PKR exchange
        rate.
      </p>
      {steps.map((s, i) => (
        <fieldset key={i} className="approval-tier">
          <legend>Step {i + 1}</legend>
          <Field label={`Step ${i + 1} name`}>
            <input
              required
              maxLength={100}
              value={s.label}
              onChange={(e) => update(i, { label: e.target.value })}
            />
          </Field>
          <Field label={`Step ${i + 1} minimum PKR`}>
            <input
              required
              inputMode="decimal"
              value={s.minimum}
              onChange={(e) => update(i, { minimum: e.target.value })}
            />
          </Field>
          <Field label={`Step ${i + 1} requirement`}>
            <select
              value={s.mode}
              onChange={(e) =>
                update(i, { mode: e.target.value as "any" | "all" })
              }
            >
              <option value="any">Any one reviewer</option>
              <option value="all">Everyone selected</option>
            </select>
          </Field>
          <fieldset>
            <legend>Reviewers for step {i + 1}</legend>
            <p className="small">
              Role/profile choices resolve to active people with financial
              permission and entity access on submission. “Everyone” requires
              all resolved people.
            </p>
            {[
              { kind: "role", id: "admin", name: "Administrators" },
              { kind: "role", id: "finance", name: "Finance team" },
              ...data.approvalProfiles.map((p) => ({ kind: "profile", ...p })),
              ...data.approvalPeople
                .filter((p) => !p.entity_ids || p.entity_ids.includes(entity))
                .map((p) => ({
                  kind: "user",
                  id: p.id,
                  name: `${p.name} · person`,
                })),
            ].map((a) => (
              <label className="check" key={`${a.kind}/${a.id}`}>
                <input
                  type="checkbox"
                  checked={s.approvers.some(
                    (x) => x.kind === a.kind && x.id === a.id,
                  )}
                  onChange={(e) =>
                    update(i, {
                      approvers: e.target.checked
                        ? [
                            ...s.approvers,
                            {
                              kind: a.kind as "role" | "profile" | "user",
                              id: a.id,
                            },
                          ]
                        : s.approvers.filter(
                            (x) => x.kind !== a.kind || x.id !== a.id,
                          ),
                    })
                  }
                />
                {a.name}
              </label>
            ))}
          </fieldset>
          <div className="row-actions">
            <button
              type="button"
              disabled={i === 0}
              onClick={() => {
                const copy = [...steps];
                [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]];
                setSteps(copy);
              }}
            >
              Move up
            </button>
            <button
              type="button"
              disabled={steps.length === 1}
              onClick={() => setSteps(steps.filter((_, j) => j !== i))}
            >
              Remove step
            </button>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={steps.length >= 10}
        onClick={() => setSteps([...steps, blank()])}
      >
        Add approval step
      </button>
      <label className="check">
        <input
          type="checkbox"
          checked={separate}
          onChange={(e) => setSeparate(e.target.checked)}
        />
        Exclude the document creator from every step
      </label>
      <p className="small">
        For example: “Any one” lets the first eligible reviewer complete a step.
        “Everyone” waits for every resolved person; later steps remain locked.
        Overlapping role/person choices count each person once. The same person
        may review different steps unless excluded as creator.
      </p>
      <div className="row-actions">
        <button className="primary" disabled={busy || !entity}>
          {busy ? "Saving…" : "Save workflow"}
        </button>
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => {
            if (confirm("Discard unsaved workflow changes?")) {
              setSteps(rule?.steps || [blank()]);
              setSeparate(rule?.separate ?? true);
              clearBrowserDraft(draftKey);
            }
          }}
        >
          Discard changes
        </button>
      </div>
    </form>
  );
}
