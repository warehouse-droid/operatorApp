# Cross-yard PO/TO schedule search correction

Deployed on 2026-10-14. A Sales account assigned only to 3445 can now search
matching schedule orders across 3445, 2967, 150 and 12441. Search still spans
statuses and order types and excludes Hold, including reconciliation-applied
Hold. Clearing search or entering only whitespace restores the account's normal
yard scope and saved filters. Existing authentication, detail and write
permissions remain enforced.

The original implementation retained Sales yard scope during global search.
The user's EKO70S report explicitly superseded that requirement; the amendment
is recorded in [the append-only specification](scm-schedule-search-spec.md).
Tier 3; spec approval: not obtained (autonomous run). Existing session deployment
authorization was used. Confidence is limited to these tested scenarios.

The runtime correction is one conditional in the Sales schedule route: apply
account yard scope during ordinary browsing and return all matching yards during
an authorized nonblank search. No dependencies, API shapes or database schema
changed. No commits were made in the shared dirty workspace.

Reproduce the complete correction gauntlet from the repository root:

```sh
python3 server/tools/scm-schedule-search-yards-20261014/run.py all
```

The task baseline, toolchain versions, logs, screenshots, task patch and hashes
are preserved under `server/test-artifacts/scm-schedule-search-yards-20261014`.
The runner uses the repository's standard isolated Compose configuration, bounded
resources in `mbbs-tests.slice`, and pre-registered teardown. All test databases,
containers, disposable volumes and networks are removed on completion or failure.

| Check | Final result |
|---|---|
| Search, HTTP, browser and policy acceptance checks | 29 passed, 0 failed |
| Same acceptance files in reverse order | 29 passed, 0 failed |
| Affected schedule/Sales regression checks | 58 passed, 1 pre-existing failure; 0 new failures |
| Changed executable coverage | 1/1 changed line; 3/3 reported changed branches covered |
| Mutation checks | 3/3 detected; restored implementation passed |
| Property checks | Two existing properties, 200 generated cases each per run |
| Syntax | 10 JavaScript files passed |
| Lint | 0 new findings; 45 existing runtime findings unchanged |
| Repository type check | 889 existing errors; 0 new errors |
| Task patch secret scan | 0 findings |
| Exact merged release candidate | 29 passed; actual image startup and health passed |
| Live verification | Source tree, configuration, authentication and health passed |
| Cleanup | Both docker ps and docker ps -a contain only the four production containers |

The RED run against the previous implementation failed four behavioral checks:
Sales global search, cross-yard reference search, the reported EKO70S API case,
and the real browser search. Ordinary browsing scope already passed before the
fix and was subsequently broken by deliberate mutants to confirm its assertions.

| Required behavior | Verification |
|---|---|
| EKO70S under a Sales account assigned only to 3445 | Real PostgreSQL/HTTP fixture: TO to 3445 plus POs to 2967, 150 and 12441; exact returned references and all four destinations asserted |
| Cross-status/type search despite selected filters | API role matrix and both real browser surfaces; EKO70S fixtures include Queued, Completed and Cancelled POs |
| Hold excluded | Explicit Hold fixtures in all three other yards, original Hold fixtures and reconciliation-applied Hold; final response and browser assertions |
| Normal browsing stays yard-scoped | Empty and whitespace Sales requests exclude all three other yards and retain a local row; browser clearing restores preferences and normal rows |
| Authentication and write/detail permissions retained | Unauthenticated/wrong-role/Yard Manager requests and Sales/Dispatch write denials; no reconciliation detail exposure |
| Existing SCM structured search retained | Existing API and frontend structured-search checks |
| Unrelated live updates preserved | One-line production patch and complete captured source-tree comparison |

The three mutants restore the unconditional yard restriction, remove yard scope
from ordinary browsing, and invert the search condition. All fail behavioral
assertions. Property-only replay detects 0/3: the properties cover the shared
search policy and frontend matching, while these new yard-boundary guarantees
are verified by the explicit HTTP/browser tests. No broader property guarantee
is claimed.

The pre-existing failure remains
`scm-schedule-remarks-ui.red.test.js::each changed page carries its current fresh cache key`.
It fails in both this correction's RED baseline and final regression comparison.
The complete default suite was not repeated: the original task's unchanged
baseline exceeded 900 seconds in `aggregate-request-browser.test.js`; that limit
and evidence remain recorded in the original report. Full-suite comparison is
unverified. No production-data performance benchmark was requested or run, and
concurrency behavior did not change. Dependency audit/license changes are not
applicable because the dependency set is unchanged.

The release was merged onto `mbbs-operator-app:backorder-material-layout-20261014`, preserving intervening
notification and layout updates. Only `src/server.js` changed, by the single
conditional line; 1386 other source/package files are identical.
The candidate passed all acceptance checks before restarting only the app.
Database, webhook worker and Ollama containers and production configuration
are unchanged. No production migrations or operational-data writes were performed.

Live image: `mbbs-operator-app:scm-schedule-search-yards-20261014`.
Image ID: `sha256:bf2c8578c4800f575b23636450faf74a4bb4f6c18c5068a40d890e88d622bd92`.
Verified source tree: `a3a74f4bbace62300ffcac16e4a8145f3bf083d987dc6791ea9de6e2dbe51757`.
The prior live image is retained as
`mbbs-operator-app:scm-schedule-search-yards-rollback-20261014` for rollback.
The served Sales and Dispatch pages and schedule asset return 200; both schedule
APIs retain unauthenticated 401 responses. Production `/health` passes.

[Acceptance and regression results](../test-artifacts/scm-schedule-search-yards-20261014/checks-all.json),
[coverage](../test-artifacts/scm-schedule-search-yards-20261014/changed-coverage.json),
[mutations](../test-artifacts/scm-schedule-search-yards-20261014/mutations.json),
[static checks](../test-artifacts/scm-schedule-search-yards-20261014/static.json),
[source hashes](../test-artifacts/scm-schedule-search-yards-20261014/validation-all.json),
[one-line production patch](../test-artifacts/scm-schedule-search-yards-20261014/release/production.patch),
[candidate validation](../test-artifacts/scm-schedule-search-yards-20261014/release/candidate-validation.json),
[deployment](../test-artifacts/scm-schedule-search-yards-20261014/release/deployment.json),
[live verification](../test-artifacts/scm-schedule-search-yards-20261014/release/live-verification.json),
[test cleanup](../test-artifacts/scm-schedule-search-yards-20261014/release/cleanup.json),
[live probe cleanup](../test-artifacts/scm-schedule-search-yards-20261014/release/live-after-cleanup.json).

Release workflow: `python3 server/tools/scm-schedule-search-yards-20261014/release.py prepare`,
then `validate`, then `deploy`; `verify` rechecks the deployed release. Recorded
release directories are intentionally retained as rollback and operational audit
evidence and are outside test cleanup.
