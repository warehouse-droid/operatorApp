# SOB121250 pickup delay — 24 September 2026

SOB121250 successfully completed as **IF155154**, NetSuite ID **1012625**, with
one posting attempt. Command: `d32a412c-4f21-4ef5-b294-c673a20bab92`.
The wall-clock trace covers approximately 93.2 seconds, from 19:24:12.857 UTC
through local finalization at 19:25:46.091 UTC.

| Stage | Observed time |
| --- | ---: |
| Waiting for the app's shared SuiteQL queue | **88.984 s** |
| Actual source-status SuiteQL HTTP request | 0.810 s |
| IF transform HTTP request | 2.187 s |
| IF read-back HTTP request | 0.688 s |
| Local finalization | 0.219 s |

Admission includes the queue wait and status query; nested timing events must
not be added twice. The database completion timestamp is transaction time;
the timing event records completion of the finalization work.

The requesting query is reconstructed from the deployed status-query builder
and the persisted source ID. Deployed and workspace source hashes matched:

```sql
SELECT DISTINCT
  t.id, t.tranid, t.status,
  BUILTIN.DF(t.status) AS status_text,
  t.lastmodifieddate
FROM transaction t
WHERE t.id IN (1012515)
  AND t.type = 'SalesOrd'
ORDER BY t.id;
```

The log records when this request entered and left the shared queue, but does
not identify the SQL/caller ahead of it. It does not establish whether one slow
query or several queued queries caused the wait. No blocking query is named
without evidence. The delay occurred before this request reached NetSuite.

## Change

One added branch in `src/netsuite.js::suiteql` lets requests already admitted by
the existing Operator request pool execute without joining the background
SuiteQL promise chain. The same pool already controls Operator REST calls and
caps their combined in-process concurrency at three. Other callers keep the
existing FIFO SuiteQL queue. Source validation, pagination, retries, transforms,
verification, durable command identity and external-ID recovery are unchanged.

The task-specific patch is `test-artifacts/operator-suiteql/runtime.patch`.
It preserves all pre-existing worktree changes. No schema, dependency, browser
asset, order, or fulfillment changes are part of the release.

## Verification

Tier 3 concurrency checks; [specification](operator-suiteql-priority-spec.md).
Spec approval: **not obtained (autonomous run)**. The acceptance criteria have
not received independent human review; this limits the confidence claimed.

Re-run the source checks with `python3 tools/operator-suiteql-gauntlet.py` from
`server/`. It uses temporary databases and internal Docker networks, with no
live credentials. The existing test image is `field-sales-check-2941306:latest`,
ID `sha256:a213a201d54066121bc474fd418fe25417cc595bfc4be21abd3cefcd0cd6e6a2`;
`Dockerfile.test` target `test-e2e` and the locked dependencies provide its
rebuild recipe. Node 20.20.2, c8 12.0.0, ESLint 10.8.0, fast-check 4.9.0 and
TypeScript 7.0.2 were used.

| Acceptance criterion | Evidence |
| --- | --- |
| Pickup proceeds while background SQL remains blocked | New actual-HTTP/DB regression failed before the change; passes after |
| Background FIFO and failure recovery; no context leakage | Mixed-load example and generated scenarios |
| Shared three-request SQL/REST limit; all outcomes preserved | 16 generated scenarios, seed 24092026; exact result/error and request-count assertions |
| Parameters, pagination, 429 retries, errors, timing context | Actual transport regression; pre-existing behavior also detects the discarded-validation mutant |
| Posting and duplicate-protection invariants | Existing admission, posting service, pickup recovery and real HTTP/DB fulfillment tests |
| Real server operation | Actual server `/health` and database-backed bootstrap return 200 |

The focused run passes **34/34 tests**. The one added runtime line is covered;
the routing branch is executed, and behavioral assertions cover both Operator
and background callers. **3/3 deliberate bugs are detected independently by
the example tests and by the property test alone**. Shuffled focused file order
(seed 240926) also passes. Static comparison has **zero new diagnostics**;
the existing baseline has 254 type diagnostics and 137 scoped lint diagnostics.

