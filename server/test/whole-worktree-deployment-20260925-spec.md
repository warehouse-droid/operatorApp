# Whole worktree release — 25 September 2026

The user explicitly requested “deploy the whole worktress”, authorizing release
of all current application changes to the app and webhook worker. This supersedes
the previous deployed-only snapshot boundary. Detailed spec approval: not obtained
(autonomous execution under that authorization). Tier 3 deployment verification.

Acceptance:

1. Freeze the complete application source, assets, migrations and supporting
   tests. Build the standard production Dockerfile with development dependencies
   omitted. Exclude backup files, private configuration and operational data.
   Verify every shipped file against the frozen worktree in both running services.
2. Run the full MBT suite, the executed-order review/address/browser regressions,
   Aggregate regressions and NetSuite priority regressions in isolated databases.
   Compare failures against the captured deployed source; allow no new failures.
   Retain feature property, mutation, static and coverage evidence and rerun the
   affected Dispatch layers on the frozen release.
3. Inventory all pending migrations. Rehearse candidate app/worker startup and
   rollback on a disposable database. The expected pending migration is the
   additive `212_dispatch_executed_order_reviews.sql`; retain its data on rollback.
4. Preserve production environment, mounts, service limits and persistent volumes.
   Save and validate a private database backup and retain both prior image IDs.
   Check for active postings/webhook jobs before a coordinated app/worker restart.
5. Verify application health, worker startup, source and served asset hashes,
   anonymous authorization boundaries, schema and unchanged dependency containers.
   Restore prior app/worker images if release verification fails. Do not create
   test NetSuite documents or restore the production database automatically.

Failure model: mixed or stale sources (hash gates), regression in protected
execution/source reconciliation (domain, HTTP, browser, property and race tests),
blank address data loss (address guard suites), priority scheduling regression
(shared queue tests), missing runtime dependencies (actual-image smoke), schema
incompatibility (migration/rollback rehearsal), lost configuration (effective
Compose/runtime comparison), interrupted work (idle check and graceful stop),
unhealthy cutover (health check and image rollback).

Use existing Docker, Node, PostgreSQL and test dependencies. No dependency changes
or additional Git commit are required for deployment. Keep reproducible release
scripts in `tools/` and private captures/logs under ignored `test-artifacts/`.
