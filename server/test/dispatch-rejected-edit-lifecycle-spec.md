# Rejected Dispatch edit preserves split and group definitions

User authorization: fix the reproduced bug and correct SOB120921 on 23 September
2026. Spec approval: not obtained (autonomous run); the user authorized the fix,
but did not separately review these acceptance criteria. Tier 3: dispatch data
integrity and a guarded live repair.

## Acceptance criteria

1. Reject a truck assignment after unrelated S1/S2 and group cards entered the
   current pool after the undo snapshot: restore the truck and queue no retirement
   or reactivation of those cards.
2. The same holds for rejected dependency sequence and stop-time override edits.
3. A rejection preserves already queued lifecycle intents exactly; it must neither
   introduce an intent nor clear a valid pending intent from a prior action.
4. Deliberate undo/redo continue to retire/reactivate the structures they change.
5. The invariants hold for arbitrary split/group identifiers and repeated rejected
   edits. Browser/VM execution must use actual production function bodies.
6. Repair only SOB120921's confirmed incident: keep S1 at 21 pallets, S2 at five
   pallets and Pick-Up; replace the group's 26-pallet parent with S1 so the group
   totals 23 pallets. Preserve source quantities, unrelated orders, address,
   delivery window/date, truck, load, and stop identities.
7. Repair is one database transaction, with a private before-image and audit,
   locks, revision checks, a rollback rehearsal, and refusal if execution or
   packing has started or the incident state has changed. Repeating an already
   completed repair must be a no-op. Verify definitions, snapshots, catalog,
   grouping membership, assignments and public app health afterward.

## Failure model and checks

- Accidental retirement from stale UI history: three rejecting-path tests and
  generated input tests; manual mutants revert each caller and disable undo.
- Broken undo/redo: existing authoritative-retirement suite and direct tests.
- Concurrent live edit or operational work: transaction/advisory/row locks,
  state fingerprint and activity/lease guards; rerun preflight immediately before
  commit. Rehearse writes with rollback and verify the original state returns.
- Partial repair or wrong order: exact references/quantities, preserved before
  image, audit, all-or-nothing transaction, verification and idempotence.
- Release includes unrelated workspace edits: build a patch over the live image,
  compare file inventory, test the candidate, preserve runtime configuration and
  retain a rollback image. Only the Dispatch browser file needs deployment.

## Setup and limits

Use existing Node, Docker, node:test, espree, fast-check, c8, ESLint and TypeScript
tooling; add no dependencies. Add focused tests, repair/deployment/check scripts,
specification and evidence artifacts. Run in isolated test containers/databases;
only the explicit repair command may commit production changes. Preserve the
dirty workspace, make no commits, record source hashes. No NetSuite writes.
Full suite, static types and lint are compared with the existing baseline rather
than silently fixing unrelated failures. Record any unavailable layers explicitly.

## Rehearsal clarification (append-only)

The operator group API deliberately omits the `OthCharge` delivery-fee line. Its
manifest assertion therefore covers the six loadable S1 lines; the independent
database before/after equality still covers all seven S1 lines and every other
source line, including delivery charges. The initial seven-line operator assertion
failed and rolled the rehearsal back without a committed change.

The release also changes only the Dispatch HTML script version so reloading the
page fetches the fixed JavaScript. No other HTML changes are included.

The same lifecycle invariants apply to an empty history snapshot whose `orders`
field is absent: rejection must preserve definitions, while deliberate undo to
that empty snapshot must retire the removed structures. This adds an explicit
sparse-history edge case found during branch-coverage review.
