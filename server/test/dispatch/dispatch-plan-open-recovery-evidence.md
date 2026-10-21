# October 8 Dispatch recovery evidence

Spec: [dispatch-plan-open-recovery-20261008.md](specs/dispatch-plan-open-recovery-20261008.md).
Spec approval: not obtained (autonomous run under the user's instruction to resolve the blocks).
Tier 3: preservation of saved work and asynchronous response handling.

## Outcome

Plan 350, October 8, was repaired from revision 61 to 62 through `applyDispatchV2Command` with normal validation enabled. The latest rejected draft, snapshot 19341, supplied SN1402231 as Sety's Load 3 on CE94489. All 15 original loads were retained; the unstarted final return was sequenced after the added load. All 27 existing driver records had identical hashes before and after the repair transaction. The rejected draft remains unchanged. Audit record: 27597. The command follow-up completed without retries or errors.

The operational repair passed a complete rollback rehearsal before committing. It required the reviewed plan revision and digest, the exact latest recovery snapshot and its digest, no conflicting editor, no existing assignment for the recovered order, valid dependencies and assignments, and an unchanged executed prefix. The raw rejected draft was still rejected by the protection policy. No protection was disabled and no reconciled order status was reversed.

The browser defect was independently reproduced: creating a date whose plan already existed adopted its revision without applying its saved routes. The fix hydrates the returned snapshot and acknowledgement baseline together. Dirty drafts, wrong-date responses, invalid snapshots and responses arriving after navigation or edits cannot replace local state. A genuinely new empty date still accepts its first draft.

The audit proves that saves succeeded after today's reconciliation, then subsequent rejected drafts omitted the recorded loads. It does not establish which user action or earlier reconciliation first caused the browser to lose its local plan identity. The browser fix closes the reproduced missing-snapshot adoption path.

## Executable results

Artifacts: `server/test-artifacts/dispatch-save-after-2967-20261008/`.

- Initial RED: 12 tests, 10 failed and 2 pre-existing behaviors passed (`open-red.log`).
- Final focused suite, including save-path and adversarial checks: 14/14 passed again inside the release image (`server/deployments/dispatch-plan-open-recovery-20261008/candidate-tests.log`).
- Entire Dispatch frontend suite: baseline 392 tests, 369 passed, 23 failed; final 406 tests, 383 passed, the same 23 failed. No new failures. Exact failure names and diagnostics are retained in `verification/frontend-{baseline,final}.log` and `verification/checks.log`. Existing failures include incomplete legacy test harness globals, older cache-version assertions and a performance-budget assertion under the shared test CPU budget.
- Generated property checks cover 40 route shapes, checking snapshot preservation, dirty-draft retention, new empty dates, wrong dates and delayed responses.
- Seven manual mutants were killed by the full focused suite. Five applicable mutants were independently killed by the property test alone. The two remaining mutants demonstrate the previously existing HTTP-error and read-only protections.
- Changed-function lint: zero findings.
- Changed-function TypeScript check: passed. Existing browser-global interfaces are declared as `any`; this is not a full frontend type proof.
- V8 coverage: all 29 executable lines of `createPlanForDate` covered, including every added statement. No overall project coverage or complete branch-coverage percentage is claimed.
- Final source SHA-256 for `public/dispatch.js`: `38623815445ed4c4ae79fa2c26f5a708e660fda2bd72c6c2f5466c0682f3ec40`.
- Node version: v20.20.2. Existing pinned development dependencies installed with `npm ci --ignore-scripts`; no dependency or lockfile changes.

Spec mapping: OPEN-01 and OPEN-06 verify saved snapshots and empty existing plans; OPEN-02 and OPEN-09 verify draft/fence retention and no replacement save; OPEN-03 verifies first saves; OPEN-04 verifies malformed/wrong-date responses; OPEN-05 verifies asynchronous invalidation; OPEN-07 and OPEN-10 verify HTTP/read-only behavior; OPEN-08 checks generated invariants.

Reproduce from the repository root:

```sh
bash server/tools/dispatch-plan-open-recovery-test.sh
bash server/tools/dispatch-plan-open-recovery-gauntlet.sh
```

The gauntlet records baseline failures, checks final failure equality, runs types/lint/mutations and inspects V8 ranges. Dependencies and every test container are bounded in `mbbs-tests.slice`, and cleanup is registered before launch. No production credentials or data volumes enter test containers.

Limits: the full backend suite was not rerun because production changes are limited to two browser files; backend save behavior was exercised by the guarded operational rehearsal and actual save. No interactive browser session was automated. The real application endpoints, served assets and normal bootstrap were verified. Full-suite randomized ordering was not run; suites ran serially and the focused suite was repeated in the candidate image. The scope excludes unrelated baseline failures.

## Deployment and final checks

Deployed only `public/dispatch.js` and `public/dispatch.html` over the then-current production image, preserving another release made during this task. Image: `sha256:111c558c291a5b3fc76579d804090d67610e58c566fd094588a6b82fd4fe7421`. Configuration and the database, webhook worker and Ollama containers were unchanged. Exact image rollback and baseline files are retained under `server/deployments/dispatch-plan-open-recovery-20261008/`.

The first image preparation failed because BuildKit treated a raw image ID as a registry image name. Production was untouched. Retried successfully with a local rollback tag; both logs are retained.

Local and public application health returned HTTP 200, both served browser files matched their expected hashes, and unauthenticated plan access remained HTTP 401. Final read-only verification at 2026-10-08T17:42:20Z loaded revision 62 through normal bootstrap, found all 16 loads and SN1402231, and found zero executed-prefix conflicts. The original recovery snapshot and completed follow-up were verified.

After teardown, both `docker ps` and `docker ps -a` contained only the four production containers. No disposable test volumes or test networks remained. Production health passed. Private operational captures have restricted permissions.
