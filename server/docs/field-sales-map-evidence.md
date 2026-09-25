# Field Sales map and ward follow-up

Deployed at 2026-09-19 00:12 UTC to `/field-sales/`. The update displays named wards, automatically filters the prospect list to the visible map, and adds individual selection, Select all across pages, and one-command bulk route additions. Existing stops and route form edits are preserved; duplicates and the existing 250-stop limit are checked before saving.

The append-only acceptance criteria are in [the Field Sales specification](../test/field-sales/spec.md). Tier 2; **spec approval: not obtained (autonomous run)**. No dependency, database migration, production test record or NetSuite operation was added.

## Reproduction and source identity

Run `bash server/tools/field-sales-map-test.sh` from the repository root with Docker available, then `python3 server/tools/field-sales-map-evidence.py`. The disposable runner uses the existing pinned `field-sales-check-2941306` image (Node 20.20.2) and isolated PostgreSQL 18; it receives no production credentials or external network access.

Verified runtime SHA-256: `2826bd1e0b5449635f749f476fe75ba9b14d0f99a801b00541da451d7a41a9a8`. Per-file hashes, verification-source hashes and artifact hashes are in `test-artifacts/field-sales/map-followup/evidence.json`.

## Results

- All **69 Field Sales tests passed**, zero failures or skips, including four new planner/helper tests and a seeded 200-case property test.
- All **seven new Chromium scenarios passed**: named wards; viewport/paging/filter preservation; selection across list pages and database persistence; late/failed responses; route capacity and failed selection; unavailable map; multi-page, oversized, incomplete and cancelled selection.
- All **five existing desktop/phone scenarios passed**, including notes, quote PDFs, offline visits/photos, new stops and reconnect/conflict workflows. No uncaught browser errors in either browser runner.
- Frontend/new-test lint passed without warnings. Python deployment compilation and shell syntax checks passed.
- All **three deliberate helper mutants were killed by their named acceptance tests**: duplicate additions, incorrectly rejecting 250 stops, and wrong ward lookup.
- New helper coverage: **14/14 lines, 3/3 functions, 16/17 branches (94.11%)**. Browser V8 coverage for the actual planner modules is recorded separately in `planner-browser-coverage.json`; complete UI branch or changed-line coverage is not claimed.

The first RED run detected absent named wards and the missing map/selection controls. Test fixture corrections (configured visit outcome, opening newly created routes, and waiting until the asynchronous bulk save is enqueued) and the mutation harness correction are explicitly recorded in the specification. Acceptance assertions were retained. Helper tests written after implementation were validated with the deliberate mutants.

Coverage and mutation establish sensitivity for the helper, not every browser interaction. The Google Maps SDK and session response were simulated at the external boundary; the planner, authenticated HTTP endpoints, PostgreSQL, IndexedDB and route persistence were real. No paid Google request was made. Broader unrelated repository suites, new static typing, randomized whole-suite ordering and a dependency audit were not repeated for this four-asset frontend change. Existing shared domain/server code and dependency versions were unchanged; the complete Field Sales suite and existing browser workflows were rerun. The prior broad-suite baseline remains in [the original evidence](field-sales-evidence.md).

## Deployment

`tools/field-sales-map-deploy.py` records preparation, build, apply and verification. The release overlays only `planner.js`, `planner-data.js`, `styles.css` and `service-worker.js` onto the application image that was live at preparation, preserving intervening unrelated releases. It retains that exact image for rollback, checks idle posting/editor queues, validates configuration before cutover, recreates only the app and automatically rolls back on failed verification.

Image: `mbbs-operator-app:field-sales-map-20260919-v2`, ID `sha256:3a275f774e87dc9f0f52614e8ed44e11efef6a71377d482719516d65af941aab`.

**14 live checks passed** across local/public origins: health, all four exact asset hashes, Field Sales entrypoint and anonymous API denial. Service configuration, worker, database and Ollama container identities were preserved. Private release manifests, cutover logs and rollback configuration are retained in `test-artifacts/field-sales/map-deployment-20260919/`.
