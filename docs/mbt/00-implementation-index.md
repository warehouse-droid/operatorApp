# MBT Bin Operations Implementation Index

This file is the restart point for MBT Bin Operations work. Read it before
opening implementation files or relying on prior conversation context.

## Current Phase 3 planning checkpoint — 2026-08-03

- Authoritative draft:
  `docs/mbt/phase-3-local-operations-shadow-billing.md`.
- Status: **APPROVED FOR LOCAL IMPLEMENTATION** by the user's 2026-08-03 request
  `$old-coder please implement phase 3`. Production deployment, restart,
  customer-data import, live NetSuite access, and feature activation remain
  separately unauthorized.
- Scope intentionally combines the source design's original master-data,
  operational-pilot, and billing-shadow phases into one local-first Phase 3.
- NetSuite read synchronization is the normal customer source. CSV and the
  current `/home/ubuntu/MBT_customer_20260803.xls` NetSuite SpreadsheetML file
  are bootstrap/recovery inputs through the same canonical apply service and
  require real NetSuite internal IDs.
- The workbook was inspected read-only: SHA-256
  `b4fd35e134626543d3e94cbbb0ef898f99dd168b9452eef64986dd8a4f3b95dc`,
  1,262 data rows, unique/nonblank internal IDs, ten core columns, and no
  service addresses. It remains outside Git and no customer row/PII is copied
  into documentation or test fixtures.
- The current `tools/mbt-gauntlet.sh P3` token silently follows P1 branches and
  is not valid Phase 3 evidence. Packet P3.1 must establish a dedicated P3
  gauntlet before any automated-completion claim.
- Dispatch own yards remain the single yard master and are shared with MBT:
  `12441/15`, `3445/1`, `2967/28`, and `150/26`. Do not build a duplicate MBT
  yard import or setup page.
- `dispatch_trucks` remains the single fleet registry. Phase 3 adds explicit
  `flatbed`/`bin` type; all existing trucks backfill to Flatbed, while Bin
  trucks are explicitly added/configured in Dispatch Settings with base yard,
  slot capacity, and supported bin sizes.
- Dispatch assigns one service leg rather than a commercial contract. Only the
  server-derived current ready front leg appears in the BIN pool; the whole
  contract and later legs are read-only timeline context.
- Current packet: P3.2 bounded local import foundation and current synthetic
  SpreadsheetML contract. The executable approval record is
  `docs/mbt/03-executable-spec.md`; evidence is initialized at
  `docs/mbt/evidence/P3.md`.
- P3.0 baseline: green on the isolated P2 gauntlet—407/407 main tests,
  deterministic shuffled repetition, full static/coverage/mutation/quality
  gates, 106/106 legacy harnesses, production-shaped closed-gate runtime, and
  60/60 desktop/mobile Chromium/WebKit browser cases. Registry audit was the
  only explicitly skipped layer and no dependency changed.
- P3.1 RED is now frozen: 0/16 passed at the exact absent workflow, explicit
  phase selection, predeploy/runtime, mutation, capability evaluator,
  environment-gate, database-flag, migration, and bounded-lock boundaries.
- P3.1 GREEN is complete: 43/43 final focused tests, typecheck, lint/complexity,
  and 52/52 persisted mutants pass. All nine database flags and all seven new
  environment gates remain closed; Dispatch and Driver disabled-path
  regressions are green.
- Next action: freeze and observe P3.2 parser/import/API RED before adding its
  additive schema or production implementation.

## Approved scope

- Source design: `/home/ubuntu/MBT Bin Operations Design Review.docx`
- Approved implementation request: Phase 1 — Foundation
- Assurance tier: Old Coder Tier 3
- Spec approval: obtained from the user by the request to implement the
  previously presented Phase 1 plan with `$old-coder`
- Baseline commit: `37dfafbf534268aa84832c0f7a677f5f6a656bf6`

## Immutable decisions

- The Bin Operations domain uses `mbt_*` names.
- Existing Smart SCM `method = 'MBT'` is unrelated and must not change.
- The reserved Dispatch order type is exactly `BIN`.
- NetSuite customer internal ID 33 is the MBBS intercompany customer.
- NetSuite is authoritative for customers and accounting.
- The application creates Sales Orders, not invoices.
- NetSuite writes, BIN dispatch, Driver BIN execution, Front Desk operations,
  and billing remain disabled throughout Phase 1.
