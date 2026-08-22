# Durable NetSuite delayed status refresh specification

Risk tier: Tier 3. A missed refresh can leave an approved purchase order hidden
from operational screens, while duplicate or cross-transaction execution can
corrupt synchronization evidence.

## Scope

Replace the in-process `setTimeout` used by NetSuite sales-order and
purchase-order webhooks with a database-backed outbox worker. The webhook is
still the only automatic trigger. This change must not scan all pending orders,
start a whole-order sync, write to NetSuite, alter webhook responses, deploy, or
mutate production data.

The first durable attempt becomes eligible 10 seconds after the webhook. A
worker polls at a bounded interval, claims at most 10 jobs, uses a two-minute
lease, and processes network calls outside the claim transaction. Independent
workers may run concurrently.

## Failure model

1. The process exits after the webhook commits but before the delayed callback.
2. Async transaction context survives into a timer and executes on a pooled
   connection that has since been loaned to an unrelated transaction.
3. NetSuite delivers the same webhook concurrently or repeatedly.
4. Two application instances claim the same due job.
5. A worker exits after claiming a job.
6. NetSuite is unavailable, returns no matching transaction, or still reports
   Pending Approval when the first attempt runs.
7. A worker updates local state but loses all evidence of its attempt.
8. The webhook transaction rolls back after scheduling work.
9. Sales-order line allocation is temporarily unsettled after status refresh.
10. A stale worker tries to finish a job after its lease has been recovered.

## Required invariants

1. Enqueueing and webhook writes commit or roll back together.
2. No delayed work depends on an in-memory timer or inherited transaction
   context.
3. At most one active job exists for an order type and NetSuite order id.
   Duplicate webhooks coalesce while that job is active. A later webhook may
   create a new job after the earlier job is terminal.
4. Claiming uses row locking with `SKIP LOCKED`. Exactly one current lease owns
   a job, and lease identity is checked for every terminal or retry transition.
5. Every claim creates a durable attempt row. Every attempt ends as succeeded,
   retry, failed, or lease-expired; no execution is silently omitted.
6. Expired running jobs are recoverable after process restart.
7. A transient error, missing NetSuite result, or Pending Approval result is
   retried with bounded backoff: 30 seconds, 2 minutes, 10 minutes, 30 minutes,
   2 hours, 6 hours, and 12 hours. Eight attempts are permitted in total.
8. A non-pending NetSuite result updates the existing local order status and
   emits the same application events as the old callback, exactly once for the
   successful leased attempt.
9. A Pending Approval result may update its freshness timestamp but must leave
   the job retryable.
10. Sales-order allocation refresh retains its existing second-attempt behavior:
    unsettled allocation data gets one additional attempt; status refresh does
    not fail forever solely because allocation remains unsettled.
11. The established delayed-refresh audit actions remain available and include
    job id and attempt number. The outbox and attempt tables are authoritative
    evidence even if supplemental audit logging itself fails.
12. No job processor queries the global pending-approval candidate list.

## Executable acceptance scenarios

- A purchase-order webhook commits one due job and a duplicate webhook reuses
  it; rolling back a webhook leaves no job.
- Two simultaneous claimers receive disjoint jobs, and only one receives a
  single due job.
- A claimed job has a running attempt row before its network call begins.
- A simulated process restart can claim the committed due job.
- A simulated NetSuite `A / Pending Supervisor Approval` result produces a
  retry attempt, then `B / Pending Receipt` updates the order once and succeeds.
- Network and missing-result failures follow the exact bounded delays and end
  in a durable failed state after attempt eight.
- An expired lease is marked lease-expired and reclaimed; the stale lease token
  cannot complete it.
- A successful sales-order refresh emits both existing sales-order events and a
  successful purchase-order refresh emits both existing purchase-order events.
- Existing webhook response fields and the explicit
  `scheduleDelayedStatus: false` test/control option remain compatible.
- Source-contract tests reject `setTimeout` scheduling in the webhook path and
  reject global pending-order polling by the worker.

## Verification plan

1. Run acceptance tests before implementation and record the expected RED.
2. Run unit/property tests for validation, retry policy, and worker outcomes.
3. Run PostgreSQL integration and concurrency tests in a disposable isolated
   test stack, including migration upgrade and transaction rollback.
4. Run adversarial lease, restart, duplicate, missing-result, and audit-failure
   tests.
5. Run targeted coverage and mutation checks for the policy and worker service.
6. Run repository lint/type checks and the broader relevant regression suites.
7. Tear down the disposable test containers, volumes, and task-specific image.

No production deployment or production repair is part of this change.

## Implementation clarification 2026-08-19

The two-minute lease is a crash-detection window, not a maximum NetSuite call
duration. A live worker renews its fenced lease periodically while it waits for
NetSuite and database work. If the process stops, renewal stops and another
worker may recover the attempt after two minutes. A stale worker still cannot
commit after recovery.

Claimed batches start processing concurrently (bounded to 10), so every claimed
job starts its lease heartbeat immediately. NetSuite SuiteQL access remains
serialized by the existing NetSuite request queue; this prevents later jobs in
a claimed batch from expiring merely because they waited behind the first job.
