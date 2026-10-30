# Linked PCS comparison in sales UOM — 2026-10-26

The reported PALLET line on SOA10762 has 8 EACH ordered and 1 PCS/EACH linked
to a PO. Its zero PCS packing annotation incorrectly blocked the remaining
7 EACH. The shared Operator projection now converts linked PCS into sales
units, using the explicit conversion or a 1:1 EACH alias fallback, and checks
that sales total. Stored sales and PCS representations count once. Real excess
still blocks packing. No production order or allocation quantities are edited.

Spec: [operator-linked-pcs-sales-spec.md](operator-linked-pcs-sales-spec.md).
Tier 3 scope: fulfillment quantity validation. Spec approval: **not obtained
(autonomous run)**. The user requested the fix and supplied the conversion rule;
the executable specification was not independently reviewed.

## Final verification

The fresh verification run completed after the last runtime/test edit. Runtime
SHA-256: `ad71441f9e658fcb5c09dc8c5b6e4a0f049e5e07cdaa58b5e3ca7e6e69a61955`.
Candidate tree: `83db8bd808e385bd005b1d0252013bbe3ef0a406134c379b65eba5c3342890e6`.
Only `src/operator-linked-quantity-domain.js` changes in the release overlay.

| Layer | Result |
| --- | --- |
| Affected suites, 25 files | 140 tests: 137 passed, 3 existing failures, zero new failures, zero skipped |
| Baseline comparison | Same 3 failure names and diagnostics on captured live source and candidate; 20/23 passed on each |
| Focused coverage suite | 25/25 passed; 19/19 changed executable lines covered |
| Types and lint | Passed; no errors or warnings |
| Diff secret scan | Passed |
| New properties | 3 properties, 1,300 generated cases (500 conservation, 500 excess, 300 lifecycle) |
| Manual mutation | 6/6 killed by unit/property tests; 5/6 killed by properties alone |
| Source restoration | 25/25 focused tests passed afterward; runtime hash unchanged |
| Suite ordering | Deterministic shuffle seed `linked-pcs-20261026` |
| Image verification | All 1,507 runtime files match the tested candidate; application import passed |

The unknown-UOM mutant survives the properties because they generate known
conversions; the unit test kills it. The other mutants omit EACH conversion,
ignore the conversion factor, double count PCS and sales, restore the PCS
annotation cap, or disable the sales excess guard.

Toolchain: Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0. No dependencies, schema, gates or commits were added/changed.
The runtime change adds no network, filesystem, process or environment access.

## Spec mapping

| Scenario | Automated evidence | Status |
| --- | --- | --- |
| PCS1 EACH fallback and explicit conversion | `mbt/unit/operator-linked-pcs-sales.test.js`, PCS1 tests | Pass |
| PCS2 conversion to SQFT and complete supply | Same unit file, PCS2 tests | Pass |
| PCS3 PO/TO combination without duplicate counting | Same unit file, PCS3 tests; conservation property | Pass |
| PCS4 excess, hostile values, unknown units and lifecycle | Same unit file, PCS4 tests; excess/lifecycle properties | Pass |
| PCS5 pack/load seven; reject nine atomically; fully linked reference | `mbt/integration/operator-linked-pcs-sales.test.js`, all three tests | Pass |
| PCS6 standalone/batch/group quantities and grouped list behavior | First PCS5 integration test and affected regression suites | Pass, subject to existing CO failures below |

## Existing failures and limits

These unchanged CO failures were reproduced on both source versions without
changing their assertions:

- `generated reference projection conserves each unit and is immutable and idempotent`:
  counterexample `[[[1,0],[1,0],[1,0],[1,0],[1,1]]]`.
- `mode changes and unlink restore the original independent CO requirement`:
  expected `26.125`, actual `0`.
- `replenishment changes to direct pickup when the affected CO cargo is packed`:
  expected `26.125`, actual `0`.

Repository-wide unrelated suites and external NetSuite posting were not run.
UI layout was not changed; no browser visual check was required. Legacy
standalone SQL card counts with missing stored allocation sales quantities were
not added to this scope; the reported allocation stores the correct 1 EACH.
Dependency/license audits were not repeated because dependencies did not change.
No new concurrent writes or migrations were introduced. Existing transaction
tests cover rejection without writes and actual grouped packing/loading.

Before implementation, 11 new unit/property tests and all 3 new integration
tests failed on behavior; the unknown-conversion regression already passed and
is exercised by the killed unknown-UOM mutant. During verification, the new
integration request was corrected from `sales` to the existing `salesQty` API
field, and a local variable was renamed to satisfy lint; assertions were retained.
Harness fixes added readable baseline mounts, baseline public imports and
support for both Node test summary formats. No failing assertion was weakened.

## Reproduction and cleanup

Run the complete gauntlet against the retained operational candidate:

```sh
sudo -n env \
  DISPATCH_SOURCE_RUNTIME="$PWD/server/deployments/operator-linked-pcs-sales-20261026/candidate" \
  DISPATCH_SOURCE_MIGRATIONS="$PWD/server/deployments/operator-linked-pcs-sales-20261026/candidate/migrations" \
  bash docker/run-operator-linked-pcs-checks.sh
```

Run from the repository root. The persisted checks are in
`tools/operator-linked-pcs-checks.mjs`; the release controller is
`tools/operator-linked-pcs-release.py`. Reproduction uses the retained live
baseline and candidate plus the existing test image; deployment copies follow
the host's latest-five retention policy.

Each run registered teardown before creating containers, used the standard
bounded Compose configuration under `mbbs-tests.slice`, and removed its database,
containers, network, generated coverage, logs and temporary source copies through
the disposable retention runner, including failed runs. Source documentation
and deployment/rollback audit records are retained.

## Deployment and live readback

Deployed at **2026-10-26 20:51:39 UTC** as
`mbbs-operator-app:operator-linked-pcs-sales-20261026`, image
`sha256:eb11f84b967d21ae8378d3c20f2697689a9e1bff9d07dbc776758158066fc492`.
Both local and public health returned 200; both protected APIs rejected anonymous
requests. The 1,507-file runtime, configuration, and unchanged dependencies were
verified.

A read-only production transaction confirmed `SOA10760+SOA10762` at `3445`:
PALLET on SOA10762 has 1 linked PCS = 1 EACH, 7 EACH required from the yard,
`linked_quantity_blocked=false`, and no linked-quantity errors. Ordered quantity
remains 8 EACH, and packed/loaded quantities remain zero. Underpack correctly
remains 1 until Operator records the remaining yard packing.

The first attempt automatically rolled back because the inherited verifier
required the entire host to contain only production containers, and another
task started a disposable test during verification. Rollback source,
configuration and dependencies were verified before retrying. This release's
verifier now records separately any running, labeled disposable Compose tests
belonging to independent runs; unknown or stopped extra containers still fail.
All production, runtime, HTTP, configuration and dependency checks remain in
place. The complete gauntlet and image check were rerun before the successful
retry; the figures above are from that final run.

Final cleanup at **20:52:26 UTC** verified exactly the four production containers
in both `docker ps` and `docker ps -a`, no disposable networks/volumes, an empty
artifact-run directory, and healthy production. Concise operational records are
under `server/deployments/operator-linked-pcs-sales-20261026/`:
`validation.json`, `image-check.json`, `deployed.json`, `live-after.json`,
`rollback-audit.json`, `rollback-rebase.json` and `final-cleanup.json`.