- UUIDs are generated in Node; no PostgreSQL UUID extension is introduced.
- Money is stored as integer minor units plus ISO currency.
- Asset movements, used rate versions, billing versions, outbox attempts, and
  audit events are append-only or database-immutable.
- External delivery is at-least-once with a stable idempotency identity and
  reconciliation; the project does not claim magical external exactly-once.

## Current packet

- Packet: P1.9 — fresh gauntlet and evidence
- Status: complete; the final fresh P1 gauntlet is green
- Last completed migration: 107; fresh application of migrations 001–107 and
  the representative schema-101 upgrade have both been verified
- Reserved Phase 1 migrations: 102–107
- Final broad green: 187/187 main tests, three shuffled 187/187 repetitions,
  106/106 legacy harnesses, 39/39 browser cases, 14/14 mutants killed, and all
  remaining quality/deployment gates passed
- Final evidence: `docs/mbt/evidence/P1.md`

## RED journal

- P1.0 isolated-test foundation, 2026-08-03:
  `docker run --rm --network none ... node --test test/mbt/infrastructure/test-foundation.test.js`
  failed 3/3 named tests with `P1_TEST_FOUNDATION_NOT_IMPLEMENTED`.
- P1.1 pure contracts, 2026-08-03:
  `docker run --rm ... node --test --test-concurrency=1 test/mbt/unit/pure-contracts.test.js`
  failed 13/13 named tests with deliberate `ERR_MBT_NOT_IMPLEMENTED` behavior.
- P1.2-P1.7 foundation schema, 2026-08-03:
  after applying migrations 001-101 to a disposable network-isolated
  PostgreSQL 18 database, `node --test --test-concurrency=1
  test/mbt/integration/foundation-schema.test.js` failed 5/6 named tests for
  the absent Phase 1 relations, seeds, truck fields, immutability triggers,
  and deduplication indexes. The unrelated Smart SCM `MBT` constraint test
  passed.
- P1.2/P1.6/P1.7 foundation services, 2026-08-03:
  `node --test --test-concurrency=1
  test/mbt/unit/foundation-services.test.js` failed 8/8 named tests with
  deliberate `ERR_MBT_NOT_IMPLEMENTED` behavior after a test-only import-name
  correction made before assertions were frozen.
- P1.2 live MBT authorities, 2026-08-03: the real PostgreSQL authority suite
  failed 2/3 because `mbt_frontdesk` and `mbt_billing` were not accepted; the
  unknown-authority rejection already passed.
- P1.2/P1.8 real HTTP capabilities, 2026-08-03: after a test-helper-only
  non-JSON response correction, the frozen status and configuration tests
  failed with HTTP 404 instead of the required authenticated 401/403 routes.
- P1.2/P1.8 real HTTP role matrix, 2026-08-03: all 4 controlled-surface tests
  failed with HTTP 404 before the role-specific endpoints existed.
- P1.8 controlled UI shell, 2026-08-03: both route/asset contract tests failed
  with HTTP 404 before the Phase 1 pages and assets existed.
- P1.4/P1.5 asset, rate, and visit audit hardening, 2026-08-03: frozen tests
  were added before their database guards. The old schema reported 7 pass / 5
  fail in the asset-movement suite for direct after-state drift, revision
  drift, a stale movement pointer, and an unmaterialized direct movement; the
  rate lifecycle suite reported 1 pass / 10 fail for invalid activation,
  draft use, and absent first-use stamping; the visit suite reported 2 pass /
  3 fail for mutable activated/used templates and mutable completed-visit
  evidence; and the reservation suite reported 5 pass / 4 fail because
  completed/cancelled visits still accepted reservations through one or both
  entry paths. Every failure was at the intended assertion boundary.
- P1.6 F11/F12 audit hardening, 2026-08-03: the isolated outbox/preflight and
  outbox-claim suites first reported 15 pass / 5 fail because the
  uncertain-create resolver and billing-approval repository/export did not
  exist. The immutable-financial suite separately reported 2 pass / 1 fail
  because an approved billing version accepted a late line insert. One
  additional replay assertion then failed because changed approval-only
  evidence under the same idempotency key was silently replayed.
- P1.8 F14 contract hardening, 2026-08-03: the isolated schema, Dispatch safety,
  and Driver guard set reported 10 pass / 4 fail. The old implementation
  rejected valid `stops` as extra data, accepted missing `stops`, missed a
  stop-only Driver BIN identity, and failed to find nested BIN identity.

## GREEN journal

- P1.0 isolated-test foundation, 2026-08-03: the original frozen suite passed
  3/3 under network-isolated Node 20 after implementation.
