# NetSuite order webhook: 50-request container stress specification

## Scope and isolation

This test exercises the production HTTP route and production queue worker code in a disposable Docker Compose project. It must refuse to run unless `MBT_TEST_ISOLATED=1`, the database is the disposable `mbt_test` database on host `db`, the target HTTP host is the test service `app`/`mbt-web`, and the configured credential is the documented test-only placeholder. NetSuite, Samsara, Smart SCM, and other external writes remain disabled.

## Failure model

- Fifty requests arrive together and expose connection-pool, transaction, or advisory-lock races.
- Exact duplicates create extra queue work.
- Older and newer versions of one entity are both processed, or the older version replaces the newer one.
- Multiple worker processes claim jobs at the same time even though production processing is required to be serial.
- Accepted work is lost, remains queued, fails, or is applied more than once.
- Authentication or malformed-payload failures accidentally enqueue work.
- Fast acknowledgement hides excessive application or PostgreSQL CPU use.

## Executable acceptance contract

1. Start a fresh isolated PostgreSQL database and application container.
2. Reject an invalid secret with HTTP 401 and a malformed authenticated payload with HTTP 400; neither request may create an inbox row.
3. Release exactly 50 authenticated POST requests from one barrier, with 50 client operations in flight: 35 entities, 10 second versions, and 5 exact duplicates.
4. Every valid request returns HTTP 202. HTTP acknowledgement p95 is below 1,000 ms and the maximum is below 5,000 ms.
5. Before workers start, the inbox contains exactly 45 durable rows: 35 queued latest versions and 10 superseded versions. The five duplicate requests create no rows. Across each two-version entity, exactly one coalescing/superseding decision is observed.
6. Start four competing worker containers, each configured for concurrency one, then release the paused queue. The real mapping path drains all retained work.
7. Final state is exactly 35 succeeded, 10 superseded, and zero queued/running/failed. There are exactly 35 successful attempts, no overlapping attempt intervals, and no row has more than one attempt.
8. The mapped database has exactly 35 sales orders and 35 sales-order lines for the run. The newest quantity wins for every versioned entity.
9. Capture sampled CPU and memory for the application, PostgreSQL, and competing workers while ingress and drain are active.
10. Tear down only the named disposable Compose project and its temporary volume/network. Production containers and production data are out of scope.

Detailed pre-approval of this specification was not separately obtained; the run is autonomous in response to the user's explicit request for a test-container stress test.
