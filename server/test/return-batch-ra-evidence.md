# Return batch RA repair — 2026-09-18

RB-000004 created **RMAB01506**, NetSuite internal ID **997297**.
NetSuite subsequently recorded a UI cancellation by Warehouse MBBS. The user
explicitly confirmed to keep it cancelled. SR-000004 and PR-000001 now both
report cancelled and retain that same RA identity and visible number.
The header and all four item rows use location 28 (yard 2967).
NetSuite and local history were read back after deployment. All six external-ID
lookups across the batch, stock and pallet references found exactly one RA and
no Credit Memo. A final retry through the pallet record preserved cancellation
and reused the same RA without increasing the creation-attempt count.

Deployed image: `mbbs-operator-app:return-batch-ra-20260918-v5`.
Image ID: `sha256:5d38a3c1951723571ff2f7f7776518007e38ea0d60cc1903ff6d4b5fc22c8c0a`.
Source manifest SHA-256: `602658b1baa82c32b76af1f85a0225cc715e77df7cf90359e711c2b7eb73a4de`.
The release preserves the concurrent operator-topbar deployment and the earlier
stock-line INSERT correction. Additive migrations 203 and 207 retain legacy
record uniqueness and add a separate immutable batch authority.

Specification: [return-batch-ra-spec.md](return-batch-ra-spec.md).
Assurance workflow: old-coder Tier 3. Spec approval was not obtained separately
(autonomous run under the user's explicit requirements).

## What prevented posting

The initial SQL-only release did not contain the afternoon RA work, and legacy
return automation was disabled. RB-000004 consequently had zero NetSuite attempts.
The full repair uncovered two real account constraints that mocked tests had
missed: duplicate `orderLine` keys are rejected during transformation, and RA GET
responses omit `orderLine`. The final implementation keeps one linked stock row,
adds distinct reason rows with source markers, and verifies native Sales Order
links and units using NetSuite's transaction-line links.

There were two creation requests for this incident: the first returned HTTP 400
DUPLICATE_KEYS without creating a record; the corrected request created RMAB01506.
Its ID was retained when readback initially failed. Subsequent recovery read the
same transaction; it did not create a replacement. Stock admission was paused
while resolving the account behavior and restored after successful verification.
All eight stock/pallet RA gates are enabled for the four supported operator yards.
Previously disabled historical batches were not enrolled automatically.

## Live record verification

| Item | Quantity | Reason | Rate | Yard |
| --- | ---: | --- | ---: | --- |
| UNI-WIN60S-1530-DUSK | 18.18 SQFT | R2 | 0 | 2967 |
| UNI-WIN60S-1530-DUSK | 18.18 SQFT | R3 | 0 | 2967 |
| UNI-WIN60S-1530-DUSK | 9.09 SQFT | R4 | 0 | 2967 |
| PALLET | 2 Each | GD | 40 | 2967 |

The zero stock rate matches source SOA08504. The native source link verifies
line 4932267 and sales units 494. Before the UI cancellation, live quota checks
counted 18.18 through NetSuite's native link plus 27.27 locally, totaling 45.45;
9.05 remained returnable from 54.5. That earlier quota observation is retained
in live-history-quota.json. Final personal-history reads expose RMAB01506 and
cancelled on both records. The phone rendering was checked using the actual
cancelled result and final release assets. No local return was automatically voided.

## Verification

| Layer | Result |
| --- | --- |
| Focused return suite | 64/64 pass; repeated in reversed file order; final formatter simplification rechecked with all 5 client tests |
| Built image and production dependencies | 45/45 database tests pass after the last backend change |
| Final UI | 6 browser checks pass, including actual RB-000004 at phone width |
| Generated domain cases | 100 cases, seed 9182026; original SQL regression adds 24 generated samples |
| Concurrency | 12 simultaneous sibling retries create one RA |
| Durability | Lost response, hidden external ID, outer rollback, invalid readback and sibling recovery covered |
| Deliberate faults | 8/8 killed; quantity and yard faults also killed by the property test alone |
| Static checks | Zero new lint or project type errors; strict domain types pass |
| Full workspace suite | 514/528 files pass; same 14 baseline failing files and test names, zero new |
| Live verification | One cancelled RA; all four rows and yard verified; both history references and cancelled statuses verified; sibling retry retains ID and creation-attempt count |
| Health and release identity | Healthy app; deployed hashes match the release manifest |

The full-suite run included the final native-link regression and predates the
last cancellation-preservation adjustment. The latter was checked with the focused
suite, exact-image database tests, deliberate faults and browser checks. The final
formatter simplification was checked with all client tests, static checks and the
browser suite. The full workspace suite was not repeated for those final changes.
No application dependency changes or git commits were made. Browser verification
required a downloaded Chromium binary and OS libraries in a dedicated test image.
PostgreSQL tests used disposable isolated containers; live financial writes were
limited to the requested existing RB-000004 recovery.

Changed instrumented backend lines executed: 510/532. The domain and batch
service execute all functions, with line coverage 95.89% and 94.92% respectively.
Coverage is not complete: remaining gaps are defensive invalid-input and manual
link/recovery branches, listed in `test-artifacts/return-batch-ra/changed-coverage.json`.
Browser code is checked behaviorally rather than included in those coverage counts.
Other receiving yards and standalone returns were tested with network fixtures;
only this requested mixed return was posted to the real account.

## Reproduction and artifacts

Run `bash server/tools/return-batch-ra-gauntlet.sh` using the existing local test
images and Chromium test directory. The runner performs static comparison against
the persisted baseline patch, focused SQL tests, coverage, mutations, browser
checks and the full suite with exact baseline-failure comparison. It does not
write to NetSuite. `STOCK_RETURN_SOURCE_ROOT` can point at the captured release.

The release builder, revision guard, rollback and narrowly scoped live recovery
commands are in `server/tools/return-batch-ra-release.py` and
`server/tools/return-batch-ra-live.mjs`. The latter is streamed to the deployed
container as documented in its header; its original recovery guards now reject
re-creation because this batch already has an attempt and transaction.

Artifacts are under `server/test-artifacts/return-batch-ra/`, including
`manifest.json`, `deployment.json`, `live-verification.json`,
`live-history-final.json`, `live-history-quota.json` (before cancellation),
`netsuite-status-history.json`, `live-rb000004.png`, `static.json`, `mutations.json`,
`coverage/`, `full-summary.json`, and the red/green reproduction logs.

Oracle's [sublist replacement documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1545297048.html)
describes how unmatched rows are added; actual account readback established the
successful split-row behavior here. The [Return Authorization REST reference](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0718011926.html)
provides the record endpoint context. These docs alone did not prove account behavior.
