# Safest Driver PWA offline-storage remediation

The implemented design is an immutable, byte-backed evidence ledger with route-aware admission control and an idempotent resumable outbox. New Blob/File values are converted to ArrayBuffer before IndexedDB; the route-capacity, adaptive-quality, and optional-cache-eviction requirements are now implemented and pass their post-fix stress cases.

## Implemented production controls

1. The fixed 100-photo admission gate is replaced by route-aware byte/count headroom. The count guard is 192: the 168-photo historical p99 route plus a 24-photo, three-stop margin.
2. Before every new capture, use `navigator.storage.estimate()` plus the client’s own evidence ledger to calculate route completion headroom. Request persistent storage where supported, but never treat that request as a guarantee.
3. Keep normal new captures at 2048px/~1MB. Under measured pressure, adapt only future captures toward a 1600px/750KB target, never below JPEG quality 0.60. Validate the approved 4K corpus at every quality step. Do not alter a draft once it is attached to an event.
4. Evict optional delivery-instruction/media caches and expired synchronized route caches before rejecting required evidence. Never evict an unsynchronized photo, sealed event, manifest needed by an event, or another locked driver partition.
5. Preserve the current atomic event/photo ownership transaction and sealed `syncPayload`. Add an explicit local state machine—`local → registered → uploading → uploaded_unverified → durably_received`—with an fsync-equivalent IndexedDB checkpoint at each transition.
6. Keep upload IDs, event IDs, byte size, SHA-256, ordinal, and object scope immutable. The server must return the same result for exact retries and reject changed payloads or reused IDs. A lost response after commit must be safe.
7. Retain photo bytes until the server confirms durable object existence, size, and hash. Clear each photo’s bytes only in the same local transaction that stores its durable receipt; drain other photos even when one is in backoff.
8. Enforce a UI mutation mutex and a database uniqueness/idempotency boundary. Disable action controls while a mutation is being recorded, but rely on the ledger—not the button state—as the final double-click defense.
9. Record bounded, redacted diagnostics: browser family/version, DB version, operation and transaction phase, quota estimate/usage, retained counts/bytes, event/photo aliases, retry phase/status, and whether a fault was synthetic. Never send tokens, grants, full payloads, photos, names, addresses, or object credentials.
10. The offline assets and client gate are atomically versioned as `2026.08.12.1`. Before broad rollout, run the 8-hour soak plus 30-minute drain and a physical iPhone/CriOS campaign. Keep the prior reader compatible during the rollout so retained v1/v2/v3 evidence remains recoverable whenever WebKit can expose the record bytes.

## Residual legacy WebKit Blob limitation

The exact 320-case post-fix campaign is 312 passed and 8 failed. All eight failures happen before production code loads, when mobile WebKit is asked to insert the historical schema-v1 Blob fixture and returns `UnknownError: Error preparing Blob/File data to be stored in object store`. They cannot be repaired by a later JavaScript migration because WebKit does not complete the transaction that would make those bytes readable.

The safest handling is prevention plus non-destructive recovery: keep the ArrayBuffer-only write boundary, require the new client version, never clear or rewrite the affected database, and attempt online/Dispatch recovery only from an already durable server copy or from legacy bytes the browser can successfully enumerate. If WebKit cannot expose the bytes, mark the evidence for manual review; do not claim local recovery or delete the partition. Physical iPhone validation remains required before release.

## Focused no-Blob result

The approved prevention path is now green in all eight formerly failing WebKit
case slots. Each test converts an in-memory photo Blob to ArrayBuffer before the
first IndexedDB write, verifies the raw record contains no Blob/File/object URL,
upgrades through the production schema, rechecks the exact 131,072-byte length
and SHA-256, and seals it with seven new 4K photos. The final independent result
is 8/8 passed with zero retries and zero organic browser errors.

This is the safest reliable design for new and readable records: Blob/File may
exist briefly at the camera or picker boundary, but IndexedDB receives only
ArrayBuffer bytes plus plain metadata. It does not make an already inaccessible
legacy Blob error-free. If WebKit cannot return those legacy bytes, recovery is
limited to a durable server copy, another readable client, or manual review;
the app must preserve the partition and report the condition without deletion.

## Recovery behavior

When admission is unsafe, the app should reject the capture before persistence, explain the route headroom failure, keep all work visible, and offer Sync/Retry/Dispatch review. The picker launch remains synchronous for mobile-Safari user activation; the final admission decision is repeated atomically in the photo write transaction. If a record is structurally damaged, quarantine its metadata for review and continue draining independent evidence. Identity recovery must never clear another driver partition.

Do not use any of these as a fix:

- clearing site data, deleting the IndexedDB database, or asking the driver to reinstall;
- blindly raising a byte/count cap without route headroom and browser-quota checks;
- recompressing historical, committed, uploaded, or otherwise sealed evidence;
- deleting local bytes after upload but before a durable verified receipt;
- storing Blob/File/object URLs again;
- retrying with a changed event or photo payload;
- letting multiple tabs upload without a renewable lease;
- treating WebKit emulation as physical-iPhone proof.

These shortcuts can hide the error while creating the more serious failure: silent loss or duplication of legal/operational delivery evidence.
