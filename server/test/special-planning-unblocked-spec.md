# Special-request Dispatch planning — 2026-10-12

User authorization: remove all Dispatch planning blockers related to a Special
Order request. Spec approval: not obtained (autonomous run); this records the
scope for review after implementation. Tier 3 verification is scoped to the
shared planning validator and actual save/command/restore endpoints.

## Acceptance criteria

1. A linked Special request never rejects planning for PO approval, pending or
   failed delivery changes, request closure, pending or failed quantity reviews,
   Attention, post-PO changes, stock readiness, fulfillment method, handoff route,
   or PO receipt status. Each former rejection must fail a regression test before
   implementation, then pass through manual Save and autosave with HTTP 200.
2. The active snapshot includes the assigned order; no recovery-only result,
   validation issue, or SPECIAL_* planning rejection is produced by those states.
3. Incremental planner commands, confirmed plans, snapshot restore, grouped SOs,
   and split PO references follow the same policy.
4. Planning leaves request flags, operations, decisions, reviews, closure, stock,
   and purchase approval/receipt facts intact. Request workflows and physical
   fulfillment retain their own validation. Attention remains available on the
   case for follow-up.
5. The shared compatibility validator neither reads nor locks a Special case;
   case edits and planning no longer serialize through that validator.
6. General Dispatch revision, leases, driver/truck, completion, order identity,
   transport dependency and NetSuite reconciliation protections still apply.
   In particular, an ordinary SO with Unsubmitted Operator packing remains
   planning restricted, regardless of whether another request is linked.

## Failure model and setup

- Missing one save path: real HTTP PUT/manual/autosave, incremental command and
  restore tests; property examples combine all former request blockers.
- A recovery response looks successful: assert HTTP 200, no recovery draft and
  reread the active snapshot.
- Clearing Attention masks an operational issue: reread the request and compare
  its unchanged attention/reviews/approval; no production data repair.
- Removing unrelated protections: existing save recovery, stale revision, leases,
  completion and fleet suites plus direct generic reconciliation regression.
- Concurrent case operations: exercise planning while a separate case operation
  holds its row lock and verify planning requires no Special row lock.
- Deployment drift: patch only dispatch-plan-repository.js onto the exact live
  image; compare captured source hashes/configuration and roll back on unhealthy
  release. Keep the other three production services and all data in place.

Use existing Node, PostgreSQL, fast-check, c8, ESLint and TypeScript tooling.
Retain source baselines, logs, mutation scripts and an evidence report. No new
dependencies, migrations, checkpoint commits or production business-data edits.
Tests use the standard isolated Compose configuration, mbbs-tests.slice and its
memory/CPU/PID/tmpfs limits. Register finally teardown before creating resources;
remove containers, disposable databases and project networks and check both
Docker container listings and production health.

## Investigation

SOB122402 / SPREQ-000070 has an extra Delivery Charge line (item 1987), added
following SO creation on 2026-10-09. The case draft contains the special material
and PALLET only. SO reconciliation stored Attention for the extra line and the
old planning validator rejects that flag, even though the PO is approved.
SOB122131 and SOB122133 instead have general reconciliation review with the
reason Unsubmitted Operator packing. SOB122133 has no linked Special request.

## Authorized scope update — packing status

The user clarified: packing status must not block planning, except splitting.
This supersedes acceptance criterion 6's packing exception and the one-file
release constraint. Preparing, partially packed, packed, and their packing-only
reconciliation Review permit assignment and save. The stored packing and review
facts remain intact. Mixed/unknown reconciliation issues and physical completion
still retain their restrictions. Existing packed-order split/unpack protections
remain enforced. The release may now overlay the shared SO planning policy and
its state query as well as the Special planning compatibility validator.

Add acceptance coverage for individual and grouped SOs, current order-feed/catalog
hydration, manual/autosave/commands, and packing-only review versus other or mixed
review reasons. Preserve splitting controls and test the actual split rejection.

Current authority must also clear a stale packing Review on a cached group card
when every member has a known, unrestricted source state. A genuine member review
must keep that cached group restricted. This covers the card before reopening a
plan has refreshed its saved group snapshot.
