# MBT Bin Operations Phase 1 Executable Specification

Status: approved. This specification is append-only during Phase 1. A change
to an expected behavior must be appended as a visible revision before its test
or implementation changes.

## Failure model

| Failure mode | Required detecting layer |
|---|---|
| A driver or dispatcher reaches a partial BIN workflow | Server-side feature-gate HTTP and dispatch-save tests |
| An unauthorized operator edits MBT data | Real Express authority-matrix tests and direct endpoint attempts |
| A stale browser overwrites a newer record | Revision-conditional repository and HTTP 409 tests |
| The same command runs twice | Idempotency receipt unit, database, HTTP, and concurrency tests |
| One bin is reserved twice | Partial unique constraints and independent-connection race tests |
| Asset state changes without a ledger entry | Injected transaction failure and database invariant tests |
| Historical evidence is rewritten | UPDATE/DELETE trigger tests |
| A used rate changes historical pricing | Used-version immutability trigger and service tests |
| Billing approval commits without an outbox task | Transaction rollback tests |
| Two workers post one outbox task | `SKIP LOCKED` claim race tests |
| A worker blindly retries an uncertain create | Outbox state-machine tests with an injected adapter |
| A mapping edit leaves an old preflight valid | Canonical configuration-hash and readiness tests |
| Production NetSuite is contacted in Phase 1 | Capability tests and a zero-write fake adapter contract |
| Existing SCM `MBT` transport behavior changes | Legacy data/query regression tests |
| Migration damages existing data | Fresh, upgrade, and representative data-checksum tests |
| Hostile text leaks into HTML/audit or a secret is stored | Escaping, redaction, diff-secret, and adversarial tests |
| Tests pass only in one order | Shuffled/repeated suite runs with recorded seeds |

## Approved setup changes

The following setup is authorized by the user's Phase 1 implementation request.

### Repository files

- Add Phase 1 documentation, API JSON schema, tests, fixtures, and evidence.
- Add `server/Dockerfile.test` and `docker-compose.mbt-test.yml` using an
  ephemeral PostgreSQL 18 database, dummy environment values, no production
  volume, no NetSuite/Samsara access, and no Ollama dependency.
- Add a persisted manual mutation runner and one gauntlet entry point.
- Add a GitHub workflow only after the same commands pass locally.
- Do not rewrite existing Git history and do not make checkpoint commits unless
  the user separately asks for commits.

### Exact-pinned development dependencies

Versions are written without ranges and locked in `package-lock.json`.

| Dependency | Justification |
|---|---|
| `c8` | V8 line/branch coverage for the new ESM modules |
| `fast-check` | Stateful/property testing for hashes, ranges, revisions, and reservations |
| `eslint` | Zero-warning bug and complexity checks scoped to new MBT files |
| `typescript` | Strict `checkJs` without converting the application to TypeScript |
| `@types/node` | Node API types for strict `checkJs` |
| `@types/express` | Express request/response types for new routes |
| `@types/pg` | PostgreSQL client types for repositories and race tests |
| `ajv` | Independent validation of the persisted public JSON contract |
| `@playwright/test` | Real browser verification of the Phase 1 MBT shell |
| `@axe-core/playwright` | Automated accessibility checks for that shell |

Node's built-in `node:test`, built-in `fetch`, existing Express/pg, and manual
mutation are used instead of Jest, Vitest, Supertest, Testcontainers, or
Stryker.

## Behavior scenarios

### F01 — Capabilities fail closed

Given `MBT_ENABLED` is absent or false, when an authenticated Admin requests an
MBT operational mutation, then the response is 409 with code
`MBT_CAPABILITY_DISABLED`, and no domain, audit, receipt, or outbox row changes.

Given `MBT_ENABLED=true` and the database capability is false, the same result
must occur. NetSuite write operations additionally require
`MBT_NETSUITE_WRITES_ENABLED=true`.

### F02 — Live multi-role authorization

Given accounts whose primary or secondary authorities include
`mbt_frontdesk`, `mbt_billing`, `dispatcher`, or `admin`, login returns their
live authorities and routes them to the correct home page.

