import { z } from "zod";
export const workflowKind = z.enum(["bill", "purchase-order"]);
export const workflowStep = z.strictObject({
  label: z.string().trim().min(1).max(100),
  minimum: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  mode: z.enum(["any", "all"]),
  approvers: z
    .array(
      z.strictObject({
        kind: z.enum(["role", "profile", "user"]),
        id: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(20),
});
export const workflowCommands = [
  z.strictObject({
    action: z.literal("approval.rules"),
    entity_id: z.uuid(),
    kind: workflowKind,
    version: z.number().int().min(0),
    separate: z.boolean(),
    steps: z.array(workflowStep).min(1).max(10),
  }),
] as const;
export type WorkflowStep = z.infer<typeof workflowStep>;
export interface ApprovalRun {
  id: string;
  document_id: string;
  kind: "bill" | "purchase-order";
  entity_id: string;
  rule_version: number;
  created_by: string;
  steps: {
    label: string;
    mode: "any" | "all";
    people: { id: string; name: string }[];
  }[];
  votes: {
    step: number;
    user_id: string;
    name: string;
    comment: string;
    created_at: string;
  }[];
  outcome: "Pending" | "Approved" | "Returned";
  created_at: string;
}
export function workflowProgress(run: ApprovalRun, userId: string) {
  const at = run.steps.findIndex((s, i) => {
    const votes = run.votes.filter((v) => v.step === i);
    return s.mode === "any"
      ? votes.length === 0
      : s.people.some((p) => !votes.some((v) => v.user_id === p.id));
  });
  const step = run.steps[at];
  const eligible = !!step?.people.some((p) => p.id === userId);
  const voted = run.votes.some((v) => v.step === at && v.user_id === userId);
  const remaining =
    step?.people.filter(
      (p) => !run.votes.some((v) => v.step === at && v.user_id === p.id),
    ) || [];
  return {
    at,
    step,
    remaining,
    allowed: run.outcome === "Pending" && eligible && !voted,
    final:
      at === run.steps.length - 1 &&
      (step?.mode === "any" || remaining.length === 1),
  };
}
