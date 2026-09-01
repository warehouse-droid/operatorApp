# Global Dispatch order pool and dependency execution preview specification

Status: not obtained as a separate approval checkpoint (autonomous production
repair requested on 2026-08-28).

Assurance tier: Tier 3. These changes affect confirmed Dispatch plans and the
started-work fence around SCM transfer dependencies. The user explicitly
required reproduction before coding and a short-cutover deployment.

## Production witnesses and RED targets

- `GOB-119005-119006` exists in the 2026-08-28 plan snapshot, but the global
  catalog contains only its source members (`SOB119005`, `SOB119006`). The group
  was never represented as a global order-pool entity, so it cannot be searched
  from the 2026-08-29 board even though the final delivery group is unassigned.
- `CO-GOB-119005-119006` is assigned to 2026-08-28. That transit assignment must
  remain there and must not make the distinct final-delivery group assigned.
- Dependency `231` links `SOA07787` to `TOB00991` and is cancelled. Every
  dependency execution quantity is zero; the TO is open, unplanned, and has no
  Operator or Driver start evidence. Preview nevertheless emits
  `DEPENDENCY_EXECUTION_STARTED` because it treats `cancelled` status itself as
  execution.

## Executable scenarios

### G1 — a delivery-group definition is global

Given source orders are grouped on one plan, when that plan is saved, then a
durable global catalog entry for the group is upserted with its member structure
and searchable card. Opening a different date can find the same group without
copying the owner plan's route assignment.

### G2 — assignment is independent for group and transit CO

Given `CO-<group>` is assigned on the source plan while `<group>` itself is not,
then the catalog reports the CO as planned and the group as unplanned. The group
can be selected on another date; its members are not offered as duplicate raw
orders while the global definition is active.

### G3 — an assigned group remains globally searchable but read-only

Given the group itself is assigned to a non-cancelled plan, an exact global
search returns it with that plan/date jump metadata and prevents a second
assignment. The normal unsearched pool omits assigned entries.

### G4 — an ungroup operation retires the global definition

Given the canonical owner plan no longer contains the group definition, saving
that owner plan retires the group catalog entry and exposes eligible members
again. Saving an unrelated date must not retire or resurrect the definition.

### D1 — cancelled without progress is not execution

Given a historical cancelled dependency for a TO and all of its execution
quantities are zero, a new `link_to` preview for that TO does not emit
`DEPENDENCY_EXECUTION_STARTED`.

### D2 — actual dependency progress remains a hard blocker

Given a cancelled or active dependency has any loaded, delivered, or locally
received quantity, preview emits `DEPENDENCY_EXECUTION_STARTED` with that exact
dependency ID.

### D3 — actual TO work remains a hard blocker

Given `TOB00991` itself has Operator line/status evidence or an exact Driver job
reference, preview blocks with the corresponding Operator or Driver activity
code. A job containing only `CO-TOB00991` is not an exact reference to
`TOB00991` and does not start the dependency.

## Invariants and negative constraints

- Keep existing plan-specific stale-snapshot protection: a foreign saved group
  object cannot silently materialize into another plan.
- Do not move, delete, or rewrite the live 2026-08-28 CO route assignment.
- Do not mark source members independently available while their active global
  group definition exists.
- Catalog refresh/replacement must not delete active synthetic group entries.
- Matching is by normalized exact order reference, never substring/prefix
  (`CO-TOB00991` is not `TOB00991`).
- Cancellation alone is not physical execution; non-zero execution quantity,
  actual Operator activity, exact Driver activity, receiving evidence, and
  terminal/closed state retain their existing blockers.
- Preserve public request/response shapes, plan optimistic concurrency, leases,
  offline evidence, and assignment uniqueness.
- Add no package dependency. Tests use disposable rollback transactions or the
  isolated MBT database. Production remains read-only until GREEN and backup.
- No commit is created in the user-owned dirty worktree.
