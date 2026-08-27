# Operator NetSuite Posting Gates — Evidence

Date: 2026-08-25 UTC

Specification status: approved Tier 3. The implementation is intentionally not
deployed, and all twelve production-facing database gates default to disabled.

## Outcome

- Admin has a 4-by-3 matrix for Customer Pickup, Receiving, and Delivery Prep at
  yards 3445, 2967, 12441, and 150. Each cell can be changed independently with
  an audited reason, optimistic revision check, and idempotency key.
- `NETSUITE_DIRECT_ACCESS_ENABLED` remains the deployment-wide ceiling. A cell
  can be configured on while remaining effectively off when the ceiling is off.
- Customer Pickup and Delivery Prep create exact Item Fulfillments; Receiving
  creates exact Item Receipts. Server-resolved canonical yard, source transaction,
  line identity, and confirmed quantity are authoritative.
- Durable commands, deterministic external IDs, read-before-create recovery,
  record verification, database claims, and renewable 180-second leases prevent
  duplicate transforms across retries, timeouts, restarts, and multiple replicas.
- Local completion occurs only after every required remote step is verified.
  Partial or ambiguous groups enter visible Admin attention instead of falling
  back to local-only completion.
- Native grouped and split SO/TO work resolves and aggregates exact positive
  NetSuite parents. Local CO, VRMA, re-load, and re-attempt paths remain local.
- Gate-off behavior remains compatible with the existing Operator workflows and
  performs no NetSuite posting call. Driver endpoints and offline payloads were
  not changed by the posting feature.

## Verification evidence

- Fresh isolated PostgreSQL migrations through migration 178 passed.
- Focused executable contract passed twice: 57/57 tests on each run.
- Focused browser behavior passed 24/24 across desktop Chromium, mobile Chromium,
  and mobile WebKit; related Dispatch load-order coverage passed 3/3.
- Full Node regression passed 1,958 tests in 391 files. One pre-existing,
  explicitly skipped migration-v4 case remained skipped.
- Full browser regression passed 468/468 across desktop Chromium, mobile Chromium,
  and mobile WebKit.
- Changed policy coverage passed at 96.29% statements/lines, 91.2% functions,
  and 82.92% branches.
- Persisted mutation testing killed 18/18 non-equivalent critical mutants and
  restored every mutated source before the regression suites.
- Legacy syntax, strict TypeScript, and zero-warning focused ESLint checks passed.
- Dependency inspection completed and the license scan passed 396 packages with
  the existing documented `buffers@0.1.1` exception unchanged.
- Focused secret scanning and `git diff --check` passed after explicit audited
  annotations for non-secret browser storage/fetch names and a test lease fixture.

## Residual release prerequisite

Deterministic tests use a fake NetSuite boundary. Before any production cell is
enabled, the allowlisted NetSuite sandbox must prove both an IF and an IR transform,
including lookup and verification by the deterministic external ID. Until that
proof exists, the feature is implemented but is not approved for gate activation.
