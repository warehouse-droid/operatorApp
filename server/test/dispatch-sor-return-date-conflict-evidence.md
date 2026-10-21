# SOR return date-conflict evidence

The blocker incorrectly treated the CUSTOM order SOR00221-Return as a split of SOR00221. Production read-only diagnosis found only the delivery assigned to plan 350 on 2026-10-08; the return remained open and unassigned. Recovery drafts 19659 and 19661 retained the rejected October 14 changes. The correction separates custom work from delivery split ownership while retaining exact-reference duplicate protection.

Status: deployed and verified at 2026-10-14T16:03:43Z after the user explicitly requested `deploy`. Automatic approval review initially rejected the app replacement because the original request did not explicitly authorize restarting production. The authorized cutover succeeded; live runtime hashes match the verified fix, application configuration is preserved, and the database, worker, and Ollama containers are unchanged.

Spec approval: not obtained (autonomous run). See dispatch-sor-return-date-conflict-spec.md; confidence is limited to its stated constraints and the evidence below.

## Reproduce

From the repository root, run `python3 server/tools/sor-return-date-conflict-20261014/run.py final`. This uses the standard isolated Compose configuration, mbbs-tests.slice, disposable databases, and registered finally teardown. Runtime source is captured in tools/sor-return-date-conflict-20261014/baseline and candidate. No dependencies or migrations were added; no commits were created.

Verified source state: `b007e9bab018fd5dee7da78486f8cd8055d1a3cbe34fcd9026ed9ded057880cb`. Exact runtime hashes and installed tool versions are in test-artifacts/sor-return-date-conflict-20261014/scope.json. Node version: v20.20.2.

## Acceptance mapping

| Constraint | Verification | Result |
| --- | --- | --- |
| Later return booking succeeds in classic and V2 saves; earlier delivery route is preserved | integration/dispatch-sor-return-date-conflict.test.js, first two tests | pass |
| Return reserves only itself, including legacy custom markers, split-delivery returns, and grouped cargo | unit/dispatch-sor-return-date-conflict.test.js, marker/group cases and seeded property | pass |
| Exact duplicate return rejects, retains recovery draft, and preserves active route/revision | integration/dispatch-sor-return-date-conflict.test.js, duplicate test | pass |
| Scheduling a return does not reserve its delivery | integration/dispatch-sor-return-date-conflict.test.js, final test | pass |
| Genuine whole-parent, exact-split, and sibling-split rules survive | existing unit/integration/dispatch-split-date-conflict.test.js plus new genuine-split test | pass |
| Unassigned definitions and empty yard-return loads reserve no work | new unit test and existing split-date tests | pass |
| Existing leases, save recovery, quantities, driver readiness, and SOR lifecycle remain compatible | 8 paired regression files and complete Dispatch component comparison | no new failures; existing failures retained |

## Final verification

| Layer | Actual result |
| --- | --- |
| New focused tests | 14 passed, 0 failed; reversed file order also passed all 14 |
| Focused run plus adjacent regression files and order reversal | 93 tests: 91 passed, 2 pre-existing failures, 0 new failures |
| Complete Dispatch component comparison | 316 files per run; baseline 1956 reported tests, 1786 passed, 170 failed; candidate 1956 reported tests, 1832 passed, 124 failed; 0 new named-case or file failures |
| Static types | 21204 baseline diagnostics and 21204 candidate diagnostics; 0 new diagnostics |
| Lint | 0 new runtime diagnostics; 0 new-test diagnostics |
| Changed-line coverage | 7/7 changed executable lines covered |
| Manual mutations | 5/5 killed by focused tests; 5/5 killed by the property alone |
| Seeded properties | 100 generated cases, seed 20261014; existing split property also retained |
| Real execution | Authenticated classic and V2 HTTP saves with canonical synthetic return records and a real disposable PostgreSQL database |
| Dependencies and capabilities | No new dependencies, network calls, environment access, or external capabilities in the runtime patch; 8 added diff lines scanned for secret-bearing constructs |
| Cleanup | Compose down --volumes --remove-orphans succeeded; docker ps and docker ps -a contained only the four production containers; no task test networks or volumes remained; production health passed |

Raw results, all pre-existing failure names, source hashes, coverage, mutations, and teardown listings are retained under test-artifacts/sor-return-date-conflict-20261014. Do not attribute every difference in broad-suite pass counts to this fix; baseline source-copy and harness context can affect unrelated tests.

## Limits and corrections

The camera rollback browser file exceeded the existing 90-second deadline in both component runs and is unverified. The broader MBT application baseline was interrupted after 576/986 files had started because unrelated Aggregate and bin-planning browser tests hung. Its partial logs are retained; no complete application-wide pass or comparison is claimed. The full Dispatch component suite is the planner release gate.

Initial new HTTP fixtures lacked canonical Custom Order IDs and used unpadded dates. Those fixtures were corrected before implementation; the final RED run reproduced the actual DISPATCH_ORDER_ALREADY_PLANNED defect in both save paths. No behavioral assertions were weakened to make the implementation pass.

A concurrent PO release changed the live image during verification. Both planner files remained byte-identical to the captured baseline. The initial candidate preserved that release; a first two-COPY build failed with `mount options is too long`, and a single-COPY build succeeded with a bounded syntax/hash check.

After approval, another release updated the app to `mbbs-operator-app:mbr-rates-20261014`; the guarded deployment stopped before changing production. Its two planner files still matched the tested baseline. The new image was exactly the earlier image plus one file-only layer, with identical image configuration. Adding another COPY exceeded Docker's mount-option limit. `combined-build.py` verified the exported layer's uncompressed digest, retained its nine files and permissions, added the two verified planner files in a local tar, and built a single ADD layer on the earlier image. No production container filesystem or data volume was exported. The resulting image retained the same 387-layer count. A bounded disposable container checked syntax and compared hashes and permissions of all 1,383 application files against the live app; only the two verified planner file contents differed. Cleanup removed the validation container. Original preparation, rebase, and complete inventory artifacts are retained in the release directory.

Deployed image: `mbbs-operator-app:sor-return-date-conflict-20261014`, ID `sha256:fc5f2682c415de1aa91fcaf81197c0847fafed1e54d99b6da5f127e46bc1040c`. Rollback image: `mbbs-operator-app:rollback-sor-return-date-conflict-20261014`, retaining the MBR rates release. Image and Compose configuration comparisons passed. The app-only cutover checked active posting work, preserved configuration and dependencies, verified health and exact runtime hashes, and provided automatic rollback on verification failure. It did not apply or restore the user's operational draft. Deployment results are retained in deployments/sor-return-date-conflict-20261014/deployment-result.json and test-artifacts/sor-return-date-conflict-20261014/deployment-result.json.
