# Smart SCM phased planning and PO split editing — executable specification

Approved by the user on 2026-08-26 through the implementation plan that this
document makes executable. This is a Tier 3 change because it controls inventory
recommendations and concurrently allocated Purchase Order quantities.

## Setup contract

- Use the repository's existing Node test runner, `fast-check`, PostgreSQL test
  container, Playwright, c8, ESLint, and TypeScript configuration.
- Add no runtime or development dependency.
- Do not commit, deploy, back up production, or mutate production data as part
  of this implementation.
- Preserve the dirty worktree and all unrelated user changes.
- Add one additive migration; Skip 12441 defaults off and inventory planning
  defaults to the legacy integrated mode.

## Failure model

| Failure | Required detector |
| --- | --- |
| Shifted demand is lost, duplicated, rounded incorrectly, or routed to 12441 | unit + randomized conservation properties |
| Existing planning changes while both switches are off | legacy regression and integrated-mode equivalence contracts |
| A proposal without a real PO/ref inflates expected inventory | phase-basis unit/integration contract |
| A local split is counted at both its parent and child destination | real PostgreSQL destination-overlay integration test |
| Two users build Phase 2 or consume the same source PO quantity twice | PostgreSQL concurrency tests |
| A filtered Schedule silently narrows editable route choices | frontend contract using a one-row filtered result |
| A hostile client saves a route outside the vendor/yard domain | HTTP/integration validation test |
| A planned/linked/received split is changed behind Dispatch or Driver | centralized blocker integration and adversarial endpoint tests |
| A failed split edit partially changes source, child, or Blanket ledgers | transaction rollback integration test |
| A Blanket edit violates planned = released + held + cancelled | property + real PostgreSQL conservation tests |
| A stale browser overwrites a newer split edit | optimistic-concurrency test returning 409 |
| New SCM UI or cache assets fail on supported browsers | frontend contracts + focused Playwright + full baseline |

## Scenarios

### Skip 12441

1. Given an item's 12441 demand attribution is SOB=60, SOA=30, SOM=10,
   enabling Skip 12441 moves all 100 units to 3445 and 2967 in the normalized
   SOB:SOA ratio, leaves exactly zero at 12441, and conserves exactly 100.
2. Given no item-level SOB/SOA evidence, the same-window company ratio is used;
   when the company window also has no evidence, the ratio is 50:50.
3. Given Skip 12441 is enabled, 12441 safety stock, ROP, preferred stock, and
   destination requirement are exactly zero, but available 12441 inventory has
   a zero protected floor and may source a TO.
4. No automatic PO, TO destination, Blanket release, Gormley redirect, or
   consolidation destination may be 12441 while the switch is enabled.
5. Raw sales facts are never rewritten, and disabling the switch restores the
   existing forecast/planning behavior on the next run.

### Approved PO then Transfer planning

6. Integrated mode retains the current PO/TO planning result.
7. `po_then_transfer` initially creates direct-vendor Phase 1 PO proposals only.
8. Approving the PO phase counts only open remaining quantities from real
   NetSuite POs and active local split refs. Order Requested or vendor-confirmed
   proposals without a real PO/ref count as zero.
9. Every active regular or Blanket split ref is reallocated once from the
   parent PO's original destination to the child line's effective destination;
   received, closed, cancelled, inactive, and fully received quantities count
   as zero.
10. Phase 2 creates internal TOs from residual shortage and current transferable
    source inventory; Phase 3 retains consolidation purchases for any residual.
11. The Phase 2 basis is immutable. Later PO/split changes do not change or
    invalidate its proposals; only a new planning cycle sees them.
12. Repeated or concurrent approval of the same planning-run ID creates one
    Transfer phase and returns the same completed run.

### PO/TO Schedule route domains

13. A PO row always receives pickup options from its active mapped vendor yards
    and drop-off options from the four company yards, regardless of filters or
    result count.
14. A grouped PO receives the intersection of its members' vendor yards. A TO
    receives the four company yards for both endpoints. VRMA remains unchanged.
15. A legacy current value remains visible, but an explicit invalid route change
    is rejected by the server without changing the schedule row.

### Split PO editing

16. Existing PO Split editors may submit one complete desired line state using
    the loaded revision. Reducing returns quantity to the source; increasing or
    adding consumes only the live available source balance.
17. Autocomplete returns active open lines from the exact source PO, keeps
    duplicate SKU source lines distinct, and excludes lines already positive in
    the child. A zeroed line becomes selectable again.
18. The transaction updates child line quantities, split current/requested
    ledgers, weight/content projections, and audit history together. An entirely
    empty desired split is rejected in favor of Unsplit.
19. Any active Dispatch plan assignment (with legacy snapshot fallback), active
    PO link/group, Driver activity, receiving evidence, or closed order blocks
    quantity, item, ref, yard, schedule, and unsplit mutations.
20. Concurrent sibling edits cannot exceed the source order. A stale split
    revision returns `SCM_PO_SPLIT_STALE`/409 and changes nothing.
21. For a Blanket-generated split, reduction moves released quantity to
    cancelled, increase consumes cancelled before expanding planned/released,
    held remains untouched, and added items receive linked released allocations.
    Proposal/release totals and append-only events remain conserved.

## Negative invariants

- No Driver PWA API, persistence schema, service worker behavior, or workflow is
  changed.
- The Smart SCM settings are independent; Skip 12441 defaults off and phased
  planning remains opt-in through the integrated-mode default.
- Schedule filter choices never become edit-domain choices.
- Local split editing never writes a Purchase Order change to NetSuite.
- Every rejected command rolls back all affected tables and emits no success
  event.