- P1.1 pure contracts, 2026-08-03: the original frozen unit suite passed 13/13
  under Node 20 after implementation. Property and Ajv contract suites await
  the exact-pinned development dependency installation.
- P1.2/P1.6/P1.7 foundation services, 2026-08-03: the frozen suite passed 8/8
  under network-isolated Node 20 after implementing revision checks, audit
  redaction, readiness hashing/evaluation, the Phase 1 read-only NetSuite
  boundary, and outbox transition/recovery rules.
- P1.0 isolated toolchain, 2026-08-03: PostgreSQL 18 tmpfs startup, exact lock,
  3/3 infrastructure tests, 29/29 unit/contract/property tests, 7/7 critical
  legacy smoke harnesses, real HTTP health, license allowlist, and a zero-high
  vulnerability audit passed. The full gauntlet remained correctly RED on
  unfinished Phase 1 domain work.
- P1.2 authorities, 2026-08-03: the frozen real-database suite passed 3/3 after
  migration 102 and live-session role plumbing.
- P1.2/P1.8 HTTP and shell, 2026-08-03: frozen status/config tests passed 2/2,
  the role matrix passed 4/4, and controlled shell route/assets passed 2/2.
  The disabled-reservation side-effect assertion awaits migration 105.
- P1.4/P1.5 F07–F10 audit hardening, 2026-08-03: migrations 104/105, the asset
  service, and draft-first fixtures made the combined focused suite pass 41/41
  on a database freshly migrated from 001 through 107. The same tree then
  passed the full integration/concurrency group 114/114. Focused ESLint and
  full strict `checkJs` passed. Real-PostgreSQL asset coverage was 98.98%
  statements/lines, 95.36% branches, and 100% functions. This checkpoint
  covers exact latest-movement materialization, terminal-visit reservations,
  valid rate activation and atomic first-use locking, immutable service
  templates, and immutable completed-visit evidence.
- P1.6 F11/F12 audit hardening, 2026-08-03: on a freshly migrated database the
  combined outbox, preflight, claim-race, and immutable-financial suite passed
  27/27, and the representative migration upgrade passed 1/1. The F12 coverage
  run passed 23/23 with 98.87% statements/lines, 92.59% branches, and 100%
  functions; targeted ESLint and strict `checkJs` passed.
- P1.8 F14 contract hardening, 2026-08-03: the frozen focused set passed 14/14,
  the strengthened unit set passed 7/7, schema JSON parsed cleanly, and
  targeted lint and strict `checkJs` passed. Focused Dispatch safety coverage
  passed 10/10 at 100% statements, branches, functions, and lines.
- P1.9 intermediate non-regression checkpoint, 2026-08-03: a clean disposable
  PostgreSQL 18 database accepted migrations 001–107, and the full MBT
  integration/concurrency group passed 114/114 with `MBT_ENABLED=true`, all
  operational database flags disabled, and NetSuite writes disabled. This is
  packet evidence only, not the final gauntlet or final evidence report.

## Resume protocol

1. Read `docs/mbt/01-executable-spec.md` completely.
2. Read `docs/mbt/phase-1-foundation.md` and this file.
3. Run `git status --short`; never overwrite unrelated user changes.
4. Run the target test named by the current packet and observe RED before
   editing implementation for that behavior.
5. After GREEN, run the MBT-critical regression group.
6. Update this file with the exact next action, command, and result.
7. A final claim of completion is allowed only after a fresh
   `./tools/mbt-gauntlet.sh P1` and a populated evidence report.

## Historical baseline concerns

These observations are retained from the start of Phase 1. Resolutions and
remaining current caveats are recorded in the verification boundary below.

- The repository has many individual harnesses but no aggregate test command,
  lint, strict type checking, changed-line coverage, mutation runner, property
  testing, or browser E2E platform.
- The host lacks Node/npm; Node execution must occur in a test container.
- Existing Compose mounts real environment files and persistent data, so it is
  not safe for destructive Tier 3 tests.
- `server/data/dispatch-setup.json` contains credential-looking material. It
  must be triaged without printing the value. History rewriting is not
  authorized by this implementation request.

## Current verification boundary

- The aggregate MBT commands, strict `checkJs`, zero-warning ESLint, coverage,
  shuffled execution, mutation runner, browser E2E, license check, secret scan,
  baseline allowlist, and fresh application startup now exist in the tree.
  Their packet-level or focused results above do not substitute for one final
  uninterrupted gauntlet run.
