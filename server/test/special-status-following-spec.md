# Special Request order status following (Tier 3)

Spec approval: not obtained (autonomous run). User authorized resolving SPREQ-000024's incorrect local and NetSuite statuses. Confidence is limited to these criteria.

Observed request 95, SPREQ-000024: SO SOB121882/1033108 is locally delivered (dispatch completion), PO POB03883/995310 is locally received. NetSuite reports SO F / Sales Order : Pending Billing and PO F / Purchase Order : Pending Bill. Cached headers still report B / Pending Fulfillment and B / Pending Receipt.

## Acceptance criteria

1. Render local SO delivery Completed and PO receipt Received before historical planning, for Sales and SCM, including queue cards. Partial progress remains partial. Preserve existing planning/ETA displays for unfinished orders, yard pickup and vendor pickup behavior, and preview permissions.
2. Show the latest canonical NetSuite SO status, preferring it to the case's old linking snapshot. Include canonical PO receipt evidence and both header cache timestamps. Derive SO approval from canonical evidence when present; retain existing fallback for an order that has not synced yet.
3. Refresh stale (five minutes or missing/invalid timestamp) linked canonical SO/PO headers with at most one batch read per order kind for a visible list. Ignore unlinked/skipped, duplicate and invalid identities. Preserve fresh headers. Reject mismatched/malformed remote identities and statuses without clearing saved values.
4. Persist only status, status text and header sync timestamps. Fence writes on captured canonical sync timestamp so an intervening webhook wins. Mirror events and audit occur in the same transaction, so failed persistence rolls back. No NetSuite mutations, request revision changes, order line changes, prices, quantities, links, local completion writes, or workflow cancellation.
5. Existing authenticated Sales/SCM list and detail endpoints refresh through this cache boundary after access scoping. A refresh failure leaves cached detail available and logs a failure. The visible, unedited Special queue polls the app once a minute as a fallback for missing parent order webhooks; hidden/inactive/editing queues remain blocked.
6. Repair SPREQ-000024 using the same tested status cache boundary and verify the rendered local and NetSuite statuses, production health, retained business fields and order lines.

## Failure model and checks

- Stale response overwrites a newer webhook: conditional timestamp fence, concurrency boundary test and transactional rehearsal.
- Partial or hostile remote result clears a header or changes an unrelated identity: exact ID/ref validation, incomplete response tests and properties.
- Display labels confuse planning, partial completion and full completion: rendering tests across Sales/SCM, method/compact combinations and injected markup.
- Remote outage prevents viewing/editing: per-kind failure isolation and cached-read behavior tests.
- Excess reads or edited forms overwritten: five-minute freshness, batch/deduplication tests; active/visible/blocked polling tests.
- Financial/local workflow mutations or rollback failure: whitelisted SQL and before/after business fingerprints in a rollback rehearsal and live verification.

## Setup and evidence

Use the existing cached Node/Docker test toolchain, fast-check, c8, ESLint and TypeScript. Add no dependencies and make no commits. Preserve the task-start source and live image for rollback; deploy only reviewed changed files. Tests use disposable, offline, bounded containers in mbbs-tests.slice and no production credentials/volumes. Persist the entry point, baseline comparison, coverage, manual mutants and evidence in tools/special-status-following-20261005 and test-artifacts/special-status-following-20261005. Verify cleanup and health afterward. Do not remove unrelated active workloads belonging to concurrent tasks.

## Revision 1 (explicit refinement before validation)

- Header fencing must retain PostgreSQL timestamp microseconds using text projection. JavaScript Date truncation is insufficient for the conditional update.
- The existing explicit SO-refresh action forces both linked header reads before returning the refreshed SO, so preferring canonical state does not hide the manually refreshed state.
- Cache persistence is independent of the delayed-status worker. It uses two header batches and guarded header-only updates; it does not invoke the worker's order-line reconciliation.

## Revision 2 (user clarification: physical progress and actual completion time)

The user clarified that Sales needs to know whether the SO/PO was picked up by the driver, arrived at the yard, or delivered, with the actual completed date and time. This supersedes criterion 1's generic Completed/Received labels and criterion 2's NetSuite text in the Sales display.

- Use completed driver pickup jobs, confirmed yard receipts/dropoffs and confirmed SO deliveries as evidence. Planned stops, estimated arrivals, in-progress jobs and NetSuite billing headers must not create physical completion.
- Sales shows Picked up by driver, Arrived at yard, or Delivered, and the recorded completed timestamp in America/Toronto including its timezone. Preserve the SO/PO identity and Sales SO-preview permission. SCM may retain its NetSuite header text.
- PO receipt confirmation maps to Arrived at yard for via-yard requests, and to Delivered for completed direct delivery. Partial receipt remains Partially arrived at yard. Driver job timestamps take priority over receipt fallback when matching completed physical work exists.
- Missing/invalid timestamps never fall back to planned ETA, sync time or the current time. Show the known state without inventing a completion time.
- Add scoped, batched driver-job evidence for exact SO/native PO/PO dispatch references, including alias matching; use the existing completion view and receipt timestamps. No writes to driver, receipt or completion evidence.

## Revision 3 (verification refinement)

- Invalid and ambiguous remote responses must report a failed attempted observation and log the rejection. Adversarial tests assert this in addition to zero writes.
- Exercise the real authenticated list/detail and explicit refresh handlers with only the remote HTTP boundary simulated; assert fresh reads are reused and an outage still returns cached details.
- Validate the Sales and SCM pages in cached Chromium at desktop and phone widths, including both order identities, physical labels, recorded timestamps and preview permissions. Combine browser, unit and real PostgreSQL execution for changed-line coverage.

## Revision 4 (partial-receipt regression found during adversarial review)

A completed driver stop can coexist with a partially received PO. For a via-yard route, the explicit partial receipt must retain Partially arrived at yard and must not show a full completion timestamp. The regression was observed failing before changing that priority; a full receipt retains the actual driver dropoff timestamp.
