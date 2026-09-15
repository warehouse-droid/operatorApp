# Dispatch map redraw and 11-Sep Driver PWA evidence

Status: deployed on 2026-09-11 at 06:07 UTC; public and direct-app post-checks
passed. The user requested deployment before the full regression rerun finished.
That rerun subsequently completed successfully. No commit was made.

## Scope and confidence

Evidence-first Tier 3 checks cover paid-request bounds, hostile provider data,
in-flight route changes, browser redraw, and Driver completion regressions.
Spec approval: not obtained (autonomous run); confidence is bounded by the
acceptance criteria in `dispatch-google-map-redraw-spec.md`, not independent
human review of that specification. The later "deploy first" authorization is
recorded there explicitly.

The fix adds validated road geometry and ordered Google stop coordinates to
the existing Routes response, preserves them in route estimates, and redraws
overlays on the retained map. Refresh is beside Maps Preview; the duplicate
schematic preview is removed. Driver PWA implementation files were unchanged.
No new dependencies, Google APIs, credentials, or migrations were added.

## Reproduction and source identity

Base commit: `36a26ac4c3f76b9fe2bd39fe2773144db0a28ce2` plus this worktree.
The fresh final run is `test-artifacts/google-map-redraw/final-P6myeF/`.
Its source manifest was checked again when the gauntlet finished.

From the repository root, with Docker available:

```sh
bash server/tools/google-map-redraw-gauntlet.sh
```

This repository-only command uses the committed CE94489-derived fixture. To
reproduce the exact three-driver historical replay, retain the private read-only
export and run:

```sh
DRIVER_REPLAY_PLAN_FILE=/app/test-artifacts/google-map-redraw/plan-20260911-readonly.json \
  bash server/tools/google-map-redraw-gauntlet.sh
```

The exact historical dataset is deliberately not committed. The export tool
is `tools/export-driver-plan-replay.mjs`; it uses a read-only transaction and
rolls it back. The full-data run used plan 323, revision 19, dated 2026-09-11,
with six loads across Dao, Li, and Sety. A later live revision is a different
input, not a reproduction of this snapshot.

Toolchain: Node 20.20.2; versions pinned in `package-lock.json`: Playwright
1.62.1, fast-check 4.9.0, ESLint 10.8.0, TypeScript 7.0.2, c8 12.0.0.

| Runtime source | SHA-256 |
|---|---|
| `src/google-maps-gateway.js` | `8f32226fa11a1ae9e23a8054709534f6b14da876e11ea4af151019df29a23e53` |
| `public/dispatch.js` | `863410fe8f2573bd37989e5c70113ed01fc54dfe53b514cf8fe1d92f926a360e` |
| `public/dispatch.html` | `ce131420568fe95fdf8f632b70b219e6e54582291ce9daf8deb04dc71c572d3b` |

## Acceptance criteria to evidence

Paths below are relative to `test/`.

| Spec | Verification | Result |
|---|---|---|
| GMAP-01: one bounded Routes call, no extra geocoding | `mbt/unit/google-maps-route-geometry.red.test.js`; existing Maps usage suite | Pass |
| GMAP-02: geometry-only redraw, same canvas/map/admission | `dispatch/frontend/dispatch-google-map-redraw.red.test.js`; `mbt/e2e/dispatch-google-map-redraw.spec.js` | Pass |
| GMAP-03: coordinate axes, first pin, ordering, distinct vendors | Geometry unit/property tests; CE94489 browser case | Pass |
| GMAP-04: persistence and stale response protection | Cache/serialization and edited-route/date/plan/removed-load frontend cases | Pass |
| GMAP-05: hostile/oversized/mismatched geometry and quota denial | Geometry unit/property tests; approximate/unavailable frontend cases | Pass |
| GMAP-06: one right-aligned header button | CE94489 browser case, 390px preview in all three profiles | Pass |
| GMAP-07: no operational writes or request-driven view reset | Browser write guard; in-flight identity tests; retained-map assertions | Pass |
| GMAP-08: no duplicate schematic preview | CE94489 browser case | Pass |
| GMAP-09: dated Driver completion, photos, advancement and reload | `mbt/e2e/driver-plan-20260911-replay.spec.js` | Pass within isolated boundaries below |

