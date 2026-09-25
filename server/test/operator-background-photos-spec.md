# Operator photos must not hold confirmation

User authorization: fix the blocking photo uploads demonstrated for SOB120487 +
SOB120489. This supersedes the local-SO exception in operator-posting-latency-spec.md.
Spec approval: not obtained (autonomous run). Tier 3: evidence durability,
authorization, concurrent retries, and operational writes.

## Acceptance scenarios

1. Delivery Load (including grouped SOs, COs and reloads), Customer Pickup Load,
   Receiving, and Consolidation Load persist captured images in IndexedDB before
   submitting a small confirmation request containing photo identities, not bytes.
   No device upload or R2 request is awaited by confirmation. Existing callers
   supplying data URLs or R2 references remain compatible.
2. A full/unsupported device store stops confirmation with a useful error. Successful
   confirmation has a durable server reservation for each photo, bound to the
   operator, yard, operation and immutable hash/size/type. Reservations and local
   Load commit together. Failed Load validation rolls both back.
3. Network-ambiguous confirmation retries replay the same result without loading
   quantities twice. Changed photos/target/actor cannot reuse an accepted request.
4. A browser queue resumes after refresh/reopen and retries lost responses. Only
   the current account's photos upload. Bytes remain on the device until the app
   acknowledges matching durable storage. Failed transfers never repeat Load.
5. The server verifies bytes against the accepted manifest before acknowledging;
   R2 work runs independently with durable retries and expiring exclusive leases.
   Stale workers cannot replace a newer completion. Accepted image bytes remain
   available until remote storage succeeds.
6. Photo history shows pending proof explicitly and resolves the original photo
   after upload. Pending proof is never represented as an already uploaded image.
   Existing photo-view permissions and yard restrictions remain enforced.
7. An unobtrusive pending-photo status lets operators continue and indicates that
   reopening Operator on the same device resumes interrupted device transfers.
8. Replay the two reported orders in the actual frontend, with the same two photos
   and a controlled 750 kbps uplink. Load must show completion under one second
   in the isolated replay while photos remain pending; both orders subsequently
   retain both photos. Report device/network limitations honestly.
9. Preserve quantity validation, CO packing guards, posting gates, photo-count
   policy, grouped identity and all-or-nothing local transactions. Do not create
   production test transactions or send copied customer photos to external storage.

## Failure model and setup

Use existing Node/PostgreSQL/Playwright/ESLint/TypeScript/c8/fast-check tools in
isolated Docker containers, with local photo transport only. No dependencies,
external services, git resets or checkpoint commits. Preserve unrelated edits.
Add one additive migration, a device outbox, a server reservation/transfer queue,
focused regression tests, replay tooling and an evidence report.

Exercise quota failure, refresh, wrong account/yard, malformed/oversized manifests,
hash mismatch, lost upload responses, repeated confirmation, concurrent claims,
stale leases, rollback, and native posting compatibility. Run the full affected
suite in both orders, static baseline comparison, coverage and deliberate mutants.
Known browser boundary: closing/suspending every Operator window pauses device
transfers until the app is reopened; clearing site storage/removing the device
before transfer can destroy its only copy. Do not promise uploads continue after
the browser is closed.

## Contract changes recorded during implementation

The old photo-client test explicitly expected local flows to wait for R2. Replace
that assertion with identity-only requests for both posting modes, as requested.
Pickup photo requirements still come from the live gate; its zero-photo branch
is now in the outbox. Cache assertions advance to the exact new Operator assets,
including the outbox script. Migration inventory advances from 203 to 204.
Photo transfer order may differ across tabs; the accepted manifest order and
proof content stay fixed. The Chromium transport fixture explicitly reports
online because its Docker network has no external interface.

Browser retry refinement: an online/focus/account-resume signal during an active
drain is remembered and runs after that drain finishes. It must not be dropped
until the next periodic timer. The account-switch browser test exposed this
timing case; keep its five-second assertion and verify repeated runs.
