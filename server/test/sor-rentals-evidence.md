# SOR rentals and optional customer signatures — evidence

The approved behavior is in [sor-rentals-spec.md](sor-rentals-spec.md), including
the subsequent requests for editable T&C, a shared Admin preview, and a Driver
button that opens the signing popup. Spec approval: the user requested
“Implement the plan”; the later T&C and popup additions were explicit requests.
This is Tier 3 because reconciliation changes durable operational records and
signature evidence crosses authentication and offline synchronization boundaries.

## Identified source and release

- Workspace task-source hash: `ed8bf500797e3c6fe417d1767c229575ca57c9ff4f988fc08ebc644332736840`.
- Tested/deployed image: `mbbs-operator-app:sor-rentals-20260924-v1`.
- Image ID: `sha256:e8ca312feea3c012da428cbf829b70f9b5c00aa1330e5391e6959b7c16eec1d3`.
- The exact 37 production files are listed in `tools/sor-rentals-files.json`.
  `test-artifacts/sor-rentals/verification.json` records both workspace and
  candidate hashes. The candidate applies only the task delta to the captured
  live image, preserving unrelated live/workspace differences. No commit or
  runtime dependency change was made.
- Private release artifacts and rollback image are retained under
  `/home/ubuntu/operatorapp-deploy-backups/sor-rentals-20260924-v1`.

All final results below were collected after the last production source edit.
Later deployment-tool changes corrected backup table names; they did not change
the application image. Raw logs/results below are relative to
`test-artifacts/sor-rentals/`.

## Acceptance criteria and executable evidence

| Spec | Main verification |
| --- | --- |
| 1: rental hierarchy, daily/monthly names, inventory precedence, equipment overrides, fee exclusion | `test/dispatch/unit/sor-rental-policy.test.js`; table cases and 200 property cases, seed 188 |
| 2: Admin authorization, revision conflicts, source metadata, overrides and audit | `test/dispatch/integration/sor-admin-http.test.js`, `sor-rental-repository.test.js`; actual Admin browser save/reload |
| 3: physical pickup 3445, preserve source Rental 50, notes address, service equipment cargo | policy and repository tests; Admin browser also executes the actual Dispatch cargo predicate; rollout rehearsal |
| 4: one undated local return, eligible quantities only, no Pick-Up/sales-only return | policy, repository and lifecycle tests; 14-order rehearsal and guarded live rollout |
| 5: split suffixes/quantities and groups | policy properties (100 cases, seed 188), repository/lifecycle tests; prior SOB live regression probe |
| 6: repeated/concurrent sync, source edits, assigned review, completed history, billed outstanding returns | `sor-rental-concurrency.test.js`, `sor-return-lifecycle.test.js`; actual server startup/background reconciliation and duplicate-count assertion |
| 7: missing-address guard, plan ahead but collect after delivery, scoped backfill | lifecycle tests; rollout fixture and live pool/assignment-restriction checks |
| 8: optional button/popup, all outbound SOR scopes, cancel/clear/skip | policy signature-scope tests, `sor-signature-evidence.test.js`, `tools/sor-rentals-browser.mjs` |
| 9: online/offline evidence, signer, time, refs, refresh/retry, scope isolation, photo quota | signature integration tests and browser; `tools/sor-rentals-driver-flow.mjs` executes actual online and offline completion APIs |
| 10: authorized history/archive, old-client compatibility, PWA upgrade and other order flows | signature integration, Driver/Dispatch browser rendering, compatibility integration runner, PWA asset/cache checks, baseline comparisons, prior SOB live probe |
| T&C setting and preview addition | actual Admin HTTP/browser tests, shared-popup browser tests, frozen original wording/revision assertions in online and offline completion |

The local return is transport work linked to its source order with no charge.
The implementation reads NetSuite item metadata; it does not create NetSuite
financial returns or credits. Reconciliation writes and catalog refreshes share
a transaction. Migration rollback/reapply and queue error assertions cover
partial-write and silent-failure scenarios.

## Final validation results

