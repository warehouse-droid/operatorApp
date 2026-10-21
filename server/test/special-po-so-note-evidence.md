# Special Request PO Note evidence

Deployed and verified.

The subsequently authorized PO/TO Schedule release is deployed at 2026-10-01T03:32:07.393952+00:00. The current app is `mbbs-operator-app:special-po-mini-rows-20261001` (`sha256:f5b723bd222430ba2d21d5c3e86fb44cd96144ee0a29a42e961435fe083d5151`), layered over the Note app listed below. The Note worker remains the image listed below. Note source and POB03976's `for SOB121819` Note were verified intact. The original Note image verification describes the Note publication; read-only verification of the current combined app is `python3 tools/special-po-mini-rows-deploy.py verify`. [Schedule deployment evidence](scm-schedule-multi-sort-deploy-evidence.md) records its checks and the successful retry after a public connection timeout triggered automatic image rollback.

Prepared behavior: new Special Request POs use `custbody7: "for <SO number>"`. The Special Request mini bar reads and saves the linked real NetSuite PO Note. PO Split Remark/Note edits use the existing local schedule API. The Note remains distinct from the PO memo/Remark and pickup instructions. Existing PALLET and routing behavior is retained.

Spec approval: not obtained (autonomous run). [Acceptance spec](special-po-so-note-spec.md) records the user clarification and the source isolation decision. Calibration: Tier 3, purchasing and an authenticated remote write endpoint. These checks support the stated scenarios; the spec has not had independent human review.

| Check | Result from the final scoped source |
| --- | --- |
| Focused unit, PostgreSQL, REST/HTTP and browser tests | 33/33 pass |
| Affected suite, including existing regressions | 108 tests: 95 pass, 13 existing fixture failures, 0 skipped; zero new failures |
| Source-before baseline with the added history assertion | 75 tests: 61 pass, 14 fail; 13 existing fixture failures plus the newly added history Note assertion failing against old code |
| Added history Note assertion | Passes in the final source; its manual mutant is killed |
| Syntax | All 13 selected JavaScript files pass |
| Types / lint | Zero new diagnostics/findings; the two new runtime modules have zero own type errors; focused tests and check helpers lint cleanly |
| Changed-line coverage | 203/203 measured changed lines; 99/111 measured branches |
| Manual mutation | 9/9 killed; 2/2 rerun against properties alone and killed |
| Property checks | 200 SO-number cases, seed 2026100117; exact Note and unchanged purchasing payload |
| Suite health | Focused suite repeated successfully; explicit Node runner API file permutation passes 33/33 |
| Worker candidate | Actual Note list/target/reference/history reads, canonical sync, mirror, partial payload preservation and clearing pass |
| Exact app candidate | Same 108/95/13 affected-suite result and failure names; no new failures |
| Supply chain / secrets | No dependency or lockfile changes in the release; scoped secret scan passes |
| Runtime images | Built offline over each service's own deployed parent; full source trees, production dependency imports and runtime configuration checks pass |

The 13 remaining failures reject older test fixtures without an active NetSuite customer. They occur with the source before this change and with the final source. The added history assertion was also present in the before-source run and failed on its expected missing Note; it is a RED assertion, not a pre-existing failure. Full logs and names are retained in [check results](../test-artifacts/special-po-so-note-20261001/checks.json), [baseline log](../test-artifacts/special-po-so-note-20261001/baseline-tests.log) and [final log](../test-artifacts/special-po-so-note-20261001/final-tests.log).

| Acceptance scenario | Executed evidence |
| --- | --- |
| 1. Correct SO number, whitespace and exact Note field | `special-po-so-note.test.js` unit payload/property tests and integration standalone POST |
| 2. Hydrate missing SO number; stop before posting if unavailable; omit test-only missing SO | Unit service tests, including action order and zero remote submission assertions |
| 3. Retain material/PALLET quantity, units, cost, discount, memo, marker and origin | Exact payload assertions, 200 property samples, existing discount/PALLET/standalone unit suites and real REST-boundary POST integration |
| 4. Lost POST response recovers marker without another PO or SO edit | Unit recovery and both standalone POST transport integrations |
| 5. Correct Note survives query reads, canonical/mirror/history sync, partial data and clearing | PostgreSQL integration, real history service test and exact worker candidate checks |
| 6. Actual Note mapped separately from Remark and pickup instructions; local overrides/aliases retained | PostgreSQL catalog/schedule assertions and browser alias / two-page round trip |
| 7. Additive idempotent schema and scoped release preserving unrelated work | Migration runs twice in isolated integration; memo/cost/location retention assertions; selected-file diffs, source hashes and parent-image/configuration checks |
| 8. Real PO identity, stale Note/case/schedule, verified PATCH-only-Note, retries, auth and rollback | `special-po-note-edit.test.js`, `special-po-routing-note-service.test.js`, actual Express HTTP tests and full schedule-row rollback assertion |
| 9. Split edits stay local; real Note remains independent | Browser and real HTTP round trips through both save paths; count of remote writes remains unchanged by split saves |

