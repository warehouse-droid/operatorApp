# MBT Bin Operations Phase 3 Executable Specification

Status: **APPROVED**, 2026-08-03. The user approved the specification by
requesting `$old-coder please implement phase 3` after reviewing and revising
`docs/mbt/phase-3-local-operations-shadow-billing.md`.

The authoritative behavior and failure model are the complete Phase 3 plan.
This file freezes its implementation setup, scenario-to-test map, negative
contracts, and append-only RED/GREEN journal.

## Assurance and authorization boundary

- Assurance tier: Old Coder Tier 3.
- Approved source: `docs/mbt/phase-3-local-operations-shadow-billing.md`.
- Approved implementation: P3.0 through P3.11 automated/local work.
- Not authorized: production deployment, container restart, feature activation,
  live NetSuite requests, importing the real customer workbook, commit, push,
  or any NetSuite/Samsara mutation.
- Git: preserve the existing dirty `codex/dockerVer` worktree. No checkpoint
  commit was authorized; final evidence identifies a reproducible source-tree
  hash and exact base commit instead.
- Database: only isolated disposable PostgreSQL during development. Additive
  forward migrations begin after migration 109; never edit an applied migration.
- Dependencies: none planned. Reuse the exact-pinned existing Node 20,
  PostgreSQL 18, Node test runner, Ajv, fast-check, c8, TypeScript, ESLint, and
  Playwright stack. Any new dependency requires an approved appended revision
  before installation.
- Customer data: `/home/ubuntu/MBT_customer_20260803.xls` remains read-only and
  outside Git. Automated tests use synthetic PII-free structural fixtures.

## Frozen scenario-to-test map

Tests may be split into additional files, but each frozen scenario must retain
at least the named primary detector below.

| Scenario | Primary executable detector |
|---|---|
| P3-F01 NetSuite full/incremental sync | `integration/customer-sync.test.js` |
| P3-F02 source ordering/conflict | `integration/customer-sync.test.js`, `property/customer-sync.property.test.js` |
| P3-F03 failed snapshot preservation | `integration/customer-sync.test.js` |
| P3-F04 source/consumer compatibility | `integration/customer-consumer-compatibility.test.js` |
| P3-F05 Returns compatibility/cutover | `integration/customer-consumer-compatibility.test.js`, legacy Returns harnesses |
| P3-F06 current workbook preview | `unit/customer-spreadsheetml.test.js` |
| P3-F07 workbook apply/retry | `integration/master-data-import-foundation.test.js` |
| P3-F08 hostile imports | `property/master-data-import.property.test.js`, `unit/customer-spreadsheetml.test.js` |
| P3-F09 local item setup | `integration/local-item-catalog-p3.test.js` |
| P3-F10 shared yards/fleet/master setup | `integration/shared-dispatch-mbt-yards.test.js`, `integration/dispatch-truck-types.test.js` |
| P3-F11 asset registration/import | `integration/asset-registration.test.js` |
| P3-F12 rate-card setup | `integration/rate-card-configuration.test.js`, `property/local-rate-calculator.property.test.js` |
| P3-F13 Front Desk conversion | `integration/frontdesk-workflow.test.js`, `concurrency/frontdesk-races.test.js` |
| P3-F14 snapshot/amendment | `integration/frontdesk-workflow.test.js` |
| P3-F15 contract front-leg isolation | `integration/bin-contract-front-leg.test.js`, `e2e/p3-bin-dispatch.spec.js` |
| P3-F16 atomic leg plan/reservation | `integration/bin-dispatch-enabled.test.js`, `concurrency/bin-dispatch-enabled-races.test.js` |
| P3-F17 leg advancement/recovery | `concurrency/bin-leg-advancement-races.test.js` |
| P3-F18 Driver online delivery | `integration/driver-bin-execution.test.js` |
| P3-F19 Driver offline/reopen/sync | `e2e/p3-driver-bin-offline.spec.js`, `concurrency/driver-bin-sync-races.test.js` |
| P3-F20 manifest-change review | `integration/driver-bin-execution.test.js` |
| P3-F21 loaded pickup/dump | `integration/driver-bin-execution.test.js` |
| P3-F22 exchange | `integration/driver-bin-execution.test.js` |
| P3-F23 movement comparison | `integration/pilot-reconciliation.test.js` |
| P3-F24 receipt/distance comparison | `integration/pilot-reconciliation.test.js` |
| P3-F25 MBT contract calculation | `unit/local-billing-calculator.test.js`, `property/local-billing-calculator.property.test.js` |
| P3-F26 MBBS cross-charge rules | `integration/shadow-billing.test.js`, billing property tests |
| P3-F27 local approval only | `integration/shadow-billing.test.js`, `concurrency/shadow-billing-races.test.js` |
| P3-F28 variance correction | `integration/pilot-reconciliation.test.js` |
| P3-F29 independent gates/recovery | `integration/p3-feature-gates.test.js` |
| P3-F30 full non-regression | dedicated P3 gauntlet and explicit full legacy allowlist |

## Frozen negative contracts

| Must not happen | Detector |
|---|---|
| Existing Smart SCM proposal, schedule, reconciliation, PO/TO/VRMA, printing, blanket, or vendor behavior changes | full legacy allowlist plus all `smart-scm-*` harnesses |
| Ordinary Dispatch SO/TO/PO/VRMA/custom save, timing, forecast, grouping, split, activity, or assignment behavior changes | full Dispatch harness group, ordinary-plan before/after fixtures, save latency contract |
| Existing Driver non-BIN stops, offline sync, photos, rests, GPS, Samsara, truck switch, timestamps, review, or i18n changes | full Driver harness group and old-manifest compatibility tests |
| Existing Operator delivery/return/camera/yard workflows change | full Operator/Returns/Yard harness groups |
| Existing Returns customer API shape or pallet-return behavior changes | `test:returns-customer-directory`, `test:returns`, portal/operator harnesses |
| `netsuite-mirror/v1` changes or its cursors accept customer events | existing mirror harness plus customer compatibility contract |
| A local operation creates NetSuite chain/outbox/deposit/posting/transport work | database counts, fail-fast transport spy, local approval integration tests |
| Existing trucks become Bin or existing yards are duplicated | migration upgrade checksums and shared-master integration tests |
| Whole contracts/future legs enter Dispatch, or a leg splits across trucks | front-leg schema/repository/browser/concurrency tests |
| Production state changes during implementation | isolated Compose verifier, project-name guard, no deploy command in gauntlet |

## Reserved implementation migrations

Exact contents remain packet-scoped and additive:

1. `110_mbt_p3_feature_gates_imports.sql`
2. `111_mbt_p3_customer_sync_mirror.sql`
3. `112_mbt_p3_shared_dispatch_master_data.sql`
4. `113_mbt_p3_front_leg_operations.sql`
5. `114_mbt_p3_reconciliation_shadow_billing.sql`

If a migration split is required, append a spec revision before adding the new
number. Never rewrite 102–109 or an applied Phase 3 migration.

## Current journal

### P3.0 — 2026-08-03

- Spec approval: obtained from the user.
- Base commit: `37dfafbf534268aa84832c0f7a677f5f6a656bf6`.
- Worktree: intentionally dirty with the existing uncommitted Phase 1/2/local-
  first implementation. Treat all pre-existing changes as user-owned baseline.
- Pre-Phase-3 baseline command:
  `MBT_GAUNTLET_SKIP_REGISTRY_AUDIT=1 bash tools/mbt-gauntlet.sh P2` from
  `server/`, against isolated Compose project `mbbs-mbt-p1-test`.
- Baseline result: **GREEN**, exit 0. The primary run passed 407/407 tests;
  deterministic shuffled repetitions, type checking, lint/complexity, legacy
  syntax, coverage, persisted P2 mutation set, license allowlist, 106/106
  explicit legacy harnesses, production-shaped startup/predeploy/runtime
  fail-closed checks, and 60/60 Playwright cases across desktop Chromium,
  mobile Chromium, and mobile WebKit all passed. Registry vulnerability audit
  was the only deliberate skip (`MBT_GAUNTLET_SKIP_REGISTRY_AUDIT=1`); no
  dependency changed during this baseline.
- Baseline compatibility inventory: the explicit 106-harness legacy allowlist
  includes Smart SCM, Dispatch, Driver/offline/photos/rest/GPS/Samsara,
  Operator, Returns, yard movement, NetSuite mirror, and PO history seams.
- RED/GREEN status: P3.0 complete. No Phase 3 runtime source edit occurred
  before this baseline. P3.1 tests are next and must be observed RED before
  migration/gate/gauntlet implementation.

### P3.1 RED — 2026-08-03

- Frozen tests:
  `infrastructure/p3-gauntlet-contract.test.js`,
  `integration/p3-feature-gates.test.js`, and
  `integration/p3-migration-upgrade.test.js`.
- Test-only correction before assertion freeze: the first infrastructure test
  initially attempted to read repository-level `.github` files from the
  intentionally server-only test image. It was changed to validate a synthetic
  exact P3 workflow; the outer gauntlet remains responsible for validating the
  real file. No product assertion or implementation changed.
- Focused isolated command:
  `node --test --test-concurrency=1 --test-reporter=dot` with the three files
  above, after migrations 001–109 on disposable PostgreSQL.
- Observed RED: **0 passed / 16 failed**, all at intended missing Phase 3
  boundaries: CI contract rejects P3; gauntlet has no explicit P3 branch;
  P3 predeploy/runtime/mutation contracts are absent; the database has six
  rather than nine closed flags; `phase3-capabilities.js` and seven isolated
  environment gates are absent; migration 110 is absent from fresh/current
  databases; and a schema-109 migration attempt has no bounded lock failure
  because there is no P3 migration to apply.
- Assertions are now frozen. Implementation may not weaken or edit these tests
  to obtain GREEN.
- Test-harness correction during GREEN: the bounded-lock rehearsal originally
  retained an `ACCESS EXCLUSIVE` lock and then queried the locked flag table
  from a second connection, causing the test itself to wait forever after the
  migration had correctly timed out. The blocker transaction is now rolled
  back immediately after verifying migration non-application and before the
  flag-table read. Expected rows, checksums, timeout, atomicity, and retry
  assertions are unchanged.

### P3.1 GREEN — 2026-08-03

- Migration 110 adds only the three previously absent Phase 3 flags and leaves
  all nine MBT flags false. It uses an idempotent insert and a three-second
  transaction-local lock timeout; fresh, schema-109 upgrade, exact rerun,
  bounded-lock rollback/retry, and representative legacy checksums pass.
- The new capability evaluator requires independent environment-root,
  environment-capability, database-root, database-capability, and pilot scope
  facts. Missing facts fail closed, enabling one capability cannot activate
  another, and NetSuite writes remain forbidden throughout Phase 3.
- P3 now has its own least-privilege workflow, explicit gauntlet/predeploy/
  runtime branches, seven closed environment gates, exact-nine database-gate
  inspection, and a persisted mutation set. P1/P2 selectors remain explicit.
- Additive hardening RED: the first P3 production smoke implementation made
  its authenticated MBT route requests anonymously and did not own a cleanup
  identity. The new detector passed 3/5 and failed 2/5 on missing bearer auth
  and missing cleanup. GREEN creates one temporary isolated Admin/session,
  authenticates both calls with one token, compares operational state, and
  deletes the identity in `finally`; the unchanged detector passes 5/5.
- Final focused isolated result: **43/43 passed**, including all frozen P3.1
  tests, the P1/P2 predeploy/config seams, and disabled Dispatch/Driver BIN
  regressions. `npm run typecheck:mbt` and `npm run lint:mbt` both exit 0.
- Persisted mutation proof: **52/52 killed (100%)** with exact source-hash
  restoration. The first attempt killed 51 mutants and exposed a stale
  indentation-only source needle for mutant 52; after correcting that harness
  target, the fresh run killed all 52. No product assertion was changed.
- Packet status: complete. No SCM, Dispatch, Driver, or Operator operational
  path was activated or changed by P3.1. P3.2 import tests are the next RED.

### P3.2 RED — 2026-08-03

- Frozen tests:
  `unit/master-data-csv.test.js`,
  `unit/customer-spreadsheetml.test.js`,
  `property/master-data-import.property.test.js`,
  `integration/master-data-import-foundation.test.js`,
  `concurrency/master-data-import-races.test.js`, and
  `integration/master-data-import-http.test.js`. A shared
  `support/master-data-import-fixtures.js` builds only invented identifiers,
  reserved `example.invalid` addresses, and a synthetic SpreadsheetML scale
  fixture; the real workbook was not opened, copied, or imported.
- Frozen boundaries include the exact 20-MiB/50,000-row/200-column/4,000-cell
  limits; chunked RFC 4180 parsing; UTF-8/control/header/cell failures; formula
  neutralization; the ten observed SpreadsheetML headers and explicit source
  defaults; exact-scope/status skips; incomplete entity markers; bounded bare
  ampersand recovery; OLE/ZIP/DTD/entity/formula/link/macro/malformed rejection;
  deterministic file/normalized hashes; an aggregate-only 1,262-row preview;
  no preview customer/outbox mutation or raw upload retention; atomic apply,
  exact retry, target-revision binding, rollback, and provenance; 25
  independent-client revision races; simultaneous exact retry; and live-session
  Admin/no-store/raw-upload HTTP contracts.
- Test-only lint command in the isolated image completed with exit 0:
  `npx eslint --config eslint.mbt.config.js --max-warnings=0` over the six files
  and synthetic fixture helper.
- Focused isolated RED command:
  `node --test --test-concurrency=1 --test-reporter=dot` with the six files
  above against the disposable `mbbs-mbt-p1-test` PostgreSQL project.
- Observed RED: **0 passed / 30 failed**, all at intended missing P3.2
  boundaries. The bounded CSV, customer normalizer, SpreadsheetML, and import
  coordinator modules do not exist; the four durable import tables do not
  exist; and all four public import route tests receive 404 instead of their
  frozen authorization/capability/response contracts. Assertions are now
  frozen. No production source, migration, dependency, deployment, or live
  customer data changed during this RED packet.
- Test-harness correction before GREEN: the 25-race test originally asserted
  that the shared database's total historical NetSuite outbox count was zero.
  Earlier isolated P1/P2 tests may legitimately retain future-intent rows, so
  the detector now freezes the before count and requires the import races to
  leave it exactly unchanged. The zero-new-external-work assertion is
  unchanged; only unrelated retained state is excluded.
- Pure-test fixture corrections before GREEN: fast-check may construct
  null-prototype records, but CSV has no representation for a JavaScript object
  prototype, so generated `{code, detail}` values are now copied into ordinary
  records before the unchanged 1,000-example semantic round-trip assertion.
  The downward-limit success fixture also uses a two-character cell limit for
  its two-character `id` header rather than an internally contradictory limit
  of one. Property run count, values, approved upper bounds, and every product
  assertion remain unchanged. The first implementation run exposed only these
  fixture mismatches: **17/19 passed** before correction.

### P3.3 RED — 2026-08-03

- Frozen tests: `integration/customer-sync.test.js`,
  `concurrency/customer-sync-races.test.js`,
  `property/customer-sync.property.test.js`, and
  `integration/customer-consumer-compatibility.test.js`. All identifiers,
  names, contacts, addresses, timestamps, signatures, and customer aggregates
  are invented fixtures; the real customer workbook and live NetSuite were not
  read or invoked.
