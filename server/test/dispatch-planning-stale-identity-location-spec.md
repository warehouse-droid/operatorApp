# Dispatch Planning stale identity and outbound-location specification

Status: autonomous production repair requested on 2026-08-28.

Spec approval: not obtained as a separate checkpoint. The user explicitly
authorized diagnosis, a test-before-code repair, and short-cutover deployment.
The executable scenarios below were stated before implementation; confidence is
therefore based on the RED/GREEN and gauntlet evidence rather than independent
spec review.

## Executable scenarios

1. Given an assigned Custom Order whose saved snapshot retains its exact unique
   `ref_number` but has lost both stable-ID fields, canonicalization restores the
   ID from `dispatch_custom_orders`, preserves one pickup followed by one drop,
   and emits the canonical database snapshot.
2. Given a supplied stable Custom Order ID and a different existing Custom Order
   reference, canonicalization rejects the plan with
   `DISPATCH_CUSTOM_ORDER_PLAN_ID_MISMATCH`; exact-ref recovery must never become
   an identity-substitution path.
3. Given an already processed Sales Order webhook without a source modification
   timestamp, a later full webhook for the same order that also lacks that
   timestamp is accepted by receipt order even when its payload hash sorts lower.
   Its `12441` line location is claimable and must not remain `superseded` behind
   the older `2967` snapshot.
4. Given an older queued timestamp-free snapshot, a later timestamp-free snapshot
   supersedes and coalesces the older queued work by receipt order.
5. Given explicit source modification timestamps, older arrivals remain rejected
   and the existing retry, pause, lease, single-claimer, and duplicate guarantees
   remain unchanged.
6. Given an apply attempt that fails validation, the candidate remains a recovery
   snapshot and the active Dispatch plan is not overwritten.

## Production witnesses and RED proof

- `DELIVERY-MBR-0828-1` existed as Custom Order ID `143`. Recovery snapshots
  `16231` through `16233` retained the assigned ref but had a blank stable ID;
  the pre-fix test failed with `DISPATCH_CUSTOM_ORDER_PLAN_ID_REQUIRED`.
- `SOA07750` webhook `28` applied four `2967` lines at 11:55 UTC. Webhook `70`
  arrived at 13:18 UTC with its line location at `12441`, but both events lacked
  `sourceModifiedAt` and row `70` was discarded as `superseded` by payload-hash
  ordering. The pre-fix integration test observed `superseded: true` where
  `false` was required.

## Invariants and setup

- Diagnosis is read-only. No plan, order, schedule, or webhook state is changed
  until the implementation passes its isolated tests and the deployment backup
  is complete.
- Only the known false-superseded `SOA07750` event may be requeued after cutover;
  unrelated superseded events are not replayed.
- The active confirmed Dispatch plan is never rewritten as part of remediation.
- Custom-order immutable-ref, duplicate-stop, completion, and route guards remain
  authoritative.
- Timestamped webhook ordering remains source-time based.
- Existing dependencies and public response shapes do not change. No package is
  installed, no migration is needed, and no commit is created in the user-owned
  dirty worktree.
- Tests run only in the disposable `docker-compose.mbt-test.yml` database. The
  production verification and repair queries are narrow and auditable.
