import { randomUUID as uuid } from "node:crypto";
import type { SQL, Row } from "./db.ts";
import { Problem, audit, type Context } from "./domain.ts";
import { minor } from "../shared/money.ts";
import { grantedCapabilities, hasCapability } from "../shared/permissions.ts";
import {
  workflowProgress,
  type WorkflowStep,
  type ApprovalRun,
} from "../shared/approval-workflows.ts";

async function people(tx: SQL, ctx: Context, entity: string) {
  const rows = (
    await tx.query(
      `SELECT m.user_id AS id,d.name,m.role,m.role_profile_id,m.entity_ids,p.capabilities
   FROM memberships m JOIN gv_approval_directory() d ON d.id=m.user_id LEFT JOIN role_profiles p ON p.id=m.role_profile_id AND p.tenant_id=m.tenant_id
   WHERE m.tenant_id=$1 AND m.active`,
      [ctx.tenantId],
    )
  ).rows;
  return rows
    .map((p): Row => ({
      ...p,
      name: p.id === ctx.userId && ctx.name ? ctx.name : p.name,
    }))
    .filter(
      (p) =>
        (!p.entity_ids || p.entity_ids.includes(entity)) &&
        grantedCapabilities({
          role: p.role,
          capabilities: p.role_profile_id ? p.capabilities : undefined,
        }).includes("books.post"),
    );
}
export async function approvalSnapshot(tx: SQL, ctx: Context) {
  if (!hasCapability(ctx, "books.view"))
    return {
      approvalRules: [],
      approvalRuns: [],
      approvalPeople: [],
      approvalProfiles: [],
    };
  const runs = (
    await tx.query(
      "SELECT * FROM approval_runs ORDER BY created_at DESC,id DESC",
    )
  ).rows;
  const votes = (
    await tx.query("SELECT * FROM approval_votes ORDER BY created_at,id")
  ).rows;
  return {
    approvalRules: (
      await tx.query("SELECT * FROM approval_rules ORDER BY entity_id,kind")
    ).rows,
    approvalRuns: runs.map((r) => ({
      ...r,
      votes: votes.filter((v) => v.run_id === r.id),
    })) as ApprovalRun[],
    approvalPeople:
      ctx.role === "admin"
        ? (
            await tx.query(
              "SELECT d.id,d.name,m.role,m.role_profile_id,m.entity_ids,p.capabilities FROM memberships m JOIN gv_approval_directory() d ON d.id=m.user_id LEFT JOIN role_profiles p ON p.id=m.role_profile_id AND p.tenant_id=m.tenant_id WHERE m.tenant_id=$1 AND m.active",
              [ctx.tenantId],
            )
          ).rows.filter((p) =>
            hasCapability(
              {
                role: p.role,
                capabilities: p.role_profile_id ? p.capabilities : undefined,
              },
              "books.post",
            ),
          )
        : [],
    approvalProfiles:
      ctx.role === "admin"
        ? (
            await tx.query(
              "SELECT id,name,base_role,capabilities FROM role_profiles",
            )
          ).rows.filter((p) =>
            hasCapability(
              { role: p.base_role, capabilities: p.capabilities },
              "books.post",
            ),
          )
        : [],
  };
}
export async function saveApprovalRules(tx: SQL, ctx: Context, c: Row) {
  if (ctx.role !== "admin")
    throw new Problem(403, "Only administrators can change approval rules.");
  const entity = (
    await tx.query("SELECT id FROM entities WHERE id=$1 FOR UPDATE", [
      c.entity_id,
    ])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity unavailable.");
  const old = (
    await tx.query(
      "SELECT * FROM approval_rules WHERE entity_id=$1 AND kind=$2",
      [c.entity_id, c.kind],
    )
  ).rows[0];
  if ((old?.version || 0) !== c.version)
    throw new Problem(409, "Rules changed. Refresh before saving.");
  if (minor(c.steps[0].minimum) !== 0n)
    throw new Problem(400, "The first step must apply from PKR zero.");
  const eligible = await people(tx, ctx, c.entity_id);
  for (const step of c.steps as WorkflowStep[]) {
    if (!step.approvers.every((a) => eligible.some((p) => matches(a, p))))
      throw new Problem(
        400,
        `Every approver in ${step.label} must resolve to an active person with financial permission and entity access.`,
      );
  }
  const id = old?.id || uuid();
  await tx.query(
    `INSERT INTO approval_rules(id,tenant_id,entity_id,kind,version,separate,steps) VALUES($1,$2,$3,$4,1,$5,$6)
   ON CONFLICT(tenant_id,entity_id,kind) DO UPDATE SET version=approval_rules.version+1,separate=excluded.separate,steps=excluded.steps`,
    [
      id,
      ctx.tenantId,
      c.entity_id,
      c.kind,
      c.separate,
      JSON.stringify(c.steps),
    ],
  );
  await audit(tx, ctx, id, c.action, {
    before: old || null,
    after: c,
    text: `Updated ${c.kind} approval rules. Existing submissions retain their reviewers.`,
  });
  return { id };
}
function matches(a: WorkflowStep["approvers"][number], p: Row) {
  return a.kind === "user"
    ? p.id === a.id
    : a.kind === "profile"
      ? p.role_profile_id === a.id
      : p.role === a.id;
}
export async function startApproval(
  tx: SQL,
  ctx: Context,
  kind: string,
  document: Row,
  amount: string,
) {
  // The document row and entity lock serialize submission with settings edits.
  await tx.query("SELECT id FROM entities WHERE id=$1 FOR UPDATE", [
    document.entity_id,
  ]);
  const rule = (
    await tx.query(
      "SELECT * FROM approval_rules WHERE entity_id=$1 AND kind=$2",
      [document.entity_id, kind],
    )
  ).rows[0];
  if (!rule) return null; // Existing policies remain compatible until configured.
  const members = await people(tx, ctx, document.entity_id);
  const steps = (rule.steps as WorkflowStep[])
    .filter((s) => BigInt(amount) >= minor(s.minimum))
    .map((s) => ({
      label: s.label,
      mode: s.mode,
      people: members
        .filter(
          (p) =>
            (!rule.separate || p.id !== document.created_by) &&
            s.approvers.some((a) => matches(a, p)),
        )
        .map((p) => ({ id: p.id, name: p.name })),
    }));
  if (!steps.length || steps.some((s) => !s.people.length))
    throw new Problem(
      409,
      "A required step has no eligible reviewer after creator separation. Update the rules or team access before submitting.",
    );
  const id = uuid();
  await tx.query(
    "INSERT INTO approval_runs(id,tenant_id,entity_id,kind,document_id,rule_version,created_by,steps) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      ctx.tenantId,
      document.entity_id,
      kind,
      document.id,
      rule.version,
      document.created_by,
      JSON.stringify(steps),
    ],
  );
  await audit(tx, ctx, document.id, "approval.submitted", {
    run_id: id,
    version: rule.version,
    steps,
    text: `Submitted ${kind} for ${steps.length} approval steps.`,
  });
  return id;
}
export async function pendingApproval(
  tx: SQL,
  id: string,
): Promise<ApprovalRun | null> {
  const run = (
    await tx.query(
      "SELECT * FROM approval_runs WHERE document_id=$1 AND outcome='Pending' FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!run) return null;
  return {
    ...run,
    votes: (
      await tx.query(
        "SELECT * FROM approval_votes WHERE run_id=$1 ORDER BY created_at,id",
        [run.id],
      )
    ).rows,
  } as ApprovalRun;
}
export async function actApproval(
  tx: SQL,
  ctx: Context,
  run: ApprovalRun,
  comment: string,
  returning = false,
) {
  const live = await people(tx, ctx, run.entity_id);
  if (!live.some((p) => p.id === ctx.userId))
    throw new Problem(
      403,
      "Current financial permission and entity access are required.",
    );
  const progress = workflowProgress(run, ctx.userId);
  if (returning && ctx.role === "admin") {
    /* Administrators can repair a stranded review. */
  } else if (!progress.allowed)
    throw new Problem(
      403,
      "You are not an outstanding reviewer for the current step.",
    );
  if (returning) {
    if (!comment.trim())
      throw new Problem(400, "Explain why this document is being returned.");
    await tx.query("UPDATE approval_runs SET outcome='Returned' WHERE id=$1", [
      run.id,
    ]);
  } else {
    const name = live.find((p) => p.id === ctx.userId)!.name;
    await tx.query(
      "INSERT INTO approval_votes(id,tenant_id,run_id,step,user_id,name,comment) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [uuid(), ctx.tenantId, run.id, progress.at, ctx.userId, name, comment],
    );
    if (progress.final)
      await tx.query(
        "UPDATE approval_runs SET outcome='Approved' WHERE id=$1",
        [run.id],
      );
  }
  await audit(
    tx,
    ctx,
    run.document_id,
    returning ? "approval.returned" : "approval.reviewed",
    {
      run_id: run.id,
      step: progress.at + 1,
      actorName: ctx.name || null,
      comment,
      text: returning
        ? `Returned for changes: ${comment}`
        : `Approved ${progress.step?.label}: ${comment}`,
    },
  );
  return progress.final && !returning;
}
