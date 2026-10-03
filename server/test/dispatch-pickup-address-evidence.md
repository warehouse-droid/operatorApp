# SOA09326 pickup override evidence

Tier 2; spec approval not obtained (autonomous run).
Specification: [dispatch-pickup-override-spec.md](dispatch-pickup-override-spec.md).

Read-only production inspection found SOA09326's saved override and catalog
address correctly set to `195 Milner Ave, Scarborough, ON M1S 3R1`, with
inventory source yard `2967`. SOA09464 has no pickup override. The audit of
adding SOA09326 to Aurther / BL27129 / Load 2 showed reuse of SOA09464's
pickup stop, leaving only a new delivery for SOA09326. SOA09326 was then
removed by the operator; there was no saved plan containing it at inspection.

The patch makes physical pickup overrides part of stop reuse and split-target
eligibility in the browser and late-order commands. Save preparation separates
mixed future pickup allocations while protecting the executed route prefix.
SCM reconciliation observes the same rule. The compact card now displays the
override. Logical inventory yards remain unchanged. Same-address orders still
share a pickup; different addresses require separate stops in the load.

Acceptance mapping:

| Behavior | Verification |
| --- | --- |
| Saved address shown on order card | SOA09326 card regression and actual Chromium DOM assertion |
| Add order without inheriting another order's address | SOA09326 regression, browser add/save, scoped Driver jobs |
| Retain yard allocation keys | Both pickups retain `2967`; validator passes |
| Correct an already shared future pickup | Cleanup/sync regression and browser save preparation |
| Same override can share a stop | SCM case-insensitive regression and generated insertion sequences |
| Different overrides cannot share through split/late/SCM | Command and browser split-target regressions |
| Preserve started prefix | Regression and dedicated boundary-removal mutant |
| Conservation and idempotence | 60 generated cases, seed 9326; repeated normalization equality |

Final validation:

- 26 focused tests passed (25 Node tests including 16 existing tests, 1 Chromium test).
- All eight new non-protection Node regressions failed against the captured
  original source. The protection regression passed originally and fails when
  the new prefix guard is removed.
- 60 adjacent tests: 58 passed, the same 2 baseline failures remained.
- Load-assignment harness passed. Pickup-override harness retained its same
  baseline assertion failure about the old `jobLabel` source pattern.
- Five manual mutants killed: hide card override; reuse wrong physical stop;
  retain mixed mutable allocation; ignore backend override matching; remove
  prefix protection. Mutations use temporary source copies.
- Changed executable lines covered: browser 15/15, pickup domain 9/9, SCM 4/4
  (28/28 total). Chromium V8 and Node c8 coverage are combined; the unrelated
  repository-wide MBT coverage threshold is replaced by this changed-line gate.
- ESLint: no new diagnostics against 1,319 existing diagnostics. TypeScript:
  no new diagnostics against 174 normalized unique existing diagnostics.
  New Node regression/check files have no lint diagnostics; browser test has
  syntax and actual Chromium execution checks.
- No dependencies, migrations or new external capabilities in production code.
  No live order/plan writes were used for testing. No staging or commits.

Existing adjacent failures (unchanged):

1. `RP-08 sequence, timing, capacity, labels, and tooltips use visit-scoped orders`
   expects an obsolete Dispatch CSS version.
2. `RP-05 active travel protects its destination while allowing work after it`
   has an existing true/false assertion failure.

Reproduce with `bash tools/dispatch-pickup-address-check.sh` using the existing
`mbbs-bin-planning-test:20260927` image and isolated Postgres 18. Versions:
Node 20.20.2, fast-check 4.9, ESLint 10.8, TypeScript 7.0.2, c8 12,
Playwright 1.62.1. Source hashes and detailed logs are recorded in
`test-artifacts/dispatch-pickup-override/validation.json` and
`test-artifacts/mbt-bin-planning/checks/pickup-override-final/pickup-override`.
The committed-style patch artifact `dispatch-pickup-address.changes.patch`
reconstructs the task baseline without relying on a clean Git worktree.

Limits: address matching normalizes case, spacing and punctuation, without
geocoding equivalence. Distinct equivalent address spellings may remain
separate visits. The full unrelated application monolith was not rerun; the
pickup suite, affected SCM/save integration, Driver manifest and actual browser
flows cover this change. No randomized test-file ordering was added; generated
order sequences exercise grouping order and the focused browser/database test
files run in separate isolated databases.

Release status: prepared `mbbs-operator-app:dispatch-pickup-address-20260928`,
image `sha256:e114083293235088401d1747b250324557ce3828acb58b4f102c276e1e3e04f4`.
All 26 focused tests passed again on the exact candidate image.
Automatic approval review rejected applying the image because it considered
the earlier user deployment authorization to cover the previous fix only.
No cutover command executed. The live app remains on the captured
`special-local-pickup-20260928` image. Explicit deployment approval was requested.
Manifest and candidate test results are in
`deployments/dispatch-pickup-address-20260928/manifest.json` and `verified.json`.

## Authorized release on 3 October 2026

The user explicitly authorized deployment, commit and push on codex/dockerVer.
The current BOSS image was used as the parent. The earlier blocked September 28
image was not deployed. Fresh results and the successful live cutover are in
[the October 3 release](../deployments/dispatch-pickup-address-20261003/README.md).
Those results supersede the historical release status and static/harness counts
above. There are now 140 additional BOSS/login checks and 27 reordered checks.