| Layer | Result | Evidence / persisted runner |
| --- | --- | --- |
| Focused tests | 32 passed, 0 failed, 0 skipped | `candidate-focused.log`; `tools/sor-rentals-focused.mjs` |
| Full MBT suite | baseline 22/577 files failed; final shuffled run 21/577 failed; zero new failed tests/files | `full-baseline-valid.log`, `full-final-shuffled.log`; `npm run test:mbt`, `MBT_SHUFFLE_SEED=20260924 npm run test:mbt:shuffled` |
| Full Dispatch suite | baseline 29/226 files failed; final 29/232 failed; zero new failed tests/files | `dispatch-baseline.log`, `dispatch-current.log`; `npm run test:dispatch:performance` |
| Types | 163 baseline diagnostics, 163 current, 0 new | `types-*-focused.log`; `tools/sor-rentals-types.sh` |
| Lint | 3,531 baseline diagnostics, 3,531 current, 0 new; new SOR modules clean | `lint-*.json`; `tools/sor-rentals-static.mjs` |
| Coverage | 576/576 measured lines in the nine new JavaScript modules; legacy integration gaps listed below | `coverage/lines.json`, `verification.json`; `tools/sor-rentals-browser-coverage.mjs` |
| Manual mutation | focused suite killed 8/8; property-only suite killed 4/8 | `mutations.json`, `mutant-*.log`; `tools/sor-rentals-mutations.py` |
| Properties | 300 generated classification/content/split cases, seed 188 | policy test; mutation failures include shrunk counterexamples |
| Real browser | Driver popup, drawing, cancel/clear, persistence, offline recovery, frozen T&C, isolation and photo quota passed; actual Admin save/reload/preview passed | `browser-result.json`, `admin-browser-result.json`; browser runners |
| Real completion API | online and offline signed delivery passed; each retains original T&C and two delivery photos; wrong upload scope rejected | `driver-flow-result.json`, `driver-flow.log`; `tools/sor-rentals-driver-flow.mjs` |
| Migration | apply/rollback/reapply passed; original constraints restored; returns initially disabled; four source triggers present | `migration-result.json`; `tools/sor-rentals-migration.mjs` |
| Runtime/reconciliation | actual server start, background queue drain, health 200 and unchanged 14-return count passed | `startup-result.json`; `tools/sor-rentals-startup.mjs` |
| PWA install | cache generation 43, all 19 assets cached together; changed assets share version | `cache-result.json`; `tools/sor-rentals-cache-check.mjs` |
| Built image | exact release image with production dependencies starts; health 200, Admin anonymous 401, shells served | `image-smoke.json`; `tools/sor-rentals-image-smoke.mjs` |
| Rollout rehearsal | 103 metadata items, exactly 14 returns, 2 missing-address restrictions, 0 pending and 0 errors | `rollout-rehearsal.log`; `tools/sor-rentals-rollout-fixture.mjs` |
| Supply chain/secrets | no added runtime dependencies; no high-confidence secret-pattern findings in task delta | `verification.json`; `tools/sor-rentals-evidence.py` |

Eight deliberately broken implementations cover inventory exclusion, Admin
override precedence, mixed-order contents, split identity, completed history,
outstanding returns after billing, metadata synchronization and Driver prompts.
The four database/history/Driver mutants survive the pure property suite and
are killed by integration tests; the property tests do not cover those layers.
Mutants were mounted separately without changing working production source.

Adversarial checks include hostile T&C markup rendered literally, stale Admin
revisions, non-admin writes, empty/oversized signature inputs, cross-driver and
cross-stop evidence, duplicate reconciliation and source edits after assignment.
The completion flow uses the real application, database and APIs, with only the
external durable object-store readback replaced at its boundary. The worker
cache test executes the real worker in a VM with a browser Cache API boundary.

## Reproducing the checks

From `server/`, the entry point is:

```sh
sudo -n python3 tools/sor-rentals-gauntlet.py all
```

This runs the broad baseline/current suites, runtime rehearsals, focused/browser
checks, types, lint, mutations, migration checks and evidence comparison. It
requires the retained baseline snapshot at `test-artifacts/sor-rentals/before`,
the candidate source/release manifest above, the recorded dependency/browser
artifacts, and the isolated test database setup. These captured dirty-workspace
and live-image snapshots cannot be reconstructed from the repository's HEAD
alone; they are retained for this release. The test harness uses an internal
Docker network with external writes disabled and readonly source mounts.

`tools/sor-rentals-test-env.sh start` creates the disposable PostgreSQL network
and database. The focused database is
`mbt_test_file_50a188aabbcc_focus` and must be created and migrated before
`quick`; runtime mode recreates only its two explicitly named fixture databases.
`broad`, `runtime`, `quick` and `evidence` can also run separately. This evidence
does not claim that invoking the entry point bootstraps missing baseline or
dependency artifacts on a fresh clone.

