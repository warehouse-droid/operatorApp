# Aggregate Requests deployment — 2026-09-22

The subsequent translated card layout and Operator Inventory menu were deployed at 13:40 UTC. See [the UI follow-up record](aggregate-ui-evidence.md) for the current release; this document retains the initial module deployment evidence.

Deployment was explicitly authorized by the user's “deploy” instruction and completed at **12:33:21 UTC**.

- Standalone module: <https://test.mbbsoperation.com/aggregate-requests>
- SCM tab: <https://test.mbbsoperation.com/scm/stock-requests?tab=aggregate>
- Release image: `mbbs-operator-app:aggregate-requests-20260922-v1`
- Image ID: `sha256:15fa095e832bb922e5c7890dd5aa477a9b2f9a801e197fc869d848656837ab75`
- Applied migration: `215_aggregate_requests.sql`

The release overlays 17 runtime files onto the captured `field-sales-existing-customers-20260922-v1` image. The task patch applied with zero fuzz. Existing live differences in the Operator shell/client and server were retained. Production package files and dependencies were preserved exactly.

## Validation

The prepared candidate passed **36/36 Aggregate tests** and **51 related checks**, including real PostgreSQL, authenticated HTTP, Chromium, existing Regular/Special behavior, Operator cache contracts, and sidebar permissions. Syntax, lint, and domain type checks passed. Candidate image contents matched all 17 prepared file hashes.

After cutover:

- Both local and public health endpoints returned HTTP 200 with `ok: true`.
- Both module pages returned HTTP 200 and included the Aggregate client.
- Both Aggregate APIs rejected anonymous requests with HTTP 401.
- All 12 changed public assets matched the release hashes through local and public HTTP.
- A PostgreSQL-enforced read-only repository check confirmed all three tables, seven materials, four yards, and the Toronto-derived service date.
- All 17 running-container files matched the candidate hashes.
- Application environment, command, mounts, ports, and restart settings were preserved. The webhook worker, database, and Ollama containers were unchanged.
- Startup logs contained no syntax, reference, missing-module, or uncaught-exception errors.

No operational requests were created by the production verification. Migration 215 is additive; schema and migration-ledger backups were captured and validated before it was applied.

## Release records and rollback

The persisted release tool is [aggregate-deploy.py](../tools/aggregate-deploy.py), with `prepare`, `build`, `check`, `apply`, and `verify` stages. It checks the previous implementation evidence, current image/source, exact candidate, live settings, and active application work before cutover. A verification failure triggers application-image rollback while retaining the additive tables and any entered requests.

Release metadata, exact patch, backup archives, candidate logs, browser artifacts, runtime verification, and Compose overrides are retained in:

`server/test-artifacts/aggregate-deployment-20260922`

The previous application image is retained as `mbbs-operator-app:rollback-aggregate-requests-20260922-v1`; `compose.rollback.yml` records its immutable image ID. No rollback was needed.

See [implementation evidence](aggregate-requests-evidence.md) for coverage, mutation testing, and the full-suite comparison. That suite had no new failures; 23 pre-existing failures and one skipped test remain.
