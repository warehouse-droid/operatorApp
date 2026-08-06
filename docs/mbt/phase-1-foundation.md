# Phase 1 — Foundation Work Packets

Each packet follows SPEC → RED → GREEN → REFACTOR. Assertions are frozen after
their observed RED run unless the executable specification is visibly amended.

## P1.0 — Test platform and baseline

- Add isolated Node/PostgreSQL test containers.
- Add exact-pinned test dependencies and commands.
- Add deterministic fixtures, independent-client race support, shuffled runner,
  manual mutation runner, and gauntlet entry point.
- Record every existing non-live harness result before MBT implementation.

## P1.1 — Pure contracts and primitives

- Canonical JSON/hash.
- Error envelope and correlation IDs.
- Capability evaluation.
- Revisions and idempotency semantics.
- Rate-band validation/selection.
- Public JSON schema.

## P1.2 — Authorities, flags, receipts, and audit

- Migration 102.
- Live role plumbing, route homes, middleware, account UI, sidebar.
- Audit immutability/redaction and unified Admin audit projection.
- HTTP authority matrix.

## P1.3 — Shared customer schema

- Migration 103 only; synchronization/cutover remains Phase 3.
- Canonical customer/address/contact/subsidiary tables and local site profiles.
- History-preserving constraints and source version/hash fields.

## P1.4 — Assets, templates, and fleet capability

- Migration 104.
- Four bin-type seeds.
- Yards, materials, dump sites, assets, current state, append-only movements.
- Service templates/steps/evidence requirements.
- Existing trucks default disabled; normalized API fields.

## P1.5 — Rates, contracts, visits, and reservations

- Migration 105.
- Rate versions/bands/components/tariffs/deposit rules.
- Quotes/contracts/amendments/visits/evidence/distance snapshots.
- Exact asset reservation and transactionally paired movement service.

## P1.6 — Billing and outbox foundation

- Migration 106.
- Immutable billing records, deposits, cross-charge dedupe, SO chains.
- Durable outbox/attempts/reconciliation and injected worker state machine.
- No production scheduling and no NetSuite mutation adapter.

## P1.7 — NetSuite configuration readiness foundation

- Migration 107.
- Mapping catalog, current configuration hash, persisted preflight runs/checks.
- Read-only fake adapter contract.

## P1.8 — MBT shell and Dispatch safety seam

- `/mbt/frontdesk`, `/mbt/billing`, `/mbt/config` controlled states.
- MBT router/status/config read APIs.
- Reserved BIN JSON contract and disabled-save rejection.
- No Driver/PWA materialization.

## P1.9 — Fresh gauntlet and evidence

- Full tests and critical legacy regression.
- Types, lint, changed-line coverage, properties, manual mutation.
- Fresh/upgrade migrations, concurrency repeat, browser shell, real HTTP start.
- Dependency/license/secret/capability diff.
- Populate `docs/mbt/evidence/P1.md` only from the final fresh run.

## Implementation journal — 2026-08-03 intermediate checkpoint

This section is append-only. It records packet evidence, not final acceptance.
The frozen assertion rule at the top of this file remains in force, and no
entry below permits creation of `docs/mbt/evidence/P1.md` before the complete
P1.9 gauntlet is green.

### P1.0–P1.3

- The isolated PostgreSQL/Node toolchain, aggregate commands, explicit legacy
  allowlist, shuffle, coverage, mutation, type, lint, license, secret-scan, and
  browser entry points are present. Earlier frozen infrastructure, pure
  contract, authority, schema, and service packets reached their recorded
  GREEN states.
- Migrations 102 and 103 provide the fail-closed authority/audit foundation and
  shared customer schema. The customer tables remain foundation-only; no live
  customer synchronization or cutover is part of Phase 1.

### P1.4–P1.5

- Migration 104 now binds materialized asset state to the exact latest
  append-only movement at the database boundary and freezes activated or used
  service-template versions, steps, and evidence requirements.
- Migration 105 now validates distance bands during draft-to-active
  transition, atomically stamps the first non-draft quote/contract use, locks
  used pricing children, freezes evidence for completed visits, and rejects
  reservations for completed or cancelled visits. Fixtures create template and
  rate children while draft and activate only after their definitions exist.
- The historical audit RED runs reported the missing guards independently.
  After implementation, the combined focused real-database set passed 41/41;
  full integration/concurrency passed 114/114 on a fresh schema; and focused
  asset service coverage reached 98.98% lines/statements, 95.36% branches, and
  100% functions.

### P1.6–P1.7

- Billing approval and its deterministic outbox task are one transaction;
  changed approval evidence cannot reuse an idempotency identity. Approved
  billing versions reject late lines. Uncertain creates require external-ID
  lookup evidence before any retry, and the readiness adapter remains
  read-only.