- Phase 1 remains fail-closed: Front Desk operations, BIN Dispatch, Driver BIN
  execution, Billing operations, and NetSuite writes remain disabled by their
  database/environment gates. The verified safety seam rejects BIN
  save/restore/confirm and Driver materialization without producing partial
  domain, audit, receipt, reservation, or outbox state.
- The Phase 1 NetSuite adapter remains read-only and injected. No result in this
  journal authorizes production NetSuite, Samsara, customer-sync, billing, BIN
  Dispatch, or Driver/PWA mutation work.
- Do not reuse a database whose migration file changed after its filename was
  recorded in `schema_migrations`. One long-lived disposable database was
  observed with stale migration-105 trigger metadata; fresh migration was
  green and is the required final evidence path.
- Audit events and command receipts are deliberately immutable. A suite that
  uses fixed idempotency identities must run on a fresh database rather than
  treating historical evidence as cleanup-able test state.
- Frozen RED assertions remain unchanged unless an executable-spec revision is
  appended first. Post-GREEN hardening assertions are additive and do not
  rewrite the historical RED observation.

## Next action

Phase 1 is complete. Do not enable an MBT operational flag or begin Phase 2
without a separate user request. A Phase 1 deployment must follow
`docs/mbt/phase-1-deployment.md`: migrations first, closed gates, read-only
preflight, then established-route smoke checks.

## Append-only checkpoint — 2026-08-03 legacy seams and migration review

This checkpoint adds evidence discovered after the intermediate 114/114 run.
It does not change the current packet: P1.9 remains in progress, and it does
not authorize creation of `docs/mbt/evidence/P1.md`.

### Direct legacy-seam RED → GREEN

- A controlled fresh-database integration RED run reported 20 pass / 5 fail.
  The five failures were the intended direct seams: primary-role route
  precedence over secondary MBT roles, the complete `actorRoles` detail in the
  unified Admin audit projection, and nested stop-level BIN rejection at each
  save, restore, and confirm repository entry point. The tests compare durable
  plan/snapshot/history state before and after each rejection, so a UI-only
  guard cannot satisfy them.
- After the repository guard, centralized route precedence, and audit detail
  repairs, the same focused set passed 25/25 twice on the isolated database;
  focused ESLint also passed. The additive assertions retain every established
  primary home route and require the MBT audit UUID and the exact roles,
  reason, revisions, correlation ID, request ID, and idempotency key.
- A complementary legacy-config/syntax packet first reported 9 pass / 1 fail,
  with the only RED being absent gauntlet syntax-check wiring. It then passed
  10/10 after adding explicit parse checks for `public/login.js`,
  `public/control.js`, and `public/app-sidebar.js`. The packet also covers
  fail-closed MBT environment defaults, the accepted truthy/falsey spellings,
  live `applyEnvFile` replacement without process-environment pollution, and a
  disabled root HTTP gate. Its targeted typecheck, ESLint, syntax command, and
  diff checks passed.

### Preliminary full-baseline harness repairs

- Two preliminary full-baseline checkpoints exposed harness/environment
  assumptions rather than MBT runtime regressions. These checkpoints are not a
  substitute for the final P1.9 baseline stage.
- The Admin access harness still expected the legacy home-route branches to be
  inline in `server.js`. Its static assertion now verifies that the server
  delegates to `operatorHomeRoute` and verifies the established Admin,
  Dispatcher, SCM, Yard Manager, Sales, and Operator mappings at their shared
  authority source. This was a harness-only repair; route behavior was not
  changed to satisfy a stale string assertion.
- The NetSuite mirror harness assumed that `${MBBS_REPO_ROOT}/server` existed
  inside the read-only baseline container. It now accepts an explicit
  `MBBS_SERVER_ROOT=/app`. The baseline service exposes only the two exact
  configuration fixtures it reads—`docker-compose.v2.yml` and
  `docker/v2.env.example`—as read-only mounts under `/workspace`; it does not
  mount the repository, production environment files, credentials, persistent
  data, or an external network.
- The Return UI harnesses contained old cachebuster literals. Their assertions
  now track the already-current driver-cache-isolation service-worker name,
  reconciliation-resume Control asset, and Blanket/focus-preservation Smart
  SCM assets. These were test-only expectation updates; no Return or Smart SCM
  runtime asset was changed by this repair.

### Read-only migration non-regression audit

