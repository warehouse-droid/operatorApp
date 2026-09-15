# Map preview persistence — 2026-09-11

Deployed `mbbs-operator-app:map-preview-cache-20260911-v1` to the application and
worker. Runtime image:
`sha256:c42f0a7818626270c797a7b1e09d9c4f371dfb6c14ecd50a91b623567a817f9f`.
This release changes only `public/dispatch.js` and `public/dispatch.html` on top
of the deployed Sales Order cargo fix. No database repair or migration was needed.

## Cause and fix

Google route geometry was already written to the bounded browser cache, but
`hydrateCachedRouteEstimates` had no callers. A normal reload therefore did not
restore the cached preview. Additionally, valid saved travel times caused the
cache lookup to return early even when an older plan lacked map geometry.

Both full planner rendering and incremental planner updates now restore matching
cached estimates. Complete saved timing receives missing cached geometry without
replacing its travel/stay values. Existing complete geometry remains untouched.
Restoration follows each driver's load sequence across trucks so inherited
departure times match before later loads are looked up.

The cache remains browser-local, with the existing count, size and age bounds
(100 entries, 500,000 characters, 30 days). Existing route signatures continue to
check date, stops, departure, toll preference and travel adjustment. A changed
route does not receive an old preview. There are no new provider requests or
plan writes in the restore path. Rendering Google map tiles still uses the
existing browser-map admission; the route calculation itself is reused.

## Verification

Artifacts: `server/test-artifacts/map-preview-persistence/`.

| Check | Result |
| --- | --- |
| New persistence and existing map frontend tests | 16 passed |
| Storage bounds, route duration, stop visits, Maps policy, planner performance and cargo grouping regressions | 45 passed |
| Real Dispatch UI reload case on desktop Chromium, mobile Chromium and mobile WebKit | 3 passed |
| Scoped ESLint and whitespace check | Passed |
| Release file hashes versus tested source | Exact match |
| Live health and script at direct and configured public origins | Passed |

The browser test failed before the fix: after refresh, it showed approximate
geometry despite a saved road route. The passing test performs two manual
calculations, reloads normally, reloads with a timing-only saved plan, and reloads
after changing toll settings. The first two reloads restore the latest road path
and all pins, and the changed route stays approximate. Calculation count remains
two and plan-write count remains zero throughout. Each fresh page receives its
normal browser-map admission. Google SDK and API boundaries are substituted;
there are no paid live requests or operational test writes.

WebKit exposed a test expectation that read the first debounced cache write
before the second write completed. The test now waits for the latest specific
path before capturing its expected value; the full geometry assertion is
unchanged. Final browser output is `browser-final.log`; lint is `lint-final.log`.

Private deployment definitions, baseline assets, source hashes and live checks
are in `docker/backups/map-preview-persistence-20260911/`. Its
`compose.rollback.yml` retains the previous cargo-fix image. The application is
healthy and the worker is running. Existing printer-agent credential warnings
remain outside this change. No test database was created or modified for this
task, and no commit was made.
