# Operator posting timings, deferred photos, and compact status

## Authorization and setup

The user requested per-call IF/IR timing logs, R2 uploads after posting with background processing, and a compact posting-mode notice. Autonomous implementation; spec approval not obtained (autonomous run). Tier 3 applies to durable photo work and worker concurrency.

Use existing Node, PostgreSQL, Docker, ESLint, TypeScript, c8, fast-check, and Playwright tools. Add no packages or external services. Preserve unrelated work. Add one additive database migration, focused tests, reproducible verification tools, and evidence. Tests use an isolated database and fake external transports; they must never create live NetSuite transactions or upload customer photos.

## Acceptance scenarios

1. Every NetSuite HTTP attempt within an Operator IF or IR operation logs elapsed milliseconds, method, endpoint path, attempt number, HTTP status or error code, command ID, transaction type, and processing stage. Include failed calls, retries, and reads. Include response-body download in the duration.
2. Distinguish time waiting for the NetSuite request queues, source preparation, duplicate checks, transforms, verification/recovery, and local finalization. Concurrent operations keep their own correlation IDs. Logging failures cannot change transaction outcomes. Logs contain no tokens, request/response bodies, SQL text, or photo data.
3. For IF/IR, submit captured photo data to the app and save it durably with the posting command before any transform. Do not await R2 upload before posting or before reporting verified completion. Existing R2 references still work.
4. Upload queued photos only after the related command has completed. Resume queued/expired work after restart. Concurrent workers cannot commit over another worker's lease. Retry failed uploads with bounded backoff without repeating the NetSuite posting. Keep readable local photo data until upload and reference replacement commit together.
5. After upload, update only the command's associated receiving/load photo records (including source records of grouped/consolidated loads). Preserve photo order, distinct photos, unrelated records, transaction identities, and immutable command identity. Retain content hashes rather than image bodies in the immutable input snapshot.
6. Reject malformed, unsupported, oversized photo data before posting. Keep existing photo-count, operator/yard, quantity, source-line, and posting-policy checks. Existing direct-upload/local-only flows remain compatible. Consolidated IF loads use the same durable photo path.
7. Photo worker timings identify the command and upload attempt. Upload errors are visible in logs and persisted retry state; they do not turn an already verified IF/IR into a failed posting.
8. The posting-mode banner uses its natural content height on phone, tablet, and desktop; it never receives the screen's flexible grid row. Show a short, readable posting mode and preserve actionable unavailable-mode errors.

## Failure model and checks

- Photo loss after closing browser/restarting server: durable DB queue and restart/retry integration tests.
- Duplicate posting from upload retries: independent worker with no NetSuite mutation dependency; completed-command invariants and integration tests.
- Concurrent/stale workers: PostgreSQL claim/lease races and stale-completion tests.
- Partial reference replacement: transaction rollback and scoped-linkage integration tests.
- Sensitive log content/cross-command attribution: hostile-content, failed-call, and concurrent-context tests.
- Malformed/unbounded photo input: bounded parser tests and generated round trips.
- UI consumes the available screen: real browser geometry tests at multiple sizes.
- Existing behavior regresses: baseline/full-suite comparison, type/lint checks, changed-code coverage, manual mutants, and seeded test order.

No fixed latency reduction is promised: photos must still reach durable application storage, and actual NetSuite processing time depends on the account. Detailed timing is the basis for subsequent optimization.

## Additional user request: completed receiving orders

9. A split PO or normal PO whose local receipt status is `received` is absent from receiving lists, searches, vendor counts, and item suggestions, even while the cached NetSuite status still says Pending Receipt/Partially Received. Partial receipts stay available.
10. A stale screen cannot submit another receive operation for a locally completed order. Existing completed-job lookup and photo/history access remain available.
11. Back to Receiving clears order/item searches, stale selection and suggestions, invalidates outstanding search requests, and saves the cleared navigation state.

Read-only production evidence: SN1400333 is already `receipt_status=received`, receipt IR14634, but the cached NetSuite status remains `Purchase Order : Pending Billing/Partially Received`. No production data correction is needed to hide this order once the list predicate is fixed.

Migration fixture update: the existing migration-200 rollback rehearsal must remove the new dependent photo queue before removing its parent batch table, then reapply both migrations inside the rollback transaction. Keep the existing saved-work assertions and also assert the photo queue survives the rehearsal rollback.

The frontend release increments the Operator service-worker cache and JS/CSS asset versions. Existing cache tests must assert these exact new versions while preserving their cache-install, activation, and live-policy assertions.

Ownership edge case: ordinary Delivery Sales Orders are posted later by driver completion, so no Operator posting command exists for them. Keep their existing direct-upload path; only native Operator IF/IR work uses command-backed deferred uploads. Customer Pickup SO fulfillment and native Transfer Order fulfillment remain eligible for deferred uploads. Consolidated batches have their own durable photo owner even when their loading is local.

The official migration-upgrade and deployment-readiness inventory assertions advance from migration 200 to migration 201, retaining the exact migration list, no-op upgrade, and legacy data-preservation checks.

The consolidated-load browser test previously required R2 to finish before submit. That assertion intentionally changes with deferred uploads: captured images must reach the app unchanged, survive a failed app request, and remain available after refreshing a pending batch. Assert zero browser R2 calls. Server integration tests own R2 retry and reference replacement assertions.