## Final fresh gauntlet

All rows below use the final source state and the single fresh gauntlet entry
point above. Logs are in `final-P6myeF/`; no earlier failed run replaces a case.

| Layer / command inside test container | Result |
|---|---|
| `npm run test:mbt` | 457 files; 2,265 passed, 0 failed, 1 existing opt-in test skipped |
| `npm run test:baseline:mbt:full` | 134/134 legacy harnesses passed |
| `npm run test:google-maps-usage` | 31/31 passed |
| `npm run test:driver-live-route-prefix-lock` | 22/22 passed |
| Focused gateway/frontend/property Node tests | 29/29 passed |
| Reversed focused file order | 18/18 passed |
| Two Playwright specs, three profiles | 12/12 passed; 0 skipped, unexpected, or flaky cases |
| `npm run typecheck:mbt`, compared with archived base | Identical 233 pre-existing diagnostics; 0 new errors, not a clean global typecheck |
| Maps lint plus all new helpers/specs and mutation registration lint | Passed, no warnings |
| Syntax and `git diff --check` | Passed |
| `google-map-redraw-changed-coverage.mjs` | 103/103 changed executable lines: gateway 17/17, Dispatch 86/86 |
| `run-google-map-redraw-mutations.mjs` | 9/9 killed; 5/5 relevant mutants also killed by properties alone; source hashes restored |
| `run-google-maps-usage-mutations.mjs` | 8/8 killed; sources restored |
| Geometry properties | 3 properties × 150 examples, seeds 20260911–20260913; separate exact 5000/5001 boundary case passed |
| Secret scans | No high-confidence findings |

The existing opt-in skip is
`mbbs-cross-charge-route-pricing-v4-migration.test.js`: its dedicated
`MBT_CROSS_CHARGE_MIGRATION_CUTOVER_TEST=1` flag was not enabled. That unrelated
migration cutover was not exercised or claimed; this release has no migrations.

An additional compatibility run of the unchanged
`npm run coverage:google-maps-usage` command also passed on this frozen source:
19 tests; 97.19% statements/lines, 94.11% functions, 76.48% branches. Its log is
`test-artifacts/google-map-redraw/maps-coverage-compatibility.log`. These are
whole-core coverage figures, not substitutes for the changed-line gate.

## Dated Driver replay results

Each row passed on desktop Chromium, mobile Chromium, and iPhone-style WebKit.
The figures are per browser, not aggregated duplicate plan counts.

| Driver | Truck / loads | Logical jobs completed | Uploaded test photos |
|---|---|---:|---:|
| Dao | BC71838 / Loads 1–3 | 8 | 14 |
| Li | CC46868 / Loads 1–2 | 7 | 12 |
| Sety | CE94489 / Load 1 | 7 | 10 |

Per browser: 22 logical jobs, including three travel jobs, and 36 test photos.
Sety's last physical drop completes two grouped logical jobs. All expected job
IDs were checked against persisted completion records. Required-photo buttons
remain disabled before evidence is supplied; next-job progression never returns
a completed earlier job. Started and completed progress survive page reloads.
The online-only disconnected guard was also exercised.

Boundaries: real application authentication, start/completion endpoints, and
database persistence ran in an isolated database. The external photo-storage
boundary returned test-only object references; actual cloud upload durability
was not tested. GPS used the explicit UI override with Samsara disabled. The
snapshot's orders were replayed without cloning NetSuite/inventory mirrors, so
this is not proof of live NetSuite posting or inventory side effects. Service
workers were blocked; installed-device offline behavior was not replayed.
Only the isolated started-at clock was advanced to avoid waiting ten seconds
at every stop. No live driver job was started or completed as a test.

