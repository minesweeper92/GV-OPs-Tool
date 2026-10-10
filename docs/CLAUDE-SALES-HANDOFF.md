# Claude handoff: complete sales in parallel with shared foundations

Prepared 10 October 2026 at Zohaib's request. This is an implementation assignment,
not a claim that Claude has received it or that sales is complete.

## Start here

Repository: https://github.com/minesweeper92/GV-OPs-Tool

Coordination/acceptance issue: https://github.com/minesweeper92/GV-OPs-Tool/issues/18

Latest verified code baseline: `2aa234a8d31c8f8cb7be70a7d09cdb935c093ab4`,
`feature/financial-entry-recovery`. The dedicated sales checkout is
`GV-Platform-sales`, sibling to Codex's `GV-Platform` checkout. Work there on
`feature/complete-sales`; never switch branches in Codex's checkout.

Read `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, and
`docs/UX-REVIEW-2026-10-09.md` before editing. The authoritative requirements are
Zohaib's local `Downloads/Unified-Books-CRM-Requirements.md`, including section 32.
Do not replace its scope with this handoff, revive the legacy CRM, or upload the
requirements/business records without separate authorization.

Open prerequisites are stacked #12 → #13 → #15 → #17. Main alone is behind the
verified working build. Start from the pinned baseline above, retain the complete
ancestry, and retarget/rebase only after prerequisite merges are verified. Do not
merge pending PRs merely to simplify the stack or bypass protection/review.

## Ownership and coordination

Zohaib explicitly requested parallel builders on 10 October. This supersedes the
earlier sole-Codex-builder arrangement; it does not authorize overlapping writes.

| Owner | Workstream | New migration allocation |
| --- | --- | --- |
| Codex | Shared foundations: payment terms/configurable document defaults, shared documents/attachments, consistent forms/lists and cross-cutting permission/approval infrastructure | 043–049 |
| Claude | Complete sales: receipts/customer cash, collections, sales orders/receipts, remaining sales document workflows and their accounting/UI/tests | 050–069 |

Migrations are explicitly registered in `server/db.ts`. Preserve **every** entry,
including 034–036 and 040–042. Never modify an applied migration. A higher number
is not permission to depend on an unpublished lower-numbered migration. Sales
migrations must work on the pinned baseline; integrate new defaults additively.
Before exceeding the reserved range, coordinate another reservation.

Create sales-specific modules and tests. Shared integration files (`src/App.tsx`,
`src/model.ts`, `server/app.ts`, `server/domain.ts`, `shared/commands.ts`,
`server/permission-checks.ts`, `server/db.ts`, report dispatchers) need narrow,
additive edits. Never remove another builder's command, migration, snapshot key,
route, permission check or report classification during a conflict resolution.
Keep new CSS scoped to sales. Coordinate changes to global primitives, composers,
profiles, documents, numbering and navigation safety with Codex before rewriting.

Use repository issues/PR comments for acceptance, dependencies, changes and test
evidence. Each builder owns their feature branch; integrate reviewed PRs serially.
Do not automatically expand into purchasing/projects/accounting just because a
sales slice is finished: report the sales remainder first, then agree ownership.

## Existing working sales slice — retain it

- Customer is a shared company with customer/vendor flags; contacts are people
  with dated company affiliations. Do not introduce a duplicate customer master.
- Leads/deals have explicit legal entities and current permission/entity checks.
- Named quote alternatives contain immutable revisions. Acceptance chooses an
  **exact version**, not automatically the newest alternative or revision.
- Accepted quotes generate full/partial earned or advance invoice drafts; direct
  invoice creation, number series, issue, manual sent status, draft cancellation
  and unpaid void/reversal already exist. Review before calling these missing.
- Single-invoice receipts support cash, income-tax withholding (1200), customer
  sales-tax withholding (1210) and settlement FX. Preserve existing records and
  their carrying amounts. Migration 041 must remain registered.
- Invoice-based credits, applications, refunds and dated reversals exist; customer
  credit liability is 2400. These are not yet generic unapplied cash receipts.
- Recurring invoice templates generate drafts only; historical cycle snapshots
  and current creator permission/entity checks must remain intact.
- Statements, historical ageing, ledger reports, reconciliation and project
  profitability already interpret specific posting sources. Every new source
  needs explicit classification and regression coverage, not only a new screen.
- Bank/manual-journal/chart drafts have tab recovery/navigation protection. Reuse
  the patterns; do not advertise them as cross-device or offline server drafts.

Useful entry points: `server/domain.ts` (`payment.create`, quote/invoice lifecycle),
`server/credits.ts`, `server/statements.ts`, `server/financial-reports.ts`,
`server/banking.ts`, `server/projects.ts`, `shared/commands.ts`,
`shared/documents.ts`, `src/Billing.tsx`, `src/InvoiceComposer.tsx`,
`src/QuoteComposer.tsx`, `src/PartyStatements.tsx`, `src/browserDraft.ts`,
`src/NavigationSafety.tsx`. Existing grouped vendor-payment workflows are a
reference, not code to paste without checking receivables semantics.

## Implement complete workflows, in this order

### A. Customer receipts and unapplied cash

Requirements: AR-040–AR-042; compatible with AR-046/TAX controls and AR-051.

1. One receipt for one customer, explicit entity and currency, allocated over
   several eligible issued invoices. Oldest-first suggestion with editable
   allocations; never cross entities/customers/currencies silently.
2. Separate cash, each withholding type and bank fee. A single receipt is one
   bank movement. Non-cash withholding must never inflate bank receipts.
3. Unallocated cash remains an identified customer liability, not revenue or
   an invented invoice. Show available cash by customer/entity/currency. Do not
   invent unallocated statutory withholding balances without a validated rule.
4. Apply later to invoices, record unused-cash refunds, and reverse applications,
   refunds and whole receipts with dated, immutable compensating entries.
5. Explicit amount/account/date review before posting; scoped recoverable drafts,
   clear validation, stable retry identity, accessible cancellation and focus.
6. Preserve historical single-invoice payments. Show which invoices each receipt
   settled and which receipt/application changed a balance. No destructive rewrite.
7. Cover partial/final carrying-value allocation and FX, rounding residuals,
   locked/reconciled dates, concurrent allocation and lost-response retries.

### B. Collections

Requirements: AR-060–AR-064 and statement gaps in AR-061.

1. Real overdue worklist grouped by customer, with entity/currency labels,
   disputed balances, last contact, promise-to-pay date and next action.
2. Audited communication notes/actions linked to the customer and exact invoice
   in the CRM timeline; assignments respect active membership and entity access.
3. Dispute flags pause reminder eligibility and create an owner task. Credit
   holds visibly warn/block new sales as configured and are enforced server-side.
4. Versioned reminder schedules/templates with before/on/after-due rules and
   stop conditions. Without an approved delivery integration, expose genuine
   queued/manual follow-up status, **never pretend emails were sent**.
5. Statement/history balances must reconcile, including unapplied cash and credits;
   scheduled delivery depends on the separately approved integration phase.

### C. Sales documents and orders

Requirements: AR-001–AR-020, AR-050–AR-052, AR-070 and AR-074; preserve original
Must/Should/P1 priorities and explicitly track anything not completed.

1. Accepted quote → sales order → partial/full invoice with immutable source
   snapshots and allocation limits. Cancelled/voided allocations release only the
   appropriate remaining amount. Sales orders do not post revenue or cash.
2. Cash sales receipt records sale and payment atomically, including tax/fees and
   an explicit bank account. Do not build it as two independently committing
   commands or a cosmetic "paid" invoice flag.
3. Complete document actions/history, progress allocations, credit/write-off
   gaps, and approval integration; retain exact quote-option acceptance semantics.
4. Reuse the shared approval engine for quote discount/margin/total rules
   (AR-009) and invoice approvals, coordinating the extension with Codex. Do not
   fork a second approval engine or bypass cost-visibility permissions.
5. Distinguish draft, issued, sent, accepted, invoiced, settled and reversed states.
   Manual sent evidence is not proof of delivery. Hide/disable invalid actions with
   a useful reason, and enforce the same rule on the server.
6. Coordinate with Codex's pending document defaults. Saved draft/source document
   values take priority; customer overrides precede entity defaults. Changes to
   settings never silently reprice or rewrite existing documents. Do not infer an
   issuing entity, tax rate or market exchange rate from convenience defaults.

Delivery, gateways, full portal signatures, certificates and jurisdictional tax
validation depend on their approved integration/compliance workstreams. Track
them as outstanding sales requirements; do not count a mock, manual log or button
as implementation. External account connections, real emails/payments and paid
provisioning still need separate authorization.

## Accounting, security and UX acceptance

- All commands run inside authenticated `inTenant`, RLS/non-bypass SQL role and
  current legal-entity grants; custom capabilities are rechecked on the server.
- Integer minor units/BigInt only. Source records, allocation changes, balanced
  journal and audit commit in one transaction. Lock competing invoices/receipts
  deterministically; reject retry-key reuse with a different payload.
- Posted financial history is append-only. Validate lifecycle, date chronology,
  locked periods, reconciled banks, cross-tenant and cross-entity denial.
- Carry old and new payments correctly through AR controls, liabilities, ageing,
  statements, cash flow, bank reconciliation and project attribution. Aggregate
  views are labelled aggregates, not statutory consolidated accounts.
- Show prerequisites and real empty/loading/error states. Keep existing GV
  navy/beige/orange identity; use Zoho's proven document workflow, not a new visual
  system. Avoid long mandatory forms, fake actions and silent data loss.
- Test keyboard operation, focus restoration, small screens, effective permission
  gates and uncertain network outcomes. Add no dependencies casually.

## Safe environments and verification

**Port 4320 is protected and contains real Zoho data.** Do not restart it with new
code, reset/reseed/migrate its database, run mutating QA, or upload/copy its data.
Do not touch the old SQLite/native CRM either. Authentication mode is not a data
classification. No customer data is needed for this assignment.

Codex's fictional preview is on **4342**; do not change or restart it. Claude owns
fictional preview **4350**, live reload **4351**, with a newly created temporary
database. Verify a free port and use `mktemp -d`; never reuse the protected path.
Disable the recurring worker for interactive previews unless deliberately testing
it. Do not commit DBs, browser state, screenshot/trace/test artifacts or secrets.

Automated browser tests currently hardcode **4322**. They cannot safely run
simultaneously across checkouts. Agree a testing window, or first make the test
port configurable in Claude's branch while preserving 4322 as the default and
running both the default and alternate setup. Each branch owns its dependencies,
build outputs and fixtures; do not symlink writable build/test directories.

Pinned baseline evidence: full local `npm run verify` passed 151 backend/unit and
60 browser tests, typecheck and production build; `npm audit --audit-level=high`
reported no vulnerabilities. This is **not** hosted-CI, accountant, UAT or release
sign-off. Existing client chunk-size warning remains.

For each finished increment run full verify/audit, add API/ledger/RLS/concurrency
and browser regressions, push the feature branch and open a reviewed PR. CI must
pass disposable PostgreSQL plus browser checks. If migration fixtures assert a
fixed list/count, update them without removing old migrations. Include precise
evidence, screenshots of fictional data where useful, migration impact, known
gaps and a verified preview URL. Self-review is not independent review.

## First reply expected from Claude

Confirm the correct checkout/branch and pinned baseline; list existing sales
features versus missing acceptance criteria; acknowledge migration/port/file
ownership and protected-data boundaries; then implement slice A end-to-end.
Report the real commit/PR and tests, not a documentation-only completion claim.
Claude is not currently running merely because this file exists.