- Frozen boundaries cover P3-F01–P3-F05 and the P3-F07 canonical seam:
  read-only full/incremental paging by `(modified_at, internal_id)` including
  equal timestamps; two exact full reconciliations and one incremental;
  canonical customer/subsidiary/address/contact materialization; exact replay;
  source ordering, one durable conflict, live-NetSuite precedence, and local
  site-field preservation; empty/partial/malformed/timed-out/lease-lost
  snapshot preservation; CSV bootstrap through the same canonical apply;
  25 independent lease races, 25 equal-version payload races, and injected
  post-canonical rollback; 1,000-run cursor/precedence properties plus a
  500-run permutation/identity property; independent signed and bounded
  `customer-master/v1` event/snapshot consumption; unchanged
  `netsuite-mirror/v1` state/constraint; exact Returns response/search shape,
  active-row parity by internal ID, single-writer cutover, and explicit
  rollback; consumer direct-NetSuite calls and all remote transport mutations
  remain exactly zero.
- Test-only lint command in the isolated image completed with exit 0:
  `npx eslint --config eslint.mbt.config.js --max-warnings=0` over the four
  frozen files.
- Focused isolated RED command:
  `node --test --test-concurrency=1 --test-reporter=spec` with the four files
  above against the disposable `mbbs-mbt-p1-test` PostgreSQL project.
- Observed RED: **0 passed / 15 failed / 0 cancelled / 0 skipped**, exit 1.
  Every test reached its intended assertion and failed on an absent P3.3
  production contract: the read-only source, tuple/source rules, canonical
  sync/apply/provenance service, independent `customer-master/v1` contract,
  consumer reconciliation, and Returns projection/ownership modules do not
  exist. There were no collection, fixture, database, or live-transport
  failures. Assertions are now frozen. No production source, migration,
  dependency, deployment, existing Returns implementation, or live data was
  changed during this RED packet.

### Phase 3 migration assignment revision — 2026-08-03

- Migration 110 was applied and frozen by P3.1 with closed feature flags only.
  The P3.2 and P3.3 tests were both observed RED before adding further schema.
- The already-reserved `111_mbt_p3_customer_sync_mirror.sql` now owns the
  combined section 6.1 durability substrate: bounded import batches/staging/
  results plus provenance, `customer-master/v1`, consumer, snapshot, and
  Returns-projection evidence. This does not combine parser/import behavior
  with synchronization behavior; those remain separately gated GREEN packets.
- The migration is additive and closed-state only. It imports no file, rewrites
  no existing customer/Returns row, invokes no external source, and activates
  no capability. No new migration number or dependency was required.

### P3.4 RED — 2026-08-03

- Frozen tests:
  `integration/shared-dispatch-mbt-yards.test.js`,
  `integration/dispatch-truck-types.test.js`,
  `concurrency/dispatch-truck-capability-races.test.js`, and
  `integration/local-item-catalog-p3.test.js`. All yard, item, material, dump,
  template, truck, actor, and command fixtures are synthetic or the four exact
  already-approved Dispatch own-yard mappings; no external system or real
  import file was read.
- Frozen P3-F09 boundaries cover the five protected system identities; custom
  uppercase immutable codes; the seven allowed categories and three pricing
  modes; nullable/no-effect NetSuite metadata; absence of money, UOM, and
  currency ownership; one validator for synthetic normalized manual and CSV
  rows; exact replay; protected-identity rejection; and retained revisions and
  audit snapshots after inactivation.
- Frozen P3-F10 boundaries cover one relational identity for each exact
  `12441/15`, `3445/1`, `2967/28`, and `150/26` yard with existing address and
  coordinate details (including the legitimate null coordinate pair for
  `150`); the unchanged legacy `ownYards` projection; no competing yard/fleet
  registry; Flatbed backfill/default; typed truck/base-yard/slot/supported-size
  invariants; one complete Bin truck round trip; legacy-field omission
  preservation; 25 two-client optimistic capability races; material, dump-site
  acceptance, coordinate/reference, service-template step/evidence, rollback,
  and inactivation history; and closed master-data API gates before domain or
  transport effects.
- P3.2 owns bounded CSV parsing and the preview/apply coordinator. P3.4 passes
  invented normalized rows into a frozen local-domain adapter contract rather
  than defining a second parser. The future CSV adapter must use the P3.2
  coordinator and this same per-row validator.
- Test-only lint first ran without the repository's explicit flat-config flag
  and ESLint correctly refused to select a configuration. The corrected
  isolated command, `npx eslint --config eslint.mbt.config.js` over all four
  files, completed with exit 0; no assertion or product file changed between
  the two invocations.
- Focused isolated RED command:
  `node --test --test-concurrency=1 --test-reporter=dot` with the four files
  above against the disposable `mbbs-mbt-p1-test` PostgreSQL project.
- Observed RED: **0 passed / 14 failed**, exit 1. Every test reached an intended
  missing P3.4 boundary: migration 112, shared-yard location identity and
  projection, truck type/revision/base-yard constraints and repository fields,
  the optimistic capability command, extensible/system-owned local items, the
  shared local-master service, material/dump/template commands, and gated
  setup routes are absent. The route detector received 404 rather than the
  required closed-gate 409. There were no collection, syntax, fixture, live-
  transport, or production-state failures. Assertions are now frozen.
- No P3.4 production source, migration, dependency, Dispatch/Driver/SCM/
  Operator implementation, deployment, or live data changed in this RED
  packet. `e2e/p3-dispatch-settings.spec.js` remains explicitly deferred to
  the later P3.4 UI/browser hardening pass and is not represented as passing
  evidence here.

### P3.2 pure GREEN — 2026-08-03

- Implemented only the bounded, side-effect-free import seam in
  `src/mbt/bounded-csv.js`, `src/mbt/customer-import-normalizer.js`, and
  `src/mbt/customer-spreadsheetml.js`. This packet adds no migration,
  repository, service, route, dependency, deployment change, database access,
  live NetSuite call, or operational change to SCM, Dispatch, Driver, or
  Operator.
- Fresh isolated pure command:
  `node --test --test-concurrency=1 --test-reporter=spec` over
  `unit/master-data-csv.test.js`, `unit/customer-spreadsheetml.test.js`, and
  `property/master-data-import.property.test.js`. Observed result:
  **19 passed / 0 failed / 0 cancelled / 0 skipped**, exit 0. This includes
  four 1,000-example properties and the invented 1,262-row SpreadsheetML
  scale fixture; no real workbook was read.
- The pre-GREEN fixture corrections recorded in the P3.2 RED entry remain
  narrowly test-only: converting fast-check's prototype-free generated
  records to ordinary records before semantic CSV comparison, and making the
  downward cell-limit fixture large enough for its own two-character header.
  The first implementation run was **17/19**; the corrected fresh run was
  **19/19**. No product expectation, property run count, generated value, or
  approved upper bound was weakened.
- Fresh full `npm run typecheck:mbt` and focused ESLint over the three sources,
  three pure tests, synthetic fixture helper, and mutation runner both
  completed with exit 0 and zero warnings.
- Four persisted pure-import mutants cover direct-input byte-limit bypass,
  duplicate internal-ID acceptance, executable SpreadsheetML formula
  acceptance, and bare-ampersand repair outside `Data`. A fresh disposable P3
  mutation image killed all four and the complete cumulative suite:
  **56/56 killed (100%)**, exit 0. The runner restored every mutated source to
  its exact pre-mutation SHA-256 before continuing.

### P3.5 RED — 2026-08-03

- Frozen test-only files:
  `integration/asset-registration.test.js`,
  `concurrency/asset-registration-races.test.js`,
  `integration/asset-registry-http.test.js`, and
  `unit/asset-page-contract.test.js`. All asset, yard, actor, movement,
  barcode, QR, reconciliation, and timestamp values are synthetic. No live
  asset list, manual record, external source, or upload file was read.
- P3-F11 boundaries freeze one local `asset-registry-service.js` orchestration
  seam over the existing append-only asset ledger: manual registration and
  exact replay create exactly one asset, `asset_registered` sequence-1
  movement, exact current state, audit, and command receipt in one transaction;
  blank/unknown yard or bin type and duplicate asset code/QR/barcode create no
  partial evidence; an injected failure immediately after asset insertion
  rolls back every boundary. List/search, complete sequence-1 timeline, and
  revisioned presentation/maintenance attributes retain movement history.
- P3-F23 boundaries freeze an opening movement comparison with independent
  immutable application/manual snapshots for asset, before/after state,
  location, truck, driver, visit, sequence, and occurrence time. Exact rows
  match, mismatches open a variance, and `evidence_only` resolution retains the
  original movement/state unchanged. Existing `asset-movements.test.js` and
  `asset-reservations.test.js` remain the primary movement, correction,
  deferred-state, and 50-client reservation detectors.
- The concurrency file freezes 25 independent two-command races rotating the
  colliding natural key across asset code, QR, and barcode. Every race must
  produce one complete winner and one deterministic 409 loser. A separate
  25-client exact-retry race must retain one asset/movement/state/audit/receipt
  and return 24 exact replays.
- The HTTP contract freezes live-session Admin/Dispatcher private reads,
  Admin-only registration, server-owned actor binding, no-store responses,
  required `Idempotency-Key`, independent `assetManagement` authorization,
  read-only recovery with the write gate closed, and zero NetSuite transport.
  The browser contract freezes a separate `/mbt/assets` page and MBT-only
  sidebar/client seam for registry, current state, timeline, CSV opening
  inventory, and reconciliation; it may not call SCM, Dispatch, Driver, or
  Operator APIs.
- Focused ESLint command in the isolated test image completed with exit 0 and
  zero warnings over all four new files. The first RED reporter included the
  entire large `server.js` value in one failed regex diagnostic; before
  assertion freeze that check was expressed as the same boolean route/file
  predicate with a bounded failure message. No expected behavior changed.
- Focused isolated RED command:
  `node --test --test-concurrency=1 --test-reporter=dot` with the four files
  above against the disposable `mbbs-mbt-p1-test` PostgreSQL project.
  Observed RED: **0 passed / 13 failed**, exit 1. All 13 tests reached intended
  missing P3.5 boundaries: eight service/concurrency cases reject the absent
  registry exports with explicit assertions, three API cases receive 404, and
  two browser cases reject the absent route/page. There were no collection,
  syntax, fixture, database, or external-transport failures. Assertions are
  now frozen.
- Reusable-foundation control run:
  `node --test --test-concurrency=1 --test-reporter=dot` over the unchanged
  existing movement and reservation files completed with exit 0 and **21/21
  test/subtest cases green**, including the 50-independent-client reservation
  race and append-only correction/state invariants.
- No P3.5 production source, migration, router/server/public asset, package,
  dependency, deployment, feature activation, SCM, Dispatch, Driver, or
  Operator behavior changed during this RED packet.

### P3.5 migration assignment revision — 2026-08-03

- The frozen P3-F23 GREEN requires durable immutable application/manual
  movement snapshots and append-only variance resolutions before the broader
  pilot reconciliation/billing packet. Migration 113 remains exclusively
  reserved for front-leg operations, and migration 114 remains reserved for
  the broader reconciliation/shadow-billing graph.
- Additive migration `115_mbt_p3_asset_registry_reconciliation.sql` therefore
  owns only P3.5 asset-movement comparison batches, rows, and resolutions. It
  may not add billing, receipt, distance, Front Desk, Dispatch, Driver,
  NetSuite, or feature-activation behavior. The split prevents P3.5 from
  partially applying either reserved packet and leaves both reserved numbers
  independently implementable.

### P3.4 frozen-query correction disclosure — 2026-08-03

- The first GREEN run reached the legacy truck round-trip verification but
  PostgreSQL rejected its evidence query with `42702` before any product
  assertion: the query selected unqualified `revision` while joining both
  `dispatch_trucks` and `mbt_bin_types`, and both relations already own that
  column.
- With explicit gauntlet-owner authorization, the frozen query now selects
  `truck.revision`. No expected value, assertion, input, product boundary, or
  pass condition changed. The correction only makes the already-frozen
  revision assertion executable and is disclosed before its rerun.

### P3.4 upgrade-fixture correction disclosure — 2026-08-03

- The first GREEN run used a genuinely fresh disposable database, which
  correctly had zero Dispatch trucks before migration 112. The frozen
  fresh-schema assertion nevertheless required `rowCount > 0`; that checked
  test pollution, not an upgrade boundary.
- With explicit gauntlet-owner authorization, the ordinary fresh-schema check
  now accepts zero-or-more trucks while retaining the invariant over every row.
  A dedicated temporary database applies schema through 111, seeds one
  representative legacy truck with an old active BIN capability, then applies
  112 and retains the stronger nonempty upgrade assertion: the truck becomes
  explicit Flatbed exactly once, its legacy-column checksum is unchanged, and
  an exact SQL rerun leaves the complete P3.4 data digest unchanged. No product
  expectation was removed or weakened.

## Journal rules

- Append observed RED and GREEN commands/results; do not rewrite history.
- Tests are committed to the worktree and run RED before their implementation.
- A test passing because behavior pre-exists needs a throwaway mutant proving it
  detects regression, followed by source restoration verification.
- A P3 completion claim requires one final fresh dedicated P3 gauntlet and
  `docs/mbt/evidence/P3.md` populated from that run.

### P3.4 GREEN — 2026-08-03

- Production scope was limited to additive migration
  `112_mbt_p3_shared_dispatch_master_data.sql`, the shared Dispatch truck/yard
  repository projection, one optimistic truck-capability command, and the
  local master-data service/catalog extension. No feature flag was enabled;
  Driver, Operator, Smart SCM, deployment, restart, external transport, and
  live data were untouched.
- A new disposable Compose project, `mbbs-mbt-p34-test`, applied migrations
  001–112 from empty state. Exact command:
  `docker compose -p mbbs-mbt-p34-test -f docker-compose.mbt-test.yml
  --profile tools run --rm migrate`. Result: exit 0, including
  `Applied 112_mbt_p3_shared_dispatch_master_data.sql`.
- The first clean migration exposed and repaired one real schema defect before
  final evidence: the generalized item-code constraint rejected the protected
  numeric-leading identities `14YD`, `20YD`, and `40YD`. The final constraint
  and domain validator accept the protected identities without weakening the
  uppercase/length boundary.
- Final P3.4 command:
  `node --test --test-concurrency=1 --test-reporter=spec` over
  `integration/migration-112-upgrade.test.js`,
  `integration/shared-dispatch-mbt-yards.test.js`,
  `integration/dispatch-truck-types.test.js`,
  `concurrency/dispatch-truck-capability-races.test.js`, and
  `integration/local-item-catalog-p3.test.js`. Observed result:
  **15 passed / 0 failed / 0 cancelled / 0 skipped**, exit 0. This is the
  original 14 frozen assertions plus one additive schema-111 upgrade/rerun
  rehearsal. The authorized frozen-query and fresh-fixture corrections are
  disclosed in the two preceding journal entries.
- The dedicated upgrade rehearsal seeds one representative legacy truck with
  an old active BIN capability before migration 112, proves the migration
  makes it explicit Flatbed while preserving the legacy-column checksum, then
  executes the exact migration SQL again and proves the complete yard/item/
  truck/capability digest remains unchanged. An independent disposable rerun
  also produced identical digest
  `7c385256d9038b16732cd312bc3acb1e` before and after.
- Focused ESLint over the four P3.4 production modules and five test files
  completed with exit 0 and zero warnings. `git diff --check` also completed
  with exit 0. The most recent full Phase 3 `npm run typecheck:mbt` reached no
  P3.4 error but remained nonzero on concurrently edited P3.2/P3.5 modules;
  this packet does not misreport that shared-tree run as globally green.
