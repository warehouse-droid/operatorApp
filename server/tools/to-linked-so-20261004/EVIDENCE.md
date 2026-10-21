# Linked SO delivery gate for TO fulfillment

Fixed and deployed on 2026-10-04. The TO worker previously waited for a Driver event carrying the TO reference, so it missed the customer delivery recorded against linked SOs. Two old jobs also saved the dispatch date as `Sat Oct 03`, which could never match the ISO event date.

The worker now captures the active direct-delivery dependency, linked SO references, and exact plan/load/date when the Operator saves a load. Every linked SO must have effective Driver drop-off evidence. Group members are retained individually. Current Driver references, dates, assignment withdrawal, dependency changes and cancelled plans are checked again before posting. Standalone TO behavior and Operator/Driver gates remain intact. The Admin attention card displays the linked SOs and group reference.

Spec approval: **not obtained (autonomous run)**. The user authorized the fix and required verification of existing IF/IR before retry. Criteria and later adversarial discoveries are retained in [SPEC.md](SPEC.md); there was no independent human spec review.

## Live result

| TO | Linked SO delivery | Verified existing IF | Saved quantities | NetSuite/cache status |
| --- | --- | --- | --- | --- |
| TOB01190 | SOA09690 | IF156515 / 1038301 | 6, 1 | Pending Receipt |
| TOB01191 | SOA09694 and SOA09702, group GOA-9694-9702 | IF156516 / 1038302 | 51, 32, 2 | Pending Receipt |

Both Driver deliveries were already complete and both IFs already existed in NetSuite. The repair fetched existing IFs and authoritative sources again, checked exact source, physical line, item, quantity, unit and location, and matched the saved Operator load with every linked SO's effective Driver completion. Both transactional rollback rehearsals succeeded before application.

The local repair completed the two durable jobs, attached the existing IF evidence, refreshed cached headers and recorded two explicit maintenance audits. It preserved all line quantities and physical receiving state; the original job snapshot is retained in the audit. **No new IF or IR was created.** No receipt was fabricated. Readback at **2026-10-04 01:17:24 UTC** confirmed both jobs remain terminal and no pending TO posting jobs remain. Repeated preparation and stale Admin retry calls made no NetSuite posting and did not reopen the reconciled jobs.

## Tests and limits

Final focused run: **249 passed, 0 failed**, repeated in a different file order with **249 passed, 0 failed**. Browser rendering and injection checks: **7 passed**. Changed backend lines: **107/107 covered**; all four instrumented backend modules: **349/349 lines**, **256/270 branches (94.81%)**. Scoped lint and changed-diff secret scanning passed. Type checking has **274 existing diagnostics and 0 new diagnostic signatures**.

All **11 deliberate mutants were killed**. Six pure-domain mutants were also killed by the property suite alone. Five repository/scheduler mutants were killed by real database integration tests, covering replacement of a group's second completion, scheduler/Admin reopening of a completed IF, removal of a Driver SO reference, and a corrected Driver date. The untouched temporary database test copy passed before those mutation results were accepted. These five are not claimed as property-suite kills.

An earlier mutation-harness attempt omitted required public modules and failed at import. Its database mutation results were discarded. After the harness was corrected, all 12 untouched database tests passed and the five database mutants were rerun successfully. Production implementation and behavioral assertions were unchanged by that correction.

The broad MBT run executed **837 files**, with **80 previously failing files and 0 new failing files** against the retained baseline. Its baseline comparison is retained in [evidence.json](../../test-artifacts/to-linked-so-20261004/evidence.json) and `full-final.log`. The repository has existing broad-suite failures. That run overlapped final guard refinements; all affected files were rerun against the final source in the focused run. The broad suite must not be described as fully green or as a single immutable-source run. This is an explicit verification limit.

| Criterion | Executable evidence |
| --- | --- |
| Capture linked SOs/group members and ISO date | `to-linked-so-completion.test.js`: group/date capture, registered split and row-order properties |
| Require Operator and every correctly scoped Driver drop-off | linked completion properties, real group admission, wrong reference/type/load/date integration checks |
| Block cancelled/changed/missing assignments without losing Operator records | relink/cancel, cancelled plan, missing assignment and conflicting TO-route integration tests |
| Retain each admitted completion and reject stale records | second-completion replacement and Driver reference/date correction integration tests; five database mutants |
| Preserve ordinary TO, IF/IR, exact quantities and duplicate protection | existing transfer background posting, source-reference, uncertain recovery, multipart and source-drift suites in the focused manifest |
| Name SOs/group in Admin and render safely | `browser.mjs`, seven assertions using the actual rendering function |
| Reconcile only existing verified IFs | persisted read-only inventory, two rollback rehearsals, fresh verification on apply, two audits and independent live readback |
| Reconciled jobs remain terminal | completed-job race regression and corresponding database mutant; real post-repair preparation replay |

Known boundary: an old job whose linked assignment was never captured, or a job whose link changes after loading, requires explicit Admin review. The worker does not guess a replacement route. Only the two reviewed legacy jobs were repaired; no historical jobs were created.

## Release and reproduction

Image: `mbbs-operator-app:to-linked-so-20261004-v2`.

Image ID: `sha256:cbf9c6443782480290904902dd654a9ab48b2eb70a39ca59394e8a5dd83f5278`.

Five reviewed files were initially overlaid on `sha256:137de6b4c7bd2338db29b150e81d4b7b391e2cd512d2352f98febe4652d23f77`. The final Admin retry guard was overlaid on the verified first release, `sha256:22ef132adcb8983e24c369fe8a41b0ac6af919c1b974bf8ddad092c14f70d981`. The running image, five file hashes, served Admin JavaScript, and healthy `/health` response were verified. Configuration, credentials, mounts, ports, dependencies and the webhook worker were preserved. No migrations or dependency changes were required. Rollback image and compose override are retained privately. No unrelated workspace changes were committed or deployed.

The source tree hash, exact file hashes, pinned tool versions and per-layer results are retained under [test-artifacts/to-linked-so-20261004](../../test-artifacts/to-linked-so-20261004/). Private production evidence and configuration remain under `/home/ubuntu/operatorapp-investigations/to-linked-so-20261004` with restricted permissions.

Existing isolated runner required; no production database is used by test commands:

```sh
python3 tools/to-linked-so-20261004/gauntlet.py all
python3 tools/to-linked-so-20261004/evidence.py
```

The full-suite watchdog reports timeouts as failures, not skips. Per-layer `focused`, `static`, `mutation` and `full` modes are available. `reconcile.py dry-run` / `apply` are guarded, single-use maintenance operations and intentionally reject the now-completed jobs. They must not be rerun as a posting retry.
