# NetSuite-address PO pickup acceptance — evidence

Date: 2026-09-02 UTC

Deployment state: deployed on 2026-09-02 UTC as
`mbbs-operator-app:netsuite-address-pickup-20260902T014107Z`
(`sha256:13f9a9ef3ee387fca1124c994e990c15bf8c52042360fcfb4898b229cd071e96`).

## Diagnosis

- A read-only production audit found `POB03560` mapped to
  `__USE_NETSUITE_ADDRESS__`, with vendor ID `6963`, vendor label
  `Castle Building Centres Group Ltd.#1580`, no configured local vendor yard,
  and no stored schedule pickup override.
- The schedule read model correctly displayed the derived NetSuite vendor
  label, but the older browser save path submitted that display value as if it
  were a newly selected yard.
- Server validation correctly found no configured yard and rejected the whole
  method change with `SCM_PO_PICKUP_YARD_INVALID`.

## RED evidence

- The production-shaped rollback integration first reproduced the exact
  rejection when changing Method from `MBT` to `Vendor` with the visible
  derived pickup in the old full-row payload.
- The frontend contract first showed that an optionless derived pickup was
  still editable and resubmitted.

## Implemented boundary

- A PO with an active canonical NetSuite-address mapping may treat only its
  unchanged canonical vendor label as a cached-client compatibility value.
- The compatibility value is discarded and the stored pickup remains unset;
  it can never become a route override.
- Canonical vendor mapping selection is ID-first, then name fallback, with the
  newest active row winning inside each identity.
- Current clients render optionless PO pickups read-only and omit unchanged PO
  pickup values from save patches.
- Configured-yard changes still validate and persist. Unrelated yards still
  fail atomically with `SCM_PO_PICKUP_YARD_INVALID`.
- The branch is PO-only and does not write PO lines, receipt quantities,
  reconciliation evidence, completion evidence, dispatch plans, or Driver PWA
  state.

## Focused GREEN evidence

- Frontend and property contracts: 10/10 passed, including 600 generated
  policy cases.
- Production-shaped rollback integration: passed with the real
  `Partially Done` state, the old full-row editable fields, no status field,
  unchanged PO reference, unchanged progress, and no stored pickup override.
- The integration also proved atomic rejection of an unrelated yard,
  ID-before-name mapping precedence, and ordinary configured-yard updates.
- Repaired shared-database refresh isolation and the two stale release
  inventories passed in a fresh image.
- The exhaustive MBT suite passed twice from clean test images: 432 files and
  2,158 tests on each run.
- PO Split UI assurance passed with 19 changed statements, 18 changed branches,
  and 18/18 mutants killed.
- Final Schedule changed-line coverage passed all 10 probes; the pickup-specific
  repository checker passed all 5 probes; the isolated policy module reached
  100% statement and branch coverage.
- Final Schedule mutation assurance killed 14/14 mutants, including stale
  universal-completion projection paths. Pickup-specific mutation assurance
  killed 6/6 mutants. Both mutation runners restored their sources.
- The Blanket PO fixture, split receipt allocation, POB03658 split-driver
  lifecycle, and direct-pickup TO terminal-completion regressions passed.
- Final syntax, lint, type, dependency-tree, secret-boundary, and diff-whitespace
  gates passed from the release source tree.

## Release and rollback boundary

- The candidate migration ledger matched production 193/193 with no pending
  migration, so no schema or data migration ran.
- App and webhook worker moved together to the same immutable image in a
  2.08-second Compose cutover. Both were healthy/running with zero restarts.
- The database was not restarted; its start time remained
  `2026-08-14T13:14:47.59677958Z` with zero restarts.
- Source, candidate image, pre-cutover response, and post-cutover response kept
  identical Driver hashes: `driver.html` `9a8703a4...`, `driver.js`
  `e340f82f...`, and `driver-service-worker.js` `02c648a3...`.
- Pre- and post-cutover live POB03560 checks both passed inside always-rolled-back
  transactions: the old full-row payload changed Method to Vendor, kept status
  Partially Done and pickup NULL, preserved the PO reference, and rejected an
  unrelated yard atomically. Production POB03560 remains MBT until the user
  retries and saves the Vendor change.
- The running health and Schedule page returned HTTP 200, and the page served
  the `20260902-netsuite-address-pickup-v1` cache-bust.
- The prior immutable image
  `mbbs-operator-app:global-completion-v4-20260902T002723Z` remains the exact
  app/worker rollback target.