The map browser cases run real Dispatch JavaScript/CSS with the Google SDK and
API boundaries substituted. They prove supplied road geometry is redrawn,
not that real Google map tiles were pixel-tested. A supplemental opt-in live
provider check at 05:28:41 UTC on the same production source returned five legs,
1,322 road-path points, and six ordered coordinates with the three distinct
CE94489 vendor locations. It used one metered Routes request, no extra geocoding,
and no operational writes. `tools/verify-google-route-geometry.mjs` persists that
check; its result is private `real-google-geometry.json`. It was not repeated
during deployment merely to consume another paid request.

## Failures resolved without weakening assertions

Initial behavior-RED runs reproduced missing gateway geometry, failure to
redraw the retained map, dropped persisted geometry, stale response acceptance,
and the unwanted duplicate preview. Existing static harnesses were separately
updated to follow the extracted overlay helper while retaining grouping,
all-order tooltip, hover, and asset-version contracts.

Browser harness fixes used actual sign-in/device identity, an explicit Docker
WebKit network signal, and settled background requests before intentional
reloads. Chromium's keepalive/204 response event is counted as settled because
it does not reliably emit requestfinished. The zero-page-error assertion stayed
intact. Cleanup preserves foreign-key-protected isolated job/arrival audit rows.
The final 12 cases ran together with no substitutions or retries.

Coverage excludes the padded outer function used to extract real frontend
functions; that padding cannot claim execution. Genuine module globals are
counted normally. Coverage exposed the missing geometry-only change-detector
regression, now checked by a dedicated test and a killed mutant. The new
mutation runner was registered in the repository manifest; the original exact
manifest completeness assertion remains intact. TypeScript 7's diagnostic exit
code is handled while still requiring exact baseline/current diagnostic parity.

No dependency audit or license review was added because dependencies did not
change. Adversarial geometry and stale-response tests cover the stated parser
and asynchronous failure modes; no broad production load test or full browser
repository matrix was claimed. The final browser scope is the two affected
specs, not the older whole-release 501-case matrix.

## Deployment and live post-checks

Image: `mbbs-operator-app:map-redraw-20260911-v1`.
Live image identity:
`sha256:c08c029754876b94f83328b0f228e16abaa27d353b77b344bd63811986545079`.
All 874 deployable files matched the worktree; runtime manifest SHA-256:
`16b3f829b005530b3d9b1334f1da7ea4682c04f05f08fe91fef4abaabbffe44c`.

Only app and webhook worker were recreated. Both started at 06:07:38 UTC with
zero restarts during post-checks. The database retained its 2026-08-14 startup
time. The 200ms health observer measured 4.91 seconds unavailable, with a
sample-bounded upper gap of 5.15 seconds, then stable recovery.

A fresh private custom-format database backup passed `pg_restore --list`.
The previous `whole-worktree-20260911-v1` image and an explicit rollback Compose
definition remain available. No pending migrations or active webhook jobs were
found before cutover. Private release definitions, backup, runtime verifier,
and live verifier are in `docker/backups/map-redraw-20260911/`.

Direct-app and public HTTPS checks both passed: health; eight served asset
hashes; Driver, Dispatch, review and Maps usage pages; the new
`20260911-map-geometry-v2` Dispatch asset; protected API boundaries; distinct
browser/server keys; Maps mode `normal` with the existing 4,500 hard limit;
and both catalog and assignment readiness. No keys were printed. No new paid
provider request or operational test mutation was used for these checks.

Normal unchanged startup maintenance reported three global Dispatch CO pickup
metadata repairs and a ready projection with zero remaining backfill. Startup
logs also retain the previously observed invalid-printer-credential 401 polling
warning; this was not suppressed or repaired as part of the map deployment.
There were no other error-pattern lines in the captured app/worker startup
window. This is not a claim that the logs contain no warnings.
