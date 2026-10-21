# PO/TO schedule search evidence

This report records the initial deployment. The user subsequently clarified
cross-yard search; see the [deployed correction and current evidence](scm-schedule-search-yards-evidence.md).

Deployed to the live application on 2026-10-14 after the user's explicit
deployment instruction. The running application is healthy.
Sales and Dispatch global search spans views, column filters, statuses and types,
including Completed, Cancelled, Blanket, special POs, TOs, VRMAs and closed or
inactive orders. Hold remains excluded. Clearing search restores selected filters.
Sales yard authorization and existing API/write permissions remain enforced.

Tier 3. Spec approval: not obtained (autonomous run); the user explicitly
corrected the requirement to exclude Hold. Confidence is limited to the scenarios
in [the specification](scm-schedule-search-spec.md); no absolute correctness claim.

Reproduce the final affected-schedule gauntlet from the repository root:

```sh
python3 server/tools/scm-schedule-search-20261014/run.py all
```

The command uses the recorded current-workspace baseline in
`server/test-artifacts/scm-schedule-search-20261014/before`. It launches the
standard isolated Compose configuration with bounded resources in
`mbbs-tests.slice` and always tears down containers, volumes and networks.
The original default-suite baseline is reproducible with the same command
using `baseline` instead of `all`.

Final fresh run: [validation and source hashes](../test-artifacts/scm-schedule-search-20261014/validation-all.json),
[task-only patch](../test-artifacts/scm-schedule-search-20261014/changes.patch),
[results](../test-artifacts/scm-schedule-search-20261014/checks-all.json).
Source hashes were verified unchanged after completion. Node 20.20.2,
Playwright 1.62.1, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0 and TypeScript 7.0.2;
no dependencies or commits were added.

| Layer | Final result |
|---|---|
| Search, policy and real HTTP/browser acceptance tests | 27 passed, 0 failed |
| Same acceptance files in reversed order | 27 passed, 0 failed |
| Affected schedule regression set | 57 passed, 1 pre-existing failure; 0 new failures |
| Changed executable lines | 71/71 covered: visibility 15, routes 28, SQL repository 13, browser 15 |
| Manual mutation | 7/7 deliberate regressions detected; restored implementation passed |
| Properties | 2 properties, 200 generated cases each per run |
| Real browser interaction | Sales and Dispatch passed search, rendered-row, permission and clear-search checks |
| Syntax | 10 JavaScript files passed; Python runner/report scripts parsed successfully |
| Lint | 0 new findings; 45 existing findings in legacy runtime files remained unchanged |
| Repository type check | 889 existing errors; 0 new errors |
| Secret scan | 0 findings in the task-only patch |
| Cleanup and live health | No test containers, disposable volumes or networks remained; production health passed |
| Complete default repository suite | Unverified: original baseline exceeded 900 seconds in an unrelated aggregate-request browser test |

Acceptance mapping:

| Spec scenario | Verifying tests | Result |
|---|---|---|
| Search across statuses, types, views and filters | Frontend surface matrix; HTTP role matrix; real browser test | Pass |
| Hold excluded before and after reconciliation | HTTP matrix and held fixture; final-response policy test; frontend matrix | Pass |
| Clearing or whitespace restores browse rules/preferences | Frontend storage/clear test; HTTP blank-search test; browser clear test | Pass |
| Sales authorized yards and combined yards | HTTP yard-scope and targeted-outside-yard tests; real browser test | Pass |
| Existing role, authentication, detail and write permissions | HTTP unauthorized/wrong-role/Yard Manager/write tests; policy matrix | Pass |
| Existing SCM structured search remains intact | Frontend and HTTP SCM structured-search tests | Pass |
| Case-insensitive matching and no results | Frontend property; HTTP partial-reference/no-match test | Pass |
| Existing schedule behavior outside the requested change | Affected schedule regression set | Pass except the pre-existing cache assertion |
| No dependency or production-data changes | Task-only patch review; isolated Compose environment and teardown evidence | Pass |
| Full repository regression comparison | Default-suite baseline | Unverified; timeout described below |

