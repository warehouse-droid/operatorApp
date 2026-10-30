# Driver inactivation evidence — 2026-10-29

Deployed on 2026-10-29 after the user requested deployment; see
[deployment verification](driver-inactivation-deployment.md). Dispatch can inactivate a driver
with unfinished work, continue saving/editing/confirming plans (including BIN
plans), and reassign unfinished work. Inactive drivers cannot authenticate or
persist starts/completions. Deactivation revokes sessions and offline grants in
the same transaction. Existing assignments and job records are retained.

Spec: [driver-inactivation-spec.md](driver-inactivation-spec.md).
Spec approval: not obtained (autonomous run). Tier 3: authentication and
concurrent execution. No dependencies, migrations, commits, or production-data
changes were introduced by this task. Unrelated workspace edits were preserved.

Reproduce from the repository root:

```sh
bash docker/run-isolated-tests.sh node tools/driver-inactivation-checks.mjs gauntlet
```

Final fresh run exited **0**. Node **v20.20.2**; tool versions are pinned in
`server/package-lock.json` (TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0,
fast-check 4.9.0). Tested source SHA256, using the runner's source-tree recipe:

```text
ffaa18756eb75988c1029cb82c9096ce30094bcba1089fb0fae959ec6c5d0c97
```

The shared workspace received unrelated Repair/Control UI edits during the
run. Afterward, all 17 selected runtime, test, tooling and lock files matched the
tested image. The hash identifies the tested snapshot, not those
later unrelated UI edits.

| Check | Final result |
| --- | --- |
| Acceptance | **12/12 passed**, including actual HTTP login, deactivation, session and offline-grant requests |
| Regression scope | **427/427 passed in 95 files**; another 9 files had only the 11 unchanged baseline failures below |
| Baseline comparison | Pre-change behavior reconstructed without discarding unrelated edits; candidate matched failed names, counts, and diagnostics in all 9 files |
| Suite ordering | Regression files shuffled with seed **20261029**, fresh database per file; final reversed acceptance order **12/12 passed** |
| Static checks | Syntax for 10 runtime/acceptance files; focused lint for 5 new files with **0 errors/warnings**; new execution guard passed TypeScript checking |
| Whitespace | `git diff --check` passed for task files |
| Coverage | New execution guard: **37/37 lines (100%)**, **6/8 branches (75%)** |
| Properties | **100 cases**, seed **20261029**, verifying that an existing driver's activation state cannot block planning |
| Mutation control | Unmodified scratch workspace **12/12 passed** before mutation |
| Manual mutations | **6/6 detected**: allow inactive execution; ignore canonical assignment; block active drivers; remove driver row locking; block inactive planning; remove unknown-driver validation |

The planning property itself detected the restored inactive-planning rejection.
The execution and concurrency mutants were detected by integration tests; the
planning property is not claimed to verify execution authorization.

Acceptance mapping:

| Spec | Executable evidence |
| --- | --- |
| S1: deactivate unfinished work, retain records, revoke access | `dispatch/integration/driver-inactivation.test.js`, S1; fleet endpoint harness also covers management visibility, audit and re-enabling |
| S2: deny login/start/completion | Same integration file, S1/S2; online, offline-timestamp and dispatcher-assistance completion inputs all reject without changing the stored job |
| S3: planning continues | Same file, S3; `dispatch/unit/driver-inactivation-planning.test.js`; `mbt/integration/bin-planning-driver.test.js`; `mbt/integration/p3-bin-confirmation-coverage-hardening.test.js`; fleet harnesses |
| S4: reassignment required | Same integration file, S4; forged active login rejected against the canonical inactive assignment; saved reassignment permits active replacement execution |
| S5: queued execution cannot cross deactivation | Same integration file, both S5 lock tests; removing the row lock is detected by the completion race test |
| S6: explain consequences | Updated setup confirmation text inspected; JavaScript syntax checked; no browser run for this text-only change |

Unknown-driver and inactive-truck validation remains covered by unit/fleet
tests. Inactive drivers stay absent from new-driver selectors. Dispatcher-only
activation middleware is unchanged and was inspected; the existing endpoint
harness checks protected management access. Existing route, photo/history,
reopen, offline and historical-assistance suites were included in regressions.
Started stops still require the existing reopen workflow before reassignment.

Unchanged baseline failures (29 tests in these files: 18 pass, 11 fail):

- `driver-plan-date-execution-wiring.contract.test.js`: “S11: the guarded client ships in a new atomic Driver shell generation”.
- `driver-camera-ordinary-upload.test.js`: “a fresh Driver shell version evicts older copy-enabled cached assets”.
- `driver-live-route-prefix-lock.integration.test.js`: “automated billed reconciliation defers instead of deleting a completed route prefix”.
- `scm-pob03658-split-driver-lifecycle.red.test.js`: “POB03658: a matched parent update plus a new Driver-completed split stays out of Reconcile Review”.
- `driver-pwa-recovery-assets.test.js`: “the installed Driver shell cannot mix old DB/route code with photo recovery code”.
- `src/dispatch-driver-order-harness.js`: existing harness assertion failure.
- `driver-pwa-site-reset.test.js`: “the reset ships as a new atomic shell generation without forcing a protocol-version cutover”.
- `driver-pwa-cache-repair.test.js`: “a failed staging download leaves the active and non-Driver caches byte-for-byte unchanged”; “a fresh Driver worker reloads every v41 shell asset and initializes only its scoped sentinel”; “a successful repair replaces only the complete Driver shell and preserves offline data sentinels”.
- `driver-pwa-ux-regressions.test.js`: “the updated override policy is atomically included in the Driver PWA shell”.

The initial acceptance run demonstrated the requested missing behavior: 10
failures and 2 existing-positive passes. BIN confirmation tests also failed
before the planning checks changed. An early implementation added a global
completion lock that deadlocked an existing historical-assistance concurrency
test. Replacing it with driver row locks fixed that regression; final race and
historical-assistance tests passed. Scratch-run tooling was corrected to include
migrations and avoid copying unrelated unreadable reports; pristine controls
passed before attributing any failures to mutations.

Limits: this is the affected 104-file driver/fleet scope, not the full repository
suite. Type/lint checks are focused, not project-wide. Coverage quantifies the
new guard rather than every changed line in the large existing modules; two
guard branches remain uncovered. No browser or disconnected-device test was
added. Historical repository calls without a current setup record retain their
existing policy; public callers still enforce authentication and ownership.
No dependency audit was rerun because dependencies did not change. Task changes
were reviewed for credentials and new external capabilities; none were added.

The standard runner used bounded containers under `mbbs-tests.slice`, removed
its Compose project with volumes/orphans, checked both running and stopped
containers, and verified production health. The unique artifact directory,
coverage, logs and temporary baseline/mutation copies were deleted. The later
read-only source comparison container was also removed. Final inventories found
no resources for this task, and `/health` returned `ok: true`. An independent
Repair test project was running concurrently and was left to its own runner.