The nine mutants cover the wrong Note field, wrong prefix, fabricated empty SO Note, ignored existing marker, invalid input acceptance, stale Note overwrite, writing memo instead of Note, sending the real Note into local routing, and dropping Note during history sync. Source hashes are verified unchanged after restoration.

The RED records contain 15 expected failures out of 19 Note tests and seven expected failures out of ten routing/browser tests. Initially passing blank-SO, marker recovery and invalid-input guards are covered by the final mutants; previously existing browser checks remain regression coverage. Early HTTP fixture errors were corrected to use the valid customer/UOM/schema contracts and reliable cleanup. New implementation type errors were fixed. A coverage attempt incorrectly attributed an unchanged closing brace to an insertion; hash-verified histogram diffs measure the actual changed lines without excluding structural lines. Concurrent schedule-filter edits caused the source-hash check to reject a stale runner copy; the frozen feature snapshot keeps them out of this release while preserving them in the workspace. A worker patch placement conflict was corrected and both scoped patches subsequently applied with zero fuzz.

Known validation limits: the full repository suite was not run; the affected scope is the 19 suite files listed in `tools/special-po-so-note-suites.mjs`. Twelve measured branches remain uncovered and are listed in [coverage](../test-artifacts/special-po-so-note-20261001/changed-lines.json). No live test PO was created and no live Note was edited for validation; actual NetSuite REST and SuiteQL reads confirmed POB03976's Note is `for SOB121819` and its memo is `Pickering Yard - Unilock`. Remote writes were exercised through the real transport against local boundary fixtures. External NetSuite edits between the pre-write read and PATCH are not an atomic compare-and-swap; local saves are serialized and stale values are checked immediately before writing. No latency budget was supplied, so no benchmark was added. A destructive schema down migration is intentionally absent: image rollback retains the nullable column. Idempotence and local transaction rollback were tested; a live rollback rehearsal was not performed. Dependency audit/license checks were skipped because the dependency set was unchanged. No Git commits or agents were used.

Tools: node v20.20.2, coverageDiffGit git version 2.53.0, typescript 7.0.2, eslint 10.8.0, c8 12.0.0, fast-check 4.9.0, @playwright/test 1.62.1.

Feature source identifier: `6a4100ef70f18fd378bc3cd9577b0951ef566f61074691354fccc75e25bc188c` (SHA-256 of sorted file/hash pairs). The complete 15-file hash list is in `checks.json` and the immutable scoped files are under `test-artifacts/special-po-so-note-20261001/feature-source`. Workspace hashes are recorded separately because the shared schedule file contains concurrent filter edits.

| Service | Prepared image | Image ID | Runtime tree files | Runtime tree hash |
| --- | --- | --- | --- | --- |
| app | `mbbs-operator-app:special-po-so-note-app-20261001` | `sha256:f5635b999dd2e7cb43bb98da80144c41ca8d93fdb414207adc81fef4f2ff5164` | 1171 | `c7e4b857d5578edcd01fe57c81e9dfb8ab60de15c94135533e08df02f25df616` |
| webhook-worker | `mbbs-operator-app:special-po-so-note-webhook-worker-20261001` | `sha256:0af94b746a117b1be9c34d61fe9fa2c277899c0f144ffdb3b7bdc19bafbd0fb0` | 1113 | `94dedd0dcd8bb4ae48b888550e90075d8d18dec7e6a065cd5bca690e4eca63f6` |

Live verification: `SPREQ-000017`, `POB03976`, Note `for SOB121819`; new-PO draft Note `for SOB121819`. Health, served assets, source trees and configuration passed. The PALLET remains quantity 1 at cost 35. The payload was not submitted and NetSuite verification was read-only.

Reproduce all validation using the existing isolated runner/database/Chromium setup:

```sh
python3 tools/special-po-so-note-run.py gauntlet
```

The persisted entry point restores the frozen feature source, generates hash-verified diffs, and runs types, lint, affected/focused tests, coverage, worker checks, explicit file-order permutation, all mutants and the scoped secret scan. It uses the preserved before-source snapshot and recorded installed tool versions. Release candidates and reviewable patches are under `deployments/special-po-so-note-20261001`. Deployment is `python3 tools/special-po-so-note-deploy.py apply`; it requires explicit approval, checks for active operations, migrates transactionally, replaces only app/worker, verifies read-only live evidence and restores the captured images on failure. Read-only re-verification after deployment is `python3 tools/special-po-so-note-deploy.py verify`.

Generated: 2026-10-01T04:01:31.470811+00:00.
