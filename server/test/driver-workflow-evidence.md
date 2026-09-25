# Driver PWA workflow verification — 24 September 2026

Acceptance criteria: [driver-workflow-spec.md](driver-workflow-spec.md).
Spec approval: not obtained (autonomous run under the user's instruction to
check and fix the normal workflow). No dependencies were added.

## Scope and fixes

Playwright drives the actual deployed Driver UI and Express handlers, with only
the three changed browser assets overlaid. It uses fresh drivers, a disposable
PostgreSQL database, an internal Docker network with no published ports, and a
real installed service worker. No production orders or driver records are used.
The photo-store boundary is simulated; it validates signed upload tickets and
stores real JPEG bytes for the application's evidence validation and readback.

The checks found and fixed four problems:

1. Localized instruction display metadata was mistaken for a Dispatch edit,
   forcing an extra tap at an unchanged delivery stop.
2. A same-stop refresh discarded the location verification receipt while
   retaining the accepted override. Completion then required Dispatch review.
   The receipt now survives an unchanged stop, and online overrides obtain a
   receipt when needed. Changed stops clear the receipt and override together.
3. A completion could become applied between reading the server's next stop
   and reading local events. An older response then caused a false stop-change
   warning. A single fresh read now checks that exact case before blocking.
   Actual edits, review-required events and other-device evidence still block.
   When the previous completion is still uploading, Start now uses the existing
   ordered ledger. It no longer reaches the foreground endpoint ahead of the
   previous completion and triggers a 409 response. The local stop starts from
   the first tap; synchronization applies the saved events in order.
4. After an offline reload, Chromium could report online despite failed
   requests. A recovery sync then covered the working route with a hold screen.
   Holds and foreground Start now respect the recorded offline state. An actual
   offline event also releases the visible hold without clearing saved work.

Only `public/driver.js`, `public/driver.html` and
`public/driver-service-worker.js` are released. Cache generation is 44. The
database schema, IndexedDB format, server evidence validation and offline
protocol are unchanged.

## Behavior coverage

| Behavior | Verification |
| --- | --- |
| Login, invalid-password feedback, session retention, route, rest/resume | Real browser actions and real authentication/API |
| Pickup, normal delivery, unsigned SOR delivery, signed SOR delivery | Two complete driver journeys; database receipt assertions |
| Two required photos and optional remarks | Camera/gallery chooser actions, disabled completion until enough photos, stored evidence |
| Optional signature popup and wording | Cancel, reject empty signature, draw, save name, reopen from photo screen, frozen wording in saved record |
| Mobile layout and navigation | 390×844 and 320×568 viewports, actionable completion, history and Back |
| Offline reopen and draft recovery | Actual browser network cut, service worker reload, IndexedDB photo/note recovery |
| Offline work and reconnect | Later stops completed offline; every queued event applied after reconnect |
| Actual route changes still require review | Focused tests for instructions, revision, address, references, phone, media and cross-device evidence |
| Same-stop location receipt and completion timing | Real browser failures preserved; deterministic focused regressions |

## Failure evidence and limits

`test-artifacts/driver-workflow/initial-*`, `location-receipt-red-*` and
`next-stop-race-red-*`, `pending-start-red-*` and `offline-overlay-red-*` preserve browser failures and
traces. `comparison-red.log`, `next-stop-race-unit-red.log` and
`pending-start-unit-red.log` and `offline-overlay-unit-red.log` show regression failures
before their fixes. One initial test assumption was corrected: online-only mode
intentionally disables unfinished ordinary photo/note drafts. Draft recovery is
therefore asserted in offline-enabled mode; both modes verify persisted history.

The older `src/driver-offline-client-harness.js` fails on both the unchanged
deployed image and this candidate with
`Could not isolate duplicate completion evidence repair.` Its baseline and
candidate logs are retained; no clean full-suite result is claimed. Repository
wide type checking, coverage percentages and unrelated suites were not run for
this focused frontend release. Existing ESLint diagnostics are baselined.