- Critical non-regression command over the existing local-item unit/property/
  integration/concurrency/HTTP/UI-contract files plus disabled BIN Dispatch
  passed **23/23**, exit 0. The established Dispatch fleet/setup static
  harness, save-coordination harness, and fleet endpoint harness all exited 0;
  the endpoint harness reported **18 checks passed**.
- One reused long-lived disposable database correctly failed migration 112 at
  `dispatch_location_id SET NOT NULL` because prior P1/P2/P3 test runs had
  retained synthetic `mbt_yards` rows with no real Dispatch/NetSuite location
  identity. Phase 3 deliberately does not invent external IDs. Tests therefore
  use fresh projects or exact mapped pre-112 yard fixtures; a genuinely
  unmapped upgrade remains fail-closed and transactionally unapplied. This is
  a test-environment reuse limitation, not authorization for a product
  backfill.
- P3.4 browser Settings hardening, complete mutation selection, and the final
  broad P3 gauntlet remain pending later packet/final evidence. This is packet
  GREEN only, not a Phase 3 completion claim.

### P3.6 RED specification and failure model — 2026-08-03

- Scope is P3-F12 plus only the reusable pure calculation seam needed later by
  P3-F24/P3-F25: local draft rate graphs, validation/activation/cloning,
  raw-metre distance selection, exact integer-minor-unit lines, and separate
  dump customer tariff/actual cost/margin evidence. Full billing cases, tax,
  Front Desk, reconciliation workflow, Dispatch, Driver, Operator, Smart SCM,
  posting, and NetSuite transport remain outside this packet.
- Assurance is Tier 3 because a wrong band, cent, version, or activation race
  changes money. No dependency, migration, router/server/sidebar edit,
  deployment, feature activation, or external request is authorized for RED.
- Frozen detector plan:
  `unit/local-rate-calculator.test.js` covers exact half-open raw-metre bands,
  deterministic/scoped component lines, safe integer arithmetic, input
  immutability, and separate dump economics;
  `property/local-rate-calculator.property.test.js` runs at least 1,000 cases
  each for band boundaries, order-independent cent conservation, and dump
  margin separation;
  `integration/rate-card-configuration.test.js` covers one shared normalized
  manual/multi-CSV draft graph, atomic child creation, hostile/reference/date/
  currency/unit validation, activation, exact replay, and used-version cloning;
  `concurrency/rate-card-configuration-races.test.js` repeats independent
  activation and exact-retry races at least 25 times;
  `integration/rate-card-configuration-http.test.js` freezes live-session
  Admin/no-store/idempotency/gate/server-actor/zero-transport contracts; and
  `unit/rate-card-page-contract.test.js` freezes the accessible Rate Cards tab,
  manual/multi-file workflow, explicit cents/metres presentation, and
  focus-preserving local-only client boundary. Existing P1 rate lifecycle and
  immutable financial tests remain primary used-version database detectors.
- Failure detectors are explicit: kilometre pre-rounding and inclusive maximum
  are killed by boundary properties; fractional/unsafe metre or cent input and
  overflow by unit/property rejection; nondeterministic child ordering by
  permutation equality; dump cost/customer-charge conflation by independent
  conservation identities; partial/manual-versus-CSV drift by transactional
  graph equality/checksums; two active versions or lost optimistic updates by
  25-race results; used-version mutation by original checksum plus cloned draft;
  and accidental external/operational capability by route spies and static
  page/API isolation checks.
- Pre-RED reusable-foundation control command ran the existing
  `unit/pure-contracts.test.js`, `integration/rate-lifecycle.test.js`, and
  `integration/immutable-financial-evidence.test.js` against disposable
  PostgreSQL. Observed result: **30 passed / 0 failed / 0 skipped**, exit 0.

### P3.3 GREEN — 2026-08-03

- Production scope was limited to the canonical customer source/rule,
  read-only adapter, transaction boundary, sync/apply/provenance service,
  independently versioned `customer-master/v1` event/snapshot contract, and
  canonical Returns projection/ownership modules. Migration 111 supplies the
  additive durability tables. No feature flag was enabled; existing Returns,
  `netsuite-mirror/v1`, SCM, Dispatch, Driver, Operator, deployment, restart,
  live customer data, NetSuite request, or remote mutation path was changed.
- The frozen P3.3 command was:
  `node --test --test-concurrency=1 --test-reporter=spec
  test/mbt/property/customer-sync.property.test.js
  test/mbt/integration/customer-sync.test.js
  test/mbt/concurrency/customer-sync-races.test.js
  test/mbt/integration/customer-consumer-compatibility.test.js` in the
  isolated `mbbs-mbt-p1-test` Compose project. Final observed result after the
  last P3.3 implementation edit: **15 passed / 0 failed / 0 cancelled / 0
  skipped**, exit 0. This includes 25 lease races, 25 equal-version payload
  races, atomic rollback injection, 1,000 cursor properties, 1,000 precedence
  properties, and 500 permutation/internal-ID properties.
- The first GREEN attempt passed **13/15**. It exposed two production defects:
  PostgreSQL needed an explicit single type for the conflict identity
  parameter, and internal decisions `ignore`/`conflict` needed public result
  names `ignored`/`conflicted`. Only production code changed; every frozen test
  and assertion remained unchanged. The focused two-suite rerun passed 8/8,
  followed by the final 15/15 run above.
- Focused ESLint over
  `customer-database.js`, `customer-source-rules.js`,
  `netsuite-customer-source.js`, `return-customer-projection.js`,
  `customer-sync-service.js`, and `customer-master-contract.js` completed with
  exit 0 and zero warnings. `npm run typecheck:mbt` reported no diagnostic in
  any P3.3-owned file; the shared worktree run remained nonzero only on
  concurrently edited asset/import files and is not represented as a global
  typecheck pass.
- Established compatibility commands both passed: `npm run
  test:returns-customer-directory` reported `Return customer directory harness
  passed`; `npm run test:netsuite-mirror`, run through the baseline service
  with its required `/workspace` and `/app` mounts, reported `NetSuite
  compatibility and disabled V2 deployment harness passed`.
- The P3.2 import regression command covered the four master-data import
  property/integration/concurrency files. Its first shared-database rerun was
  **15/16** because a prior successful synthetic run had retained entity number
  `741011`; PostgreSQL proved the existing row was the earlier synthetic
  `Synthetic Atomic Beta` from `synthetic-account`. No source assertion was
  changed and no retained evidence was deleted. A fresh disposable project
  `mbbs-mbt-p3-customer-final` applied migrations 001–112 and 115 from empty
  state, then the same command passed **16/16**, exit 0, including 25 stale-
  preview races, exact concurrent retries, post-canonical rollback, HTTP
  privacy/capability boundaries, and 3,000 hostile/deterministic identity
  properties plus formula-neutralization properties.
- The long-lived shared project could not apply unrelated migration 112 because
  earlier synthetic yards intentionally have no real Dispatch location IDs;
  `schema_migrations` independently confirmed migration 111 had committed.
  The fresh project applied 112 successfully. This disclosed fixture residue
  did not alter P3.3 behavior and is not hidden as a passing shared-database
  migration run.
- P3.3 packet GREEN is complete. Changed-line coverage, P3.3-specific mutation,
  shuffled/full legacy, browser, production-shaped execution, supply-chain,
  and the final broad P3 gauntlet remain later packet/final-evidence work; this
  entry does not claim Phase 3 completion or pilot readiness.

### P3.2 transactional hardening RED/GREEN — 2026-08-03

- After the initial P3.2 GREEN, a new frozen failure-injection detector was
  added at the canonical-customer/import boundary: an exception immediately
  after canonical apply must roll back customer aggregates, import apply
  results, command receipt, batch status, and any outbox delta together.
- The first focused run reached the intended detector and failed because the
  canonical service opened its own transaction through the raw pool; the
  outer import command could therefore not roll it back. Observed RED:
  **0 passed / 1 failed** at the missing rejection/rollback boundary.
- GREEN passes an AsyncLocalStorage-aware query-only database adapter into the
  canonical service, so nested work participates in the import command's
  existing transaction. The focused failure-injection rerun passed **1/1**.
  No assertion or injected boundary was changed.
- A fresh, uniquely named disposable PostgreSQL project applied migrations
  001 through 112 and 115, then ran all six frozen P3.2 files. Observed result:
  **31 passed / 0 failed / 0 skipped**, including four 1,000-example
  properties, the synthetic 1,262-row SpreadsheetML case, 25 independent
  revision races, exact-retry races, HTTP authorization/gating, and the new
  post-canonical rollback detector. `npm run typecheck:mbt` also exited 0.
- The long-lived shared test database retained a fixed synthetic entity from
  an earlier successful run and can collide with one legacy fixed fixture.
  No retained row was deleted or rewritten. The authoritative packet run used
  the fresh disposable database, demonstrating test-state pollution rather
  than a product defect. The real workbook and live NetSuite remained unread
  and uncalled.

### P3.2–P3.4 configuration/API exit hardening RED — 2026-08-03

- Frozen additions: `unit/phase3-config-page-contract.test.js` and
  `integration/customer-operations-http.test.js`. They cover the missing
  usable configuration exits without changing the already-green parser,
  customer canonicalization, or local-master assertions.
- The browser contract requires Customer Sync & Import with primary read-only
  NetSuite sync, bounded CSV/SpreadsheetML preview/apply, provenance/freshness,
  Local Items, Materials & Dump Sites, Service Templates, and Rate Cards on the
  single MBT configuration surface. It also prohibits a duplicate MBT yard or
  truck master and confirms the established Dispatch setup projection carries
  the typed capability fields.
- The HTTP contract requires live-session/Admin sync and conflict commands,
  server-owned actor identity, idempotency/audit/revision inputs, closed-gate
  command blocking with evidence reads preserved, no-store responses, and
  paginated canonical search for Admin/Front Desk.
- Observed RED: six missing UI/API assertions failed at the intended absent
  routes/labels/client seams; the already-implemented typed Dispatch projection
  assertion passed. No production file changed before this RED and assertions
  are now frozen.

### P3.5 Asset Registry GREEN — 2026-08-03

- Production scope is the local asset-registry service, additive migration
  `115_mbt_p3_asset_registry_reconciliation.sql`, and the isolated
  `/mbt/assets` browser surface. Registration uses the established atomic MBT
  command boundary and creates the asset, sequence-1 `asset_registered`
  movement, current state, audit, and exact replay receipt together. Attribute
  edits are optimistic and audited; comparisons retain immutable application
  and manual snapshots; resolutions append one audited decision and never
  rewrite the movement ledger. No P3 capability was enabled and no SCM,
  Dispatch planning, Driver, Operator, deployment, restart, live-data, or
  external-transport path was changed by this packet.
- A fresh isolated Compose project, `mbbs-mbt-p35-test`, applied migrations
  001–112 and 115 from empty state with exit 0. The exact migration 115 SQL was
  then executed inside a rollback-only transaction and reported
  `migration 115 exact SQL rerun succeeded and rolled back`; the ordinary
  migration command subsequently exited 0 with no pending migration. A reused
  P1/P2 test database remains intentionally blocked at migration 112 because
  its historical synthetic yards have no real Dispatch/NetSuite external
  identity. No external identity was invented and no retained row was changed
  to conceal that environment-only residue.
- The frozen P3.5 detector set passed **13/13**: six service/transaction cases,
  two 25-client concurrency cases, three live HTTP authorization/gate/replay
  cases, and two static browser-isolation contracts. The final combined asset
  packet passed **41/41**, exit 0: those frozen 13, seven additive boundary
  hardening tests, and all **21/21** established asset movement/reservation
  controls. The shared synthetic movement fixture was corrected, with explicit
  owner approval, only to reuse migration 112's exact mapped `12441` yard; no
  product assertion or behavior changed.
- The first focused changed-service coverage run correctly rejected the packet
  at 87.09% statements/lines and 57.04% branches. A separate post-GREEN
  hardening suite was added without altering the frozen 13. It covers all five
  location kinds, default/invalid states, active references, list bounds and
  cursors, missing timelines, partial/stale/duplicate attribute edits,
  malformed/duplicate/missing comparison rows, terminal resolution rules, and
  a simultaneous one-winner resolution race. Final changed-service coverage is
  **99.16% statements, 99.16% lines, 100% functions, and 96.05% branches**,
  clearing the configured 95/95/95/90 gates.
- The post-GREEN suite also killed a controlled throwaway unbounded-list mutant:
  observed RED was **6/7** with the bounded-pagination assertion reporting a
  missing rejection. The source was restored to exact SHA-256
  `8481e16fd2741b916ac7926ef4fe8fc393dd83687c3513f25c1679472a0dcfda`,
  followed by **7/7** GREEN against the restored host source. Two earlier
  pre-freeze hardening-authoring runs exposed only test-fixture mistakes
  (`RETURNING ... ORDER BY` syntax and the established
  `MBT_STALE_REVISION` code); both were corrected before the final suite and no
  production source changed for them.
- Four persisted P3.5 mutants cover transactional rollback-hook bypass,
  duplicate-identity mapping bypass, sequence-1 ledger corruption, and hidden
  open variance. The final ephemeral cumulative Phase 3 mutation run killed
  **60/60 (100%)**, exit 0. The runner verifies the exact pre-mutation SHA-256
  is restored after every mutant.
- Focused ESLint over the service, frozen and hardening tests, shared fixture,
  and mutation runner exited 0 with zero warnings. Browser syntax checking for
  `mbt-assets.js` exited 0. The shared full `typecheck:mbt` run currently has no
  diagnostic in a P3.5-owned file; it remains nonzero only on concurrently
  edited customer/local-master/router seams and is not misreported as a global
  typecheck pass. This is packet GREEN, not a Phase 3 completion or deployment
  claim; the final fresh P3 gauntlet remains the completion authority.

### P3.6 rate-card configuration and pure calculator RED — 2026-08-03

- Assertions are frozen after the observed RED. The executable inventory is
  **22 assertions** across six new files: five exact unit calculations, three
  1,000-example property contracts, six transactional configuration contracts,
  two 25-repetition concurrency contracts, three live-session HTTP contracts,
  and three static browser/accessibility contracts. The property and race
  counts are part of the frozen GREEN contract; RED stops at the intentionally
  absent production exports before those loops execute.
- The exact focused command used `node --test --test-concurrency=1
  --test-reporter=dot` over `unit/local-rate-calculator.test.js`,
  `property/local-rate-calculator.property.test.js`,
  `integration/rate-card-configuration.test.js`,
  `concurrency/rate-card-configuration-races.test.js`,
  `integration/rate-card-configuration-http.test.js`, and
  `unit/rate-card-page-contract.test.js` in the isolated
  `mbbs-mbt-p34-test` Compose project. Observed result: **0 passed / 22 failed**,
  exit 1, rendered as exactly 22 `X` markers.
- Failure attribution was exact: five unit plus three property assertions
  stopped at missing `local-rate-calculator` exports; six integration plus two
  concurrency assertions stopped at missing `rate-card-configuration-service`
  exports; all three HTTP assertions saw the intended absent-route `404`; and
  the three browser assertions reached missing lifecycle controls, explicit
  cents/metres multi-file editing, and active-input focus preservation. There
  was no collection, syntax, fixture, database, timeout, or external-system
  failure.
