# Hourly linked pickup SO refresh

The user authorized the shared background refresh at one-hour intervals. Spec
approval: not obtained (autonomous run); these implementation criteria are
reviewable after the fact. Tier 3: concurrent background/local-state writes.

1. With direct NetSuite access enabled, run once on startup and then when one
   hour has elapsed since the last durable start. Persist the interval across
   app restarts; two workers cannot run together. Skip while operational sync
   is running. Release the session lock on success, failure and interruption.
2. Select unique canonical SOs linked to non-delivery Special/Backorder cases
   or Regular pickup requests. Exclude cancelled/closed requests, Delivery,
   test fixtures, locally reopened orders and already reconciled terminal SOs.
   Regular requests whose routing work is complete still need SO status until
   customer fulfillment is verified. Bound batches and rotate by last attempt.
3. Read status and cumulative fulfilled quantities from NetSuite only. Reject
   missing, ambiguous, mismatched or malformed responses. Partial fulfillment
   remains active. Fully fulfilled SOs lock their Special requests and complete
   eligible Regular requests. Existing Special completion evidence still applies
   to supplier arrival; never invent a PO receipt or physical delivery.
4. Persist header status, fulfillment progress and request reconciliation in
   one local transaction. A changed canonical sync timestamp, request revision,
   link or method fences stale observations. Preserve commercial amounts,
   ordered quantities, local packing work and all NetSuite records. On failures,
   retain last verified data, record an error, and continue other orders.
5. Record successful status observations and refresh timestamps. Show them on
   Regular pickup request summaries; emit existing request update events after
   commit. Completed requests remain read-only through existing workflow guards.

Failure model: duplicate execution (database lock and simultaneous-worker test),
stale response overwriting a webhook/edit (microsecond timestamp/revision race
tests), false completion (partial/missing/malformed/header/quantity tests and
generated quantities), partial local writes (forced rollback), silent outages
(audit/error assertions and continuation), unexpected NetSuite writes (mock
only the read boundary; no remote mutation capability), host resource leakage
(bounded disposable Compose with registered teardown and retained receipts).

Use existing Node/PostgreSQL/fast-check/ESLint/TypeScript/c8/Playwright tooling.
No new packages, migrations or commits. Run focused and relevant regression
suites, static checks, changed-line coverage and three manual mutants. Preserve
only concise evidence and operational release/rollback records; remove temporary
containers, databases, networks, logs and browser/coverage artifacts.

Schema clarification before implementation: canonical SO lines store local
packing progress, not a separate NetSuite cumulative quantity. Keep those lines
unchanged. Store observed cumulative quantities in the request progress snapshot
and audit record, and refresh only the canonical header's status/fulfillment
summary. This avoids overwriting packing work or adding a schema migration.

Linkage clarification: one active non-delivery Backorder uses an optional
Already Ordered SO reference. Include that reference when it resolves to one
canonical SO; keep the manual case linkage and approval fields unchanged.