Physical camera capture, successful hardware GPS positioning, live Samsara/DVIR,
remote object-store availability and iOS/WebKit are outside this check. Camera
and gallery use the real chooser with a fixture JPEG; the tested GPS path is the
actual unavailable-location warning and explicit override. Test drivers have
Samsara disabled. No live integration writes occur.

## Reproduce

From `/home/ubuntu/apps/operatorApp/server`, with the recorded Docker images and
existing Playwright/Chromium installation available:

```sh
sudo -n python3 tools/driver-workflow-checks.py
sudo -n python3 tools/driver-workflow-env.py reset
sudo -n python3 tools/driver-workflow-env.py run
sudo -n python3 tools/driver-workflow-env.py stop
```

The first command runs nine focused tests, the deployed-baseline ESLint
comparison, and five isolated source mutants. The other commands create, run
and remove only this task's disposable environment. Runner: Node 20.20.2,
Playwright 1.62.1, Chromium build 1234, PostgreSQL 18 Alpine. The application base
image is `mbbs-operator-app:sor-rentals-20260924-v1` at
`sha256:e8ca312feea3c012da428cbf829b70f9b5c00aa1330e5391e6959b7c16eec1d3`.

## Final results

Final browser run finished at `2026-09-24T05:29:26.358Z`. Both journeys passed: 7 stops, 14 required photos and 2 saved customer signatures. All queued events applied, with no review-required events. Page exceptions: 0; API responses at 500 or above: 0. Mobile layout checks: 17.

Focused tests: **9 passed, 0 failed**. Mutation checks: **5/5 killed**, using copied source files; production source was never mutated. ESLint: **0 new diagnostics**. Existing counts were `driver.js` 456 baseline / 455 current, `driver-service-worker.js` 20 baseline / 20 current.

Trace inspection also recorded one nonfatal 404 on the background localized-instructions request while the previous stop was syncing. The cached stop remained usable and the first Start succeeded. This report does not claim zero HTTP errors of every class. Fixture delivery instruction texts were empty; remote translation was not tested.

Artifacts: [browser result](../test-artifacts/driver-workflow/result.json), [online trace](../test-artifacts/driver-workflow/online-trace.zip), [offline trace](../test-artifacts/driver-workflow/offline-trace.zip), [signature popup](../test-artifacts/driver-workflow/signature-popup.png), [small-screen completion](../test-artifacts/driver-workflow/offline-photos-small.png), [focused tests](../test-artifacts/driver-workflow/focused.log), [lint](../test-artifacts/driver-workflow/static.json), [mutations](../test-artifacts/driver-workflow/mutations.json).

Exact asset hashes observed from the test app and verified after deployment:

| Asset | SHA-256 |
| --- | --- |
| `public/driver.js` | `3bccc77de9ca56a6414dc7e0679f2319d26b57065b1061ddeb6633a90a862722` |
| `public/driver.html` | `d0a2a50bc86f380ab037227c2ca66f9450b5088bfc5b90baca573e56bd769f45` |
| `public/driver-service-worker.js` | `57c7a230d477478c6b7f5afbd6abf576bd757bb4aff5ab7a10ab77374b04a4e5` |

## Deployment

Deployed to https://test.mbbsoperation.com at `2026-09-24T05:30:10.544652+00:00`. Image: `mbbs-operator-app:driver-workflow-20260924-v1` (`sha256:9083537a13caa6cb21c24d5c441bbb5144d2e72e95fe746e820d7829b12cfdad`). All 1040 captured source hashes match the candidate, with exactly 3 browser files changed. Local and public health: 200. Anonymous Driver API: 401. Configuration and dependent containers are unchanged. No database migration was applied.

Release command: `sudo -n python3 tools/driver-workflow-deploy.py validate`, followed by `sudo -n python3 tools/driver-workflow-deploy.py apply`. Apply performs health, public asset hash, configuration and complete source verification, with automatic rollback on failure. The previous image is retained as `mbbs-operator-app:rollback-driver-workflow-20260924-v1`. Deployment evidence: [deployment-result.json](../test-artifacts/driver-workflow/deployment-result.json).


The disposable browser/app/database containers and internal test network were removed after verification. Test artifacts and the rollback image were retained.
