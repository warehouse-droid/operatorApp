# Smart SCM Blanket residual coverage specification

Status: approved by the user on 2026-08-31.

Assurance tier: 3. These quantities can create Purchase Orders and Transfer
Orders, so undercoverage and double coverage are operationally material.

## Executable contract

1. Given an item-yard requires 50 PLT and the compatible open Blanket pool has
   1 whole PLT, the Blanket allocation is 1 PLT and ordinary planning receives
   exactly 49 PLT.
2. The 49-PLT residual follows the existing routing rules. An eligible vendor
   produces PO coverage; an unavailable vendor with safe source stock produces
   TO coverage. Blanket availability does not force either order type.
3. When compatible Blanket quantity equals or exceeds demand, ordinary planning
   emits no PO or TO for that item-yard.
4. When multiple yards compete for one item pool, whole pallets are assigned by
   urgency level descending, urgency score descending, then location ID
   ascending. Source PO lines remain oldest-first. The result is deterministic.
5. Blanket coverage uses only compatible item/ToPLT source lines and never
   exceeds either floor(required PLT) or the open pool after receipts, active
   sales allocations, active PO splits, and reserved/held Blanket releases.
6. Fractional demand not covered by a whole Blanket pallet remains in the
   ordinary residual. A manually paused item receives no automatic Blanket
   allocation, preserving the current Blanket workflow exclusion.
7. Integrated and `po_then_transfer` planning use the same residual. The
   combined Blanket plus PO/TO quantity is validated against original demand.
8. Planning-run totals and proposal evidence retain original required PLT,
   Blanket-covered PLT, residual PLT, and the source PO references used by the
   calculation snapshot.
9. The Blanket coverage panel describes quantity coverage, not an entire-item
   PO pause, and tells operators that uncovered demand remains eligible for
   PO/TO planning.

## Must-not-change invariants

- Existing Blanket release reservation, source-line lineage, split creation,
  derived PALLET lines, and reservation-time stale-balance checks remain intact.
- Manual PO pauses remain all-or-nothing for vendor POs and continue permitting
  safe internal TOs.
- Existing endpoints and database schema remain compatible. New API data is
  additive JSON metadata; historical runs and proposals are not rewritten.
- The calculation itself does not reserve or release Blanket stock.
- No dependency, network, subprocess, filesystem, or environment capability is
  added to production code.

## Failure model and detector

| Failure | Required detector |
| --- | --- |
| One Blanket pallet suppresses all 50 PLT | Regression asserting a 49-PLT ordinary residual |
| PO/TO covers 50 while Blanket also covers 1 | Combined-coverage validator and overcoverage regression |
| The same pool is credited to multiple yards | Property tests over arbitrary pools and demand states |
| Inventory and Blanket planners allocate different yards | Shared allocator integration test |
| Reserved/held or incompatible stock is credited | Database pool integration scenarios |
| Phased approval rebuilds the full demand | `po_then_transfer` regression |
| UI still calls Blanket coverage a PO pause | Frontend source contract |
| Weak tests allow an off-by-one or removed guard | Persisted mutation runner with all mutants killed |

## Setup and evidence plan

- Use the repository's existing Node test runner, c8, ESLint, TypeScript check,
  database harnesses, and secret scanner. Add no dependencies.
- Add a focused test/coverage/mutation/gauntlet entry point and a reproducible
  source-state script. Do not create commits or reset the dirty worktree; record
  a deterministic tree hash instead.
- Observe the new behavioral regression failing before implementation, then run
  the final gauntlet from a fresh state and publish exact results in the paired
  evidence report.