- A line-by-line review of migrations 102–107 found no collision with the
  unrelated Smart SCM `scm_transport_schedule.method = 'MBT'` value. The clean
  schema-101 upgrade test preserves an exact representative Smart SCM schedule
  row, and both that test and the foundation test prove the existing method
  constraint still accepts `MBT`.
- Logical non-regression is green on the supported clean path. Migration 102
  widens the existing `operators` role constraints without rewriting operator
  rows; migration 104 adds fail-closed `dispatch_trucks` fields defaulting to
  `false` and `0`. Migrations 103, 105, 106, and 107 do not alter or backfill a
  schema-101 business table. The representative upgrade preserves the exact
  legacy operator, session, truck, plan, plan snapshot, and Smart SCM schedule
  state and proves the official migration runner is a no-op on its second run.
- Production deployment still needs an operational DDL gate. The role
  constraint work on `operators` and the capability columns/check on
  `dispatch_trucks` require table locks, and the migration runner holds each
  file in one transaction without a bounded lock timeout. Use a brief
  maintenance window or bounded lock monitoring/abort-and-retry procedure for
  those migrations. Current tests prove logical preservation, not zero-wait
  migration behavior under concurrent production traffic.
- No browser result is recorded in this checkpoint; browser verification
  remains part of the unfinished P1.9 gauntlet.

## Append-only checkpoint — 2026-08-03 disabled-mode performance and browser reliability

This checkpoint records additional RED to GREEN evidence discovered while
proving that Phase 1 cannot degrade established behavior while disabled. It is
not the final P1 evidence report.

- The first full legacy-baseline attempt reached the Admin access harness and
  failed because that static harness still required the pre-centralization
  literal SCM branch. Runtime routing already preserved `scm` and
  `scm_staff`; the repaired harness passed its focused rerun.
- A subsequent gauntlet reached browser setup after the application and legacy
  stages, then failed because the E2E build command had not activated its
  runtime profile. A frozen infrastructure assertion failed before the
  profile repair and passed 2/2 afterward.
- A multi-driver assignment regression test failed `2 !== 1`, proving the
  reserved-identity scan ran once per driver. Empty-batch and production Node
  environment assertions also failed at their intended boundaries. The
  repaired batch planner validates once, preserves direct and empty-batch
  Driver guards, and retains ordinary assignment status. The focused safety
  set passed 15/15; established Dispatch assignment integration passed 23/23,
  Driver scheduling passed 50/50, and Dispatch forecast passed.
- The all-browser gate exposed one Chromium desktop navigation timeout while
  the same Dispatcher login passed on mobile Chromium and WebKit. The original
  intercepting test proxy reproduced the timeout once in 20 repetitions. A
  passive response-body diagnostic then failed 30/30 because Chromium discards
  a fetch body after immediate document navigation. The final helper observes
  the real response status and verifies the issued token from committed
  browser storage; it passed 30/30 desktop Dispatcher repetitions without an
  application-code change.
- Broad pre-browser stages were green at this checkpoint: 184/184 main tests,
  three shuffled 184/184 repetitions, strict types, zero-warning lint, 98.39%
  statements/lines, 99.45% functions, 93.05% branches, 14/14 mutants killed,
  387 dependency licenses checked, 106/106 legacy harnesses, healthy
  production-image startup, and read-only deployment readiness. These remain
  intermediate results until the final post-CI gauntlet completes.

## Append-only checkpoint — 2026-08-03 fail-closed continuous verification

This checkpoint closes the last infrastructure gap before the final fresh
gauntlet. It changes no application runtime, production Compose file,
environment, or persistent data.

- The initial change-collector contract failed with exit 78 and an explicit
  `not implemented` result. The initial CI contract suite failed 0/3 because
  the workflow safety contract and gauntlet wiring did not yet exist.
- The implemented collector now covers the requested base-commit diff together
  with staged, unstaged, and untracked local changes, while excluding generated
  `server/test-artifacts`. A supplied base must be a fetched, nonzero, full
  40-character commit ID; invalid, missing, zero, or option-like values fail
  closed rather than silently narrowing the scan.
- The executable collector contract passed base, dirty-tree, exclusion, and
  invalid-base cases and proved that a controlled credential is detected while
  its value remains redacted. The static workflow contract passed 3/3, the real
  workflow verifier passed, the exact changed-file secret scan reported zero
  findings, and focused ESLint, Bash syntax, and `git diff --check` passed.