Direct configuration APIs permit Admin only. Front Desk and Billing receive
only their declared Phase 1 read surface. Dispatcher and Driver gain no MBT
configuration access. Editing localStorage or hiding navigation changes no
server result.

### F03 — Optimistic concurrency

Given a mutable row at revision 4, a command with expected revision 4 succeeds
and stores revision 5. A second command with expected revision 4 returns HTTP
409/code `MBT_STALE_REVISION` and changes no state or audit row.

### F04 — Command idempotency

Given an actor, command name, idempotency key, and canonical payload, the first
successful command stores one receipt. An exact retry returns the same status
and response without repeating work. Reusing the key with a different
canonical payload hash returns 409/code `MBT_IDEMPOTENCY_CONFLICT`.

### F05 — Audit immutability and redaction

Every successful privileged mutation records actor, roles, action, entity,
before/after, reason, revision, correlation ID, request ID, and idempotency key.
OAuth tokens, passwords, card/bank credentials, and configured secret values
are redacted. PostgreSQL rejects UPDATE and DELETE of an audit event.

### F06 — Reference seeds and legacy truck safety

Migrations seed exactly one configurable active 14-, 20-, 30-, and 40-yard bin
type. Reapplying migrations does not duplicate them. Every existing truck has
`bin_service_enabled=false` and `bin_slot_capacity=0` unless explicitly updated
later. Existing Smart SCM rows whose shipping method is `MBT` are unchanged.

### F07 — Exact asset state and reservation

Only one unreleased reservation may exist for an asset. Only one unreleased
reservation may exist for a visit reservation slot. Fifty repeated races using
independent database clients yield exactly one success per asset and conflict
for every loser. Asset state and movement ledger entry commit or roll back
together.

### F08 — Append-only movements

A movement records before/after status and location, source, actor, visit,
contract, truck/driver references, evidence references, timestamp, and override
reason. PostgreSQL rejects UPDATE and DELETE. Corrections append a linked
reversal/correction movement.

### F09 — Rate-band and historical pricing safety

An activatable version begins at 0 metres, has contiguous `[min,max)` bands,
has no gap or overlap, and only its last band is open. Exact provider metres
select the correct boundary band. After first use, version, band, component,
and tariff rows reject mutation and deletion; a new version must be cloned.

### F10 — Contracts, visits, and immutable completion foundations

Contract, amendment, and visit statuses accept only the design states. Mutable
records require revisions. Completed visits reject direct history edits.
Service-template steps have stable action codes and ordering.

### F11 — Billing and cross-charge structural safety

Billing versions/lines are immutable and use minor currency units. Database
uniqueness prevents duplicate SO+load, PO+load, VRMA+load, and global TO-root
cross-charge cases. A Customer Deposit record cannot be created without an
explicit funds-confirmed command and stores no card/bank credential.

### F12 — Durable outbox foundation

Billing approval state and its outbox row commit atomically. Workers claim an
eligible task in a short transaction and perform no network work inside that
transaction. Two workers cannot claim the same row. An expired pre-send lease
returns to pending; an expired post-send lease becomes attention. An uncertain
create requires lookup by external ID before retry. Receipt attachment is a
dependent task and cannot make an already-posted Sales Order unposted.

### F13 — NetSuite mapping readiness foundation

Every active `(mapping_type, local_key)` has one current revision. Preflight
runs persist a canonical configuration hash and per-check result. A pass is
usable only for the current hash. Missing, invalid, inactive, wrong-subsidiary,
permission-denied, or unable-to-verify required checks fail readiness. The
Phase 1 adapter is injected and exposes reads only; no operational NetSuite
write can occur.

### F14 — Dispatch BIN safety seam

The public schema reserves `DispatchOrder.type = 'BIN'`, stable stop IDs,
`serviceAction`, and the `mbt` identity/evidence snapshot. A BIN payload may
round-trip through snapshot serialization, but save/restore/confirm rejects it
while `bin_dispatch` is disabled. It is not materialized into Driver jobs or
treated as a normal drop-off.

### F15 — UI shell and negative scope

`/mbt/config`, `/mbt/frontdesk`, and `/mbt/billing` render controlled Phase 1
states with accessible English content. Configuration is visible only to
permitted roles. Phase 1 must not implement customer imports, live customer
sync, Front Desk contract commands, live BIN dispatch, Driver/PWA BIN work,
billing approval UI, or any NetSuite write.

