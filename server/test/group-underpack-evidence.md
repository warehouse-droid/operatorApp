# Delivery packing rounding — deployed 2026-09-15

**SOB120124+SOB120358 now shows Packed, five lines, underpack_count=0.**
Live verification at **22:07:56 UTC** also confirmed that it is absent from the
active packing list and remains in Packed. The two order headers and every
stored line were identical to the pre-deployment snapshot.

## Cause and change

The affected line requires 93.26 SQFT and has all eight layers packed.
8 × 11.657 = 93.256 SQFT; the old badge treated the 0.004 difference as missing
stock while the line editor correctly showed eight packed layers.

Individual and grouped SO/TO status calculations now recognize converted
rounding remainders within the existing 0.1 sales-unit loading tolerance. The
remainder must also be smaller than a whole package conversion. Unpacked lines,
sales-only shortages and genuinely missing units retain their open quantities.
Group status continues to check each source line, so another member's excess
packing cannot cover a shortage.

Loading, load validation, and server/PWA whole-package conversion compare at
the repository's existing six-decimal precision. This fixes exact 0.1 boundary
errors without increasing the tolerance. The Operator script and service-worker
cache versions were advanced together. No production reconciliation or data
rewrite was needed.

## Replay requested by the user

| Check | Result |
| --- | --- |
| Real delivery sales orders replayed | **1,200** |
| Captured effective Operator lines | **3,072** |
| Group projections replayed | **1,200** |
| Independent Python Decimal oracle mismatches | **0** |
| Active / Packed list rows checked | 67 / 8 |
| Rounding-only corrections | SOB120124: 1 underpacked line → 0 |
| Actual underpacked orders retained | SOM06481, five unpacked lines |
| Stored line changes caused by reads | **0** |

The sample includes current packed orders and recent delivery orders. Its
effective quantities include the existing linked-supply deductions. Production
capture used a repeatable-read, read-only transaction. The replay ran in a
separate PostgreSQL container on an internal network and rolled back its data.

Input SHA-256:
`62489932fa1ecbbc152b17a46968d256aa6e71fbc30195ff70924d60815e7eaf`.

## Final validation

| Layer | Result |
| --- | --- |
| Focused tests, shuffled seed 20260915 | **46 passed**, 10 files |
| PWA quantity properties | **2,000** generated pallet/layer and boundary cases |
| SQL/group properties | **160** generated cases |
| Confirmation/loading properties | **80** generated cases |
| Manual mutation | **9/9 caught** by full focused checks and **9/9** by properties alone |
| Changed executable/configuration lines | **27/27 covered** |
| New rounding module | **100% lines, functions and branches** |
| Type check | Same **233** existing diagnostics; **0 new** |
| Lint | Same **9** existing findings; **0 new** |
| Chromium with actual isolated HTTP responses | Five captured production lines show Packed; removing one layer shows Underpack; no browser errors |
| Production image smoke checks | Passed, including exact conversion boundaries |
| Secret scan / dependencies | Passed; no new dependencies |

The complete MBT run exercised **484 files** against the final runtime code:
2,460 tests passed and five failed. Three failures were exact assertions for the
previous PWA cache version. Only those version literals were updated; all
behavioral assertions were preserved. The three affected files were rerun:
**14 tests passed**. The evidence collector verifies both their passing results
and that the edits changed only the two version strings. There are **zero new
unresolved failures**; these two pre-existing failures remain:

- `P3.12: browser specs share one worker-owned database-pool lifecycle`
- `quality non-regression: the gauntlet builds and validates the omit-dev runtime`

## Acceptance mapping

| Scenario | Verification |
| --- | --- |
| Reported five-line group, batch/detail/list consistency | `mbt/integration/group-underpack.test.js`, real-data browser replay, live read |
| Standalone/grouped SO/TO and partially loaded quantities | Integration tests and 1,200-order replay |
| Missing units, sales-only fractions, overpacking and member isolation | Integration controls plus SQL/group properties |
| Whole PLT/LYR without fractional leftovers | `mbt/unit/group-underpack-ui.test.js`, Chromium boundary assertions |
| Exact tolerance during confirmation/loading | `dispatch/property/group-underpack-boundary.property.test.js` and integration boundaries |
| PWA update and preservation of Driver caches/API bypass | `mbt/unit/operator-yard-assets.test.js` and updated cache contracts |
| Production rows unchanged | Read-only pre/post snapshot equality |

## Deployment and reproduction

App and worker image: **`mbbs-operator-app:group-underpack-20260915-v2`**,
deployed **22:07:04 UTC**. Health and installed hashes passed. Served Operator
HTML, JavaScript and service-worker hashes match the tested release. The latest
independent Dispatch assets were retained and their hashes checked against the
prior live image.

Only these runtime files were layered onto the live image:

- `src/delivery-repository.js`
- `src/delivery-packing-progress.js`
- `public/operator.js`
- `public/operator.html`
- `public/service-worker.js`

Reproduce the checks with `bash server/tools/group-underpack-gauntlet.sh`.
It uses the frozen release under `docker/backups/group-underpack-20260915/release`
and the captured replay input. Test tooling: Node 20.20.2, PostgreSQL 18,
Playwright 1.62.1 and the repository's existing fast-check, ESLint and c8.
No packages were installed. Runtime source hashes, individual logs, screenshots,
coverage, mutation results and replay details are in
`server/test-artifacts/group-underpack-20260915/`. The deployment manifest and
prior image/configuration metadata are in the matching Docker backup directory.

## Scope and honest notes

Spec approval: **not obtained (autonomous run)**; the user authorized the fix,
isolated testing and application. The spec is available for review after the
fact. Tier 3 evidence applies to the stated packing behavior, not every possible
inventory or NetSuite workflow.

The replay validates locally cached effective quantities and local confirmation,
loading and display behavior. It does not post to NetSuite or simulate physical
delivery. Production verification was read-only.

The initial regression tests failed on the reported 0.004 residual. Additional
boundary tests then reproduced the 0.1 floating-point errors; these were fixed
and the broader checks rerun. The browser check switched to an existing
browser-enabled image after the default image lacked Chromium, and used Compact
view to display all five lines on one page. No assertions were relaxed to accept
incorrect quantities.
