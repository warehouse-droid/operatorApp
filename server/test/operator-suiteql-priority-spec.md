# Operator SuiteQL queue isolation — SOB121250

Tier 3: concurrency around existing NetSuite fulfillment validation.
Spec approval: not obtained (autonomous run). The user reported a 90-second
Confirm Pickup and authorized investigation/fix; this specification is available
for review after implementation.

Observed command d32a412c-4f21-4ef5-b294-c673a20bab92 completed as IF155154.
The source-validation SuiteQL waited 88,984.06 ms in the shared application
queue; its HTTP request took 810.20 ms. The transform took 2,187.05 ms.

Acceptance scenarios (implemented against the real NetSuite transport and an
isolated HTTP server/database):

1. A blocked background SuiteQL response must not prevent an Operator source
   status check from finishing. The background response stays blocked until
   explicitly released by the test; the Operator check has a 1-second test
   deadline, not a production NetSuite latency promise.
2. Multiple background queries remain FIFO and serialized, including after a
   failed query. Operator context must not leak into unrelated background work.
3. Operator SQL and REST reads share the existing three-request pool. Under
   mixed concurrent load, peak Operator requests is exactly three when at least
   three are queued, all complete, every result matches its request, and every
   failure releases its slot. A blocked background query remains independent.
4. Operator SuiteQL preserves parameters, pagination, 429 retry, non-retryable
   errors, and timing attribution. Validation and fulfillment verification,
   durable command identity, and duplicate protection remain unchanged.
5. Existing full tests have zero new failures against a captured baseline;
   no new type/lint diagnostics. The changed line is covered and plausible
   routing/result mutants fail both example and generated concurrency checks.

Failure model: bypassing every caller could flood NetSuite (FIFO/context tests);
removing the Operator cap could flood NetSuite (mixed stress/property tests);
returning early could skip validation (exact result/error assertions); failures
could wedge either queue (error recovery); hidden retries could duplicate writes
(existing posting/recovery integration regressions); timing could lose command
attribution (telemetry checks). External account-wide NetSuite limits remain
outside the process-local pool and no absolute production duration is promised.

Setup: existing Node 20/Docker/PostgreSQL and pinned project dev tools only.
No dependencies, commits, schema changes, live order edits, or test fulfillments.
Capture the pre-change source, use an internal Docker test network with its own
temporary database and dummy credentials, persist tests/runner/mutation evidence.
Runtime change is scoped to SuiteQL scheduling in src/netsuite.js. Any release
must be based on the current live image, preserve unrelated files/configuration,
retain rollback, and avoid restarting during active fulfillment posting.