The separate `python3 tools/operator-suiteql-image-test.py` checks immutable
production images without source overlays. The old image reproduces the queue
blockage. The candidate validates the pickup in **22.61 ms against a local test
HTTP server**, while the background request remains blocked; nine mixed requests
preserve the limit of three. Candidate server health and database bootstrap
both return 200. This is a scheduling test, not a live NetSuite latency promise.

Runtime SHA-256 after the change:
`3aa9bcadc407b2b3a09044d40d86bf1fe1744a7657821f8e8fe0c479546e6dec`.
Candidate image:
`sha256:6171ae55d34b14aa06fea330b0251e0cc4d62550bf4baa57f41a96e23822035a`.
All 1,048 packaged source/asset/migration/manifest hashes were checked; the other
1,047 match the live baseline exactly.

No dependency/license audit was rerun because no dependencies changed. The
one-line runtime patch introduces no new network destination, credential,
subprocess, filesystem access, or environment variable and contains no secrets.
Browser visual testing and migration rollback tests do not apply to this
server-only scheduling change. Runtime rollback is the captured previous image.
There is no claim of a global concurrency cap across application processes or
NetSuite accounts; external throttling and its existing retry behavior remain.

During validation, c8 initially applied the project's global 95% threshold to
the entire large NetSuite module. The focused run instead enforces coverage on
the changed scheduling line, as specified. All 34 behavioral tests had passed
in that initial run. The first image check also detected restrictive copied
file permissions; those were corrected and the packaged-image tests rerun
before release. No test assertions were weakened.

## Full-suite result and source isolation

The final full inventory ran against a frozen copy of the original source plus
this task's one-line runtime patch and new regression test. All **585 files** ran
using the repository's existing per-file database isolation, partitioned across
three temporary environments:

| Run | Tests | Passed | Failed | Skipped | Cancelled |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original baseline | 3,122 | 3,100 | 21 | 1 | 0 |
| Scoped candidate | 3,126 | 3,105 | 20 | 1 | 0 |

There are **zero new failing test identities or failed files**. The remaining
20 failures occur in the original baseline. One stock-return test failed only
in the first baseline run because its network spy saw a background metadata
read; a fresh run of that unchanged baseline file passed 5/5. That instability
is recorded, not claimed as fixed. The full repository is not green.

An earlier run against the changing shared workspace was discarded for release
comparison. Concurrent special-workflow edits added an Admin feature flag and
made its expected-inventory test fail. A countercheck removing this queue fix
reproduced that same failure. Those edits remain untouched in the workspace
and are absent from the prepared release. The final frozen run has no such new
failure. Source hashes are in `test-artifacts/operator-suiteql/scoped-source-hashes.json`;
the final summary is `test-artifacts/operator-suiteql/regression.json`.

The final suite-health check executes each shuffled file in a separate process
to preserve its intended order; Node sorts a list of test-file arguments. All
assertions and runtime code remained unchanged while correcting that runner.

## Release status

**Prepared and verified; not deployed.** The user explicitly chose
**“Leave the fix prepared.”** Deployment is not authorized; retain the tested
candidate and rollback artifacts without changing the live application.

Automatic approval review previously rejected replacing the live application
container because it interpreted the original request as investigation only.
That attempted deploy command was rejected before execution; validation was
then run separately without changing the live app.

The release preflight found no queued/active fulfillments or idle transactions.
A subsequent read-only check still shows SOB121250 completed as IF155154 with
exactly one posting attempt. Applying the release will recheck the live image,
source, environment and idle state, replace only the app container, and verify
all source hashes and public/local health/database probes. The previous image
is retained for automatic rollback. The database, webhook worker and Ollama
container are preserved.

Prepared release and rollback artifacts:
`/home/ubuntu/operatorapp-deploy-backups/operator-suiteql-20260924-v1`.