- Before the frozen RED, focused ESLint over all six new files found one
  test-only `no-shadow` name collision with Node's imported `after` hook. That
  local variable was renamed before assertions were frozen. The subsequent
  focused ESLint exited 0; `git diff --check` exited 0; and the full
  `npm run typecheck:mbt` exited 0. No production assertion was weakened to
  obtain RED.
- The reusable P1 rate-band/rate-lifecycle control remained **30/30 passing**
  before RED. This packet changed only tests and append-only documentation: no
  production calculator/service/router/server/sidebar/UI source, migration,
  dependency, flag, deployment, restart, SCM, Dispatch, Driver, or Operator
  behavior changed. All rate/customer/site identifiers are synthetic and no
  live NetSuite, customer workbook, network transport, or posting path ran.

### P3.7 Front Desk vertical slice RED — 2026-08-03

- Assertions are frozen after the final observed RED. The executable inventory
  is **10 top-level detectors** plus one reusable synthetic prerequisite
  fixture: six transactional workflow/snapshot assertions in
  `integration/frontdesk-workflow.test.js`, two 25-repetition independent-
  client race assertions in `concurrency/frontdesk-races.test.js`, and two
  accessible lifecycle assertions in `e2e/p3-frontdesk.spec.js`.
- P3-F13 is fixed at canonical active/service-ready pilot search, a server-
  calculated 12,500-metre exact-cent quote, `draft -> issued -> accepted ->
  converted`, one confirmed contract, one ready delivery front leg, one
  explicitly dependent tentative return, one local MBT billing case, exact
  replay, changed-payload conflict, rollback after contract/visit boundaries,
  and no Sales Order chain, deposit, outbox/attempt, reconciliation, ordinary
  order, Dispatch plan, Driver job, or Operator-order delta.
- P3-F14 is fixed at immutable customer/site/rate/template/pricing snapshots,
  an append-only approved extension, mutation of only the unstarted tentative
  return, retained delivery history, exact replay, stale-revision rejection,
  started-return rejection, and 25 two-client amendment races with one winner
  and one stale loser. Each conversion race independently requires one
  contract, two visits, one local case, one receipt/audit, and zero posting
  artifacts.
- Focused service/concurrency command: `node --test --test-concurrency=1
  --test-reporter=spec test/mbt/integration/frontdesk-workflow.test.js
  test/mbt/concurrency/frontdesk-races.test.js` in isolated Compose project
  `mbbs-mbt-p3-frontdesk-red`. Observed result: **0 passed / 8 failed / 0
  cancelled / 0 skipped**, exit 1. Every failure is the explicit missing
  `frontdesk-service.js` operation boundary (`searchFrontdeskCustomers`,
  `createFrontdeskQuote`, or `convertFrontdeskQuote`); there was no collection,
  syntax, fixture, database, timeout, or external-system failure. The frozen
  25-repetition bodies remain unexecuted until GREEN supplies the boundary.
- The disposable database applied migrations 001–112 and 115 from empty state,
  exit 0. A direct execution of `createFrontdeskPrerequisites({ label:
  "fixture-proof" })` succeeded and independently returned `{quotes: 0,
  contracts: 0, outbox: 0}` for its synthetic customer. This proves the RED is
  not hiding invalid fixture SQL or premature quote/posting work.
- Production-shaped desktop Chromium command: `npx playwright test
  test/mbt/e2e/p3-frontdesk.spec.js --config test/playwright.config.mjs
  --project=chromium-desktop`. Observed result: **0 passed / 2 failed**, exit 1.
  Both authenticated tests loaded the real `/mbt/frontdesk` page and failed in
  6.2 seconds at the exact absent-workflow boundary: the accessible `Front
  Desk` heading is missing because the current page still exposes `Front Desk
  foundation`, `Phase 1`, and `Front Desk is not yet operational`. No auth,
  route-fixture, browser-launch, collection, or timeout failure occurred.
- Focused ESLint over all four new files exited 0 with zero warnings, and the
  full `npm run typecheck:mbt` exited 0. This packet changed tests and append-
  only evidence only: no production source, migration, dependency, central
  router/server/sidebar, feature gate, deployment, restart, SCM, Dispatch,
  Driver, Operator, live data, NetSuite transport, or posting behavior changed.

### P3.2–P3.4 configuration and typed Dispatch exits GREEN — 2026-08-03

- The previously frozen configuration/API detectors are GREEN without changing
  their assertions. The canonical customer, customer operations, and Phase 3
  configuration command passed **22/22** on disposable PostgreSQL. The new
  Customer Sync & Import, Materials & Dump Sites, Service Templates, and Rate
  Cards tabs coexist with the established Local Items landing tab; the joint
  old/new static contract passed **7/7**, and all **23/23** established local-
  item plus closed-BIN Dispatch controls passed after the default-tab
  compatibility correction.
- The typed Dispatch Settings RED was observed before implementation: one of
  two frozen UI/route assertions passed, the missing guarded server seam failed,
  and a separate Flatbed base-yard compatibility detector failed. A later
  legacy-client hardening detector reproduced a real split identity
  (`base_yard=12441`, relational yard `3445`) as **4/5** before the repository
  safeguard. No assertion was weakened.
- GREEN adds Type (Flatbed/Bin), BIN slots, 14YD/20YD/40YD capability controls,
  an audit reason, expected revision, and a dedicated Dispatcher-only,
  idempotent, no-store capability command. Ordinary and newly registered
  Flatbed trucks retain the established bulk setup path when Phase 3 gates are
  closed. A new Bin registration first commits a safe Flatbed and only then
  attempts the guarded capability change. Existing Bin changes use optimistic
  revision control before the legacy setup save.
- The shared-yard/migration/truck-race/local-master/Settings command passed
  **19/19**, including 25 two-client capability races and the upgrade/rerun
  rehearsal. A production-shaped HTTP hardening contract first failed on the
  missing no-store header for role-denied responses, then passed **1/1** after
  all role-forbidden responses were made private. It proves live-session role
  checks, closed gates, server-owned actor identity, exact replay, stale
  revision rejection, one audit/history row, and no external transport.
- Established Dispatch fleet/setup, save-coordination, and fleet endpoint
  harnesses passed; the endpoint harness retained all **18** checks. Full Phase
  3 typecheck, focused ESLint, browser-script syntax checks, and
  `git diff --check` exited 0 at this checkpoint. No flag was enabled and no
  deployment, restart, live workbook, NetSuite call, SCM, Driver, or Operator
  workflow was performed.

### P3.8 current Dispatch BIN integration RED — 2026-08-03

- Assertions are frozen after the final observed RED. The inventory is **23
  top-level detectors** plus one synthetic fixture: three feed-schema
  assertions in `contracts/mbt-p3.schema.test.js`; four front-leg projection
  assertions in `integration/bin-contract-front-leg.test.js`; eight atomic
  assignment, capability, rollback, and whole-leg move assertions in
  `integration/bin-dispatch-enabled.test.js`; two assignment-race assertions in
  `concurrency/bin-dispatch-enabled-races.test.js`; four advancement/move/
  recovery race assertions in `concurrency/bin-leg-advancement-races.test.js`;
  and two authenticated browser assertions in `e2e/p3-bin-dispatch.spec.js`.
  `support/bin-dispatch-fixtures.js` contains only synthetic Phase 3.8 state.
- P3-F15 is fixed at a server-derived versioned `mbt-bin-dispatch-feed-v1`:
  only the selected-date ready current front service visit is draggable; a
  planned leg remains timeline-only; tentative/future/whole-contract/legacy-SO
  identities cannot enter the pool; search is bounded to contract, customer,
  site, action, asset, and visit identity; the complete ordered mandatory-stop
  route and locked future timeline remain visible; and a later visit cannot
  enter `ready` while its predecessor is nonterminal.
- P3-F16 is fixed at one atomic idempotent command over the plan revision,
  visit revision/state, complete stop group, exact asset reservation, type-Bin
  truck and supported size, shared-yard identity, immutable capability
  snapshot, command receipt, and audit. Flatbed/wrong-asset/stale/closed-pilot
  inputs leave every boundary unchanged; an injected failure immediately after
  reservation rolls everything back. Fifty distinct competitors for the same
  leg/asset must yield one complete winner and 49 deterministic conflicts;
  twenty-five simultaneous exact retries must yield one write and 24 exact
  replays. Ordinary SO/PO/TO/dependency/Driver/Operator/NetSuite counts remain
  unchanged.
- The P3-F16 control also closes a previously uncovered fleet seam required by
  Phase 3 section 4.5: a truck referenced by a future BIN plan cannot become
  Flatbed, and a truck backing an active whole-leg asset reservation cannot
  lose its required type or BIN-size support. Both reject with stable
  `MBT_TRUCK_CAPABILITY_IN_USE` before truck revision, plan snapshot, or
  reservation changes.
- P3-F17 is fixed at transactional whole-leg transfer for unstarted work,
  rejection of partial/deleted/reordered mandatory stops, one revision winner
  under concurrent moves, and a distinct audit-note-required recovery command
  after work starts that durably retains the prior assignment snapshot.
  Twenty-five independent completion-advancement commands must promote the
  explicit successor and refresh the pool exactly once; exact retry replays
  that one outcome; completed and successor legs can never coexist in the
  unassigned pool.
- Focused Node command: `node --test --test-concurrency=1
  --test-reporter=dot` over the contract, two integration, and two concurrency
  files above in disposable Compose project `mbbs-mbt-p35-test`, whose database
  has migrations 001–112 and 115. Final observed result: **0 passed / 21
  failed**, exit 1, rendered as exactly 21 `X` markers. Nineteen failures were
  the intended absent `mbt-p3.schema.json` or `bin-dispatch-service.js`
  operation boundaries; the remaining two were exact `Missing expected
  rejection` evidence that the current truck-capability command does not yet
  protect future BIN plans or active whole-leg reservations.
- Before assertion freeze, the two fleet-control fixtures initially changed a
  truck and inserted its supported BIN type in separate transactions. The
  established deferred coherence trigger correctly raised `55000` between
  those writes. The fixture now performs the same two setup writes in one
  transaction; both tests reach and fail only at the intended missing in-use
  guard. The browser detector's second absent-control wait was also bounded to
  five seconds. No product expectation or pass condition changed.
- Production-shaped desktop Chromium loaded the real authenticated
  `/dispatch/planning` page against synthetic no-store API fixtures. Observed
  result: **0 passed / 2 failed**, exit 1. The first test failed after 5 seconds
  because the current order pool has no accessible `BIN` tab. The second
  successfully entered established Dispatch Edit Mode and obtained its edit
  lease, then failed after 5 seconds at the same absent `BIN` control before
  any drag or mutation. There was no browser-launch, login, page-load, API
  fixture, lease, database, or external-system failure.
- The unchanged control command over `mbt-v1.schema.test.js`,
  `dispatch-bin-safety.test.js`, `dispatch-bin-disabled.test.js`,
  `driver-bin-disabled.test.js`, and `dispatch-assignment-bin-scan.test.js`
  remained **24/24 passing** after RED. It pins disabled BIN save/restore/
  confirm and Driver materialization, ordinary multi-driver projection, and
  the bounded single BIN scan. Focused ESLint over all seven new test/support
  files exited 0 with zero warnings, and `git diff --check` exited 0.
- This packet changed only tests, one test-support fixture, and this append-only
  journal. It did not add migration 113, the P3 schema/service/router/UI, a
  dependency, or any production source; enable a flag; deploy/restart an
  application; import live data; contact NetSuite/Samsara; or alter SCM,
  ordinary Dispatch, Driver, or Operator behavior. GREEN is deliberately not
  implemented in this packet.

### P3.8 current Dispatch BIN integration GREEN — 2026-08-03

- Production is additive and remains behind the independent MBT root,
  `binDispatch`, database, and pilot-scope boundaries. Migration
  `116_mbt_p3_bin_dispatch_operations.sql` adds only Dispatch assignment
  snapshots/history and predecessor-terminal enforcement. The strict
  `mbt-bin-dispatch-feed-v1` contract, server-derived front-leg service,
  no-store routes, isolated BIN order-pool UI, whole-leg drag assignment,
  transfer/recovery, and successor advancement do not enter ordinary order
  allocation or Driver/Operator execution paths. No capability was enabled.
- A fresh disposable PostgreSQL database applied migrations 001 through 117
  from empty state with exit 0. Migration 116 was also executed exactly a
  second time during the GREEN packet and succeeded with only its expected
  idempotent `IF EXISTS` notices. No retained, production, or externally
  connected database was read or changed.
- The frozen P3.8 server packet plus twelve separate post-GREEN boundary tests
  passed **33/33**: three strict schema cases, eighteen front-leg/assignment/
  advancement service and concurrency cases, and twelve hardening cases. The
  hardening set covers malformed/auth/revision boundaries, terminal timelines,
  sparse but valid snapshots, missing canonical records, shared-yard state,
  exact assets, reservation rollback, duplicate stop identity, bounded
  fallbacks, transfer/recovery eligibility, and stale advancement refresh.
- One combined changed-service run passed **30/30** with enforced coverage of
  **99.8% statements, 99.8% lines, 100% functions, and 90.3% branches** for
  `bin-dispatch-service.js`, clearing the configured 95/95/95/90 thresholds.
  The first combined attempt exposed no product failure: independent Node test
  workers randomized synthetic date bases and collided at Dispatch's valid
  one-plan-per-date constraint. Hardening-only dates were moved to a disjoint
  synthetic range; assertions and product behavior were unchanged, and the
  clean-database rerun passed.
- The persisted P3.8 mutation runner killed **6/6 (100%)** mutants covering
  current-leg search isolation, BIN-truck compatibility, exact asset identity,
  post-reservation rollback, whole-leg stop identity, and successor
  eligibility. It restored the exact tested service source SHA-256
  `07ccf1f24fd479bd7337abf6275e22ab5bd37cf1bb32fb2832084d5ee19af358`.
- The strict schema plus established closed-BIN/ordinary Dispatch and Driver
  controls passed **27/27** (**3** P3.8 schema and **24** unchanged controls).
  Production-shaped desktop Chromium passed **2/2**, including an authenticated
  real `/dispatch/planning` render, zero serious/critical axe violations,
  exact visit-command payload, and materialization of every mandatory stop in
  one BIN load.
- Focused ESLint and JavaScript syntax checks passed. The shared full Phase 3
  typecheck has no P3.8-owned diagnostic; it remains nonzero only in concurrent
  P3.9 Driver BIN files. Legacy syntax plus the focused Dispatch save/physical-
  visit, Driver PWA stop, Operator camera/schedule, and SCM navigation harnesses
  all exited 0. `git diff --check` is part of the final packet handoff.
- This GREEN did not deploy or restart the application, commit or push, import
  live data, contact NetSuite/Samsara, activate a feature gate, or mutate SCM,
  ordinary Dispatch, existing Driver, or Operator behavior. P3.8 reserves one
  exact outgoing asset; distinct outgoing/incoming exchange reservations are
  deliberately owned by the following P3.9 Driver packet.

### P3.6 local rate cards and pure shadow-rate calculation GREEN — 2026-08-03

- Production is additive and remains behind the existing MBT root and
  `masterData` environment/database gates. The packet adds a pure exact-cent,
  raw-metre calculator; a local rate-card graph service; Admin/no-store list,
  draft, validate, activate, and clone routes; and an isolated accessible Rate
  Cards configuration panel. Writes use the established server-owned actor,
  idempotency receipt, audit, optimistic revision, and transaction boundaries.
  No feature flag was enabled and no SCM, ordinary Dispatch, Driver, Operator,
  posting, outbox, or external transport path was changed.
