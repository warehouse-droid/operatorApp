# Executed source updates: verification evidence

Spec approval: not obtained (autonomous run). Tier 3. This report verifies the requested behavior within the scenarios below; it is not a claim that every production scenario is covered.

Verified source changes no longer require acknowledgement before saving Dispatch work. A separate persistent warning explains what changed and records the dispatcher's explicit confirmation of that source version. The submitted refresh is reconciled to the recorded execution snapshot; the authoritative source order stays updated. Manual removal, reordering, reassignment and unverified cargo changes retain the prefix lock.

GOA-8930-8931 and SOA08930 keep their valid address when a refresh/draft contains blanks. Explicit blank edits fail in the browser and API. TOB01111 warns about the removed PER-MM80S-2237-SCG line (326.48 SQFT), PALLET quantity 29 → 25 EACH, and separately labelled calculated pallet changes. The warning does not claim the dispatcher made the source edit or that it happened after execution.

## Final run

- Isolated Executed source review run passed: 24 file(s), 107 test(s).
- Isolated Executed source review run passed: 24 file(s), 107 test(s).
- New broader-suite failures: 0. See the exact baseline/current summaries and failed test names in `test-artifacts/executed-order-review/evidence-final.json`.
- New lint/type diagnostics: 0 / 0. Existing diagnostics remain (lint: 2154; TypeScript output lines: 271).
- Four new feature modules: 473/473 lines executed; 79.43% branches; 100% functions.
- Deliberate regressions detected: 7/7. The property suite alone detected all 5 applicable domain/address mutants.
- Credential-pattern scan: 0 hits. No dependencies added. Docker image: `sha256:a213a201d54066121bc474fd418fe25417cc595bfc4be21abd3cefcd0cd6e6a2`.
- Source tree SHA-256: `69429c7780c4d799030d11aadc820a78fd673cc97090722c0290ec0848b95822`. All file hashes and tool versions are in the machine-readable report. Existing workspace changes were preserved; no commit or staging was performed.

## Scenarios and evidence

| Requirement / failure mode | Executable evidence |
| --- | --- |
| TOB01111 line removal, quantity/derived-total warnings | `test/dispatch/unit/dispatch-executed-order-review.test.js`; exact minimized incident fixture/test |
| GOA-8930-8931 nested blank address, immutable/idempotent refresh | Domain unit/property tests; existing split-address, stale-address and grouped-action suites |
| Save before confirmation, keeping job records and stops | `test/dispatch/integration/dispatch-executed-order-review.test.js`: actual HTTP PUT, V2 command save, snapshot restore |
| Source address/yard copied directly to an executed stop | Domain source-stop regression and command/restore integration scenario |
| Warning survives save/reload, newer update needs another confirmation | Persistent-ledger integration tests and source-version properties |
| Authentication, edit lease, invalid/stale tokens, concurrent acknowledgement | HTTP and adversarial integration cases; concurrent attempts produce one audit entry |
| Driver prefix still protected | Existing prefix unit, contract, property, adversarial, integration and concurrency suites; forged cargo/source properties |
| Browser warning, nonblocking save, explicit confirmation, blank form, HTML escaping | `test/dispatch/frontend/dispatch-executed-order-review.browser.test.mjs`, full Dispatch script in Chromium |
| Atomic migration rollback | Review-table drop/reapply within a rolled-back transaction in the disposable database; original observations recovered exactly |
| Real incident replay | `tools/executed-order-review-replay.mjs` plus `test/dispatch/fixtures/executed-order-incidents.json` |

The isolated Docker network has a fresh PostgreSQL database and does not load a production environment file. Integration tests seed executed driver work, modify the local NetSuite mirror, and exercise the real application/repositories. This simulates data after NetSuite ingestion; incoming webhook delivery is not replayed. The browser uses mocked network boundaries and the actual frontend implementation.

## Reproduce

Run `bash server/tools/executed-order-review-gauntlet.sh` from the repository. `EXECUTION_REVIEW_BASELINE` may select the pre-change source capture. The default capture is under `server/test-artifacts/executed-order-review/baseline`; a clean commit cannot represent that initially dirty workspace. The runner creates and removes disposable internal Docker networks/databases and requires the recorded local test image. Runtime versions are recorded in `versions-final.json`.

## Failures found and limits

Initial tests exposed missing source-review behavior; the user's clarification replaced the initial acknowledgement save gate with an independently persisted review. Further tests found grouped PO reset handling, legacy aliases, stop-level source refresh cases, and PO pickup metadata that must remain separate from delivery data. These were fixed without removing the prefix-lock assertions. The source-stop RED run had 14 passes and 1 assertion failure before implementation; the PO pickup regression had 15 passes and 1 assertion failure before its fix. One integration fixture initially changed a TO dispatch override that did not change its canonical destination; it was corrected to update the actual mirrored destination and now explicitly asserts that the source address changes. The first migration attempt used a bigint actor key; it was corrected to match the existing text operator ID before release.

The first coverage command inherited the unrelated `src/mbt` branch threshold and failed despite passing tests. The final feature command explicitly reports branches separately and gates 100% line execution for its four new modules. An intermediate report overlapped the last implementation edit and was discarded; the affected suites, coverage and mutations were repeated on the final source. Full changed-line coverage across the existing application files and browser was not measured. These paths have functional/contract tests. JavaScript outside the repository TypeScript configuration is not fully type-checked. Complexity review was manual under the existing Dispatch lint profile. Secret scanning uses explicit patterns; no external vulnerability/license audit was needed because dependencies did not change. There was no production-sized latency benchmark or live NetSuite write.

## Release state

Deployed to the live app and webhook worker on **25 September 2026 at 20:29 UTC**,
as part of the explicitly authorized complete worktree release. Migration
`212_dispatch_executed_order_reviews.sql` was applied before the new app started.
Fresh release checks and the exact image/source identities are recorded in
[the whole-worktree deployment evidence](whole-worktree-deployment-20260925-evidence.md).
The runtime file list remains `tools/executed-order-review-files.json`. A rollback
to the previous app image can retain the additive review table and acknowledgements.