- CI is limited to pull requests and pushes to `main`, uses only
  `contents: read`, runs on GitHub-hosted Ubuntu 24.04 with a 90-minute limit,
  pins checkout by full commit, fetches full history without retaining
  credentials, and invokes only the isolated P1 gauntlet. The contract rejects
  privileged events, writable permissions, self-hosting, production Compose or
  environment access, services, secrets, artifact upload, shallow history, and
  registry-audit bypasses.

### Inherited-base harness isolation RED → GREEN

- The first post-CI full gauntlet stopped before image build with exit 65:
  `MBT_GAUNTLET_BASE_SHA does not resolve to a fetched commit.` The requested
  real-repository base revision had leaked into the contract harness's unrelated
  disposable Git fixture. No application, migration, database, or production
  action ran before this failure.
- An additive infrastructure assertion then reproduced the missing isolation as
  a focused 2 pass / 1 fail RED. The harness now explicitly clears only the
  caller's base revision before creating its fixture; its own valid and invalid
  base assignments remain exercised. The focused static suite passed 3/3 and
  the canonical executable harness passed under the inherited real-repository
  base revision.
- One ad hoc verification invocation supplied relative scanner paths even
  though the Docker harness requires its canonical absolute defaults; that
  invocation failed its scanner-output assertion. Rerunning the persisted
  canonical command passed. No source or assertion was changed for this command
  usage error.

## Final acceptance — 2026-08-03

- The complete fresh P1 gauntlet passed after the harness-isolation repair:
  187/187 main tests; three shuffled 187/187 repetitions over 33 files; strict
  types; zero-warning lint; legacy public-script syntax; 98.39% lines and
  statements, 99.45% functions, and 93.05% branches; 14/14 mutants killed;
  387 package licenses checked; 106/106 legacy harnesses; healthy production
  image; ready read-only preflight; 39/39 Chromium/WebKit browser cases; source
  integrity; and zero npm vulnerabilities.
- Migrations 001–107 applied from fresh, and the representative schema-101
  upgrade remained exact and idempotent. The final secret gate inspected 95
  new paths plus changed lines and reported zero high-confidence findings.
- `docs/mbt/evidence/P1.md` contains the final specification mapping, exact
  layer results, dependency/capability review, failures encountered, and known
  deployment limits. Phase 1 remains disabled, fail-closed, and additive.

## Phase 2 restart point — 2026-08-03

- Approved request: implement Phase 2 with `$old-coder` according to the
  previously approved P2 plan.
- Recovered authoritative plan:
  `docs/mbt/phase-2-netsuite-sandbox.md`.
- Executable specification: `docs/mbt/02-executable-spec.md`.
- Scope: Admin-managed NetSuite sandbox mappings, GET-only readiness
  validation, reports, and immutable signoff evidence.
- Explicitly deferred: customer sync/master import, Front Desk operations,
  asset operations, BIN Dispatch, Driver execution, billing posting, and every
  NetSuite mutation.
- Current packet: P2 implementation after frozen RED; final P2 gauntlet and
  real sandbox signoff are not yet complete.

### Phase 2 RED journal

- P2 schema/repository/concurrency: migration contract reported 0/5 because
  migration 108, singleton lease fields/index, severity, and signoff evidence
  were absent. Repository and race files failed at the missing
  `netsuite-readiness-repository.js` import. These are the intended boundaries.
- P2 unit/property: the two focused files reported 0 pass / 2 file failures at
  the missing catalog and GET-only adapter modules. The packet covers six
  1,000-case properties plus deterministic reports and hostile projections.
- P2 real HTTP: 0/3 passed. Dispatcher/Admin requests reached 404 instead of
  the required role-aware mapping/readiness routes.
- P2 browser: 0/2 passed because the accessible “NetSuite Readiness” tab did
  not exist. The assertions below that boundary cover hostile-text safety,
  axe accessibility, closed gates, exports, and revisioned controls.
- Before GREEN, P2-R1 recorded one test-only repeatability correction: a fresh
  database must prove mapping revision 0→1, while shuffled reruns derive the
  retained current revision instead of deleting immutable evidence.
- P2-R1 also records that audit rows created inside one rollback fixture share
  PostgreSQL's transaction-stable `now()` value, so their test order is the
  semantic revision with action/UUID used only as deterministic tie-breakers.

## Append-only Phase 2 implementation checkpoint — 2026-08-03

This checkpoint supersedes only the earlier Phase 2 “after frozen RED” current
packet wording. It preserves the RED journal and does not change the Phase 1
acceptance record.

### Implemented Phase 2 boundary