- The six frozen RED files and all **22 assertions** remained unchanged. The
  first database GREEN attempt passed **7/8** and exposed a production audit
  invariant defect for a newly created clone: its new audit identity used the
  source revision as `revisionBefore`. Production was corrected to record the
  clone's own `1 -> 1` creation evidence; the rerun passed **8/8**. Exact
  retries therefore retain one result without repeating child inserts or audit
  effects.
- Final combined execution over the frozen 22, the established 30 rate
  controls, and nine separate post-GREEN hardening assertions passed
  **61/61**, exit 0. It includes 3,000 property examples, 25 independent
  two-version activation races, 25 simultaneous exact retries, live HTTP
  authorization/cache/gate checks, static focus/accessibility contracts, and
  immutable used-version controls.
- Post-GREEN hardening first found an uncontrolled malformed distance-band
  object. Production now routes that input through the same allowlisted 400
  validation contract. Two later red results were test-fixture defects only:
  an active fixture omitted its database-required activation timestamp, and a
  synthetic customer ID had not been inserted in the disposable mirror. The
  fixtures were corrected without changing frozen assertions or product
  expectations; the hardening files finished **9/9**.
- Focused changed-module coverage is **99.51% statements, 99.51% lines, 100%
  functions, and 93.71% branches** overall. Individually, the calculator is
  100% statements/lines/functions and 90.52% branches; the configuration
  service is 99.35% statements/lines, 100% functions, and 95.06% branches.
  This clears the Tier-3 95/95/95/90 gates.
- Four persisted P3.6 mutants cover unsafe subtotal accumulation, dump-cost/
  customer-charge conflation, allowlist bypass, and concurrent activation
  conflict bypass. The cumulative ephemeral Phase 3 run killed **64/64
  (100%)**, restoring and verifying the exact source hash after every mutant.
- Focused ESLint and browser-script syntax checks exited 0. The final shared
  `typecheck:mbt` had no P3.6-owned diagnostic; it remained nonzero only in
  concurrently edited `frontdesk-service.js` and
  `master-data-import-service.js`, so it is not represented as a global pass.
  The normalized API accepts one already-aggregated `csv` graph, while the
  five-file UI currently previews selection only; parsing/applying the unified
  CSV bundle remains a separately owned packet rather than a hidden P3.6
  completion claim.
- All identities and data were synthetic and all database work used the
  disposable test stack. No dependency, migration, deployment, restart,
  commit, live workbook/PII access, NetSuite/Samsara request, or external write
  occurred.

### P3.6a five-file rate-card CSV import executable specification — 2026-08-03

- Approval and scope: the parent implementation assignment explicitly approves
  a real server-owned five-file preview/apply workflow. It does not approve a
  dependency, migration, feature activation, deployment, restart, commit,
  external request, or edits outside the isolated rate-card import service,
  dedicated API, and Rate Cards browser controls. Existing manual rate cards,
  generic imports, SCM, Dispatch, Driver, Operator, Front Desk, assets, and
  billing are invariants.
- Exact input: one request must contain exactly `rate_cards`,
  `distance_bands`, `components`, `dump_tariffs`, and `deposit_rules`, each
  named for its matching `.csv` file and containing UTF-8 CSV text. Missing,
  duplicate/extra, wrongly named, individually oversized, collectively
  oversized, malformed, unknown/missing/duplicate-header, or extra-cell input
  fails closed. `rate_cards.csv` has exactly one row; distance bands have at
  least one; the other child files may be header-only. Booleans, nullable and
  required safe integers, positive decimals, ISO times, CAD currency, codes,
  bases, and child relationships are converted exactly once on the server.
- Canonical boundary: the five parsed children are aggregated into the same
  graph accepted by `normalizeLocalRateCardGraph(..., {sourceKind: "csv"})`.
  Client-supplied normalized graphs are never accepted. Permuting file-object
  order or CSV row order cannot change the canonical hash or graph meaning.
- Preview: authenticated Admin plus both closed-by-default `masterData` gates
  are required before parsing. Preview may write only private import-batch and
  staged normalized evidence; it cannot create a rate card/version/child,
  command receipt, domain audit, outbox item, or operational record. The
  no-store response contains a server batch ID, file/hash/revision identities,
  safe row counts, and the validated aggregate graph, never raw CSV bytes.
- Apply: authenticated Admin, the same gates, preview batch, normalized hash,
  target-revision token, nonblank audit reason, and Idempotency-Key are
  required. Under one database transaction and batch lock, apply rechecks the
  preview ownership/status/expiry/hash/target, invokes the established audited
  `applyLocalRateCardDraft` path with `sourceKind: "csv"`, and marks the batch
  applied. Exact retries replay one response. Independent competitors have one
  winner. Any injected failure after draft creation rolls back the draft,
  children, nested/outer receipts and audits, and batch transition together.
- Browser: all five existing file controls must read their bytes, call the
  dedicated server preview, render the returned aggregate evidence, keep Apply
  disabled until a successful preview, then call the dedicated apply endpoint
  with the returned identities, audit reason, and idempotency key. Success
  refreshes the list and selected lifecycle version. Failed preview/apply is
  recoverable and does not disturb editor focus or manual drafting.
- Tier-3 failure model: hostile/unbounded parsing is detected by unit/property
  cases; type drift by table-driven exact conversion failures; client/server
  authority drift by live HTTP spies; preview side effects and partial apply by
  database count/rollback injection; lost idempotency or double creation by
  25-client exact-retry and independent-key races; stale targets by locked
  revision-token checks; vacuous assertions by persisted parser/transaction/
  route/UI mutants; and regression by the complete P3.6 plus established rate
  control suite. No new package is needed: existing bounded CSV, canonical
  hashing, transaction, command/audit, Express, Node test, c8, and ESLint seams
  provide the gauntlet.

### P3.6a five-file rate-card CSV import GREEN — 2026-08-03

- Production now implements the approved dedicated preview/apply boundary.
  Exactly five bounded files are parsed into the canonical local rate graph;
  preview stores one private normalized staged graph without raw bytes or
  domain effects; and apply revalidates actor ownership, status, expiry,
  content hash, target token, and live references before using the established
  audited draft command inside one enclosing transaction.
- The frozen 17 assertions and eight separate adversarial assertions pass
  **25/25**. They include 2,000 property examples, 25 simultaneous exact
  retries, an independent-key race, live Express authorization/no-store
  boundaries, post-draft rollback, hostile envelopes/scalars, staged-evidence
  tampering, changed targets, and translated database conflicts.
- Scoped production coverage is **100% statements, 100% lines, 100%
  functions, and 97.31% branches**. The parser is 100% in all four dimensions;
  the service is 100/100/100/93.05. Four persisted CSV-specific mutants extend
  the cumulative Phase 3 runner to **68/68 killed (100%)** with source hashes
  restored after every run.
- The established rate/manual suite plus this packet passes **86/86**. The
  generic import/router/configuration-page regression set passes **20/20**.
  Focused lint, browser syntax, and whitespace gates pass. Shared typecheck has
  no diagnostic in this packet and is disclosed as nonzero only in concurrently
  developed Driver BIN files. No flag was enabled and no deployment, restart,
  commit, dependency, migration, external request, live import, posting, SCM,
  ordinary Dispatch, Driver, or Operator mutation occurred. Status is
  `AUTOMATED COMPLETE / PILOT PENDING`.

### P3.7 Front Desk vertical slice GREEN — 2026-08-03

- The frozen P3-F13/P3-F14 contract remains unchanged. Production adds only an
  MBT-local Front Desk service, gated router endpoints, isolated browser
  surface, and migration 113's predecessor/conversion constraints. It does not
  alter or call SCM, ordinary Dispatch, Driver, Operator, NetSuite posting, or
  the MBT outbox. The established Phase 1 status response remains byte-for-byte
  compatible while either Front Desk gate is closed.
- Customer search reads active canonical customer/subsidiary/site rows only.
  Quote creation accepts identities and schedule intent, but distance, active
  effective rates, CAD integer cents, tax, and deposits are recomputed from
  server adapters and local configuration. Missing server pricing adapters
  fail closed with `MBT_FRONTDESK_PRICING_UNAVAILABLE`; client display totals
  never become commercial evidence.
- Issue, acceptance, conversion, and extension use authenticated Front Desk or
  Admin identity, audit reason, idempotency receipt, optimistic revision, row
  lock, and one transaction. Conversion creates exactly one confirmed local
  contract, one ready delivery front leg, one predecessor-blocked tentative
  return, and one open unposted local billing case. The return cannot become a
  second independent dispatch job.
- Accepted customer/site/template/rate/tax/pricing evidence is snapshotted.
  Extension appends one approved immutable amendment and may move only the
  unstarted tentative return. Invalid/stale/missing chains and started returns
  fail before partial persistence. Exact retries replay the stored result;
  distinct-key races have one winner.
- The accessible responsive browser flow supports customer search without
  focus loss, quote/issue/accept/convert, an explicit ordered delivery/return
  timeline, and return-window extension. Posting controls are deliberately
  absent. Front Desk remains closed by default and requires both capability
  gates plus real server distance/tax adapters before a named pilot is enabled.
- Frozen Node GREEN: **8/8 passed**, including 25 conversion races and 25
  extension races. Eight post-GREEN adversarial/variant assertions raise the
  combined execution to **16/16 passed** and cover malformed authority/input,
  inactive or mismatched canonical configuration, rate windows, unsafe money,
  stale/expired lifecycle commands, sparse optional evidence, hook rollback,
  and broken visit chains. Frozen Chromium GREEN: **2/2 passed**, including
  zero axe serious/critical findings and mobile overflow checks.
- Focused `c8` over `frontdesk-service.js` clears the Tier-3 gate at **100%
  statements, 100% lines, 100% functions, and 96.8% branches**. A persisted
  writable-ephemeral runner kills **10/10 Front Desk mutants (100%)** covering
  role bypass, missing row locking, configuration/rate/fingerprint/cent guards,
  conversion state, return readiness/predecessor, and cancelled extension.
- Established role/gate/ordinary Dispatch/Driver controls pass **27/27**. A
  separate live Express boundary detector passes **3/3** for authenticated
  no-store reads, capability denial before service execution, server-bound
  actor identity, mandatory idempotency, injected server pricing adapters, and
  all quote/contract route mappings. A full MBT typecheck passed at the
  corrected P3.7 checkpoint. A final shared-
  worktree rerun reported only concurrent P3.5 asset/BIN diagnostics and no
  P3.7 diagnostic; focused ESLint and owned-file whitespace checks are clean.
  All database/browser evidence is synthetic and disposable. No dependency,
  feature activation, deployment, restart, commit, live PII, or external
  request occurred. Status is `AUTOMATED COMPLETE / PILOT PENDING`.

### P3.9 Driver PWA BIN execution RED — 2026-08-03

- Four frozen files define the first P3-F18–P3-F22 server boundary: a synthetic
  assigned-leg fixture, three pure event contracts (including 2,000 generated
  examples), four database integration contracts, and two concurrency
  contracts. They require a versioned complete BIN job, strict outgoing/
  incoming scan identities, complete dump-receipt cents and quantities,
  durable per-requirement photos, dedicated visit/step/evidence/asset
  application, separate device occurrence/server receipt/server application
  times, exact replay, competing-event exclusion, unsafe-snapshot review, and
  zero ordinary-order/NetSuite effects.
- The fresh isolated project `mbbs-mbt-p39-red` migrated 001–116 and ran the
  three test files serially with dot reporting. The observed result was exactly
  **0 passed / 9 failed**, exit 1, rendered as nine `X` markers. All failures
  stopped at the deliberately absent `driver-bin-contract.js` or
  `driver-bin-execution-service.js` exports. There was no database, fixture,
  collection, timeout, browser, or external-system failure.
- Frozen hashes after non-behavioral ESLint formatting are fixture
  `81586d224b980e9d7812135b217a3d82483a2a49a4ee5ce038f1d689fbd2fa87`,
  property
  `adfd1358ab549e477fde173d4c24d95e5254f78ae16a95371306c1f69c4e92d1`,
  integration
  `e693a64111824334422c3060897f16ba8950ace53ced613e0db07cbf1c817d96`,
  and concurrency
  `18ed8ac841179331963082a58b5186eb7aaeba68fb22f652ffbdac49ee8aca6a`.
  No P3.9 production source or migration existed before this RED. Migration
  117 is reserved for the additive Driver BIN application/receipt boundary.

### P3.9 Driver PWA BIN client RED — 2026-08-03

- The frozen client packet adds six pure/static browser-contract assertions and
  two Chromium workflow assertions for P3-F18–P3-F22. It requires strict
  recognition of only `mbt-driver-bin-job-v1`, minimum-client comparison,
  requirement-code-to-asset-role mapping, independent exchange scans, exact
  note/signature/photo evidence, precise dump-receipt cents and quantities,
  partitioned metadata drafts, and shell caching of the BIN client module.
- Driver actions must remain local-first for BIN work even while online: start
  and completion enter the established IndexedDB event/photo ledger and use
  `/api/driver/offline-sync`; neither may call the legacy direct start or photo
  completion endpoint. Airplane-mode input and Blob evidence must survive a
  page reload and synchronize with the original occurrence timestamp after
  reconnect, without performing an offline location request.
- The fresh disposable test image observed **0 passed / 6 failed**. Five tests
  stopped at the deliberately absent `public/driver-bin-ui.js`; the static seam
  failed because that module was absent from Driver HTML/service-worker shell.
  No production Driver client source was changed before this RED. Frozen hashes
  are unit/static
  `35873d8dfec6c75621524931345c3aa6b7605f1262ec1ade9e70cedf848bbc86`
  and Chromium workflow
  `371b4dfb49318f56cbf4444b9f85aa73a583091c7b7c755115e4aab2ef94e1b6`.
- Compatibility clarification discovered at GREEN: the established static
  Driver photo harness had an exact count of two source templates (ordinary
  stop and DVIR). P3-F19 necessarily adds a third, BIN requirement-coded
  camera/gallery template. Its assertion is tightened to require exactly all
  three paths, each retaining the same capture/no-capture semantics; no
  ordinary or DVIR assertion is removed or broadened.

### P3.5a Asset CSV registration executable specification — 2026-08-03

- Approval and isolation: this packet closes the previously disclosed CSV
  registration gap in P3.5. It is additive behind authenticated Admin and the
  existing `assetManagement` capability. It may add only a bounded parser,
  asset-owned preview/apply service, dedicated asset API routes, and functional
  controls on `/mbt/assets`. It must not activate a flag, add a dependency or
  migration, deploy/restart/commit, contact an external system, or alter SCM,
  ordinary Dispatch, Driver, Operator, Front Desk, billing, NetSuite, the
  generic configuration import surface, or established manual asset behavior.
- Server-owned input: the downloadable UTF-8 template has one exact versioned
  header for asset code, optional QR/barcode, exact active bin-type code, exact
  active home-yard code, optional condition/tare/notes, active and maintenance
  flags, and required initial lifecycle/location/time evidence. Uploads are
  parsed only on the server through the established 20 MiB, 50,000-row,
  200-column, 4,000-character-cell, fatal-UTF-8 bounded CSV boundary. Unknown,
  missing, duplicated, malformed, control-character, extra-cell, oversized,
  invalid boolean/decimal/time, duplicate in-file identity, or inactive/unknown
  exact reference input fails closed without a partial result.
