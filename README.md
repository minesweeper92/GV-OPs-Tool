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
- Organization creation/switching, administrator-managed invitations, member roles, access removal/restoration and session revocation. Invitation links are shared manually, not emailed.
- Configurable OIDC authorization-code sign-in with PKCE, nonce, browser-bound state, signature/issuer/audience checks and verified-email invitations. Separate sample and identity-enabled databases; sample sessions cannot authenticate to the hosted adapter.

## Identity-enabled staging adapter

`npm run dev` remains a loopback-only fictional preview. A separate `npm start` entry point serves the built client and requires an HTTPS public origin, a new PostgreSQL database and a configured OIDC provider. It does not run Vite or expose sample login routes. The provider must support authorization-code/PKCE and supply a verified email; automatic email-based account linking is deliberately disabled. Provider provisioning and real-account verification have **not** been performed.

See `.env.example` for names only; supply real secrets through a secret manager, not Git. Register the exact `/auth/callback` URL with the provider. Review/back up the target before explicitly applying migrations with `GV_MIGRATION_TARGET=oidc npm run db:migrate`. Serving verifies migration checksums and refuses a sample-marked database. Put TLS and a correctly configured reverse proxy in front of the loopback listener; preserve the configured Host. Proxy-aware/distributed rate limiting and deployment security review remain required before multi-user hosting.

Local tests exercise the real OIDC protocol library against a disposable signed-token issuer, including bad signatures, wrong nonce/audience/issuer, expired requests, replay, unverified email and session separation. This is not evidence of a live identity-provider deployment.

## Deliberate limits / next work

Custom roles, per-entity permissions, extended onboarding, subscriptions, full contact editing/import, approvals, milestones, recurring documents, credit notes, bills/POs, inventory, reconciliation, bank integrations, tax/WHT certificates, financial statements, portals, email/calendar sync and other requirements remain to build. Quotes are manually marked shared; nothing is emailed. No statutory tax configuration is assumed. Base currency is PKR; broader currency precision/rate providers remain open. Period locks cannot yet be reopened. One accepted full invoice per deal in this slice.

The client list snapshot is appropriate for this small increment, not yet paginated for production-scale tenants. Production runtime/control DB privilege separation, live identity-provider configuration/validation, background jobs, backups, observability, performance/security reviews, accountant sign-off and user acceptance remain release gates. The local preview entry point refuses production mode. The PostgreSQL CI job is configured but not evidence of a hosted CI run until pushed and executed.

## Layout

- `shared`: command schemas and integer money calculations
- `server`: gateway, domain service, posting engine, SQL schema and local fixtures
- `src`: independent client, shared UI primitives, record pages and editors
- `tests`: actual API/database accounting assertions and browser workflows

No paid service, remote repository or public deployment has been created.
