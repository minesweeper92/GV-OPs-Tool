# GV Workspace: fresh implementation

New repository, created from scratch on 27 September 2026. No source or data copied from the previous CRM. This is the first tested vertical slice, **not the complete requirements document or a production release**.

## Run locally

Node 24+, `npm ci`, then `npm run dev`. Open `http://127.0.0.1:4320` and choose a clearly labelled sample identity. Fictional data persists under ignored `.data/workspace`. The previous app is not used or changed.

`npm run verify` runs type checks, API/ledger tests, production client build and browser tests. Local browser tests use installed Chrome with a separate in-memory database on port 4322. CI uses Playwright Chromium. `GV_TEST_DATABASE_URL` optionally runs integration tests against an empty, disposable loopback PostgreSQL database named `gv_workspace_test`; never point tests at live data.

## Working slice

- Separate tenants, memberships, legal entities and shared customer/vendor companies.
- Contacts with dated many-to-many company associations, preserving old project links.
- Leads convert to linked deals without re-keying.
- Editable, version-checked contact and company profiles: secondary emails and typed phones, addresses, tags, lifecycle/source, consent evidence, currency and servicing-entity preferences. Primary/secondary contact emails share tenant-wide uniqueness. Employer changes retain dated affiliations and old commercial snapshots; profile preferences never silently change a document's issuing entity.
- Lead detail and qualification states, disqualification reasons, reopening with a next action/date, and conversion retaining linked history. Assigned tasks have due dates, priorities, completion/reopening, a filtered Tasks workspace and a My day queue. Manual calls, meetings, emails and notes appear on linked contact/company/lead/deal timelines; email references are explicitly manual, not proof of sending or synchronization. Task assignment respects active membership and root-record visibility.
- Named quote alternatives with immutable revisions. Any specific version can be accepted; newest never automatically wins.
- Accepted quote to partial or full invoice drafts, explicit numbered issue, cash and withholding receipts, partial payments, draft cancellation and unpaid invoice reversal. Each invoice owns its immutable amounts and allocated line/tax snapshot; old invoice amounts are preserved by a tested migration.
- Projects from the exact accepted quote, retaining the client/contact, deal and explicitly confirmed issuing entity. Project dates, status and PKR cost budgets are versioned and audited. Planned milestones and invoice drafts reserve the contract subtotal, preventing overbilling; cancelling/voiding releases the invoice allocation. Advance invoices defer net revenue until finance explicitly records delivered work, with dated, immutable partial recognitions.
- Project profitability from posted ledger entries: earned revenue, costs, exchange result, cash collected, withholding, outstanding receivables, deferred revenue and budget variance. Linked vendor bills accrue costs once; payments do not duplicate them. Equipment and prepayments stay outside expense. Existing deal-linked documents are included when a project is created.
- Manual PKR/USD/AED/EUR/GBP transaction currencies, PKR base, fixed document exchange rates, realised FX gain/loss on settlement.
- Invoice-based partial/full credit notes with original-line tax allocation, explicit earned/deferred treatment, applications to same-customer/entity/currency invoices, recorded customer refunds with FX, and dated immutable reversals. Credits reduce receivables only when applied; unused credits remain a separate liability. Historical ageing, cash flow and project profitability include the effects. Original invoices are preserved; credits do not silently reopen fixed-contract billing allocation.
- Recurring invoice and paid-expense schedules: weekly/monthly/quarterly/yearly anchored dates, explicit timezone, end/count limits, pause/resume/stop, versioned future edits and an audited occurrence history. A 60-second server worker catches up in batches of 12 due cycles per profile, with manual generation and explicit skip actions. Invoice cycles create unposted drafts; expense cycles require payment review before posting. Retry/row-lock protection prevents duplicate cycles. Revoked/non-finance creators cannot run background generation. Recurring service contracts use a separate accepted deal rather than bypassing fixed-project budgets.
- Paid general/project expenses, separate charts/ledgers per entity, trial balance movements, journal drill-down, transaction locks, immutable audit records.
- Vendor bills with editable drafts, submission, single-administrator approval/posting, duplicate checks and explicit entity/project links. Partial payments support withholding, bank fees and realised FX; dated payment reversals and unpaid-bill voids preserve the original ledger history.
- Vendor directories and payable balances by entity and transaction currency. Base-currency balances use historical carrying amounts; period-end FX revaluation is not implemented.
- Ledger-based accrual P&L, balance sheet, indirect cash flow for classified posting types, opening/movement/closing trial balance, historical receivable/payable ageing with ledger-control reconciliation, account drill-down, CSV and browser print/PDF. Reports use a consistent transaction snapshot. Combined entity reports are labelled as aggregates, not consolidated statements.
- Named PKR bank accounts with explicit verified opening balances/offsets, account selection on receipts/vendor payments/expenses, validated CSV statement previews/imports, grouped matches, auditable undo before completion, reconciliation and carried-forward uncleared items. Reconciled bank dates reject backdated postings; imports and matches never create income/expenses.
- Transaction-level RLS, own-record sales filtering, role checks, session cookies, origin/CSRF validation and retry protection for financial postings.
- Responsive React UI with light/dark/high-contrast themes and side-panel forms.
- Organization creation/switching, administrator-managed invitations, member roles, access removal/restoration and session revocation. Invitation links are shared manually, not emailed.
- Configurable OIDC authorization-code sign-in with PKCE, nonce, browser-bound state, signature/issuer/audience checks and verified-email invitations. Separate sample and identity-enabled databases; sample sessions cannot authenticate to the hosted adapter.

