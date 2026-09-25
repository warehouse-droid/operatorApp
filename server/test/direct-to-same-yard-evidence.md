# Direct TO pickup and CO source packing handoff

The user selected **Clear SO packing; pack on the CO**. This implements the
reported SOA08838/TOB01102 pickup defect and automatic SO packing release when a
source-yard CO takes over. See [pickup specification](direct-to-same-yard-spec.md)
and [packing specification](co-source-packing-handoff-spec.md). Detailed specs
were written autonomously; separate user review of those documents was not
obtained. Packing/data concurrency verification is Tier 3.

## Scope

Six runtime files change. Pickup rendering and routing include residual SO cargo
and direct TO cargo collected at the same yard exactly once. CO creation, refresh
and explicit recreation release source SO packing/confirmations/preparing
ownership atomically, without transferring it to the CO. Existing CO packing
remains intact. Active source CO ownership blocks stale SO packing/loading, and
TO links check the selected line's CO progress after acquiring operator and row
locks. A CO created while a TO link waits forces a refresh before retrying.

Loaded/fulfilled source evidence, started Driver records, posting claims and
Consolidation Load claims prevent packing release. This adds no schema, package,
network call, NetSuite write or background data migration. The current-order
correction is a separate, guarded and audited transaction.

## Acceptance mapping

| Scenario | Evidence |
| --- | --- |
| Same-yard direct TO pickup, exact material/TO header, residual cargo | `direct-to-same-yard.test.js` fixed SOA08838-shaped cases and production-plan replay |
| Partial/multiple allocations, alternate yards, quantities and weight | 150 generated allocation cases plus fixed controls |
| Empty residual, escaped refs, drop and PO preservation | Frontend HTML assertions and adjacent pickup/PO suites |
| Clear source packing without copying or losing CO progress | `co-source-packing-handoff.test.js` creation, repeat-save, legacy repair and Operator API cases |
| Untouched lines, other yards/orders, required quantities | Exact canonical-row comparisons and grouped/non-SO cases |
| Cancellation/recreation | SO packing resumes after cancellation and is cleared again upon explicit recreation |
| Loaded, posting, Driver and consolidation work | Rejected transactions compare retained source rows |
| Atomicity and idempotency | Injected audit failure, exact audit count, repeated repairs and 25 generated packing cases |
| Concurrent operator updates and canonical row writes | Independent PostgreSQL transactions and real advisory/row-lock assertions |
| Packed CO line blocks TO link; different CO line remains allowed | Extended untouched-line regression with held CO mutex and concurrent CO creation |
| Current-order correction | Private snapshot, rollback rehearsal, guarded apply, exact protected-row comparison and Operator CO detail read |

## Reproduction

From the repository root:

```bash
sudo bash server/tools/direct-to-same-yard-gauntlet.sh
```

The persisted reverse patch reconstructs the previous production source without
changing the workspace. Tests run in internal Docker networks with disposable
PostgreSQL 18 databases. The existing `mbbs-retired-confirm-test:20260914` image
provides Node 20.20.2, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0 and TypeScript
7.0.2. No dependencies were added. Source hashes, coverage, full logs and mutation
results are saved under `server/test-artifacts/direct-to-same-yard`.

Installed image identities recorded for this run:

- Test image: `sha256:0a5ee3f2197eb21d9959c4cd71d12917e7ce5e7b112c02845681ec9eea7c460c`.
- PostgreSQL image: `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`.

The `resume` argument continues verification only if the six frozen source
hashes still match; it reruns focused coverage, mutations, reverse-order checks,
lint and types, then verifies completion of the same run's baseline/final full
suites. Deployment separately checks candidate/runtime hashes and every gate.
The `finish` argument revalidates completed TAP/mutation logs against those same
runtime hashes and reruns syntax, lint, coverage accounting and types. It was
used after correcting a variable-shadow lint error in the live-check tool;
application code and behavioral tests did not change.

## Final results

- Original pickup source: **10 tests, 2 passed, 8 failed** on the same regression
  cases, with behavioral assertion failures before the fix.
- Final focused/coverage runs: **149 passed, 0 failed, 0 skipped**. All 11 focused
  files also passed separately in reverse order. The 27 handoff tests and four
  CO-specific link tests exercise real PostgreSQL and production repositories.
- Changed executable lines: **221/221 covered** across six runtime files.
- Manual mutation checks: **21/21 killed** (8 pickup and 13 handoff/link mutants).
  The pickup property alone kills 6/8; the two survivors concern drop preservation
  and duplicate detail rows, covered by deterministic tests. The handoff property
  alone kills 2/13; the other 11 require ownership/yard/execution/concurrency or
  recreation scenarios covered by deterministic tests. No claim that generated
  quantity tests prove those other behaviors is made.
