# SCM PO NetSuite line sequence and pallet conservation specification

Status: autonomous Tier 3 executable specification (approval not obtained before implementation).

## Production witness

On 2026-09-03, a direct read-only NetSuite query for `POB03774` returned eight
active item lines. Its three `PALLET` item lines have quantities `6`, `3`, and
`4`, for an authoritative family total of `13` PALLET units. Active split
`SN1399024` still points its current `4` PALLET units at removed NetSuite line
key `4840837`; NetSuite replacement line key `4840839` also carries `4` units.
Adding the stale child to the unreduced replacement line produces the incorrect
frontend family total of `17`.

NetSuite returned `linesequencenumber` values `1` through `8`. The canonical
mirror currently retains line keys but not the active lines' sequence numbers,
and the split editor sorts source lines by SKU before line identity.

## Acceptance scenarios

1. **Canonical NetSuite sequence survives synchronization**
   - Given a NetSuite PO line with a line unique key, order-line number, and
     `linesequencenumber`,
   - when the line is normalized and stored,
   - then its canonical raw evidence retains the NetSuite order-line and
     sequence values without replacing its stable unique line key.

2. **PO detail is ordered and visibly numbered like NetSuite**
   - Given PO items whose unique keys are not in NetSuite visual order,
   - when SCM renders the PO detail,
   - then it orders the items by NetSuite sequence and shows `NetSuite line N`
     on every row that has an authoritative sequence.

3. **Split detail and split editing use the source NetSuite sequence**
   - Given an active split whose child rows originate from source PO lines,
   - when SCM renders or edits the split,
   - then child/source rows use and display the source line's NetSuite sequence,
     not alphabetical SKU order.

4. **Missing or hostile sequence metadata is safe and deterministic**
   - Given missing, duplicate, zero, negative, or non-numeric sequence values,
   - when rows are ordered,
   - then valid positive sequences come first and ties/fallbacks use stable
     numeric line identity and original position; no row is dropped.

5. **A reduced stale split allocation can be rebound without restoring it**
   - Given an active child currently carrying `4` PALLET units, historical
     requested quantity `7`, an inactive source line, and an exact active
     replacement with capacity `4`,
   - when an admin previews and applies the explicit source-line rebind,
   - then the candidate is allowed using the current `4` units, the child stays
     at `4`, requested history stays `7`, and the source/child line identity is
     moved to the replacement.

6. **POB03774 family PALLET units conserve to 13**
   - Given replacement parent line `4840839 = 4`, active child
     `SN1399024 = 4`, active child `SN1399025 = 6`, and unsplit source line
     `4893476 = 3`,
   - when the stale child is rebound and the exact family/catalog is refreshed,
   - then parent residual PALLET item units are `3` and the active family total
     is `3 + 4 + 6 = 13`, not `17`.

7. **Safety checks remain strict**
   - A replacement with capacity below the child's current quantity is rejected.
   - Item/unit mismatch, another active split allocation, pinned evidence,
     stale expected source identity, and required baseline reduction remain
     rejected or explicitly confirmed as before.
   - Candidate discovery never auto-selects or mutates a line; applying a
     rebind still requires an admin identity and audit note.
   - Cancelled split headers do not consume source capacity.
   - Existing completion/Driver evidence remains attached to the child order.

## Setup and gauntlet

- Reuse the repository's Node test runner, PostgreSQL rollback harness, c8,
  ESLint, TypeScript checks, manual mutation pattern, Docker test image, and
  localhost/live read-only verification.
- Add no package, lockfile change, external dependency, or new capability.
- Do not commit because the shared worktree contains extensive user-owned and
  concurrent changes.
- Persist focused tests, a mutation runner, a source-state script, one gauntlet
  entry point, and the final evidence report in the repository.
- Production writes are limited to a separately verified, audited POB03774
  source-line rebind and the normal exact reconciliation/catalog refresh. A
  database backup and rollback procedure are required before that write.

## Failure model

| Failure mode | Required detector/control |
| --- | --- |
| A repeated PALLET SKU is rebound to the wrong NetSuite line | Explicit admin candidate selection; item/unit/current-capacity checks; exact POB03774 before/after witness |
| Historical requested quantity is silently discarded or restored | Rollback integration assertions for current and requested quantities |
| Parent and child both expose the same four PALLET units | Family conservation integration assertion and live post-repair sum |
| Receipt baseline is reduced without adequate evidence | Existing baseline-confirmation test plus focused regression |
| Sequence metadata is malformed or absent | Deterministic ordering property/adversarial tests |
| UI sorts by SKU or line unique key instead of NetSuite sequence | Frontend contract test with deliberately conflicting orders |
| Concurrent/stale admin action overwrites newer lineage | Existing expected-source compare-and-lock behavior remains under test |
| A broad refresh changes unrelated orders | Exact-ID reconciliation/catalog refresh and before/after audit scope check |
