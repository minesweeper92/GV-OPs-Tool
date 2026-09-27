# GV Workspace: fresh implementation

New repository, created from scratch on 27 September 2026. No source or data copied from the previous CRM. This is the first tested vertical slice, **not the complete requirements document or a production release**.

## Run locally

Node 24+, `npm ci`, then `npm run dev`. Open `http://127.0.0.1:4320` and choose a clearly labelled sample identity. Fictional data persists under ignored `.data/workspace`. The previous app is not used or changed.

`npm run verify` runs type checks, API/ledger tests, production client build and browser tests. Local browser tests use installed Chrome with a separate in-memory database on port 4322. CI uses Playwright Chromium. `GV_TEST_DATABASE_URL` optionally runs integration tests against an empty, disposable loopback PostgreSQL database named `gv_workspace_test`; never point tests at live data.

## Working slice

- Separate tenants, memberships, legal entities and shared customer/vendor companies.
- Contacts with dated many-to-many company associations, preserving old project links.
- Leads convert to linked deals without re-keying.
- Named quote alternatives with immutable revisions. Any specific version can be accepted; newest never automatically wins.
- Accepted quote to invoice draft, explicit numbered issue, cash and withholding receipts, partial payments, unpaid invoice reversal.
- Manual PKR/USD/AED/EUR/GBP transaction currencies, PKR base, fixed document exchange rates, realised FX gain/loss on settlement.
- Paid general/project expenses, separate charts/ledgers per entity, trial balance movements, journal drill-down, transaction locks, immutable audit records.
- Transaction-level RLS, own-record sales filtering, role checks, session cookies, origin/CSRF validation and retry protection for financial postings.
- Responsive React UI with light/dark/high-contrast themes and side-panel forms.

## Deliberate limits / next work

Loopback sample authentication is not production OIDC. Custom roles, per-entity permissions, onboarding, subscriptions, full contact editing/import, approvals, milestones, recurring documents, credit notes, bills/POs, inventory, reconciliation, bank integrations, tax/WHT certificates, financial statements, portals, email/calendar sync and other requirements remain to build. Quotes are manually marked shared; nothing is emailed. No statutory tax configuration is assumed. Base currency is PKR; broader currency precision/rate providers remain open. Period locks cannot yet be reopened. One accepted full invoice per deal in this slice.

The client list snapshot is appropriate for this small local increment, not yet paginated for production-scale tenants. Production runtime/control DB privilege separation, secure identity, background jobs, backups, observability, performance/security reviews, accountant sign-off and user acceptance remain release gates. The server deliberately refuses production mode. The PostgreSQL CI job is configured but not evidence of a hosted CI run until pushed and executed.

## Layout

- `shared`: command schemas and integer money calculations
- `server`: gateway, domain service, posting engine, SQL schema and local fixtures
- `src`: independent client, shared UI primitives, record pages and editors
- `tests`: actual API/database accounting assertions and browser workflows

No paid service, remote repository or public deployment has been created.
