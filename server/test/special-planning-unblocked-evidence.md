# Dispatch planning restrictions — evidence, 2026-10-12

Deployed at 2026-10-12T04:24:50.907244+00:00. The live Dispatch feed and shared planning
validators now admit SOB122402, SOB122131 and SOB122133. The release changes
only three planning modules and preserves application configuration, production
data, other services and existing request/packing facts.

SOB122402 / SPREQ-000070 was blocked by Special Attention after an additional
Delivery Charge line (item 1987) appeared on the SO. SOB122131 / SPREQ-000030 and
SOB122133 had packing-only reconciliation Review. The latter has no Special
request. The shared Special-request planning hook now accepts all case states
without querying or locking the case. SO planning ignores packing-only Review;
current member authority also repairs stale group-card restrictions. Actual
reconciliation defects, completion, leases and revision fences remain enforced.
Packed and loaded orders retain their existing splitting restrictions.

The [acceptance specification](special-planning-unblocked-spec.md) records the
user's requests, packing clarification and failure model. Spec approval: not
obtained (autonomous run). Tier 3 verification is scoped to the affected planning
API and policy. No new dependencies, migrations or checkpoint commits were added.

## Measured final results

| Layer | Actual result |
| --- | --- |
| Original-code acceptance reproduction | 41/78 tests fail, including HTTP 202 recovery results instead of applied saves |
| Cached-group reproduction before its fix | 1 real assertion failure; corrected by current member authority |
| Final affected suites and shuffled acceptance repeat | 274/274 pass, 0 failures |
| Main acceptance set | 78/78 pass; includes 53 real save/command/restore/packing scenarios |
| Deliberate regression mutations | 7/7 killed; Special blockers, packing denial, broad review bypass, SQL omission, split guards, cached cards and grouped preparation |
| Changed executable statement-line coverage | 57/57 covered; no missing changed executable lines |
| Planning policy module coverage | 100% statements, branches, functions and lines |
| Type comparison | 7386 baseline diagnostics, 7364 current diagnostics, 0 new diagnostics |
| Runtime lint comparison and acceptance-test lint | 0 new runtime messages, 0 acceptance-test messages |
| Fresh resource teardown | No test containers, project networks or disposable volumes remain; production health passes |
| Live verification | All three orders have dispatchPlanningRestricted=false and pass admission checks |

Checks exercise manual save, autosave, confirmed plans, incremental commands,
restore, Special approval/review/closure/Attention combinations, source packing
stages, existing split references, grouped orders and cache hydration. They reread
active snapshots and unchanged workflow facts, retain true reconciliation defects,
exercise concurrent Driver completion and preserve existing frontend split guards.
All seven mutation failures are assertion/HTTP behavior failures, not import failures.

## Reproduction

From the repository root:

```sh
python3 server/tools/special-planning-unblocked-20261012/run.py red
python3 server/tools/special-planning-unblocked-20261012/run.py baseline-http
python3 server/tools/special-planning-unblocked-20261012/run.py final
```

The runner uses docker-compose.mbt-test.yml, a captured live source tree, existing
pinned tooling, synthetic credentials and mbbs-tests.slice. It verifies CPU,
memory, PID, init and tmpfs limits, registers finally teardown before creation,
and runs down --volumes --remove-orphans on every completion or failure. Both
Docker listings and production health are checked. Baseline/candidate source and
logs remain; test databases do not.

Final artifacts: test-artifacts/special-planning-unblocked-20261012/summary.json,
static.json, changed-coverage.json, mutations.json, runtime.patch,
cleanup-final.json and deployment-result.json. The complete final-runner.log
records each suite execution and is the authoritative result record. Individual
logs and JSON results use basenames; the completion integration/concurrency
files share a basename, so their separate result summaries remain in the full
runner log and summary.json while the per-file log retains the later execution.
Node v20.20.2; tool versions: {"c8": "12.0.0", "eslint": "10.8.0", "fast-check": "4.9.0", "typescript": "7.0.2"}.
Scoped source/test manifest hash: e2521fc2bb12008be9076e3437309846ada48c731ccd20d05023fb32b7cf10f4.

The release scripts are tools/special-planning-unblocked-20261012/deploy.py and
live.mjs. Prepare checks tested source hashes and exact base-image identity,
overlays the three files onto that image, checks configuration and environment
identity, and retains an image and Compose rollback. Apply checks that no Operator
posting is in progress, recreates only the app and automatically rolls back if
health, source hashes or live order diagnostics fail.

Live image: sha256:6639b48e4be73e8ce7b46374d441c30942b91a5c3c3da0bd07162b1b23ad13b0. Read-only live diagnostics made no application
or NetSuite writes and did not apply or edit any operational plan. Other production
service identities/configuration remained unchanged. The final host check shows
only the four production containers, with the app, database and Ollama healthy.

## Limits and corrected checks

The entire repository test collection was not run. All suites affected by these
planning paths were run, including the completion/concurrency and save/recovery
controls. The repository already has thousands of JavaScript type diagnostics;
this work holds at zero new diagnostics. Coverage is enforced on changed
executable lines; unchanged code in the large reused repositories is not required
to meet the unrelated global percentage thresholds for this scoped run. No live
business plan was saved and no live NetSuite write was made to prove these checks.

The initial coverage invocation omitted the Node command, then inherited global
thresholds intended for a broader collection. Both tooling issues were corrected;
changed-line coverage is independently enforced. Missing item rows in an initial
HTTP feed fixture were added without weakening its assertions. Two new type
annotations and test formatting/name-shadowing errors were corrected. Legacy
Special closure/locking assertions were explicitly updated to the user's newly
authorized behavior, with stronger persistence and unchanged-request checks.

Two older completion HTTP scenarios initially failed before reaching their target
checks because their confirm payloads omitted current revision/digest fences.
Their fixture now supplies that metadata; their completion assertions are unchanged.
All three corrected scenarios also pass against the captured original code, so
this is validation setup repair rather than a production behavior change.

Live diagnostics emitted an existing pg deprecation notice about concurrent query
calls on a shared client. The read-only diagnostics and all deployment checks
completed successfully; this task does not change that unrelated database API use.
