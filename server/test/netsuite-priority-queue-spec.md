# Operator priority with a shared NetSuite request budget

Tier 3 (concurrency). Spec approval: not obtained (autonomous run). User authorizes
preparing priority for Operator requests, explicitly including pickup and return;
the existing instruction to leave the fix undeployed remains in force.

This extends the earlier SuiteQL bypass: that bypass alone did not coordinate
REST requests or other processes. Scope is this application's traffic using the
same PostgreSQL database. Other integrations/accounts are outside our control.

## Acceptance scenarios

1. A held background SuiteQL request cannot prevent pickup or return SQL, POST,
   or verification GET from starting in spare capacity. Existing pickup behavior
   and the local three-operation pool remain compatible.
2. All governed SuiteQL, REST records and RESTlet HTTP requests across separate
   app/worker processes share a maximum of four active slots. Background work
   occupies at most one slot. An active response body retains its slot until read.
3. When slots are full, queued Operator work starts before queued background
   work, FIFO within each priority. Running work is never preempted; background
   resumes when Operator work drains. Strict priority may defer background under
   continuous Operator demand.
4. Operator HTTP routes and customer return lookup/submit routes carry priority
   through validation, posting, and verification. Explicitly detached directory
   refreshes and periodic reconciliation retain background priority. Request
   data/headers cannot grant priority to unrelated routes.
5. Failed HTTP requests, cancelled waiters and completed work cannot leak a slot.
   Timeout/uncertain transport outcomes retain a conservative recovery lease;
   abandoned waiters and crashed processes expire. A paused caller cannot send
   using an expired grant. A database coordination failure must never send an
   unbudgeted HTTP request. Release failure must not hide a successful posting.
6. Retry delay holds no HTTP slot after a definite 429 response. Each retry and
   each page reacquires capacity. Existing parameters, errors, payloads, posting
   idempotency, auth, API signatures and business validation remain unchanged.
7. Queue wait and HTTP execution remain separately observable without logging
   SQL, request bodies, credentials or customer details. No new packages.

## Failure model and checks

- Oversubscription/races between containers: real PostgreSQL plus child-process
  concurrency tests and randomized mixed request stress.
- Priority inversion/stranded background: exact start-order assertions under
  full capacity and eventual drain; property tests assert both bounds and liveness.
- Leaked/expired reservations or aborted callers: expiry, cancellation, timeout,
  connection failure, stale grant and release failure adversarial tests.
- Partial/repeated financial writes: preserve existing transform/return tests;
  no live NetSuite writes; verify return POST executes once and readback runs.
- Detached background priority inheritance: request boundary and refresh tests.
- Migration/runtime mismatch: apply the additive migration to a disposable DB,
  rerun it, run real server and local HTTP transport; deployment is not performed.
- Production observability: assert queue and HTTP timing events with command IDs.

## Setup and constraints

Use existing Node 20 test image, PostgreSQL 18, node:test, fast-check, c8, ESLint,
and TypeScript. No installation, dependency edits, git commits, deployment,
production database writes or live NetSuite calls. Add a scheduling table via an
additive migration, scheduler/context wiring, tests and reproducible tools under
the `netsuite-priority-queue` name. Scheduler reservations must use independent
short database transactions; never hold a business transaction connection while
waiting for capacity. Retain immutable baseline and scoped candidate snapshots,
compare the full npm test inventory and static diagnostics for zero new failures,
measure changed-line coverage, kill 3–5 plausible mutants in both examples and
properties, run shuffled focused tests and real app/local-server smoke checks.

No promise of a 90-second absolute latency ceiling: running NetSuite requests,
NetSuite processing, failures, and traffic from other integrations still affect
latency. A network timeout cannot prove NetSuite stopped executing remotely.

## Clarification before transport implementation

The four-slot invariant counts this application's in-flight HTTP attempts, through
response consumption. A settled transport error/abort releases its slot, as do
definite HTTP errors; an abandoned process retains its grant until the configured
request deadline plus 30 seconds. This replaces scenario 5's broader proposal to
quarantine all uncertain transport outcomes, which would block unrelated work
for minutes after a completed local failure. Remote work continuing after a
client-side abort remains an explicit limit of the guarantee. Caller-provided
signals and per-attempt timeouts must actually cancel fetch/body consumption.

## Route inventory correction during final review

The actual Operator browser also uses `/api/customer-pickup`, `/api/delivery`,
`/api/receiving`, `/api/inventory`, `/api/cycle-count`, and the earlier-mounted
`/api/count-sheets` and `/api/inventory/damage` routers. Include these guarded
routes in scenario 4. Exact bulk `/api/delivery/sync`, `/api/receiving/sync` and
`/api/inventory/sync` endpoints stay background even when initiated by an
Operator. Targeted order refreshes retain Operator priority. The initial mini
HTTP fixture used `/api/operator/pickup`; correct it to the real pickup prefix
and strengthen the production route inventory assertions before wiring changes.

## Existing test-harness dependency update

The SCM purchase-order race test evaluates an extracted transport function in a
VM. The shared mutation helper is now a dependency of that extracted function.
Include the real helper and its real context/telemetry dependencies in the test
harness; retain every existing 409, GET-only, GET/PATCH, identity and count
assertion. Verify it still rejects a mutant that skips the version recheck.

## Deployment authorization — 2026-09-25

The user now explicitly requests: "deploy the priority fix". This supersedes the
earlier instruction to leave the prepared revision undeployed. Deploy the tested
candidate-v4 changes over each currently running app and webhook-worker image,
preserving their unrelated changes and configuration. No new dependencies or
business transaction submissions are needed. Use the existing old-coder Tier 3
evidence and fresh release checks; no independent spec approval was obtained.

Deployment acceptance: both services contain the reviewed priority patch; the
additive migration 227 is applied once; app and worker use the same queue table;
isolated tests still verify pickup/return priority, four total slots, one
background slot, retry/cancellation cleanup, cross-process coordination and
posting invariants. Compare types/lint with the captured live baseline, rerun
mutation/property checks, and start the real candidate. Preserve rollback image
tags and validate schema/migration backups before cutover. Rollback must restore
both images while retaining the harmless additive queue table. Wait for active
posting and worker work to finish before stopping the two services together.
Verify both images/configuration, public health/authentication, source hashes,
and a bounded read-only NetSuite query after deployment. Do not create a test IF.
