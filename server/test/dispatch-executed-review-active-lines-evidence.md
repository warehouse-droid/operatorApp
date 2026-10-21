# Current source notices and re-plan requests

Deployment update: the user subsequently authorized deployment. The changes are live as of 2026-09-28 16:34 UTC; see [deployment verification](dispatch-source-replan-deployment-evidence.md). The report below records the earlier local verification run.

Spec approval: not obtained for the initial fix (autonomous run). The user explicitly selected dispatcher review and re-plan, rather than automatic recalculation. See [the specification](dispatch-executed-review-active-lines-spec.md).

The source-review lookup now excludes inactive historical sales lines while historical order search retains its existing behavior. Real differences on assigned physical stops generate a persistent notice, including before driver activity starts. Remaining work is labelled “re-plan requested”; fully executed work remains a review notice. Source syncing and valid planning saves do not depend on acknowledgement. Executed comparison/reconciliation still uses only executed contexts.

## Verification

- Final randomized adjacent suite: 140 tests, 136 passed, 4 pre-existing failures; zero new failures against the captured baseline. Shuffle seed: 28092026.
- Focused coverage run: 21 tests passed, including actual HTTP/browser behavior and a real webhook update while a prior notice remains pending.
- Changed executable lines: 42/42 executed. Branch coverage is available in the raw coverage artifact; this is not a claim of exhaustive branch coverage.
- Deliberate regressions: 8/8 caught, including the property suite catching a missing re-plan flag. The new property runs 80 generated assignment/execution/quantity cases.
- Static checks: zero new diagnostics; 1456 existing lint diagnostics and 254 existing type diagnostics. New test/check files are lint-clean. Baseline type output can compile duplicate copies through existing absolute imports; comparison deduplicates identical file/line/message blocks after normalizing the temporary checkout prefix.
- No dependencies, database schema, execution records, or acknowledgement data were changed. No production deployment was performed.

The live read-only replay of SOA09413 returned 3 active lines, salesQty 1426.64 and weight 50321.73, with no corrected notice. The former historical lookup returned 8 lines, salesQty 1490.315 and weight 54294.14. All five alleged additions were inactive rows. The latest retained webhook source-modified timestamp was 2026-09-27 18:36 UTC. The existing acknowledgement remains stored.

## Scenario mapping

| Scenario | Evidence |
| --- | --- |
| Exact false additions and inflated totals | `dispatch-executed-review-active-lines.test.js`: SOA09413 regression; read-only live replay |
| Historical cargo still available | Current-source lookup test and existing fulfilled-SO planning suites |
| Real additions, removals and quantity changes | Combined change regression and stable-token assertion |
| Old pending/acknowledged false notices disappear without deleting evidence | Both stored-observation regressions |
| Planned, partly executed, fully executed and unassigned work | New integration scenarios and 80 generated property cases |
| Source processing and saving continue | Actual webhook test, executed-prefix comparison, existing HTTP command/restore tests and Chromium save-before-confirmation test |
| Re-plan wording and immediate refresh | New frontend function tests; the unchanged full frontend runs in Chromium |
| Lease, concurrency, preserved jobs/photos and route locks | Existing review and executed-prefix integration/concurrency suites |

## Reproduce and limits

Run `bash tools/executed-review-active-lines-gauntlet.sh` from `server`. Add `--live` to repeat the read-only production replay; that mode requires the original incident and unchanged live baseline modules. The task patch reconstructs the captured baseline if its artifact folder is missing. Test image: `mbbs-bin-planning-test:20260927`; tool versions and source hashes are recorded under `test-artifacts/executed-review-active-lines`.

Pre-existing failures were retained without weakening assertions:

- HTTP billed SO can be saved and confirmed with completion retained
- SA-1 the actual details acknowledgement separates Valleymede from Estoril
- driver completion after search denies stale or forged flags on save, confirm and v2 command
- the refreshed split address produces two physical visits for Mossbrook and Heatherside

Initial new regressions failed for all five inactive-line cases and both new re-plan scenarios before implementation. The first baseline comparison lacked the migration directory in its temporary copy; the runner was corrected. Static checking found and fixed two test-variable shadowing warnings. No new performance benchmark was added: the existing indexed, batched source lookup now includes all assigned order refs. Metadata outside the existing cargo/location comparison is not newly classified as a planning change. No deployment/rollback rehearsal or dependency/license audit was necessary for this local, dependency-free correction.