### F16 — Migration and application execution

Migrations 102–107 apply to a fresh database and upgrade a representative
schema-101 database without changing existing business rows. The migrated app
starts and `/health`, `/api/mbt/status`, login, and authorized config reads work
over real HTTP.

## Phase 1 quality constraints

- All applicable existing non-live harnesses have zero new failures.
- Every changed critical-domain line and branch is exercised.
- New MBT server code reaches at least 95% lines/functions and 90% branches.
- Strict `checkJs` reports zero errors in new MBT code.
- ESLint reports zero warnings in new MBT code.
- At least 1,000 generated cases run for each pure property.
- Persisted manual mutants are all killed and source hashes restore exactly.
- A final fresh gauntlet produces the evidence report; mid-task results are not
  final evidence.

## P1-R1 — Compatibility and deployment clarification (2026-08-03)

This append-only clarification strengthens, and does not relax, the approved
Phase 1 boundary.

- Existing Operator, Dispatcher, Admin, SCM/`scm_staff`, Yard Manager, and
  Sales home routes and browser token-storage contracts must remain unchanged.
- Adding UUID-backed MBT audit events must not change the numeric tie ordering
  of existing bigint delivery/Dispatch audit records.
- Reserved BIN inspection must be iterative, cycle-safe, and able to inspect a
  20,000-level nested plan without a JavaScript call-stack failure. A 10,000
  ordinary-order scan has a one-second isolated-test ceiling.
- The production-equivalent Dockerfile, using `npm ci --omit=dev`, must build,
  expose a healthy application with all MBT environment/database gates closed,
  and pass the read-only deployment preflight. Test-only startup is not enough.
- The deployment preflight must fail closed when migration 102–107 is missing,
  an MBT database flag is enabled, or current/history Dispatch JSON already
  uses reserved `type = 'BIN'` or an object-valued `mbt` identity.
- Migrations 102–107 must finish before the new application image is started.
  Migration locks on `operators` and `dispatch_trucks` require a maintenance
  window or bounded lock monitoring with abort-and-retry.
- Production dependency declarations remain frozen. Two transitive
  security-only overrides are explicit: `brace-expansion` 1.1.17 beneath
  minimatch 3.1.5 and 2.1.3 beneath minimatch 5.1.9. The production install
  tree, spreadsheet/archive legacy harnesses, and vulnerability audit must pass.

## P1-R2 — Disabled-mode and repeatability clarification (2026-08-03)

This append-only clarification strengthens the existing non-regression and
repeatability requirements.

- Dispatch load-assignment synchronization may inspect reserved BIN identity
  only once per normalized plan, regardless of assigned-driver count. Direct
  and empty batch Driver projections must remain fail-closed.
- The production-image smoke must run with `NODE_ENV=production`; sharing the
  test service's Node environment is not production-equivalent evidence.
- Browser login verification must observe the real login response without
  proxying it through an intercepted duplicate request. It must verify the
  response status, committed route, and exact stored token/role authorities.
- Continuous verification must run in the same isolated Compose boundary and
  inspect the complete base-commit diff together with staged, unstaged, and
  untracked files. An absent or invalid requested base revision must fail
  closed rather than silently reducing the scan.

## P1-R3 — Production-scale deployment preflight clarification (2026-08-03)

This append-only clarification records the production gate failure found
before any Phase 1 database write and strengthens F14/F16 without changing an
application capability.

- The read-only deployment preflight must inspect every current and historical
  Dispatch snapshot with the same reserved-BIN semantics while keeping only a
  bounded page of snapshot JSON in memory. It must not materialize the complete
  history result set in Node.js.
- Snapshot traversal must use stable keyset pagination. A regression test must
  prove that a history larger than one page is fully inspected, a collision on
  a later page is reported, and no query result exceeds the configured page
  bound.
- Pagination must fail closed if a page cannot advance, and all preflight SQL
  remains read-only.
- The repaired production image must pass the focused preflight tests, static
  checks, legacy regression suite, and the fresh Phase 1 gauntlet before the
  production migration may continue.
