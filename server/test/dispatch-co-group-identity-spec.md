# Dispatch internal CO group identity — executable specification

Spec approval: not obtained before implementation (autonomous run after the user requested the rename and clarified both creation paths). This is the append-only review artifact.

Assurance tier: 3. The change renames a persisted planning identity while preserving completed Driver PWA evidence and guarded plan state.

## Setup and authorization boundary

- Reuse the repository-pinned Node, PostgreSQL, `node:test`, fast-check, c8, ESLint, TypeScript, and isolated Docker Compose test environment.
- Add no runtime or development dependency and do not change lockfiles.
- Preserve all unrelated worktree changes.
- Reproduce the browser naming defect and the persisted-plan repair defect before implementing either fix.
- Repair only canonical Dispatch planning projections. Historical Driver PWA job IDs, stop IDs, actual-arrival visit keys, and pre-existing audit evidence are immutable and must not be rewritten.
- Deploy with a short app/worker cutover only after the final fresh gauntlet passes.

## Failure model

1. Grouping `CO-SOA07510` and `CO-SOA07512` strips the `CO-` namespace and creates the misleading identity `GOA-7510-7512`.
2. Grouping source SOs first and then creating one CO produces `CO-GOA-7510-7512`, while creating individual COs first and grouping them produces a different identity.
3. A CO is grouped with an SO/TO/PO/custom order, creating an invalid mixed lifecycle that cannot be completed or received consistently.
4. A stale browser submits the legacy `GOA-...` identity after the frontend fix and persists it again.
5. A repair changes visible order IDs but leaves truck stops, assignment projections, or relation edges on the old identity.
6. A broad string replacement mutates stable stop/job IDs, breaking existing Driver PWA and actual-arrival evidence.
7. A repair partially commits, collides with an existing `CO-GOA-...`, changes source SO identities, reopens completed child COs, or is not idempotent.

## Acceptance scenarios

1. Given two individual CO cards `CO-SOA07510` and `CO-SOA07512`, grouping them produces exactly `CO-GOA-7510-7512`.
2. Given source cards `SOA07510` and `SOA07512`, grouping them produces `GOA-7510-7512`; creating a CO for that source group produces exactly the same outer identity, `CO-GOA-7510-7512`.
3. Grouping CO + CO is allowed. Any selection containing both CO and non-CO members is rejected with `DISPATCH_CO_GROUP_MIXED_TYPES`; ordinary non-CO grouping remains unchanged.
4. Server canonicalization converts a stale all-CO group `GOA-7510-7512` to `CO-GOA-7510-7512` and rewrites exact semantic references throughout orders, loads, and stops.
5. Canonicalization preserves embedded immutable identifiers such as `stop-...-GOA-7510-7512-...`, source SO IDs, and individual child IDs.
6. If the canonical target identity already belongs to another order, canonicalization fails closed with `DISPATCH_CO_GROUP_IDENTITY_CONFLICT` and changes nothing.
7. Startup repair runs under the Dispatch fleet-planning advisory lock, updates the current snapshot, digest/count metadata, assignment projection, and relation projection atomically, and writes a rename audit event.
8. Archived checkpoints are not rewritten. All current/checkpoint read and restore paths canonicalize the legacy identity before returning or persisting it.
9. Repeating canonicalization or startup repair is idempotent and writes no second repair audit.
10. The production case renames only the completed wrapper `GOA-7510-7512`; `CO-SOA07510` and `CO-SOA07512` remain terminal and absent from the order pool, while `SOA07512` remains available from `12441` for its separate customer-delivery leg.

## Must-not-change constraints

- Do not reopen or recreate completed/received CO children.
- Do not mark source SO customer deliveries complete from yard-transfer evidence.
- Do not rewrite Driver PWA records, Driver offline records, actual-arrival records, or existing audit rows.
- Do not change stable load IDs or stop IDs merely because they contain the old display identity.
- Do not rename ordinary grouped SO/TO/PO identities.
- Do not change plan dates, truck routing, locations, quantities, line evidence, or dependencies.
- No new dependency, external network capability, or schema-wide destructive rewrite.
