# Dispatch editor controls — evidence

Dispatch was removed from the 15-Oct-2026 date plan at the user's immediate request. Admin now lists active date-plan editors; Admin and Dispatch can kick the selected editor after a confirmation popup. Idle editing expires after ten minutes; background heartbeats cannot extend it.

Spec approval: not obtained (autonomous run). Tier 3, authorization and concurrency. Confidence is bounded by the scenarios in `dispatch-editor-control-spec.md`; there was no independent human review of that specification.

## Final candidate validation

- `84` tests passed in `7` files, including both real browser confirmation flows. Cancel preserved the editor; Confirm revoked the old credentials. Existing save/recovery regressions passed. The three feature suites also passed in reversed order (19 tests before any additional scenarios).
- `6/6` deliberate mutants were rejected: idle boundary, synthetic activity, programmatic scroll, confirmation bypass, legacy heartbeat renewal and stale session selection.
- Measured core lease repository and activity tracker: `294/294` executable lines, `88/103` branches. Changed executable line counts are in `test-artifacts/dispatch-editor-control-20261015/evidence.json`. Browser adapters, the Admin DOM module and monolithic route wiring were executed in browser/HTTP tests but are outside the numeric coverage measurement.
- Seven runtime JavaScript files passed syntax checks. Lint and scoped TypeScript comparison reported zero new diagnostics; `24` existing type diagnostics remain. Scoped secret scanning found zero findings. Tool versions are recorded in evidence.json.
- Every disposable container, database volume and test network was removed; both docker ps and docker ps -a were captured, and production health passed after teardown. The host memory-budget verifier passed six checks.
- The deployed source hashes match the validated overlay. Application configuration, database and worker image identities were checked by the release helper. A rollback image and Compose override are retained. No schema migration was needed.

## Scenario mapping

| Scenario | Executed evidence |
| --- | --- |
| Admin authorization, active listing, no secret exposure | ADMIN-01 |
| Token revocation, audit actor/target, plan/date isolation, next acquisition | ADMIN-02; DISPATCH-01 |
| Replacement session and repeated kick | ADMIN-03; IDLE-DB-02 |
| Hostile/missing selection and malformed activity age | ADMIN-04; IDLE-DB-01 |
| Delayed save after kick | ADMIN-05, real PostgreSQL fleet-lock barrier |
| Audit failure cannot partially kick | ADMIN-06, failing audit trigger and transaction rollback |
| Actual activity and exact inactivity boundary | IDLE-01 through IDLE-05; 150 seeded property examples |
| Late responses, preserved draft and immediate snapshot exit | ACTION-01 through ACTION-05 |
| Both confirmation popups, Cancel and Confirm | CONFIRM-01, real Chromium plus real isolated HTTP/database |
| Reload/tab fences and save compatibility | Existing save-reliability suites and edit-lease-session properties |

## Reproduce

From the repository root, run `python3 server/tools/dispatch-editor-control-check.py all` for workspace validation and `python3 server/tools/dispatch-editor-control-check.py candidate` for the saved release source. Both commands register teardown before startup and remove disposable resources in finally. `python3 server/tools/dispatch-editor-control-evidence.py` recreates this report from final candidate and deployment artifacts. Production capture/build/release/verify commands are in `tools/dispatch-editor-control-release.py`; release requires successful candidate validation.

Runtime source-tree hash: `2e8d6ab9cff28d5d7ebce668d979d0ab4b2cdccf48024025fdd3b74376680637`. Individual deployed source hashes, test/tool hashes, image identity and exact tool versions are recorded in evidence.json. No Git commit was created in the shared dirty workspace.

## Limits and corrected failures

The repository-wide suite and whole-application type checks were not run: this validation covers editor controls and the existing Dispatch save/recovery suites. Numeric branch coverage is partial. The tests use clocks and persisted timestamps rather than a ten-minute wall-clock wait. Dedicated negative-role assertions cover the Admin endpoints; Dispatch reuses the existing dispatcher/admin middleware. Randomized suite order, sustained production contention and a live rollback rehearsal were not run; reversed ordering, deterministic input properties, database barriers and a retained rollback image cover those risks partially. Dependency audit/license checks were skipped because dependencies did not change. No latency budget was supplied.

The initial tests reproduced missing controls and idle heartbeat renewal. Test setup fixes corrected Compose number parsing and its working directory; the browser fixture was corrected to use Dispatch Planning. Type-comparison paths were normalized. A confirmation mutant first exposed an incomplete fetch boundary stub; it was completed without changing the cancellation assertion. A further regression reproduced and fixed stale snapshot ownership after revocation. Release capture was made readable after docker cp preserved restrictive ownership. A collision between candidate source and evidence directories was corrected before final validation. A concurrent PO-line deployment was detected before release; the approved feature delta was frozen, rebased onto that newer live image and validated again. Concurrent workspace edits to unrelated order actions were excluded from the overlay. Prior failed-run logs are retained; no disposable databases were retained.