- Validator parity: preview resolves codes to the same canonical bin type,
  shared Dispatch yard, condition, and initial location identities used by
  manual registration, then invokes the exact exported manual-registration
  normalizer. Asset code, QR, barcode, required opening lifecycle/location,
  weight bounds, and state invariants therefore cannot drift between manual
  and CSV paths. Yards are referenced, never re-imported or duplicated.
- Dry-run preview: Admin plus the asset gate is authorized before body parsing.
  Preview may create only a private import batch and staged normalized rows. It
  must have zero asset, movement, current-state, command receipt, domain audit,
  outbox, dispatch reservation, or operational effects. The no-store response
  includes safe rows/counts, file/content/staged/target hashes, batch expiry,
  and target revision token, never the raw upload. Batches are actor-owned.
- Atomic apply: apply requires the exact preview batch, hashes/token, nonblank
  audit reason, and Idempotency-Key. In one transaction it locks the batch and
  sorted asset identities, revalidates ownership, expiry, status, staged
  evidence, exact live references and duplicate targets, and invokes the shared
  registration command for every row. Each row creates exactly one asset,
  sequence-1 opening movement, exact current state, receipt, audit, and import
  result. The batch transition and every nested effect roll back together on a
  failure injection. No asset may exist without its opening ledger/state.
- Retry/conflict contract: an exact retry returns the stored response and does
  not repeat any row effect. A changed payload under one idempotency key, a
  stale reference/target revision, a consumed/expired/foreign batch, duplicate
  asset/QR/barcode, or an independent concurrent competitor fails with a stable
  conflict; it cannot silently skip, overwrite, or partially register rows.
- Browser contract: Download template, Preview CSV, preview evidence table,
  audit reason, and Apply controls use only the dedicated server APIs. Apply is
  disabled until a successful preview and is invalidated by file changes.
  Errors are recoverable, manual registration/search focus is preserved, DOM
  rendering is text-safe, and success reloads the existing asset list without
  weakening the legacy list/timeline/manual registration surface.
- Frozen Tier-3 detector: four unit assertions, two 1,000-example property
  assertions, five database integration assertions, two concurrency assertions,
  three live HTTP assertions, and two Chromium assertions must first fail only
  on the absent behavior, then pass unchanged. The GREEN gauntlet also includes
  established asset registration/movement/reservation/reconciliation and asset
  page regression tests, focused 95/95/95/90 coverage, persisted parser/
  transaction/authorization/UI mutants, ESLint/typecheck, and a fresh disposable
  database. All identities and rows are synthetic; no live asset data is read
  or changed.

#### P3.5a frozen RED evidence

- The disposable project `mbbs-mbt-p35a-red` migrated the existing schema
  through 117 without adding migration 118. The five frozen Node files ran
  serially and produced exactly **0 passed / 16 failed**. Unit/property/service
  failures stopped at the deliberately absent parser, manual normalizer, or
  import-service export; the three HTTP failures were the expected 404s for
  absent dedicated routes. There was no fixture, collection, database,
  timeout, migration, or external-system failure.
- The two frozen Chromium assertions produced exactly **0 passed / 2 failed**:
  one could not find the absent Download template link, and one could not find
  the absent server preview evidence body. The existing page, login, private
  list, search input, and synthetic API interception loaded successfully.
- Frozen hashes are support
  `49c48e87e73e3ef5c06bdbff0c79c8f9b38bea68fa90f7bb5ca6c2ace96db9b1`,
  unit `8febe8d40933880cfaeef7e0e5228facda9c1aa6202861d9b8a37b60492145ec`,
  property `e1ec3882c8a445e2d2dec62f6f7a88c2e00715fec50bee6c8e36ef627bcba9b3`,
  integration
  `a298332a9b2d0eda980b6a92c28ada21a5e6338b54d9ee917481ef42e38b09ae`,
  concurrency
  `591fd4c14d3adcc68afe3b5f1fc75f0ffdcc3afc7df665c274b28ba58656b5f3`,
  HTTP `90b44f2bad32a56b4993059e5e3f4856f46b765776b16929a858e6150535e96a`,
  and browser
  `3d8323b735be8eac983f644c45746cfe6320a2fbdd51f3013808c7457a35a466`.
  These assertions are now immutable except for non-behavioral lint/type fixes.

#### P3.5a GREEN evidence

- The additive implementation uses the established Phase-3 asset gate and
  manual-registration normalizer. It adds only a bounded asset CSV parser,
  actor-owned preview/apply service, three dedicated Admin routes, and the
  isolated `/mbt/assets` controls. No migration, external write, feature-flag
  enablement, deployment, restart, or live-data operation was performed.
- The final serial Node detector passed **21/21**: the unchanged behavioral
  detector remains **16/16**, and five separate post-GREEN hardening assertions
  cover missing/incompatible state, byte/stream/filename boundaries, malformed
  actors and command identities, every supported opening location, invalid
  references, and tampered staged/batch evidence. Both property assertions ran
  1,000 generated cases, and both 25-client concurrency assertions passed.
- The final changed-module c8 gate is **99.27% statements, 99.27% lines, 100%
  functions, and 95.67% branches**, above the required 95/95/95/90 thresholds.
  The persisted mutation runners killed **7/7** parser/service/authorization/
  routing mutants and **1/1** browser Apply-without-reason mutant: **8/8
  killed (100%)**.
- Chromium passed **2/2** for template download, exact raw-byte preview,
  evidence rendering, audit-reason gating, atomic apply, search-focus
  retention, mobile overflow, and zero serious/critical axe violations. The
  established registration, movement, reservation, registry HTTP, asset-page,
  and opening-movement reconciliation regressions passed **41/41**. Focused
  ESLint completed with zero warnings and the browser script passed Node syntax
  checking.
- The independently developing P3.10 `pilot-reconciliation.test.js` was also
  attempted in a separately migrated disposable database. Its four assertions
  currently stop in the P3.10 billing fixture before reaching a P3.5a code path
  because that fixture binds a contract to a non-active rate-card version. The
  shared typecheck likewise reaches only current P3.10 calculator diagnostics;
  the P3.10 owner has accepted those failures. They are recorded here rather
  than hidden or changed outside this packet's ownership.
- Current post-lint hashes are support
  `49c48e87e73e3ef5c06bdbff0c79c8f9b38bea68fa90f7bb5ca6c2ace96db9b1`,
  unit `e59a34efe23433eb60a7686da3a5479233818940adf4f3a03fb4c08862610d38`,
  property `e1ec3882c8a445e2d2dec62f6f7a88c2e00715fec50bee6c8e36ef627bcba9b3`,
  integration
  `d4fe86488b22cb5497a6ef2f309a938ffead60f70ca678bb1c347091f8fc5ecb`,
  concurrency
  `591fd4c14d3adcc68afe3b5f1fc75f0ffdcc3afc7df665c274b28ba58656b5f3`,
  HTTP `ce228a695997316de025469f9c5b17fa9e8c7ccee2f8ff8e31d1618d85c0055f`,
  and browser
  `301dbb0b7cc491ce63c00741c280b27c0cead26cd19366d9d5d0ac14c3c7261c`.

### P3.10 reconciliation and local shadow billing executable specification — 2026-08-03

- Approval and scope: the approved Phase 3 plan and the explicit P3.10
  implementation assignment authorize this additive Tier-3 packet. It owns
  migration `118_mbt_p3_reconciliation_shadow_billing.sql`, new P3.10-only
  modules under `src/mbt`, synthetic fixtures and focused tests, and, if the
  shared seams remain conflict-free, gated billing/reconciliation routes and
  the isolated `/mbt/billing` page. It may not enable a flag, add a dependency,
  deploy/restart/commit/push, contact an external system, or alter ordinary
  Smart SCM, Dispatch, Driver, Operator, Returns, Front Desk, or NetSuite
  semantics. Migrations 114–117 are already assigned; 118 is the next additive
  packet number and supersedes the original pre-split migration-114 reservation
  for P3.10 without rewriting any applied file.
- Setup: reuse the exact-pinned Node test runner, PostgreSQL, fast-check, c8,
  TypeScript, ESLint, and existing disposable Compose stack. Add no package and
  perform no external write. Preserve the dirty worktree and identify evidence
  by file hashes because checkpoint commits are not authorized.
- P3-F23 movement comparison: one immutable application snapshot and one
  independently supplied immutable manual snapshot compare exact asset,
  before/after state and location, truck, driver, visit, sequence, and
  occurrence time fields. Exact evidence is `matched`; any mismatch appends an
  `open_variance`. No comparison or resolution can update the movement ledger.
- P3-F24 receipt/distance comparison: receipt ticket, dump site, material,
  weight/quantity, UOM, subtotal, tax, total, and currency compare exactly.
  Distance origin/destination, provider, raw metres, selected band, and charge
  compare exactly. A band or money mismatch is blocking. A raw-distance delta
  greater than `max(2,000 metres, 5% of application metres)` records
  `requiresAuditNote=true`, even when the band is unchanged. Both original
  snapshots and their canonical hashes remain queryable.
- P3-F25 MBT calculator: immutable contract/visit/rate/local-item/distance/
  receipt inputs produce a deterministic ordered `mbt-local-billing-v1`
  result using only safe integer cents and exact six-decimal quantity
  microunits. It supports transport, rental, extension, exchange, pickup,
  surcharge, discount, dump, and local custom-price lines; rejects fractional
  cents, unsafe arithmetic, currency/reference drift, duplicate line keys, and
  a negative subtotal/total; does not mutate its input; and allocates tax by a
  documented deterministic integer rule. Dump customer tariff, actual receipt
  cost, and signed margin are three separately persisted exact-cent values.
- P3-F26 MBBS generator: only completed normalized physical loads qualify. SO
  dedupes by `(root SO, physical load)` so split children count once; TO
  dedupes by root globally and binds to the first stable sorted load; PO and
  VRMA dedupe by `(type, root, physical load)` and share one fee pool per load.
  Allocation sorts by source type then root, divides integer cents evenly, and
  assigns the final remainder to the last stable root. Permuting inputs cannot
  change keys, cases, lines, or allocations, and every pool conserves exactly
  its input cents.
- P3-F27 atomic local approval: calculation/generation writes one complete
  draft version and every line in one transaction before advancing the case.
  Injected failure after the version or any line rolls back the version, all
  lines, case transition, amendment, receipt, and audit. Approval locks the
  current complete draft, performs one allowed immutable `draft -> approved`
  transition, and remains `posting_mode=local_only`. Exact retry replays one
  result; repeated independent-client races have one complete result and no
  partial version. MBT and MBBS paths create zero Sales Order chain, deposit,
  outbox, attempt, notification, posting state, NetSuite adapter, or other
  transport effect.
- P3-F28 audited resolution/correction: a variance resolution is a separate
  immutable decision in `accepted_application`, `accepted_manual`,
  `corrected_application`, `corrected_manual`, or `evidence_only`, with actor,
  nonblank note, decision time, and both snapshot hashes. Corrected application
  decisions require a correction reference. A monetary correction appends an
  amendment/reversal/new billing version linked to the original; the original
  evidence, line, amount, approval, and resolution remain immutable and
  queryable. An unresolved blocking variance prevents local approval.

#### P3.10 frozen detector map and failure model

| Scenario / failure | Frozen primary detector |
|---|---|
| P3-F23 immutable movement comparison and non-rewrite | `integration/pilot-reconciliation.test.js` |
| P3-F24 exact receipt/distance comparison and threshold note | `integration/pilot-reconciliation.test.js` |
| P3-F25 all MBT line kinds, exact tax/dump margin, hostile money | `unit/local-billing-calculator.test.js` |
| Calculator permutation/conservation/input immutability, 1,000 cases each | `property/local-billing-calculator.property.test.js` |
| P3-F26 SO/split-SO/TO/PO/VRMA dedupe and conserved allocation | `integration/shadow-billing.test.js`, property tests |
| Partial draft or amendment survives a thrown boundary | `integration/shadow-billing.test.js` failure injection |
| P3-F27 local approval creates external/posting artifacts | `integration/shadow-billing.test.js` count checks and a fail-fast transport spy |
| Exact/concurrent calculation, generation, and approval duplicate work | `concurrency/shadow-billing-races.test.js`, at least 25 repetitions |
| P3-F28 resolution rewrites originals or loses correction lineage | `integration/pilot-reconciliation.test.js` |
| Gating/auth/cache/server actor drift, if API seam is added | `integration/shadow-billing-http.test.js` |
| Billing queue/review/approval controls regress, if UI seam is added | `unit/billing-page-contract.test.js` |
| Existing financial immutability/local-only protections regress | `integration/immutable-financial-evidence.test.js`, `integration/local-first-schema.test.js` |
| A test is vacuous | focused persisted/manual P3.10 money, allocation, dedupe, lock, rollback, and enqueue mutants |

The RED files and their product assertions are frozen after one focused run in
which every detector reaches only an absent migration/module/route/page
boundary. GREEN may add separate adversarial coverage without editing those
assertions. Final packet evidence must use one fresh reproducible focused
command and report every unavailable broad P3 layer honestly; packet GREEN is
not Phase-3 completion or deployment authorization.

#### P3.10 migration assignment revision — 2026-08-03

- After the exact packet text above was appended and before any P3.10 test or
  product implementation, the coordinating P3.9 owner reserved migration 118
  for its additive Driver BIN asset-state correction. P3.10 therefore owns
  `119_mbt_p3_reconciliation_shadow_billing.sql` and must not create or edit
  migration 118. This visible revision supersedes only the migration number in
  the P3.10 scope paragraph; every behavior, detector, dependency, and negative
  contract remains unchanged.

#### P3.10 completed-load evidence hardening revision — 2026-08-04

- Migration 120 is the additive Driver clock-evidence migration owned by the
  P3.9 packet. The subsequently frozen P3.10 adversarial boundary requires an
  immutable server-owned MBBS completed-load snapshot and activated discount
  rate components, so that additive hardening is assigned to
  `121_mbt_p3_completed_load_snapshots.sql`. Migration 119 remains the original
  reconciliation/shadow-billing schema and is not renumbered or replaced.
- The trusted internal P3-F26 calculator continues to consume normalized
  representative physical-load fixtures. Any public command accepts only
  completed-load snapshot UUIDs, rejects a caller-owned `loads` property, and
  retains the snapshot UUID in the cross-charge source evidence.

#### P3.10 frozen RED evidence — 2026-08-03

- The disposable project `mbbs-mbt-p310-red` applied migrations 001–118 from
  empty state. No P3.10 migration or product module existed. The focused Node
  command ran the five frozen files serially and produced exactly **0 passed /
  21 failed**, rendered as 21 `X` markers: four unit, four 1,000-case property,
  four reconciliation integration, five shadow-billing integration, and four
  25-client concurrency detectors.
- Every final RED failure reached only an absent P3.10 operation export:
  `calculateMbtLocalBilling`, `calculateMbbsCrossCharges`,
  `createPilotReconciliationBatch`, `resolvePilotVariance`,
  `getPilotReconciliationBatch`, `calculateMbtBillingCase`,
  `approveLocalBillingVersion`, or `generateMbbsShadowBilling`. There was no
  collection, syntax, database, timeout, migration, or external-system failure.
- The first authoring run exposed a synthetic fixture defect before assertion
  freeze: it attempted to attach a contract to a draft rate version, and the
  established used-rate trigger correctly rejected it. The fixture now creates
  and activates a separate synthetic card/version before binding the contract.
  No product expectation, assertion, input amount, property count, race count,
  or pass condition changed. The successful prerequisite run above is the RED
  freeze authority.
