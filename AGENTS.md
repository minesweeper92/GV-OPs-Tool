# Fresh GV Workspace

This is a new implementation, requested on 27 September 2026. Do not copy or revive the old GV-CRM implementation. Leave its code and live data untouched.

Product scope: `/Users/zohaibburki/Downloads/Unified-Books-CRM-Requirements.md`. The document supersedes older desktop/offline plans. This repository is an incremental build, not P1 completion.

- TypeScript/React client; Fastify gateway; PostgreSQL-compatible schema. PGlite is only the local development/test database.
- All business operations run through `inTenant` using the authenticated session, a non-bypass SQL role and transaction-local RLS context.
- Use integer minor units and BigInt calculations. Source documents and ledger entries commit atomically. Never mutate posted journals or quote versions.
- Financial issuing entity is explicit. Keep tenant, legal entity, customer company and contact separate.
- Sample identities are strictly loopback-only. Do not deploy them. Implement audited production OIDC and release hardening before hosting.
- Never import live financial records, provision paid services, publish, connect Microsoft/Zoho or send emails without authorization.
- Run `npm run verify` and `npm audit --audit-level=high`. CI also runs the same integration tests on disposable PostgreSQL.
- Preserve the lockfile. Do not commit `.data`, session state, traces, screenshots or credentials.
- No agents/delegation unless requested. Use small, reviewed commits and leave honest implementation limits.