Recorded tools: Node 20.20.2, PostgreSQL 18.4, fast-check 4.9.0, c8 12.0.0,
ESLint 10.8.0, TypeScript 7.0.2, Playwright 1.62.1 (Chromium build 1234).
Docker test image: `mbbs-return-batch-browser-test:20260918`.
No new package installation, Git initialization or checkpoint commit was used.

## Failures resolved and limits

RED logs retain failures for classification, repository/lifecycle behavior,
metadata refresh, split/group projection, reverted-source review, missing
addresses, stale catalog rows, signature capture, offline bootstrap recovery and
PWA version pins. The executable checks exposed and led to fixes for those
behaviors. Existing SOV location-list and PWA asset assertions were updated only
for the explicitly approved Rental location 50 and new asset versions; their
other assertions remain. One metadata query fixture was corrected to select the
sales-order query instead of the preceding location query.

The first live deployment attempt stopped before migration/cutover because its
backup inventory named a nonexistent catalog table. The deployment tool now
backs up the actual catalog entries, state and refresh-outbox tables, uses strict
table-name matching, and checks every table's data entry before cutover.

The first activation was stopped because loading the complete source feed for
each of 135 queued references held the fleet planning lock too long. The scoped
rollout process was terminated; `activation-rollback.log` confirms returns stayed
disabled, no return records committed, all 135 references remained queued without
errors, and its database session closed. The rollout now loads one source
snapshot under the lock, reconciles every reference, then refreshes all affected
catalog references together in the same transaction. This revised procedure was
rehearsed from an empty return database, including All/SO pool and address checks,
before retrying live. The production application image did not change.

The broad suites are not wholly green. Existing failed tests are listed verbatim
in `verification.json` and the raw logs. The unrelated stock-return draft test
has an intermittent expectation about an asynchronous metadata request; its
passing final shuffled run is not claimed as a fix. Types and lint also retain
their recorded baseline diagnostics. No independent formatter was added.

New-module line coverage is 100%; branch coverage and coverage of the whole
change are not 100%. Unexecuted legacy integration lines are explicitly retained:

- `public/dispatch-offline-review.js:2351`
- `public/driver-offline-db.js:1438`
- `src/dispatch-order-catalog-repository.js:245-246`
- `src/server.js:18222,20800-20801,20888-20889,21102-21103`

These are optional legacy endpoint, recovery and duplicate wiring paths; related
core guards and compatibility contracts were exercised, but exhaustive execution
of those paths is a remaining coverage limit. The PWA browser tests use desktop
Chromium touch/pointer emulation, not physical driver phones. There is no new
performance budget or formal complexity measurement; new responsibilities were
separated into policy, repository, queue service, routes, evidence and shared UI
modules. Dependency vulnerability/license auditing was not repeated because the
release changes no dependency. The diff secret scan recognizes selected strong
credential patterns and is not a universal credential detector.

## Deployment and live backfill

The release passed local/public health, 1,040 exact source-file hashes, 15 public
asset hashes, Admin anonymous 401 and unchanged runtime configuration/dependency
checks. The prior SOB fix remains: `GOB-120921S1-121097` has 23 pallets and the
Pick-Up `SOB120921-S2` is excluded from both order-pool paths.

Live activation results are recorded in the release directory's
`rollout-activate.json`, `rollout-check.json`, and `deployment-result.json`, and
the workspace `live-*.log` files. The guarded transaction committed successfully:

- Automatic returns enabled, T&C revision 1, 130 live item-policy records.
- All 135 queued source references reconciled, 0 pending and 0 errors.
- Exactly 14 open, undated, no-charge returns: SOR00151, SOR00165, SOR00169,
  SOR00170, SOR00172, SOR00173, SOR00174, SOR00176, SOR00177, SOR00179,
  SOR00183, SOR00185, SOR00186 and SOR00188, each with `-Return` appended.
- All 14 visible in both SO and All pools. Delivery pickups are 3445 Kennedy
  Road; every return pickup equals its delivery's customer dropoff. SOR00186
  has two eligible items/quantity two; the other returns each have quantity one.
- SOR00183 and SOR00185 have missing customer addresses and remain restricted
  from assignment until corrected.

Post-activation source/assets, health, authentication and prior SOB regression
verification passed at **2026-09-24 04:35:18 UTC**. Admin settings, item overrides,
T&C editor and shared popup preview are available at
`https://test.mbbsoperation.com/admin/sor-auto-returns`.