- Frozen hashes are unit
  `fb7ce411db4bc73a2c7efa6d0f122d8dd6849ba400aaaad7c2e8f0204dc1fd91`,
  property
  `f5160cdfbabd293144bd6772a4a2d2184cccd054079fa4a9b651418e492de991`,
  reconciliation
  `2bb60a5e9ae4cd000bcae49523ada81089fa083bc57e74d61693c70b06688509`,
  shadow integration
  `4659284d315f0d8f63610a173fc1fcba61c34cbb2a23d39f0dbae2c6807d011e`,
  concurrency
  `7f68acb8a34c1fc1aa6dd7d784c20b724d5d0789e419e1098c5f1b1afc007653`,
  and fixture
  `b402639b58bfeafe6c10016883120b4a50f87f09094337927a81da6a47674252`.
  Assertions are now immutable except for non-behavioral lint/type corrections.

#### P3.9 P3-F21/P3-F22 detector-map addendum — 2026-08-03

This append-only addendum supersedes only the two abbreviated detector paths in
the document's opening matrix. P3-F21 loaded pickup/dump/return is verified by
`integration/driver-bin-loaded-exchange.test.js` plus the wrong-customer-site
boundary in `integration/driver-bin-reservation-hardening.test.js`. P3-F22
distinct-asset exchange and ordered physical-stop execution are verified by
`integration/driver-bin-loaded-exchange.test.js`. Both retain
`integration/driver-bin-execution.test.js` as their shared materialization,
offline-time, exact-retry, review, evidence, and rollback detector. Ordinary
one-outgoing reservation compatibility remains mapped to
`concurrency/asset-reservations.test.js` and the P3.8 default-off/control
packet. No acceptance criterion or frozen assertion changed in this addendum.

#### P3.2 supplied-workbook compatibility RED/GREEN addendum — 2026-08-03

- The actual 1,029,973-byte SpreadsheetML file was parsed only inside an
  isolated, network-disabled container, with output restricted to hashes and
  aggregate counts. The first run failed closed before row normalization with
  `MBT_IMPORT_SPREADSHEETML_STRUCTURE_INVALID`; no import or persistence was
  attempted.
- A synthetic frozen detector established the missing benign Microsoft
  `DocumentProperties/Company` element as **1 intended failure** in a **9-case**
  suite. A follow-up RED proved that accepting `Company` at arbitrary XML
  positions was too broad; the production rule now permits it only as a direct
  `DocumentProperties` child. The suite is **9/9 GREEN** while every hostile XML
  detector stays green.
- With the exact hierarchy label, the aggregate preview is 1,262 total, 1,251
  eligible, 10 subsidiary skips, one status skip, 39 eligible incomplete
  entity numbers, 182 eligible blank emails, 2 eligible blank phones, and one
  bounded ampersand repair. A dedicated P3 persisted mutant removes the new
  element and must be killed by the frozen detector. Live apply remains out of
  scope and unauthorized.

#### P3.9 complete-manifest integrity RED/GREEN addendum — 2026-08-03

- Independent adversarial review froze eight detectors covering template
  before/after state, exact exchange location, whole-route ordering, durable
  start-before-complete, pre-manifest occurrence, occurrence older than the
  locked asset state, and active dump/material acceptance. The prerequisite
  run was **0/8 passed** and every detector reached its intended missing
  rejection rather than a fixture/database failure.
- GREEN adds the guards only at the versioned BIN boundary. Complete manifests
  serialize by manifest/driver, validate earlier durable job completions and
  start state, retain manifest/asset clock ordering, lock every exact asset,
  preserve template-owned state/location, and recheck dump acceptance. Exact
  application replay precedes guard evaluation. Partial bootstrap manifests
  and the existing direct-domain harness remain outside the new route/time
  constraints.
- The focused detector command is **8/8 GREEN** and the full serial P3.9 server
  packet is **49/49 GREEN**. Targeted lint passes; Driver-owned types pass. The
  final P3 mutation stage must kill one plausible bypass for each guard before
  automated completion can be claimed.

### P3.11 synthetic local-pilot vertical slice — 2026-08-04

- Approval and scope: the approved Phase 3 plan explicitly authorizes P3.11 in
  a disposable local/test environment. This packet adds synthetic-only
  cross-module integration detectors, a persisted focused mutation runner, and
  the P3.11 evidence packet. It may make only a narrowly BIN-specific fix
  needed by the frozen vertical contract. It may not deploy, restart a live
  container, commit, push, import the supplied customer workbook, enable a
  production flag, contact NetSuite/Samsara, or alter ordinary SCM, Dispatch,
  Driver, Operator, Returns, or accounting behavior. No dependency is added.
- E2E-A detector: `integration/p3-local-pilot-end-to-end.test.js` imports an
  invented canonical customer through the bounded preview/apply boundary,
  hydrates only invented service data, converts an exact 14YD Front Desk quote,
  exposes only its delivery front leg, rejects a Flatbed, assigns a shared-yard
  type-Bin truck and exact asset, persists a complete Driver manifest, queues
  start/scan/photo completion while logically offline, durably resumes it,
  applies the original device occurrence times exactly once, reconciles the
  resulting movement and server-owned distance against independent exact
  manual snapshots, advances only the explicit successor, and calculates then
  locally approves the exact MBT billing lines.
- Successor-window contract: when the delivery has an actual completion time,
  advancement rebases the tentative return start to that instant plus the
  immutable contract `rental_calendar_days`; it preserves the originally
  accepted return-window duration. The successor remains hidden before the
  explicit advancement and is visible only for its rebased plan date after it
  becomes `ready`. If actual completion evidence is absent, the established
  scheduled window remains the fallback.
- E2E-D detector: the same file creates separate immutable, server-owned
  completed-load snapshots for representative split-SO, repeated-TO, and
  shared-load PO/VRMA references. Snapshot-scoped generation twice must retain
  deterministic deduplication and exact-cent allocation, with one durable
  result and no caller-authored load authority.
- Frozen negative contracts: the test snapshots ordinary SO/PO/TO/dependency/
  Operator counts and every NetSuite chain/deposit/outbox/attempt count before
  the slice; all remain byte-for-byte equal afterward. BIN Driver records are
  asserted only for their exact scoped jobs. Every P3 database gate, especially
  `mbt_netsuite_writes`, remains disabled. Transport spies are fail-fast and
  must receive zero calls.
- Failure model: a partial boundary could orphan a quote/visit/reservation,
  replay a Driver movement/evidence/photo, apply reconnect time instead of
  occurrence time, expose both contract legs, calculate from mutable distance,
  lose the accepted four-hour successor window, enqueue external accounting
  work, accept caller-authored cross-charge evidence, or contaminate ordinary
  modules. The vertical detector asserts every retained identity/count/time;
  packet mutation flips the due-date basis, drops rental-day addition, loses
  the preserved duration, disables completed-load source hashing, and enables
  external work. Existing packet-specific rollback, race, browser, auth, and
  full legacy suites remain required layers of the final P3 gauntlet.
- Setup: reuse the pinned Node 20/PostgreSQL/Ajv/fast-check/c8/TypeScript/
  ESLint/Playwright Docker toolchain. Tests use a unique disposable Compose
  project and synthetic `example.invalid` identities only. Frozen test and
  support hashes, observed RED output, GREEN output, mutation kills, and honest
  browser/restart limitations are appended below and copied into
  `docs/mbt/evidence/P3.11.md`.

#### P3.11 vertical confirmation revision — 2026-08-04

- The original synthetic detector used a direct test-only status update after
  the dedicated BIN assignment. That did not exercise the real Dispatch
  confirmation boundary and therefore could not prove that a planned BIN load
  becomes visible to Driver through supported application behavior.
- The revised E2E-A detector must call the exported standard
  `confirmDispatchPlan(planId)` operation after the dedicated, capability-
  authorized BIN assignment. It must observe a confirmed plan at revision 3,
  then obtain the exact two BIN Driver jobs and persist the complete manifest.
- This narrow confirmation path must not permit generic BIN save, restore, or
  caller-authored mutation. The established disabled-operation detectors stay
  frozen: unsupported snapshots still fail with `MBT_CAPABILITY_DISABLED`
  before status, revision, history, reservation, or Driver-visible changes.
- Failure mode added: if standard confirmation evaluates its BIN guard with
  default-false capability inputs, an otherwise valid dedicated assignment is
  stranded in `draft`; Driver sees no plan. The revised vertical test is the
  detector and must first record that exact RED before any runtime repair.

#### P3.11 explicit confirmation-boundary refinement — 2026-08-04

- The GREEN boundary is a dedicated dispatcher BIN confirmation service, not
  an option that weakens `confirmDispatchPlan`. The standard HTTP Confirm route
  may select it only for an unchanged persisted BIN snapshot and only after
  `authorizeMbtPhase3Capability({ capability: "binDispatch",
  pilotAuthorized: true })` derives all environment/database gates plus the
  authenticated live Admin/Dispatcher role. Direct/default repository calls,
  generic save, and restore remain fail-closed.
- Under the existing Dispatch plan transaction/lock, the boundary must compare
  every persisted BIN stop group to the locked visit's server-owned
  `dispatch_assignment_snapshot`: exact plan/load/revisions, one unsplit group,
  exact mandatory stop identities and order, active exact reservation rows,
  and the current type-Bin truck/bin-type/origin-yard capability. Any missing,
  extra, split, released, reassigned, or tampered evidence aborts before plan
  status/revision and Driver load-assignment projection change.
- The revised E2E-A detector calls this explicit service. Focused negative,
  rollback, and race detectors must prove generic/default denial, tamper and
  reservation rejection, atomic rollback, and one successful plan transition.
  The enabled load-assignment projection may opt into BIN jobs only from this
  validated transaction; all existing callers keep the default-false guard.

#### P3.11 confirmation invariant hardening — 2026-08-04

- The dedicated confirmation validator must re-read and lock every authority
  that can change after assignment. For each persisted BIN group it requires
  one exact active, unrevoked, unexpired `mbt_driver_pilot_scope` row matching
  the visit, contract, assigned Driver login/ID, assigned truck, and locked
  plan date. A role-derived capability boolean is not a substitute for this
  server-owned operational allowlist.
- The locked visit must still belong to the plan date, still be the contract's
  sole current front leg, and retain its assignment-time predecessor, visit,
  service-template identity/revision, dump/material, mandatory-stop, and
  reservation evidence. Activated or referenced template versions and their
  children remain database-immutable, but the selected visit-to-template
  identity is still compared to the assignment snapshot.
- Confirmation aggregates every BIN visit group by truck. The exact current
  and snapshotted type-Bin slot capacity must cover the group count; configured
  positive truck weight capacity remains mandatory, while no caller-authored
  weight projection is invented where the service visit has none. Current
  truck/bin-type/yard identity and supported-size evidence are rechecked under
  locks.
- Each active reservation is joined to and locks its current asset master and
  materialized state. The asset must remain active, serviceable, the exact BIN
  type, and in the action-appropriate location: standard delivery reservations
  remain `reserved` at the required own yard, while customer holds remain
  `at_customer` at the exact contract site. A stale physical move, released or
  substituted reservation, or incompatible dump-site/material acceptance
  aborts the whole confirmation.
- The normal authenticated HTTP Confirm request may carry the browser's
  derived `loadId` and `timing` fields on an otherwise unchanged MBT stop.
  Confirm comparison ignores only those two non-authoritative fields for MBT
  stops and never persists the submitted copy, then executes the dedicated
  locked validator over the original persisted snapshot. Any other MBT field,
  order, group, load, truck, or ordinary-plan change still enters the generic
  fail-closed save boundary and cannot be persisted by Confirm.
- Frozen detectors cover missing/wrong/expired pilot scope, date and
  predecessor drift, aggregate slot overflow, stale asset state, rejected dump
  material, exact rollback state, concurrent exact retries, and an actual
  authenticated HTTP/edit-lease Confirm body shaped like the Driver planner.

#### P3.11 established BIN compatibility reconciliation — 2026-08-04

- The later Front Desk-to-Dispatch seam intentionally permits an unbound
  delivery front leg to appear only when the server can offer at least one
  current, serviceable, exact-type asset at the required own yard. The older
  hardening detector that treated every missing `expected_asset_id` as
  incomplete predates that boundary and conflicts with its integration and
  25-client race detectors. Its safety assertion is narrowed without reducing
  protection: a visit with neither exact asset evidence nor any eligible
  server-derived choice must still fail with `MBT_BIN_FRONT_LEG_INCOMPLETE`.
- Successor advancement retains the P3.8 scheduled-time fallback. A valid
  stored successor window is returned unchanged when the completed visit has
  no actual completion timestamp; when that timestamp exists, P3.11 rebases
  the start from the actual occurrence plus `rental_calendar_days` and
  preserves the accepted window duration. Missing or invalid stored schedule
  evidence remains a conflict in both cases.
- The compatibility detector must run alongside the P3.11 actual-time
  vertical detector. A persisted mutation must prove that either replacing an
  available actual occurrence with scheduled time or deleting the no-actual
  fallback is caught before automated completion is claimed.

#### P3.11 standard Dispatch lifecycle gate revision — 2026-08-04

> Superseded before implementation: this broader hypothesis was recorded for
> audit traceability but was rejected because generic save/restore cannot
> reconcile caller-authored snapshots against the authoritative BIN visit,
> assignment, mandatory-stop, reservation, and truck-capability records. None
> of the permissions described in this subsection are authorized or
> implemented. The preceding explicit confirmation-boundary refinement remains
> authoritative: only unchanged persisted BIN confirmation may use the
> dedicated server-validated service; generic save, restore, and direct/default
> confirmation remain fail-closed.

- This append-only revision supersedes only the earlier statement that generic
  BIN save and restore remain permanently disabled. A BIN assignment made by
  the dedicated `/api/mbt/dispatch/assignments` boundary is part of the normal
  Dispatch plan; therefore the authenticated standard Save Now, snapshot
  restore, and Confirm routes may preserve it when and only when the server has
  independently authorized `binDispatch` for that request.
- The repository defaults remain fail-closed. `saveDispatchPlanSnapshot`,
  `restoreDispatchPlanSnapshot`, and `confirmDispatchPlan` must reject a plan
  containing a BIN order or nested MBT stop unless their server-only boundary
  receives all three exact booleans: environment enabled, database enabled,
  and Admin/Dispatcher pilot authorized. Missing, false, partial, or
  caller-authored capability data must not change status, revision, snapshot,
  history, load assignment, or Driver projection state.
- The standard HTTP routes derive the boundary by first detecting BIN identity
  in the canonical candidate/persisted snapshot, then calling the existing
  Phase 3 authorizer with the live authenticated operator role. Browser body
  fields cannot enable it. Non-BIN plans do not call the MBT authorizer and
  retain their established save/restore/confirm behavior while every MBT gate
  is closed.
- An enabled boundary is permission to enter the established Dispatch
  repository path, never a validation bypass. Canonical custom-order handling,
  plan-date/revision checks, edit leases, fleet/driver/load validation,
  dependency checks, snapshot history, and transaction locking remain in
  force. Identical HTTP retries retain the established no-change/revision
  behavior, and stale revisions remain conflicts.
- Frozen detectors cover: ordinary closed-gate save/confirm; every partial BIN
  capability permutation with zero writes; authenticated enabled BIN
  save/restore/confirm through standard HTTP; Sales/unauthenticated rejection;
  canonical/fleet rejection under an enabled gate; and exact revision/no-change
  replay semantics. No dependency, deployment, restart, live flag change,
  external request, or ordinary-module behavior change is authorized.