- Quantity properties: 150 allocation examples (seed `88381102`) and 25 packing
  examples (seed `8838`). The existing selected/unrelated activity property also
  passed 64 examples with seed `88381102`.
- Syntax, scoped lint, source/test/tool secret scan and `git diff --check`: passed.
- TypeScript: **233 existing diagnostics, zero new diagnostics**.
- Full baseline/final: **2,580 tests each; 2,578 passed, 1 failed, 1 skipped** in
  505 files. The unchanged failure is `P3.12: browser specs share one worker-owned
  database-pool lifecycle`. Failure and diagnostic comparisons report no additions.

Source hashes are saved in `checks.json` and `final-source.sha256`. The release
checks the exact hashes again before building and deploying. Live rehearsal,
deployment and current-order repair results follow.

## Deployment and current-order correction

Deployed `mbbs-operator-app:direct-to-same-yard-20260916-v1`, image
`sha256:2c3580e507b7474dd5e075f76d173bf94439b840fd300f709d6a3850db10292a`.
Only the six verified runtime files differ from the prior production image.
The entire candidate runtime matched the workspace sources used in testing.
Candidate migration/startup/health checks passed in a disposable database.
Cutover retained configuration, mounts and ports; the worker, database and Ollama
container identities/start times stayed unchanged. App health and the served
Dispatch JavaScript hash passed verification.

The candidate and deployed live-plan replays returned SOA08838 on plan 329,
revision 34: **52.25 SQFT / 5 LYR** of Trevista at pickup 3445, one TOB01102
header, seven operational pickup rows, seven drop rows, and CO-SOA08838 retained.
The replay ran in a repeatable-read, read-only transaction and did not mutate
the plan or its input objects.

The authorized repair was rehearsed with rollback, then previewed again and
applied under the same operator/header/line locks. Its saved preview hash had to
match immediately before the write. The correction released **six source SO
lines**, preserved **five packed CO lines**, and left every CO header/line,
TO header/line, dependency/allocation and plan snapshot/revision unchanged.
Verification read the actual Operator CO detail and found **all seven CO lines**
with their required quantities and retained packing. Source preparing ownership
and confirmations were cleared. An audit retains the original packing fields;
the private before-state backup is outside the repository under
`/home/ubuntu/operatorapp-deploy-backups/direct-to-same-yard-20260916`.

Commands:

```bash
sudo -n python3 server/tools/direct-to-same-yard-deploy.py prepare
sudo -n python3 server/tools/direct-to-same-yard-deploy.py apply
sudo -n python3 server/tools/direct-to-same-yard-deploy.py repair
sudo -n python3 server/tools/direct-to-same-yard-deploy.py verify
```

The first live-check attempt used an incorrect assignment-table name and failed
inside its read-only transaction. The tool was corrected to the schema's
`dispatch_plan_order_assignments`, linted again, and the full candidate rehearsal
completed before any deployment or committed packing repair. No runtime change
was needed for that diagnostic-tool correction. No NetSuite transaction was sent.

## Limits

Changed-line coverage measures executable statement coverage, not complete branch
coverage. Generated tests cover quantity/activity invariants; deterministic
tests cover concurrency, ownership, execution protection and other mutations.
The HTML formatter is exercised with production functions; no authenticated
browser click-through is claimed. Existing Driver records are checked, but a
separate Driver-start phantom race is not stress-tested. The legacy runtime is
not fully statically typed; unchanged repository type diagnostics are compared.
No dependency audit was needed because the dependency set did not change.

## Verification history

The first frozen-source coverage run passed 148 of 149 tests and failed the
existing `concurrent plan ownership and cancellation cannot commit a planned
cancelled CO` assertion (`2 !== 1`, line 419). Five isolated single-test replays
passed on both baseline and candidate. Replaying the complete existing test file
five times against unchanged baseline code reproduced that exact failure once.
Those diagnostic runs also reported the repository's whole-project c8 thresholds
for a partial suite; their TAP assertions, not those coverage totals, establish
the intermittent baseline failure. No existing assertion was changed or skipped.
The failed frozen-source coverage log and baseline reproduction are retained;
verification resumed against the same six runtime hashes.

An earlier adjacent repeat-pickup test, `RP-05: active travel protects its
destination while allowing work after it`, failed on both baseline and candidate.
Its logs are `adjacent-baseline.log` and `green.log`. It remains outside the clean
focused bundle and is not claimed fixed. Superseded test runs were stopped only
in this task's disposable containers when the CO timing and recreation cases
required source changes; production was unaffected.
