# MBT Local-First Configuration — Executable Specification

Status: implementation specification, 2026-08-03. This clarification is
append-only and supersedes Phase 2 only where Phase 2 treated NetSuite metadata
as the primary MBT configuration. It does not delete historical Phase 1 or
Phase 2 evidence.

## Authorization and setup

The user directed the application to focus on local setup and to leave the
unverified `Mr Bin Trucking Inc.` subsidiary and customer internal ID `7143`
for later. This autonomous implementation did not receive a separate review of
the scenarios below, so the final evidence must record `spec approval: not
obtained (autonomous run)`.

- Assurance tier: Tier 3 because item prices and posting intent affect money
  and could accidentally create external accounting work.
- Dependencies: none. Use the existing Node test runner, PostgreSQL, c8,
  TypeScript, ESLint, fast-check, Playwright, and persisted mutation runner.
- Git: do not commit, push, deploy, restart production, or rewrite unrelated
  working-tree changes. The source state is reported as the current branch and
  working-tree diff.
- Database: add one forward-only migration after migration 108. Exercise it
  only in the isolated MBT test database during development.
- NetSuite: make no remote request and add no write-capable adapter, worker, or
  route.

## Tier 3 failure model

| Failure | Required detector |
|---|---|
| A local price is rounded, negative, unsafe, or interpreted as dollars twice | Integer-minor-unit database constraints plus unit/property/API tests |
| Concurrent Admin edits silently overwrite one another | Row lock, expected revision, concurrency test |
| A retry performs the update or audit twice | Existing command receipt/idempotency boundary plus integration test |
| A local-only approval creates NetSuite work | Database outbox/chain assertions and repository integration tests |
| A future-posting marker is mistaken for write permission | Tests proving both allowed posting modes create zero external work in this phase |
| Historical billing meaning changes when an item setting is edited | Immutable billing version records the posting mode; lines can record local item code and revision |
| Existing billing lines or legacy application records are damaged during upgrade | Schema-108 upgrade rehearsal, exact legacy checksum comparison, migration rerun |
| Dispatcher, Driver, SCM, Returns, or existing MBT safety gates change | Full MBT and explicit legacy baseline suites |
| Non-Admin users read or edit monetary configuration | HTTP role matrix and browser-route tests |
| The local screen triggers NetSuite reads merely by opening | Browser/API test with a zero-call transport spy |

## Local item catalog

The local catalog contains exactly these seeded billable concepts:

| Code | Category | Price mode | Source types | Bin type |
|---|---|---|---|---|
| `DELIVERY_CROSS_CHARGE` | `cross_charge` | `calculated` | `SO`, `TO`, `PO`, `VRMA` | none |
| `14YD` | `bin_charge` | `fixed` | none | `14YD` |
| `20YD` | `bin_charge` | `fixed` | none | `20YD` |
| `40YD` | `bin_charge` | `fixed` | none | `40YD` |
| `DUMP` | `dump` | `custom` | none | none |

The existing operational `30YD` bin type is preserved but is not seeded as a
billable local item by this clarification.

Identity fields (code, category, price mode, source types, and bin type) are
server-owned. An Admin may edit display name, description template, unit of
measure, active state, and the fixed default price. Currency is CAD. Calculated
and custom-price items do not accept a fixed default price. A fixed-price item
with no default price remains visible but is reported as not ready for use.

## Scenarios

### LC01 — Deterministic local seed

Given migrations through the local-first migration, querying the local item
catalog returns the five rows above exactly once. Rerunning the official
migration runner creates no duplicates and does not rewrite an Admin-edited
row.

### LC02 — Local configuration requires no NetSuite identity

Given an empty NetSuite mapping catalog and blank NetSuite runtime settings,
an Admin can list and update local item settings. No subsidiary, customer,
form, account, script ID, or NetSuite item ID is required.

### LC03 — Exact money representation

Given a fixed bin item, the API accepts a nonnegative safe integer number of
CAD cents or `null`. It rejects negative, fractional, unsafe, string, NaN, and
infinite values before mutation. Calculated and custom items reject non-null
fixed prices.

### LC04 — Server-owned identity

Given any update request, the client cannot change item code, category, price
mode, source applicability, currency, or linked bin type. Unknown item codes
return `MBT_LOCAL_ITEM_NOT_FOUND` and leave state unchanged.

### LC05 — Audited optimistic concurrency

Given revision 1, one valid Admin update produces revision 2 and exactly one
redacted audit event. A second update expecting revision 1 fails with
`MBT_STALE_REVISION` and cannot overwrite revision 2.

### LC06 — Exact retry

Given a successful item update, replaying the same actor, command name,
idempotency key, and payload returns the stored response with the replay header
and creates no second revision or audit event. Reusing that key with changed
input fails with the existing idempotency conflict.

### LC07 — Admin-only API

`GET /api/mbt/config/local/items` and
`PUT /api/mbt/config/local/items/:itemCode` require Admin. Unauthorized and
non-Admin callers cannot read prices or mutate settings. Responses are
`no-store`; updates require an audit reason, expected revision, and
`Idempotency-Key`.

### LC08 — Local-first configuration UI