- The audit RED runs exposed five missing resolver/approval behaviors, one late
  approved-line mutation, and one changed-evidence replay. The fresh combined
  outbox/preflight/concurrency/financial set passed 27/27, the representative
  upgrade passed 1/1, and F12 coverage reached 98.87% lines/statements, 92.59%
  branches, and 100% functions.

### P1.8

- The public BIN contract requires stable, self-describing stops. Recursive
  plan inspection detects BIN identity in nested/cyclic shapes, while ordinary
  non-BIN work remains unaffected. Server-side save/restore/confirm and Driver
  projection guards remain authoritative; UI visibility cannot enable work.
- The focused audit packet moved from 10 pass / 4 fail to 14/14, with the
  strengthened unit set at 7/7 and focused coverage at 100% for statements,
  branches, functions, and lines.

### P1.9 — pending

- Fresh application of migrations 001–107, a representative schema-101
  upgrade, and a clean 114/114 integration/concurrency run are intermediate
  GREEN checkpoints.
- The final all-stage gauntlet has not yet produced a green result. Final
  evidence remains intentionally absent.

## Phase 1 non-regression safety boundary

- Operational database flags remain disabled, `MBT_NETSUITE_WRITES_ENABLED`
  remains false, and the Phase 1 NetSuite adapter has no write capability.
- No live Front Desk contract commands, BIN Dispatch, Driver/PWA BIN work,
  billing approval UI, customer sync, or external write scheduling is enabled.
- BIN rejection occurs before plan, Driver, audit, receipt, reservation, or
  outbox side effects. Existing non-BIN Dispatch behavior and the unrelated
  Smart SCM `method = 'MBT'` constraint stay outside this domain.
- Immutable audit/receipt rows and used financial/operational evidence are not
  deleted for test cleanup. Final verification must use a fresh isolated
  database and must not trust stale `schema_migrations` filenames after a
  migration file changes.

## Implementation journal — 2026-08-03 direct non-regression checkpoint

This section is append-only and supplements the intermediate checkpoint above.
P1.9 remains pending, browser verification is not reported here, and
`docs/mbt/evidence/P1.md` remains intentionally absent.

### Direct legacy seams

- The persisted Dispatch/authority/audit set moved from a controlled
  20 pass / 5 fail RED to 25/25 GREEN twice. The repaired seams are nested
  stop-level BIN rejection at save, restore, and confirm; established primary
  route precedence when secondary MBT authorities are present; and the exact
  unified Admin audit detail envelope. Each Dispatch rejection asserts that
  plan revision, status, current snapshot, and history count remain unchanged.
- Complementary config and public-script coverage moved from 9 pass / 1 fail
  to 10/10. It proves fail-closed environment defaults, strict truthy parsing,
  live environment-file replacement, disabled-root HTTP behavior, and an
  explicit gauntlet syntax parse for the three touched legacy browser scripts.
  Targeted typecheck, lint, syntax, and diff checks were green.

### Preliminary baseline harness findings

- Two preliminary full-baseline checkpoints found test infrastructure and
  stale static expectations, not a reason to change runtime behavior. The
  Admin access harness now follows centralized `operatorHomeRoute` ownership;
  the NetSuite mirror harness accepts the container's explicit `/app` server
  root while only its two exact root configuration fixtures are mounted
  read-only; and Return harness cachebuster assertions now match the current
  service-worker, Control, and Smart SCM assets.
- These repairs do not broaden the isolated container to production
  environment files, credentials, persistent storage, or external access, and
  they do not constitute final full-baseline or browser evidence.

### Migration review

- The read-only audit of migrations 102–107 found the supported clean
  schema-101 upgrade logically non-regressive. Existing operator/session,
  Dispatch, and Smart SCM representative state remains exact; the unrelated
  Smart SCM `method = 'MBT'` constraint is neither renamed nor altered; and all
  new truck capability state is fail-closed.
- The remaining release caveat is DDL availability rather than data
  correctness. `operators` role-constraint replacement and `dispatch_trucks`
  capability-column/check creation take locks inside file-wide migration
  transactions. Production should use a brief maintenance window or bounded
  lock monitoring with abort-and-retry. The test suite does not claim
  zero-downtime behavior under concurrent production traffic.

## Phase 1 final acceptance — 2026-08-03

P1.9 is complete. The final fresh all-stage gauntlet passed after the last
implementation and test edit, and the resulting evidence is recorded at
`docs/mbt/evidence/P1.md`. This acceptance does not enable any Phase 1
operational capability and does not authorize Phase 2 work.
