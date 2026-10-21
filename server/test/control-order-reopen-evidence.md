# Control order reopening verification

Spec approval: not obtained (autonomous run). Tier 3, scoped to local Operator
progress, authorization, concurrent work and retained evidence.

The release adds Control → Order Reopen and identifies the affected order and
actual progress in PO-link errors, with a named operator only when the evidence
supports that attribution. Reopening clears local quantities and ownership,
preserves ordered lines, assignments, inbound progress, images and history,
and records an immutable correction. Recorded NetSuite transactions, received
cargo, active posting/reload/consolidation and started Driver work remain guarded.

SOA08800 and SOA08801 were inspected read-only. No real order reset was used in
development, testing or release verification. The user will reopen SOA08801.
The retained imported progress diagnosis is preserved in the artifact directory.

Final fresh command: `python3 server/tools/control-order-reopen-20261012/run.py final`

| Layer | Final result |
| --- | --- |
| Feature, browser, concurrency and scoped regressions, including reordered execution | 299/299 pass, 0 fail |
| Same captured live baseline against all 16 regression files | All pass; 0 new failures |
| Changed executable lines, including real browser coverage | 530/530 covered |
| Manual non-equivalent mutants | 9/9 killed |
| Applicable mutants against properties alone | 4/4 killed |
| Type comparison | 22704 existing baseline diagnostics, 22680 current, 0 new |
| Runtime and test lint | 0 new runtime issues, 0 test issues |
| Isolated containers, database storage and networks | Removed; production healthy |

Source state: `244c5bc14ee4b952ebbe00b72f7558b259f702b28d909d1ecb67878de0ebfb81`. Runtime/test hashes are in `summary.json`;
tool versions and verification script hashes are in `tooling-manifest.json`.
No packages were added and no commits were created. The release uses the exact
captured live image plus 16 task overlays; unrelated workspace edits are preserved.

The executable specification is `test/control-order-reopen-spec.md`. Detailed
behavior is exercised in the Control repository/HTTP/local-order integration
tests, operator attribution tests and progress-message properties. Existing
packing-independent PO/TO dependencies, packing-only date planning, pickup
photo gates, yard authorization, consolidation loading, reload photo entry,
posting persistence and Driver reopening are included in the regression set.

Observed RED: 16 new feature assertions failed on the absent baseline feature;
3 message assertions failed; both shared-lock races failed; both attribution
ownership cases failed before their correction. One authorization mutant
initially survived because a foreign-yard rejection masked the role check.
An independent same-yard Operator denial test closed that gap. Original
assertions were retained. Invalid early group/VRMA fixture setup was corrected;
the baseline snapshot now includes every test support file and matrix.

Meaningful properties cover arbitrary local packed/loaded quantities with exact
target/photo conservation, and every member/operator pair in a grouped error.
The loading, packing, photo-loss and name-loss mutants are also killed by these
properties alone. Other mutants exercise authorization, stale previews, retry
safety and real pickup/Driver locks.

Checks intentionally outside this scope: live NetSuite writes and real order
resets (the user requested preservation), exhaustive testing of all unrelated
repository features, and external object-storage byte transfers (existing photo
references and records are retained exactly). No dependency audit was needed
because the dependency set did not change. Existing repository type debt is
reported above; this change adds none. Assertions and changed-line coverage
describe the tested contract rather than every possible business workflow.

Deployment and rollback metadata are retained in
`server/deployments/control-order-reopen-20261012`; live availability, source
hashes and read-only order inspection are recorded in `deployment-result.json`.
