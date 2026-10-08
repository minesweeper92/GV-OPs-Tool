# Development and release workflow

GitHub is the shared source of truth. Local checkouts are development copies.
The full tracked source and commit history belong in this repository; databases,
credentials, customer documents, browser sessions and test artifacts do not.

## Each increment

1. Open an issue describing the user workflow, scope and testable acceptance criteria.
2. Branch from current `main`, using `feature/`, `fix/` or `chore/` and a descriptive name.
3. Make small commits. Preserve unrelated changes and immutable migration history.
4. Run `npm run verify` and `npm audit --audit-level=high`. Add regression tests for
   permissions, tenant/entity boundaries, retries, accounting and UI where relevant.
5. Push the branch and open a pull request referencing the issue. Explain changes,
   evidence, migration implications and remaining limitations.
6. Merge only after the Verify check passes, including disposable PostgreSQL tests,
   and review is complete. Do not bypass failures or force-push `main`.
7. Update the issue with what is implemented and tested. A merge is not a production release.

For a solo-maintained repository, an explicit self-review can be recorded, but is
not independent review. Branch protection must be enabled in GitHub settings to
enforce this process; templates alone do not enforce it.

## Release gates

Use a staging environment with fictional or approved test data. Production needs
checked migrations, backup/restore evidence, security review, accountant and user
acceptance, and explicit deployment authorization. Paid provisioning, live-data
migration and external account connections need separate approval.

Tag only a validated release, with release notes and a migration/rollback plan.
Database rollback must preserve posted financial history, not delete or rewrite it.
Never deploy the local sample-login entry point.

## Agreed implementation order

1. Unfinished work: vendor advances and full regression (implemented and locally tested).
2. Shared foundations: permissions/approvals, configurable defaults, documents and consistent forms/lists (in progress).
3. Sales: grouped receipts, unapplied cash, collections, sales-order/document gaps.
4. Purchasing: staff claims/reimbursements, billable costs, approvals.
5. Project delivery: tasks, time, rates, unbilled work, invoicing.
6. Accounting: transfers/foreign banks, reconciliation corrections, dimensions, year-end/reporting.
7. Tax/integrations: validated configuration, certificates, Microsoft 365, delivery/payments.
8. Production/commercial gates: migration, operations, security, SaaS controls, pilot sign-off.
9. Later parity: retain P2/P3 requirements, do not silently remove them.

Start each session by checking branches, issues, PRs and CI. Keep progress on the
relevant issue/PR rather than relying on chat memory. README limits remain explicit.