## Identity-enabled staging adapter

`npm run dev` remains a loopback-only fictional preview. A separate `npm start` entry point serves the built client and requires an HTTPS public origin, a new PostgreSQL database and a configured OIDC provider. It does not run Vite or expose sample login routes. The provider must support authorization-code/PKCE and supply a verified email; automatic email-based account linking is deliberately disabled. Provider provisioning and real-account verification have **not** been performed.

See `.env.example` for names only; supply real secrets through a secret manager, not Git. Register the exact `/auth/callback` URL with the provider. Review/back up the target before explicitly applying migrations with `GV_MIGRATION_TARGET=oidc npm run db:migrate`. Serving verifies migration checksums and refuses a sample-marked database. Put TLS and a correctly configured reverse proxy in front of the loopback listener; preserve the configured Host. Proxy-aware/distributed rate limiting and deployment security review remain required before multi-user hosting.

Local tests exercise the real OIDC protocol library against a disposable signed-token issuer, including bad signatures, wrong nonce/audience/issuer, expired requests, replay, unverified email and session separation. This is not evidence of a live identity-provider deployment.

## Deliberate limits / next work

Custom roles, per-entity permissions, extended onboarding, subscriptions, contact import/merge, configurable custom fields/pipelines, task recurrence/reminders, multi-level approvals, purchase orders, vendor credits, multi-bill payment allocation, attachments, inventory, live bank integrations, foreign-currency bank accounts, bank transfers, tax/WHT certificates, advanced/comparative financial reporting, portals, email/calendar sync and other requirements remain to build. Quotes are manually marked shared; nothing is emailed. No statutory tax configuration is assumed. Base currency is PKR; broader currency precision/rate providers remain open. Period locks and completed reconciliations cannot yet be reopened. One bill per vendor payment in this slice.

Project limits: one fixed-contract project per accepted deal, finance/admin access, partial amounts spread over remaining quoted lines with exact remaining tax allocation. No scope-change orders, project team/tasks/timesheets, time-and-materials or full retainer drawdown, WIP valuation, overhead allocation or automated revenue recognition schedules yet. Profitability is all recorded dates, not a selectable historical project report. Budgets are PKR and compare posted costs; draft purchase commitments are not accrued. Advances use the agreed quote's tax treatment; this is not jurisdiction-specific retainer/tax-compliance certification. Revenue recognitions require delivery evidence and cannot yet be reversed in the UI; a recognised advance cannot be voided.

Billing limits: credits currently originate from issued invoices, not standalone opening credits. Refunds record money already returned; they do not transfer funds or adjust withholding certificates. Schedules generate drafts only, never auto-send, auto-charge or auto-post. Expense schedules are PKR paid-expense templates, not recurring vendor bills. Start date/frequency/timezone are fixed; use a new contract to change them. Generated documents keep their snapshots and cannot be regenerated for the same cycle after cancellation. Review template rates before due cycles; no market-rate feed or draft repricing is provided. The worker requires a running server and active finance creator; it is not an external durable job queue or a deployment-readiness claim.

Report limits: no cash-basis statements, consolidated eliminations, period-end FX revaluation, XLSX export, scheduled reports or statutory tax reports. Cash flow fails visibly for unclassified cash posting types (including opening-balance setup within the selected period); it does not silently guess a classification. Bank openings require a verified balance and explicit offset; opening clearing must be resolved during a checked migration. Statement imports currently require exact Date/Description/Reference/Amount CSV columns, up to 500 rows/100 KB. Historical unassigned bank/cash postings are preserved, not silently moved into new accounts. Larger bank/report datasets still need pagination/performance work.

The client list snapshot is appropriate for this small increment, not yet paginated for production-scale tenants. Production runtime/control DB privilege separation, live identity-provider configuration/validation, background jobs, backups, observability, performance/security reviews, accountant sign-off and user acceptance remain release gates. The local preview entry point refuses production mode. The PostgreSQL CI job is configured but not evidence of a hosted CI run until pushed and executed.

## Layout

- `shared`: command schemas and integer money calculations
- `server`: gateway, domain service, posting engine, SQL schema and local fixtures
- `src`: independent client, shared UI primitives, record pages and editors
- `tests`: actual API/database accounting assertions and browser workflows

No paid service, remote repository or public deployment has been created.