The existing regression failure is
`scm-schedule-remarks-ui.red.test.js::each changed page carries its current fresh cache key`.
It asserts historical literal asset versions for Schedule and PO Split and also
failed on the original source. The Schedule asset now has its new search cache
version. The original full default suite did not complete within 900 seconds;
`aggregate-request-browser.test.js` was still running. Neither unrelated issue
was repaired or hidden. [Baseline regression log](../test-artifacts/scm-schedule-search-20261014/baseline-regressions.log),
[final regression log](../test-artifacts/scm-schedule-search-20261014/all-regressions.log),
[full-suite limit](../test-artifacts/scm-schedule-search-20261014/baseline-full-suite-limit.json).

The seven mutants restored client filter restrictions, removed Sales historical
visibility, reversed the final Hold filter, enabled broad policy for empty search,
removed Sales yard scoping, restored the Blanket query gate, or restored the
cancelled-split query gate. All were detected by behavioral assertions.
Replaying only the property tests detected 2/7: client filtering and empty-search
policy. The other five involve response/database boundaries or final Hold
filtering and are covered by the explicit unit, HTTP and browser tests; the
properties alone do not establish those guarantees.
[Mutation results](../test-artifacts/scm-schedule-search-20261014/mutations.json).

Verification setup corrections: the first test cleanup used a numeric array for
text operator IDs; it was corrected before the final RED run. Test row matching
was directed through the actual filter matcher instead of the sorting function.
The original application then failed 18/22 new acceptance checks. The first static
run hit the container memory limit; compiler execution was moved before lint and
bounded without increasing container budgets. The runner was also corrected for
the native compiler's error exit code while retaining the zero-new-errors check.
Final results above come from the successful fresh run after those corrections.

The original implementation verification performed no production deployment,
migrations, NetSuite writes or operational-data changes. Its live-source snapshot
recorded the deployment as pending at that time.
[Original live source status](../test-artifacts/scm-schedule-search-20261014/live-source.json),
[cleanup and production health](../test-artifacts/scm-schedule-search-20261014/cleanup-all.json),
[coverage](../test-artifacts/scm-schedule-search-20261014/changed-coverage.json),
[static checks](../test-artifacts/scm-schedule-search-20261014/static.json).

No production-data performance benchmark was run; no latency budget was stated.
No concurrency behavior was changed. Supply-chain audit/license changes are
not applicable because the dependency set was unchanged.

Deployment verification: the release overlays exactly five runtime files on
`mbbs-operator-app:app-notification-attention-20261014`, preserving the newer
notification update and 1,382 other source/package files. The merged candidate
passed all 27 search/policy/HTTP/browser checks and actual-image startup in the
bounded disposable Compose environment. That environment and its database were
removed before the live restart.

The live image is `mbbs-operator-app:scm-schedule-search-20261014`, ID
`sha256:556c965656ab152a85751c92af4510308da06abb2d00c20a72f3b13849abb5aa`.
Its complete captured source/package tree matches the validated candidate, tree
hash `2b776879a4b9610a5d5ef7c98e9f5c456b7f97f72d7e95652b28e565e643d5b8`.
Application configuration is unchanged; the DB, webhook worker and Ollama
containers are unchanged. No production schema or operational data changes were
performed. The former live image is retained as
`mbbs-operator-app:scm-schedule-search-rollback-20261014` for rollback.

Before/after live HTTP probes ran in bounded, labelled one-off containers in
`mbbs-tests.slice`, with registered teardown. Both Schedule pages and the new
versioned JavaScript asset return 200; the served script hash matches the image.
Both schedule APIs still return 401 without authentication. Production /health
passes. Final `docker ps` and `docker ps -a` contain only the four production
containers, with no disposable test containers, volumes or networks left.

[Candidate validation](../test-artifacts/scm-schedule-search-20261014/release/candidate-validation.json),
[deployment result](../test-artifacts/scm-schedule-search-20261014/release/deployment.json),
[live verification](../test-artifacts/scm-schedule-search-20261014/release/live-verification.json),
[candidate cleanup](../test-artifacts/scm-schedule-search-20261014/release/cleanup.json),
[live-probe cleanup](../test-artifacts/scm-schedule-search-20261014/release/live-after-cleanup.json).
The reproducible release workflow is
`python3 server/tools/scm-schedule-search-20261014/release.py prepare`,
then `validate`, then `deploy`; `verify` rechecks the deployed release.