Opening `/mbt/config` presents Local Item Settings as the first selected tab.
It renders the five concepts, clear calculated/fixed/custom price behavior,
readiness, and an accessible edit form. The NetSuite readiness screen remains
available as a secondary future-integration tab, with its historical data and
safety gates unchanged.

### LC09 — Opening local setup is externally quiet

Loading and editing the local tab calls only local MBT APIs. It performs zero
NetSuite transport requests and cannot run preflight unless the Admin
explicitly opens the future-integration tab and presses its preflight button.

### LC10 — Local-only posting is the durable default

The billing case and every immutable billing version contain
`posting_mode = local_only | netsuite_future`. Existing and new rows default
to `local_only`; approval freezes the case's current mode into its version.
Both values are intent only in this phase.

### LC11 — Approval creates no NetSuite work

Approving either posting mode creates one immutable billing version and updates
the case exactly once, but creates zero rows in `mbt_netsuite_outbox` and zero
rows in `mbt_netsuite_sales_order_chain`. Supplying a non-empty outbox payload
is rejected with `MBT_LOCAL_POSTING_PAYLOAD_REFUSED` before durable mutation.

### LC12 — Local billing-line identity

Existing billing lines with a legacy NetSuite mapping key remain valid.
Future local lines may instead record a local item code and its positive
revision. The database rejects half-present local identity and a line having
neither local nor legacy mapping identity. Historical line rows remain
immutable.

## Negative constraints

- Do not populate or validate the `Mr Bin Trucking Inc.` subsidiary mapping.
- Do not populate or validate customer internal ID `7143`.
- Do not hardcode historical item candidates `3230` or `3637` as verified
  current-account IDs.
- Do not remove migration 108 tables, mappings, evidence, or UI access.
- Do not enable `MBT_ENABLED`, `MBT_NETSUITE_WRITES_ENABLED`, direct NetSuite
  access, Smart SCM live execution, Samsara writes, or any worker.
- Do not add an operational MBT order creator, NetSuite Sales Order writer,
  scheduler, or background process.
- Do not delete or deactivate the existing `30YD` operational bin type.
- Do not modify unrelated operational tables or existing user data.

## Verification entry point

The final evidence must be reproducible through the isolated MBT gauntlet and
must report tests, types, lint, changed-line coverage, persisted mutations,
property tests, migration upgrade/rerun, shuffled repetition, browser E2E,
legacy baseline, secret scan, dependency/license status, and real application
health. Any unavailable layer is recorded as skipped with its exact reason.

## LC-R1 — Normalized pricing ownership revision (2026-08-03)

This revision was identified before the first RED run and supersedes the local
catalog fields and scenarios above only where they proposed storing a default
price or unit of measure on the item setting.

Effective prices already have authoritative, revisioned homes:

- cross-charge transport calculations use approved rate-card versions;
- bin charges use rate-card components;
- dump prices use dump tariffs or a custom amount captured on the immutable
  billing line; and
- billing-line quantity, unit, unit amount, net amount, tax, and total are the
  approval-time evidence.

Therefore `mbt_local_item_settings` must not store a price, currency, or unit of
measure. Its exact local fields are: item code, display name, description,
category, linked bin type, pricing mode, optional future NetSuite mapping key,
active state, revision, actor fields, and timestamps. The pricing modes are
`calculated`, `rate_card`, and `custom_price`.

The editable API body is exactly `displayName`, `description`, `active`,
`expectedRevision`, and `reason`. Category, bin identity, pricing mode, future
mapping key, and every NetSuite identity remain server-owned. Unknown request
fields fail closed. All five seeded items are locally ready when active:
readiness does not depend on a duplicate price field.

Accordingly:

- LC03 tests bounded display/description text, exact booleans, and ensures no
  local item API/table field can accept money or UOM. Integer-minor-unit and
  custom-price safety remains covered by existing rate/billing constraints.
- LC08 renders pricing ownership (`Calculated`, `Rate card`, or
  `Custom price per order`) instead of a price editor.
- LC12 continues to permit an immutable billing line to record local item code
  and revision; the billing line remains the sole approval-time amount/UOM
  evidence.

This normalization prevents configuration drift and does not change the
posting-mode scenarios LC10–LC12.

## LC-D1 — Production deployment authorization (2026-08-03)

The user subsequently authorized deployment on `codex/dockerVer`. This
authorization supersedes only the earlier no-deploy/no-restart setup boundary.
It does not authorize a source commit, push, NetSuite mapping, NetSuite request,
NetSuite write, MBT operational flag, background worker, or unrelated service
replacement.

The deployment must:

- retain the currently running application image under an explicit rollback
  tag;
- take and validate a fresh production database backup before migration;
- keep PostgreSQL and Ollama running while only the application is stopped;
- apply migration 109 once with bounded lock and statement timeouts;
- continue only after the read-only Phase 2 predeploy reports ready with no
  missing migrations, enabled MBT flags, or Dispatch collisions;
- replace only the application with the exact production-equivalent image that
  passed the final local-first gauntlet; and
- verify health, established route availability, closed external-write gates,
  unchanged operational aggregates, and zero new mapping, readiness, signoff,
  outbox, or Sales Order-chain work.

Database rollback remains restore-based because the migration is additive and
forward-only. An application-only rollback may leave migration 109 installed;
the migration must therefore remain compatible with the prior Phase 2 image.