- Migration 108 and the readiness repository now retain revisioned mappings,
  runtime-bound preflight snapshots/results, singleton leases and recovery,
  immutable evidence, deterministic currentness, and idempotent Admin signoff.
- The Admin-only `/api/mbt/config/netsuite/*` routes provide mapping list/save,
  preflight start/latest/detail, deterministic JSON/CSV export, and signoff.
  Private responses are `no-store`; no non-Admin role gains the surface.
- The production bridge is OAuth-backed but narrow: GET only, no refresh,
  redirects refused, path constrained below the exact sandbox Record REST
  root, response type restricted to JSON/schema JSON, and response size
  bounded. The readiness adapter exposes only its frozen `readRecord`
  capability and persists bounded projections rather than raw responses.
- The server-owned read strategies are `record_by_id`, `metadata_catalog`,
  `derived_permission`, `configured_unproven`, and `unsupported`. Custom-field
  schema reads target `metadata-catalog/{parentRecordType}` with
  `Accept: application/schema+json`; different script IDs are independently
  projected from one in-memory schema payload per parent type.
- Runtime identity binds the exact configured/runtime sandbox account, exact
  allowlist, normalized Record REST root, direct-access state, read timeout,
  and preflight lease. Production-like, mismatched, mirror-consumer, or
  incomplete bindings fail before an outbound request.
- Semantic mapping configuration accepts only bounded `expected` evidence and
  unique declared `caseInsensitiveFields`. It rejects unrestricted keys,
  credential-like content, excess size/depth/node count, unsupported evidence
  fields, and invalid scalar arrays. Server-owned expectations and record-type
  allowlists remain authoritative.
- P2-R5 bounds independent evidence evaluation at four concurrent operations,
  preserves catalog/result persistence order, evaluates derived permissions
  only after evidence, and keeps unsupported/future checks at zero requests.
  Metadata request failures are evicted rather than poisoning a later retry.

### Automated GREEN recorded for this checkpoint

| Layer | Exact result |
|---|---:|
| Migration | 7/7 passed |
| Repository | 9/9 passed |
| Concurrency | 5/5 passed |
| Production GET transport | 8/8 passed |
| Real HTTP | 4/4 passed |
| Unit/property/strategy/service/latency | 43/43 passed |
| Mutation | 24/24 killed |

The latency contract first failed at the intended boundary: remote reads were
sequential (maximum active 1), a slow in-timeout fixture took about 1.94
seconds, and two same-parent metadata fields caused duplicate schema GETs.
After P2-R5, the focused evidence peaked at exactly four, completed the same
slow fixture in about 0.49 seconds, retained deterministic catalog order, and
issued one schema GET per parent record type.

These results are focused automated implementation evidence, not a final fresh
P2 gauntlet. No live NetSuite call occurred; production-transport tests used
an isolated token fixture and recording fetch. No real sandbox account,
record, permission, preflight, export, signoff, or zero-write observation is
claimed.

### Operational gate and next action

- Customer Sales Order form, SOT Sales Order form, Customer Deposit form, and
  receipt File Cabinet folder proof remain `unsupported` and
  `unable_to_verify`; their derived permissions cannot pass. A configured
  mapping must never manufacture success and no write/probe workaround is
  authorized.
- Real sandbox IDs, runtime binding, configuration hash, run UUID, exports,
  Admin signoff, probe-transaction count, and closed-gate observations are all
  `PENDING` in `docs/mbt/evidence/P2.md`.
- Resolve the unsupported required proof through approved official read-only
  endpoints, freeze the additional executable evidence, run one fresh final
  `tools/mbt-gauntlet.sh P2`, and then follow
  `docs/mbt/netsuite-sandbox-runbook.md` against the approved sandbox.
- Phase 2 is not operationally complete and enables no MBT operation or
  NetSuite write.

## Append-only Phase 2 R6/R7 hardening checkpoint — 2026-08-03

Independent evidence review found six material gaps after the first focused
GREEN packet: account subsidiary membership was not enforced; account type
used a display label instead of exact `acctType.id`; replacement environment
files could retain omitted file-owned NetSuite values; runtime currentness did
not separately bind runtime account/environment; subsidiary-scoped mappings
could precede the current MBT subsidiary; and official subsidiary proof still
used compatibility aliases.

- The frozen R7 packet contained 14 focused tests: 4 pre-existing/official
  shape proofs passed and 10 intended RED assertions exposed the six gaps.
