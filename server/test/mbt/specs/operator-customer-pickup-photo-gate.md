# Operator Customer Pickup Photo Gate — Executable Specification

Status: autonomous Tier 3 specification; advance human approval was not obtained.

## Feature

An audited Admin feature gate controls only the Operator module's Customer Pickup
photo requirement. The gate key is
`operator_customer_pickup_photo_required`. It defaults to enabled so an upgrade
preserves the current evidence requirement.

## Failure model

1. A stale or modified client bypasses the visible photo control. Server-side
   policy must reject a photo-less load while the gate is enabled before any
   quantity, order status, load record, or audit mutation.
2. The gate is disabled but a hard-coded client or route still requires photos.
   The Operator must be able to complete Customer Pickup with zero photos, and
   the resulting load/audit evidence must state the policy revision and zero
   evidence count.
3. The migration is absent, the row is missing, or the value is malformed.
   Policy must fail safe to one required photo.
4. This narrowly scoped switch weakens ordinary Delivery or re-load evidence.
   Those workflows must continue requiring two photos.
5. A cached Operator shell does not learn a changed gate. The configuration
   endpoint must be `no-store`; the UI must refresh it when entering and when
   confirming Customer Pickup; the completion API must independently re-read
   the database gate.
6. An Admin update races with a load. Each load uses one server-read policy
   snapshot and records its revision. A later request observes the newer
   revision; the client cannot choose a revision or requirement.
7. Empty strings, arbitrary URLs, and malformed photo values are counted as
   zero evidence.

## Scenarios

### S1 — default-on migration

Given schema migration 165 is applied to a database without the gate row,
when the migration completes,
then `operator_customer_pickup_photo_required` exists with `enabled = true`, a
non-empty description, and revision at least 1.

Given the row already exists with `enabled = false`,
when migration 165 is rerun,
then it does not overwrite that value.

### S2 — enabled policy requires one photo

Given the gate is enabled and a valid packed Customer Pickup order exists,
when completion supplies zero valid photo references,
then it fails with status 400 and `At least 1 photo is required`, and no order,
line, load-record, or audit state changes.

When the same kind of completion supplies one `data:image/...` or `r2://`
reference,
then it completes and persists exactly that reference.

### S3 — disabled policy permits zero photos

Given the gate is disabled and a valid packed Customer Pickup order exists,
when completion supplies no photos,
then it completes, persists an empty photo array and blank legacy photo field,
and records `requiredPhotoCount = 0`, evidence count 0, and the gate revision in
the response/load evidence/audit details.

### S4 — optional evidence remains supported

Given the gate is disabled,
when completion supplies valid photos,
then all valid supplied references are still persisted and counted.

### S5 — missing/malformed setting fails safe

Given the gate row is missing or its injected value is anything other than the
boolean `false`,
when policy is resolved,
then the requirement is enabled and the required count is 1.

### S6 — Admin can change the gate safely

Given an Admin reads the operational gate inventory,
when they disable or enable this independent gate using the existing command
API,
then optimistic revision, idempotency, audit, and role enforcement remain in
force, and the no-store Operator configuration endpoint immediately reports
the updated count without a PWA version change.

### S7 — Operator UI follows live policy

Given Customer Pickup is opened,
when the load screen starts and again when Load is pressed,
then the UI fetches `/api/customer-pickup/config` with no cache, shows one
required slot when enabled, shows photo proof as optional when disabled, skips
the uploader when there are zero photos, and submits an empty array.

### S8 — unrelated evidence remains hard

Given an ordinary Delivery or authorized re-load,
when fewer than two photos are supplied,
then the existing two-photo requirement remains unchanged.

## Negative constraints

- The browser never sends a trusted `required`, `minimum`, or gate revision
  value to the completion API.
- The switch changes no inventory, NetSuite, Driver, Dispatch, billing, or
  receiving policy.
- Existing Customer Pickup completion response fields remain compatible; new
  evidence metadata is additive.
- No dependency, package-lock, environment, container, or deployment change is
  authorized by this implementation task.

## Setup and gauntlet plan

- Use the existing Node test runner, PostgreSQL isolated test Compose stack,
  TypeScript check, ESLint configuration, coverage tooling, browser tests, and
  secret/license checks already in the repository.
- Add no dependencies.
- Add focused unit/property/integration/UI-contract tests, a persisted manual
  mutation runner, a source-state command, one gauntlet entry point, and an
  evidence report.
- Git is already initialized. No checkpoint commits or deployment are part of
  this task unless separately requested.
