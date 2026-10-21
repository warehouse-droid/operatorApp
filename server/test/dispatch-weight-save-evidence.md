# Stable weights and non-blocking saves

The [specification](dispatch-weight-save-spec.md) implements the user's weight
policy and distinguishes harmless sequence renumbering from an actual route
change. Spec approval: not obtained separately (autonomous run).

Plan 341, recovery 18506, contains no source-order update. The existing source
lookup rounds weight to three decimal places, while plan enrichment previously
returned the floating-point sum. GOB-121261-121262 therefore appeared as
8784.966199999999 after loading despite its stored/source total of 8784.966 lb.
Plan enrichment now uses the same three-decimal precision. Child SOB121261
remains 7744.966 lb.

Weight-only order and stop updates do not lock executed work. Unrelated save
errors omit weight differences, including grouped children. Numeric sequence
gaps are ignored when actual driver-route order is unchanged. Existing guards
still reject moving or rewriting started/completed work; later unstarted loads
and stops remain editable.

At the 20:23–20:24 UTC failed saves, Load 3's pickups and first delivery were
complete. Its last delivery had started at 20:10 and completed at 21:25. The
change from internal sequences [0,1,3] to [0,1,2] did not move any load.

## Final verification

- Focused suite: **17/17 passed**, including an authenticated HTTP save,
  repeated database plan reads, source-review behavior and generated cases.
- Shuffled adjacent suite: **153/155 passed**. The same two failures occur in
  the baseline (**143/145 passed**); zero new failures. The unchanged failures
  are `SA-1 the actual details acknowledgement separates Valleymede from
  Estoril` and `the refreshed split address produces two physical visits for
  Mossbrook and Heatherside`.
- Changed-line coverage reported by c8: **12/12**, across four modules.
  This does not claim exhaustive branch coverage.
- Deliberate regressions: **8/8 caught**. They restore rounding drift, restore
  stop-weight locking, expose group/child weight errors, restore numeric
  sequence locking, remove quantity protection, or wrongly lock future stops.
  The generated sequence test was strengthened after the first mutation run
  exposed a missing case for numeric gaps in predecessor loads.
- Static checks: **zero new diagnostics**; **174 existing lint findings** and
  **181 existing normalized type diagnostics**. New test/checker files are
  lint-clean. A shadowed test variable was renamed before the final full run;
  assertions were unchanged.
- Read-only candidate replay: stored and loaded group weights both
  **8784.966**, **zero source changes**, original backup passes the executed-work
  guard after the application's existing timing-preservation step, new Return
  Load retained, and a deliberate executed-quantity edit still rejected.
- An authenticated test save preserves source lines and driver job/photo
  evidence byte for byte. Production replay uses `SET TRANSACTION READ ONLY`
  and never applies a draft.

The initial regressions failed on the old implementation for both stop-weight
aliases, misleading weight errors, unchanged weight reads, HTTP saving and
harmless load renumbering. One initial runner regex was corrected before the
behavioral red run. The HTTP fixture's group sales quantity was corrected to
the sum of its children before implementation. No tests were weakened.

## Scenario mapping

| Acceptance condition | Evidence |
| --- | --- |
| Unchanged group/child weights stay stable | Integration repeated-read and authenticated-save tests; incident replay |
| Weight-only changes pass | Generated unit cases for both stop aliases and execution statuses; HTTP save; existing weight-source tests |
| Driver/source records remain intact | Integration before/after equality checks; production read-only transaction |
| Real cargo, destination and timing changes remain blocked | Generated negative unit cases; existing route, command, address and concurrency suites; quantity-protection mutant |
| Conflict messages omit unrelated weight | Unit group/child/stop diagnostic test; separate group and child mutants |
| Source notices retain their policy | Seven existing integration/property weight-source review tests |
| Harmless sequence renumbering passes | Exact Li sequence test and generated predecessor-gap test; two sequence mutants |
| Unstarted work can move without moving started work | Positive/negative later-stop/load test; existing prefix suites; over-locking mutant |

## Reproduction and limits

Run `bash tools/dispatch-weight-save-gauntlet.sh` from `server`; it reconstructs
the baseline from [the task patch](dispatch-weight-save.changes.patch) if needed,
creates a fresh isolated PostgreSQL instance, compares baseline/current suites,
and runs coverage, mutation and static checks. The patch was independently
reversed and matched all four captured baseline files exactly.

Run `python3 tools/dispatch-weight-save-live.py --candidate` for the read-only
incident replay. It requires access to the original plan and backup. Without
`--candidate`, it runs the deployed modules.

The final check directory is recorded in
`test-artifacts/dispatch-weight-save/final-run-id`; `validation.json` records
source SHA-256 hashes, raw results and coverage. Test image:
`mbbs-bin-planning-test:20260927`; Node 20.20.2, fast-check 4.9.0, ESLint 10.8.0,
TypeScript 7.0.2, c8 12.0.0, Playwright 1.62.1.

No dependencies, schemas, API contracts or credentials changed. The task patch
passed credential-pattern and whitespace checks. There are no new production
network, filesystem or subprocess capabilities. The full repository suite was
not run; the complete adjacent executed-work suite plus relevant performance
and adversarial tests were used. No new performance benchmark or dependency
audit was needed. Existing concurrency and HTTP tests cover the unchanged
locking and authorization boundaries. The production backup itself has not
been saved by this task.

Deployed and verified at **2026-09-29 22:50 UTC**, image
`mbbs-operator-app:dispatch-weight-save-20260929`, ID
`sha256:d84dc1976b6dc2ee8e518476ab297a021ae2851813b65b7ded6b8f454e1c1bf9`.
All **17 focused tests also passed against the captured release image**.
Local and public health endpoints return 200, and unauthenticated plan access
still returns 401. Configuration, worker and other dependencies are unchanged.
The previous app image is retained for rollback.

The actual deployed modules pass the read-only incident replay: plan revision
**97** and backup **18506** remain unchanged, loaded/stored group weight is
**8784.966**, source changes are **zero**, the backup passes the executed-work
guard, its new Return Load remains, and a real executed quantity edit is still
rejected. See [deployment verification](../deployments/dispatch-weight-save-20260929/deployment-result.json).
Only the four verified modules were released. No browser asset or database
update was required, and no draft was automatically applied.
