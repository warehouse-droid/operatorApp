# Dispatch stale delivery address — CE94487, 2026-09-12

Spec approval: not obtained (autonomous run under the user's request to solve the issue).
Tier 3 for the guarded live-data repair; normal bug-fix scope for address projection.

## Acceptance criteria

- SA-1: Saving SOA08353's address from 39 Estoril St to 145 Valleymede Dr updates
  its displayed, routing and default delivery addresses together, using the
  acknowledged normalized value. Grouping it with SOA08354 must then produce a
  different physical drop from SOB120030 at 39 Estoril St.
- SA-2: Refreshing a Sales Order group's source updates the representative
  member's delivery address on the group. The representative is retained by
  identity when members are reordered. A deliberate group-only address remains
  effective. Existing inconsistent group address aliases become consistent.
- SA-3: PO pickup/delivery overrides, TO yard destinations, local CO manifests,
  stop-specific destinations and same-address consolidation retain their
  existing behavior. Cargo, member identities and inputs are not mutated by
  address projection. Empty source addresses clear stale delivery addresses.
- SA-4: The affected global group and current September 12 plan receive the
  authoritative source address. Repair preserves the latest assignments,
  other orders, cargo and driver records; it does not restore removed stops.
  A backup, snapshot history, audit and revision increase accompany the repair.
  Default execution rolls back. Repeat application is a no-op. A stale revision,
  changed source address or started driver work refuses the repair.
- SA-5: The real browser executes the save handler and resolves two separate
  physical visits. The released app serves the checked assets and is healthy.

## Failure model and setup

Stale aliases: executable browser-function tests and browser replay. Stale group
refresh: real database catalog/group tests. Manual override loss and wrong member:
properties and adversarial inputs. Live concurrent writer: existing fleet/source
locks, row locks and revision guard. Partial repair: rollback rehearsal and
injected failure tests. Historical evidence loss: exact preservation assertions.

Use existing Node, Docker test images, PostgreSQL, Playwright, fast-check, ESLint
and TypeScript. No dependencies or schema changes. Add focused tests, repair
tool, repeatable gauntlet/mutation commands and evidence. Preserve existing
uncommitted changes and do not create commits. Release only the changed files
on top of the current production image, retain a rollback image, and repair
only the verified incident records.

## Amendment after guarded live rehearsal

The user saved revision 12 with both drops assigned again. SA-4 additionally
permits repairing that latest assignment using a timing projection produced by
the real Dispatch browser functions. The projection must match the locked plan
revision and exact prior trucks, include every stop of the affected load, and
have non-overlapping stop intervals. Only that load's derived timing and route
cache may change. Every assignment, stop ID/order and cargo value remains exact.
