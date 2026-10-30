# Complete-worktree release evidence — 30 October 2026

User authorization: “deploy all and commit all.” The user confirmed NetSuite
uploads are manual and requested a read-only activation audit. Detailed spec
approval was not obtained; the release followed the autonomous Tier 3 spec.

## Release contents and preservation

The prepared image is `mbbs-operator-app:whole-worktree-20261030`, image ID
`sha256:0c83f97ddc39d01f78e25b33033e873c3ff0eed97f7d953ce59d3bc7e1c10dd6`.
Its manifest covers 1,627 runtime files and has SHA-256
`dad966ccf8cf7bc07971904f4d04c11649d232be1471a9f8f6e2e50424d7d748`.
Dependencies match the deployed lockfile. The build overlays the complete
Dockerfile runtime inputs onto the existing application image without network
access. All 326 local migration filenames were already recorded in production;
no migration is required for this release.

The deployed HTML cache parameters and Driver service-worker cache v56 were
preserved. The release script retains both previous images and private runtime
configuration for rollback. It gates cutover on idle posting/fulfillment/webhook/
driver operations, then checks environment, mounts, commands, ports, resource
limits, all runtime hashes, served assets, and unchanged database/Ollama IDs.

## Regression work

The first complete comparison exposed two new failures. The harness runner
rejected a safe bundled Node test command, and the Sales Order builder added
empty packing columns to ancillary PALLET rows. Both were corrected without
weakening their existing assertions. Packing normalization remains at the
outbound Sales Order transport boundary.

A subsequent full comparison identified an intermittent retry-button fixture
and a stock-check response listener that rejected after browser teardown. Three
paired candidate/production replays reproduced the stock-check failure on
production source. That proof is bound to the unchanged test and runtime hashes.
The retry fixture now retains its mock outage until the actual user click,
preventing a background render from removing the button first. All assertions
remain. The corrected fixture passed, and a no-op retry-handler mutant failed
the expected test. A browser-globals lint annotation was then added; lint passed.

## Focused validation

[Focused results](whole-worktree-deployment-20261030-focused.json): 191 unit and
property tests, 190 passing and one failure also present on production source
(`PO payloads retain existing behavior and independent purchase quantities`).
The reversed-order run had the same result. All five selected database/browser/
worker integration files passed. Syntax, scoped lint and types passed. All seven
manual mutants were killed, including all four property-only mutation probes.

Coverage measured 131 of 132 changed mapped, non-comment lines. The only missed
line was the closing brace at `src/netsuite.js:1270` in an unchanged sales-PDF
wrapper. The changed executable statements in packing and estimate-PDF paths
were covered. Tool versions: Node 20.20.2, c8 12.0.0, TypeScript 7.0.2,
ESLint 10.8.0 and fast-check 4.9.0.

Actual candidate app and worker images both started against disposable migrated
data; both matched all 1,627 runtime hashes. Health returned 200 and the anonymous
operator API returned 401. Both previous production images also passed startup
and the same health/authentication checks against that schema.

## Full comparison and operational completion

The final full comparison passed with no newly failing test cases. All 1,253
candidate files completed: 7,577 tests, 6,987 passing, 588 failing, one cancelled
and one skipped. All 153 failing files were replayed against deployed source:
1,068 tests, 464 passing, 603 failing and one cancelled. Every candidate failure
name matched that fresh replay; the retained earlier stock-check reproduction
was not needed for the final decision. The revised retry file passed all six
cases, and the stock-check file did not fail in this final candidate run.

The first cutover automatically rolled back because an exact environment check
rejected the worker image's additional `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`
default. Original images and settings were restored and health passed. The
verification now permits only that exact default on the worker and still
requires every original environment setting to match. A rebuilt image retained
all 1,627 source hashes and the same dependency base. Its candidate/rollback
startup rehearsal passed, explicitly checking the worker default.

The final cutover succeeded at 2026-10-30T05:04:40.958860+00:00. App and worker both run the image
recorded above. Both matched all 1,627 runtime hashes; all six selected served
assets matched; health returned 200. Existing environment values, mounts,
commands, ports and resource limits were preserved. Database and Ollama
container identities were unchanged. No production migration ran.

The full comparison and all smoke runs removed their test containers, volumes
and networks. Both Docker running/all-container inventories showed only the four
production containers after teardown. The outer runner removed raw logs,
browser output and captured baseline source. Concise reports and private
operational/rollback records are retained separately.

The complete main-worktree source and this evidence are committed together after
staged credential screening. The operational `commit.json` record links the final
commit to the image and verifies all runtime blobs against the Git commit.

### Representative existing failures

The failure count comes from local application tests. In the final candidate
logs, 30 test files contained Chromium's
`chrome_crashpad_handler: --database is required` startup error. Shared setup
errors can cause many individual test cases in one file to fail.

- `special-case-edits-http.test.js:67` and
  `special-header-note-http.test.js:62` require the database hostname
  `mbbs-special-review-db`; the standard disposable Compose runner uses `db`.
  Their setup hooks fail before the application assertions.
- `stock-request-view-browser.test.js` has a mismatched output-directory path;
  `aggregate-request-browser.test.js` passes six cases and then reaches the
  180-second file deadline during completion.
- `split-fulfillment-evidence.test.js:135` expects one enqueued candidate but
  receives zero. `sales-order-null-packs.test.js:87` expects PO packing fields
  to be absent. These also fail against deployed source and remain unresolved.

These examples are not a root-cause diagnosis of every failure. Matching the
deployed-source result checks for newly failing cases; it does not establish
that every existing failure is harmless.

## Reproduction and external status

Run from the repository root with Docker access:

```sh
sudo python3 server/tools/worktree-release-20261030.py prepare
sudo python3 server/tools/worktree-release-20261030.py build
sudo bash server/tools/worktree-release-gauntlet-20261030.sh
```

The dated prepare command is intentionally guarded after deployment. Use the
retained manifest and matching image to audit this release. Full comparisons use
all 1,253 files across two 1.5 GiB/one-CPU test containers, a 1 GiB database, the
shared 4 GiB/two-CPU `mbbs-tests.slice`, per-file database clones and separate
artifact directories. The 180-second file deadline and 30-second cleanup grace
apply equally to candidate and production source; timeouts remain failures.

The outer disposable runner registers teardown and removes its unique artifacts.
Project teardown removes containers, volumes and networks; verification checks
both `docker ps` and `docker ps -a` and production health. Private configuration,
rollback images and operational provenance remain outside Git/test cleanup.

[NetSuite activation audit](../docs/netsuite-deployment-status-20261030.md) records
which scripts are active, outdated, missing or supporting files only. No NetSuite
script or transaction was changed, and remote source contents could not be read
for byte-for-byte comparison.
