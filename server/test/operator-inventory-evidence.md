# Operator Inventory — implementation and release evidence

Implemented and deployed on 23 September 2026 at 19:53 UTC.

The approved [acceptance specification](operator-inventory-spec.md) covers Damage
Stock, assigned Count Sheets, and the shared counting calculator. Approval was the
user's instruction to implement the plan. No dependencies were added.

## Delivered behavior

- Damage reports require a new photograph and an R1–R5 reason. PLT/LYR/SEC/PCS
  use item conversion factors; items without these factors use their sales UOM.
  Each report has its own line and photographs. Reports append to one Inventory
  Transfer per yard and Toronto calendar month, adopting an existing matching
  transfer. Memo example: `3445 2026 Sep Damage`.
- The entry screen uses 70% camera / 30% quantity; monthly review uses a month
  picker and 40% list / 60% details. Existing NetSuite lines appear without
  invented photographs. Failed or uncertain posting remains visible, with safe
  retry or reconciliation behavior.
- Control assigns an explicit SKU list to a yard. The first operator to take a
  sheet owns it. Every SKU, including zero counts, must be confirmed. Submission
  is for review and does not adjust stock. Reset archives the previous attempt,
  releases ownership, and invalidates stale saves.
- Cycle Count and Count Sheet share `+ − × =` below the existing digit pad.
  `12 × 9 = 108 PLT` is verified with the original 360px counting panel.

## Verification

| Layer | Result |
|---|---|
| Feature tests | **44 passed, 0 failed**, both final workspace and release candidate |
| Browser execution | Four complete flows: count/submit/reload, existing Cycle Count, Control assignment, camera/report/monthly review |
| Property testing | 300 generated arithmetic/conversion cases, seed 23092026 |
| Fault injection | 5/5 selected mutants killed; conversion mutant also killed by property tests alone |
| Backend + calculator coverage | 586/587 lines (99.82%), 66/66 functions, 435/479 branches (90.81%) |
| Static checks | New feature modules lint clean; touched JavaScript parses; strict domain type check passes |
| Project type comparison | 174 existing normalized diagnostics; **0 new** |
| Migration | Eight additive tables created; transactional rollback preserved existing test rows |
| Reordered tests | All seven feature test files passed in a different order |
| Secrets/dependencies | Secret scan passed; dependency set unchanged |
| Live release | All 25 deployed file hashes match; runtime settings and dependent containers preserved; new pages HTTP 200, anonymous APIs HTTP 401 |

The full repository run covered **3,074 tests across 577 files**: 3,046 passed,
27 failed, and one skipped. Three Receiving failures occurred while separate
Receiving work changed the shared workspace; all three files passed fresh
reruns with their assertions intact. The remaining failures match the recorded
pre-existing baseline. There are **no new inventory-related regression failures**.
The obsolete Aggregate navigation assertion that the two modules remain disabled
was replaced with enabled-and-opens assertions, as required by this task.

The release candidate deliberately excludes the separate Receiving changes and
preserves them in the workspace. Its 44 acceptance tests and nine existing
Receiving checks passed independently. The release procedure checks that every
inventory patch hunk remains intact despite those concurrent edits.

## Acceptance mapping

| Specification | Executable evidence |
|---|---|
| D1, D3, D4, K1 | `test/operator-inventory-domain.test.js` |
| D2, D3, photo verification | `test/operator-inventory-photos.test.js` |
| D2, D4–D7, retry/crash/concurrency | `test/operator-inventory-damage.test.js` |
| D5–D7, NetSuite request/readback contracts | `test/operator-inventory-adapter.test.js` |
| C1–C5, claim/reset races | `test/operator-inventory-count.test.js` |
| A1, mixed roles, HTTP workflows | `test/operator-inventory-http.test.js` |
| D8, C1–C3, K2, R1 | `test/operator-inventory-browser.test.js` and updated Aggregate navigation test |

RED runs were observed for the initial domain, repository, service, HTTP and
browser scenarios, plus the readback-acknowledgment, adapter, photo verification,
worker, complete damage route and mixed-role regressions. No behavioral assertion
was relaxed to conceal an implementation failure.

## Reproduction and artifacts

Run `bash tools/operator-inventory-gauntlet.sh` with Docker access. It uses the
existing isolated toolchain and a disposable database. Production NetSuite writes
are not used by this command.

- [Focused results](../test-artifacts/operator-inventory/focused.log)
- [Full-suite comparison](../test-artifacts/operator-inventory/operator-inventory/comparison.json)
- [Coverage summary](../test-artifacts/operator-inventory/operator-inventory/coverage/coverage-summary.json)
- [Mutation results](../test-artifacts/operator-inventory/operator-inventory/mutations/results.json)
- [Source manifest](../test-artifacts/operator-inventory/operator-inventory/source.json)
- [Calculator screenshot](../test-artifacts/operator-inventory/operator-inventory-calculator.png)
- [Damage entry screenshot](../test-artifacts/operator-inventory/operator-inventory-damage-entry.png)

Toolchain: Node 20.20.2, Playwright 1.62.1, fast-check 4.9.0, c8 12.0.0,
ESLint 10.8.0, TypeScript 7.0.2. The release image is
`sha256:c4f3d963fb916e7ebab1ad852e199af2b2fb4e5fb94a2b8d2e7088190f04652b`.
Exact release hashes, schema backup, rollback image reference and deployment
result are under
`/home/ubuntu/operatorapp-deploy-backups/operator-inventory-20260923-v1/`.
`python3 tools/operator-inventory-deploy.py verify` repeats the live release checks.

The later [description-limit correction](damage-description-fix-evidence.md)
records the first real submission's NetSuite rejection and the superseding
single-file release. The original release's checks above describe its historical
source snapshot.

## Limits

- Production NetSuite inspection was read-only. After deployment, the actual
  adapter found exactly IT00551 / 998187 for September 3445 Damage, from location
  1 to child 10, preserving its existing line and unit 191 (`PC`). Actual NetSuite
  writes were tested through simulated external responses, including lost
  acknowledgments; no live test stock transfers were created.
- Camera capture was exercised with Chromium's camera simulator. Physical device
  cameras and live R2 uploads were not rehearsed in production.
- The single uncovered backend line rejects an invalid internal management action;
  the HTTP router rejects that action before it reaches the repository. Browser
  coverage was collected, but complete changed-line coverage of the large legacy
  UI/server files is not claimed.
- No stock was adjusted by Count Sheet tests or submission. The migration and
  application release do not create operational damage reports.

NetSuite adapter behavior follows Oracle's documentation for
[Inventory Transfer](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0817112542.html)
and [expanded subresources](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_159894563219.html).

Control review/edit/add/remove follow-up: [Control damage evidence](control-damage-evidence.md). The editor uses item-list UOMs with existing NetSuite permissions.