- Failure model: a broad allow could let a browser forge enablement, let a
  Sales role mutate Dispatch, bypass fleet/canonical validation, or expose BIN
  jobs while a gate is closed; a guard applied to every plan could strand
  ordinary Dispatch when MBT is disabled; a late guard could archive or bump a
  revision before rejection; and an incomplete retry rule could double-bump a
  revision. The repository/HTTP integration packet and manual boundary
  mutations must kill each of these defects.

#### P3.11 independent completed-load dedupe refinement — 2026-08-03

- E2E-D's repeated generation means both an exact idempotency replay and a
  second command with independent idempotency/correlation/request identities
  over the same immutable completed-load snapshot IDs. Both commands must
  return the same deterministic case/version/line identities while the durable
  row counts remain four cases, four draft local-only versions, and four
  lines.
- The earlier exact replay alone could be satisfied entirely by the command
  receipt and therefore did not execute the completed-load dedupe lookup. The
  strengthened detector is regression armor for pre-existing behavior; the
  persisted P3.11 mutation packet must bypass that lookup, observe the detector
  fail, restore the source byte-for-byte, and report the kill separately from
  the completed-load source-hash mutation.

#### P3.11 final automated evidence — 2026-08-04

- A final empty disposable PostgreSQL 18 database applied migrations 001–121
  in order. The consolidated post-mutation contract, integration, adversarial,
  and concurrency packet passed **85/85** with no failure. The narrower
  compatibility packet passed **53/53**, and the expanded BIN service coverage
  packet passed **65/65**.
- Focused c8 for `bin-dispatch-service.js` measured **96.82% statements,
  96.82% lines, 100% functions, and 78.29% aggregate branches**. The branch
  value is not disguised: fail-closed predicates intentionally retain many
  short-circuit combinations, including defensive states excluded by database
  constraints. Semantic mutation and adversarial detectors, rather than
  assertion-free branch-touch tests, are the acceptance authority.
- The persisted P3.11 runner killed **17/17** mutants covering occurrence-time
  authority, successor timing, immutable billing evidence/dedupe, accidental
  transport, exact pilot scope, physical asset state, capacity, plan date,
  dump acceptance, mandatory stops, repository validation, HTTP comparison,
  default-off Driver projection, and default confirmation. Every mutated
  source was restored to its exact pre-run SHA-256.
- Final TypeScript and full MBT ESLint/complexity checks exited 0, as did
  `git diff --check`. Detailed commands, RED history, hashes, limitations, and
  the spec-to-test map are recorded in `docs/mbt/evidence/P3.11.md`.

### P3 final-gauntlet isolation and stale-contract reconciliation — 2026-08-04

- The first complete P3 gauntlet exposed that the main Node invocation reused
  one mutable database across independently authored test files. The approved
  Tier-3 suite-health contract is therefore strengthened: each database-backed
  file runs in its own disposable database cloned from the freshly migrated,
  pristine `mbt_test` template; the clone is force-dropped in `finally`; exact
  isolated host/user/database boundaries remain mandatory; and randomized
  repetitions use the same file-level isolation. This is test infrastructure
  only and must not alter production runtime behavior.
- A focused isolated rerun separated seven shared-state failures from four
  stale fixture/contract assumptions. The frozen product behaviors do not
  change. Missing/expired Driver pilot-scope tests must create a fixture without
  its normally active pilot row. The Front Desk started-return detector must
  first place the predecessor delivery in a terminal state so its successor can
  validly enter `in_progress`; it still requires the extension command to fail
  with `MBT_FRONTDESK_RETURN_STARTED` and no amendment.
- The Phase-1 shell detector is reconciled with the approved Phase-3 isolated
  browser surfaces. Every MBT page must still expose the accessible controlled
  shell, shared stylesheet, authenticated sidebar, and an explicit page
  controller; Configuration and Billing retain `mbt-shell.js`, while Front Desk
  uses its dedicated `mbt-frontdesk.js` controller. No route may pass without a
  recognized controller.
- The schema-109 upgrade rehearsal continues to require bounded lock failure,
  atomic rollback, exact retry, and preservation of all representative legacy
  identities. Its local-item checksum excludes only the `revision` counter
  because the separately approved migration 112 intentionally adds Phase-3
  ownership metadata and advances that counter once; item code, display name,
  category, pricing mode, active state, and all ordinary operator/session/
  truck/driver/Dispatch/SCM evidence remain exact.
- RED evidence: the eleven-file isolated run passed seven files and failed the
  four stale boundaries above. No product assertion may be deleted, skipped,
  broadened to arbitrary scripts, or changed to permit an invalid predecessor
  transition. The repaired harness and its cleanup/fail-closed boundaries must
  receive persisted mutation coverage before final evidence.
- The subsequent 171-file isolated run completed every file and isolated four
  further pre-later-migration contracts. Their product invariants stay frozen:
  direct financial-evidence fixtures must now provide migration 119's required
  deterministic `line_key` and `deduplication_key`; the exact local-item schema
  inventory must include migration 112's three approved ownership/scope
  columns while continuing to reject money, currency, UOM, and NetSuite-item
  duplication; the official migration no-op receipt count must end at the
  current exact migration 121 rather than the earlier packet boundary 109; and
  local-only outbox rejection must assert migration 119's broader canonical
  `mbt_local_only_outbox_work` constraint, which fires before the retained
  Sales-Order-specific defense. These are fixture/contract reconciliations
  only; no migration, repository, runtime guard, posting path, or external
  integration behavior may change.
- Status is **AUTOMATED PACKET COMPLETE / PILOT PENDING**. No deployment,
  restart, live import, external request, posting, feature activation, physical
  mobile pilot, or production data mutation is claimed.

### P3 final-gauntlet coverage reconciliation — 2026-08-04

- The first fresh post-isolation gauntlet passed the 171-file, 840-test main
  packet, all three deterministic shuffled repetitions, TypeScript, ESLint,
  and legacy JavaScript syntax, then correctly stopped at the frozen global
  c8 thresholds: 93.79% lines/statements and 84.37% branches were below the
  required 95% lines/statements and 90% branches. This is the authoritative
  RED result; the thresholds, include set, and existing assertions must not be
  reduced, excluded, ignored, skipped, or otherwise redefined to obtain GREEN.
- Reconciliation is test-only. New detectors must execute real untested Phase-3
  decisions and assert their observable DTO, authorization, validation,
  pagination, idempotency, rollback, immutable-evidence, and fail-closed
  outcomes. Touch-only assertions, broad mocks of the unit under test, c8
  directives, unreachable padding, and production-source changes are not
  authorized by this revision.
- The final acceptance boundary remains one entirely fresh
  `bash tools/mbt-gauntlet.sh P3` run after the last source or test edit. It
  must satisfy the unchanged 95/90/95/95 c8 thresholds, kill every persisted
  P3 mutant, pass the 106 legacy harnesses, pass production-shaped runtime and
  restart checks, validate all three browser profiles and accessibility, leave
  no disposable clone database, and leave every production container's start
  identity unchanged.

### P3 final-gauntlet customer boundary defect reconciliation — 2026-08-04

- The coverage reconciliation produced two genuine RED runtime defects before
  any implementation change. A one-customer snapshot with `netsuiteId: 0`
  bypassed validation because customer identity was checked only by the sort
  comparator, which is not invoked for a one-element array. Every snapshot
  customer must now pass the positive, bigint-safe NetSuite identity validator
  before sorting or paging, regardless of page size or customer count.
- PostgreSQL returns timestamp columns as `Date` values in the real customer
  operations path. Encoding those values with generic `String(...)` produced
  an opaque cursor containing a locale-formatted date that PostgreSQL rejected
  as `timestamptz` on page two. Cursor timestamps must be encoded as ISO-8601
  when the source is a `Date`; scalar identity components retain their exact
  string form. Pagination must return each row once without a 500 response.
- Frozen detectors are the single-record hostile snapshot case and the real
  authenticated HTTP sync-run/conflict page-two requests. They also retain
  authorization, validation, nullable DTO, idempotency, stale-revision,
  append-only audit/receipt, and no-transport assertions. The repair does not
  authorize a feature flag, external request, deployment, live import, or any
  NetSuite/Samsara write.

### P3 final-gauntlet customer boundary defect reconciliation II — 2026-08-04

- Numeric NetSuite identities supplied as JavaScript numbers are accepted only
  when they are safe integers. Converting an already-unsafe number to decimal
  text does not recover its original identity. This boundary applies to direct
  canonical aggregates, signed customer-master event sequences/customer IDs,
  and numeric event cursors; bigint-safe string identities retain their exact
  established support.
- A completed incremental source page may contain zero records when it carries
  a valid high-water cursor. Such a page is an exact canonical-write no-op: the
  run lease is still locked, its cursor and completion evidence advance in the
  same transaction, and the result contains zero counts and no outcomes. The
  existing rejection of empty full-reconciliation snapshots remains unchanged.
- Frozen unit and PostgreSQL integration detectors cover both boundaries. Five
  temporary source mutations independently removed direct aggregate safe-number
  validation, signed-event safe-number validation, one-record snapshot identity
  validation, the empty-incremental no-op branch, and ISO encoding for Date
  cursors. Every mutation was killed by its detector and each source was
  immediately restored to its exact pre-mutation SHA-256. The authoritative
  acceptance result remains the subsequent entirely fresh P3 gauntlet.

### P3 final-gauntlet writable mutation-image reconciliation — 2026-08-04

- The first post-coverage authoritative gauntlet killed the 70/70 persisted
  mutation set, 10/10 Front Desk mutations, 15/15 shadow-billing adversarial
  mutations, 6/6 reconciliation mutations, and the first 13/17 P3.11
  mutations before the P3.11 runner reached a top-level repository source that
  was not writable by the image's unprivileged `node` user. The runner stopped
  with `EACCES` before applying that mutant; this is a disposable test-image
  ownership defect, not an application mutant result.
- Every source root declared by the dedicated Phase-3 mutation manifest must be
  writable by the unprivileged mutation process inside the disposable writable
  mutation image. The production image, production Compose services, runtime
  users, application behavior, feature gates, and external-write boundaries
  must remain unchanged. A frozen infrastructure detector must bind the image
  contract to writable `/app/src`, `/app/public`, `/app/migrations`, and
  `/app/test/support` mutation roots.
- All mutation runners must still restore exact source hashes after every
  mutant and on failure. Acceptance remains a wholly fresh
  `bash tools/mbt-gauntlet.sh P3` after this test-infrastructure edit; partial
  results from the interrupted run cannot be promoted to final evidence.

### P3 final-gauntlet browser lifecycle and current-surface reconciliation — 2026-08-04

- After all Node, coverage, mutation, legacy, production-image, restart, and
  preflight checks passed, the fresh gauntlet exposed two stale browser-harness
  assumptions. The Phase-3 Configuration tab is now visibly named `Local
  Items` (its panel heading remains `Local Item Settings`), and the Phase-3
  Front Desk is a real local-pilot surface whose server gate disables commands;
  it is no longer the Phase-1 zero-control placeholder. Browser assertions must
  bind those current accessible names and continue to prove that closed gates
  disable mutations and that no external posting control exists.
- Playwright intentionally reuses one worker across spec files. A per-file
  `closeDb()` teardown closes the shared imported PostgreSQL pool before the
  next spec, causing `Cannot use a pool after calling end on the pool` and
  hiding later browser coverage. All E2E specs must use one shared automatic
  worker-scoped fixture that closes the pool exactly once in `finally` when the
  worker ends. Individual spec files may clean up only their own rows and must
  never close the shared pool.
- The controlled sidebar inventory includes the Phase-3 Assets surface in
  addition to Front Desk, Billing, and Configuration. Role-scoped link checks
  must prove exact absence/presence for all four paths. These changes are
  browser-test infrastructure and current-contract reconciliation only; no
  application source, role mapping, feature gate, posting path, or production
  runtime behavior is changed.
- Acceptance remains a wholly fresh `bash tools/mbt-gauntlet.sh P3` after the
  final source or test edit. The failed browser result (50 passed, 1 disclosed
  WebKit skip, 15 not run) is retained as RED evidence and is not a completion
  result.

### P3 final-gauntlet browser interaction reconciliation — 2026-08-04

- The first complete 105-case browser-matrix rerun after the shared worker
  lifecycle repair passed 83 cases and the one previously disclosed WebKit
  photo limitation, then exposed 21 current-surface or narrow-viewport harness
  failures. These failures are retained as RED evidence; no timeout, skip,
  browser project, assertion, or application safety gate may be weakened.
- The Local Items page contains both a manual-add form and the selected-item
  editor, so editor assertions must be scoped to the accessible `Edit DUMP`
  region. They must still prove retained focus and the exact single bounded
  update command.
- With the foundation disabled, Front Desk fails closed at the capability
  boundary with the exact rendered message `This MBT capability is disabled.`
  Its command controls must remain disabled and no external posting control may
  exist. Browser readiness and role-surface assertions must bind this actual
  fail-closed state rather than a later unreachable friendly-message branch.
- Dispatch Planning is an explicitly desktop-width board. In the narrow
  Chromium and WebKit projects, pointer hit-testing can place the off-screen
  Edit Mode button underneath the fixed sidebar or order board. The browser
  detector must retain a real pointer click and native `dragTo` on the desktop
  project, while narrow projects activate the same real button through its
  keyboard-accessible control and dispatch the same HTML dragstart/dragover/drop
  event sequence with one shared `DataTransfer`. All projects must still assert
  the exact visit command, idempotency key, asset revision, materialized
  mandatory stops, rerender retention, and absence of a prompt.
- The repair is browser-test reconciliation only. It must not alter Dispatch
  application code, production responsive layout, assignment semantics,
  feature gates, posting behavior, or production containers. Final acceptance
  remains one entirely fresh `bash tools/mbt-gauntlet.sh P3` after the last
  source or test edit.
- GREEN evidence before the authoritative gauntlet: the focused three-spec
  matrix passed **75/75** across desktop Chromium, Android-sized Chromium, and
  iPhone-sized WebKit. The complete seven-spec matrix then passed **104/104
  executable cases**, with only the one already disclosed WebKit IndexedDB
  Blob/File limitation skipped. These focused runs are diagnostic evidence,
  not substitutes for the required final fresh all-layer gauntlet.

### P3 final-gauntlet browser harness lint reconciliation — 2026-08-04

- The next authoritative run passed the main 1,104-test suite and all three
  randomized 1,104-test orderings, then stopped at the unchanged zero-warning
  ESLint gate. It identified one missing brace in the worker fixture and eight
  unqualified browser-global references inside the narrow-viewport drag
  callback. This is retained as RED evidence; the partial run cannot be used
  for acceptance.
- The fixture must retain its exact fail-closed browser-project check with an
  explicit block. The Playwright callback must access `document`, `CSS`,
  `HTMLElement`, `DataTransfer`, and `DragEvent` through `globalThis`, preserving
  the same real DOM elements and drag-event sequence while satisfying the Node
  lint environment without adding globals or suppressions.
- A focused run of the unchanged complete MBT ESLint command passed after this
  repair. No lint rule, browser assertion, timeout, skip, feature gate,
  application source, or production runtime was changed. Final acceptance
  remains one entirely fresh `bash tools/mbt-gauntlet.sh P3` after this last
  test edit.