- Account, customer, and item readiness now proves membership in the current
  MBT subsidiary. Customer/items also require a dedicated matching subsidiary
  ID and fail save before the MBT subsidiary exists; account mappings derive
  membership from `subsidiary.items` and do not expose a misleading editable
  subsidiary field.
- Official account proof consumes `acctName` and exact `acctType.id`.
  Official subsidiary proof consumes lowercase `legalname` and `isinactive`
  plus `currency`. Sale-item reads use Oracle's exact allowlisted record IDs.
- Runtime fingerprint v3 binds configured and runtime account identities,
  environment, Record REST root, direct access, exact allowlist, timeout, and
  effective lease. Replacement env-file loads clear only omitted values owned
  by the previous file while preserving unrelated ambient process values.
- Missing nullable evidence no longer equals explicit NetSuite `null`.
  Membership policy and runtime identity are configuration/currentness inputs,
  so a relevant policy or runtime change invalidates prior evidence.
- All 14 frozen R7 tests passed after repair. The focused semantic/unit packet
  passed 61/61 and the focused repository/HTTP packet passed 66/66. The final
  mutation set expanded to cover these review boundaries.

## Final automated Phase 2 acceptance checkpoint — 2026-08-03

One fresh isolated `tools/mbt-gauntlet.sh P2` run completed successfully:

- 378/378 main tests and three shuffled 378/378 repetitions over 52 files;
- strict type analysis, zero-warning lint/complexity, and changed legacy
  public-script syntax;
- 98.42% statements/lines, 93.47% branches, and 99.45% functions;
- 37/37 persisted mutations killed (100%);
- 106/106 legacy application harnesses;
- a healthy production-shaped image, ready migration/predeploy check, and
  fail-closed endpoint/auth smoke with operational state unchanged;
- 54/54 desktop Chromium, mobile Chromium, and mobile WebKit browser cases,
  including serious/critical accessibility checks;
- 387 dependency licenses checked with the documented pre-existing metadata
  exception, zero npm vulnerabilities, source integrity, and zero
  high-confidence secret findings across 127 new paths plus changed lines.

The disposable test database and containers were isolated from the deployed
stack. No live NetSuite request, write, application deployment, or operational
flag change occurred. Phase 2 automated implementation is accepted, but Phase
2 remains **INTERIM / NOT OPERATIONALLY COMPLETE**: required form/folder proof
is still `unsupported`, and the approved real-sandbox runtime, mappings,
preflight, exports, zero-write observations, and Admin signoff remain
`PENDING` in `docs/mbt/evidence/P2.md`.

## Phase 2 production deployment checkpoint — 2026-08-03

- The user authorized the locked, read-only Phase 2 deployment while deferring
  live Sales Order insertion. The exact accepted gauntlet image
  `sha256:26804dc8cd8e5f9eee3a272e7f6490fcd512b75bcb009e8fb9e8d06085b6ae40`
  was used for migration and the app-only cutover; the previous healthy P1
  image remains explicitly tagged for application rollback.
- A fresh 535,440,767-byte backup was catalog-validated, hash-matched, and
  fully restored with `--exit-on-error` in an isolated PostgreSQL 18 container
  before production migration. Restored representative aggregates exactly
  matched production at backup time.
- Migration 108 applied once with bounded lock/statement timeouts. The P2
  production predeploy was ready with no missing migration, enabled flag, or
  Dispatch collision. PostgreSQL and Ollama were not recreated.
- The replacement app was healthy on the exact image with zero restarts. All
  checked public legacy/MBT routes returned 200, readiness APIs rejected
  unauthenticated access with 401, and deployment produced no mapping,
  preflight, signoff, or MBT outbox row.
- Environment and database write gates remained closed. The current account
  is not sandbox-shaped and has no MBT sandbox allowlist, so P2 readiness
  refuses before outbound access. No NetSuite request or probe occurred.
- Phase 2 has no Sales Order writer. The 31/31 focused official metadata and
  GET-only contract passed, but a standard Sales Order POST payload is not
  implemented or claimed. A dedicated payload builder and offline wire-schema
  contract belong before a later write-enabled phase.
- Post-start printer-agent credential 401s require separate operational review.
  A read-only Compose inspection also expanded runtime secrets into a
  restricted internal tool transcript; no values were copied into evidence,
  but coordinated credential rotation is recommended.

The full deployment record, backup/image identities, maintenance interval,
and honest remaining external gates are in `docs/mbt/evidence/P2.md`. Phase 2
is deployed but remains **INTERIM / NOT OPERATIONALLY COMPLETE**.
