# Dispatch CO global lifecycle and GOA recovery — executable specification

Spec approval: not obtained before implementation (autonomous run following the user's explicit request to fix and recover the CO). This append-only document is the review artifact.

Assurance tier: 3. The change protects persisted Dispatch data across plan dates and concurrent plan/cancellation writers.

## Setup and authorization boundary

- Reuse the repository-pinned Node 20, PostgreSQL 18, `node:test`, fast-check, c8, ESLint, TypeScript, and isolated Docker Compose test environment.
- Add no runtime or development dependency and do not change lockfiles.
- Preserve every unrelated dirty-worktree change, including the pending V2 summary-marker work.
- Add focused integration, frontend-contract, property, concurrency, changed-line coverage, manual-mutation, recovery dry-run, source-state, and one-command gauntlet artifacts.
- Do not write production until the final fresh gauntlet is green.
- Deploy the cancellation guard before recovering production data, so the repaired CO cannot immediately be cancelled through the old path.
- The only authorized production data repair target is `CO-GOA-3464-3470-6922`. Recovery must run inside one transaction under the Dispatch planning advisory lock, validate all immutable predicates, write an audit record, and abort without partial changes on any mismatch.
- Derive “original” routing from confirmed July 14 plan `48`: source yard `2967`, destination yard `150`, and the existing confirmed CO stop on truck `BC71838`, Load 2. The later mutable pre-cancellation relationship to `12441` must not override this immutable source because the user requested the original CO.
- Do not directly rewrite plan `48` or plan `233` snapshots during recovery. The deployed global hydration path must make the restored active CO visible and sequence-enforced without fabricating a plan revision. Retain today’s `150` pickup-address override as harmless redundant evidence until a later normal user save; recovery must not silently rewrite it.

## Failure model

1. A dispatcher viewing date B cancels a CO assigned on date A because cancellation checks only the current date or local status.
2. An address-only edit treats an unchecked/missing form checkbox as destructive CO cancellation.
3. A cancelled local row disappears from today’s feed while a historical snapshot still displays it, producing contradictory global order-pool state.
4. Cancellation races a plan save: both succeed, leaving an active plan referencing a cancelled CO.
5. A stale denormalized assignment misses a real snapshot stop, or stale snapshot data misses a valid assignment marker.
6. A cancelled plan incorrectly blocks legitimate cancellation forever.
7. Recovery restores the wrong depot (`12441` instead of original `150`), alters snapshots/revisions, loses lines/details, or partially commits.
8. A missing/malformed recovery prerequisite updates the wrong CO or silently does nothing.
9. Driver PWA records a completed local CO drop, but the universal completion-kind mapper intentionally rejects `CO`/`CO_ORDER`; the physical evidence exists while the local CO stays `planned`, `pending_load`, or even `cancelled` and reappears in Dispatch.
10. Treating a yard-transfer completion as customer delivery hides the source SO too early; treating it as no completion leaves the transfer card stale. The two lifecycles must remain separate.

## Acceptance scenarios

1. Given a CO drop or pickup stop in any non-cancelled plan on any date, cancellation returns HTTP 409 with code `DISPATCH_CO_ALREADY_PLANNED`, includes owning plan/date/truck/load details, and leaves the CO byte-for-byte unchanged.
2. Given assignment metadata that points to a non-cancelled plan even if its snapshot projection is temporarily stale, cancellation is also blocked fail-closed.
3. Given only cancelled-plan references and an otherwise cancellable CO, cancellation succeeds.
4. Given an active CO whose source is a grouped GOA order, the global order pool and V2 bootstrap attach `transitCo` to that GOA regardless of which plan date owns the CO. Pickup becomes the CO destination and the original pickup/source fields remain recoverable.
5. Given a cancelled CO, bootstrap clears stale `transitCo` metadata as before and never resurrects it.
6. Given an existing CO in the Dispatch Info modal, saving address/window fields alone never calls the cancellation endpoint. Cancellation is available only through a separate explicit button and browser confirmation.
7. Given concurrent cancellation attempts or cancellation versus plan ownership, the shared advisory lock serializes the outcome; a non-cancelled plan and a cancelled CO cannot be the committed terminal state.
8. Given `CO-GOA-3464-3470-6922` in its observed production state, recovery dry-run reports the exact proposed transition but changes zero rows.
9. Given `--apply` and every expected predicate, recovery changes only that row to active `pending_load`, restores `2967 -> 150`, preserves its line rows and historical plan assignment, removes stale cancellation keys while recording recovery metadata, and writes one Dispatch audit event.
10. Repeating recovery is idempotent and reports no second mutation/audit event.
11. After deployment and recovery, today’s V2 bootstrap exposes `GOA-3464-3470-6922.transitCo.id = CO-GOA-3464-3470-6922`, `toYard = 150`; July 14 still owns the CO stop; a cancellation probe is rejected without changing the row.
12. Given a complete Driver PWA drop whose `order_refs` contains a local CO, the local and canonical CO projections move to `completed`, retain the exact Driver job/stop/time evidence, and leave the Dispatch order pool immediately.
13. The source SO remains globally plannable for its final customer-delivery leg, but its pickup yard is the completed CO destination. The CO remains available in destination-yard Receiving until receipt confirmation moves it to `received`.
14. A later physical completion supersedes an earlier cancellation; a later cancellation supersedes delayed older offline evidence. Replays are idempotent, repeated upserts cannot reopen a completed CO, and neither completed nor received COs can return to Dispatch.
15. Migration 191 backfills every eligible historical CO from the earliest terminal drop and is idempotent on a full schema upgrade replay.

## Must-not-change constraints

- Plan boards remain date-scoped; only operational order/CO ownership is global.
- Existing CO sequencing remains fail-closed: an earlier-date CO may satisfy a later source pickup only while the active relationship exists.
- Received/loaded CO cancellation protection remains intact.
- Driver-completed CO evidence remains non-billable and outside the universal SO/TO/PO/VRMA/CUSTOM completion ledger; only the dedicated local CO lifecycle is projected.
- Driver transport completion (`completed`) and destination-yard inventory confirmation (`received`) remain distinct states.
- No plan snapshot, plan revision, driver/operator evidence, CO line, V2 marker, dependency, PWA asset, cache version, feature flag, dependency version, or unrelated production row may be changed by recovery.
- No automatic cancellation is inferred from checkbox absence, network delay, refresh ordering, or address override.
- Test containers, networks, and task-specific images must be removed after verification.
