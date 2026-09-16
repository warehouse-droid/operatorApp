# SO Delivery cleanup — dry-run result

**Result: the Operator correction passes the simulation for the proposed rows. A data-only cleanup does not meet the requirement to keep fulfilled SOs available for Dispatch planning. No live order, line, plan, completion, inventory, or NetSuite transaction was changed.**

## Evidence and scope

- Production database: `mbbs_yard`, captured **2026-09-15 13:08:03 UTC** in a repeatable-read, read-only transaction, followed by rollback.
- Direct NetSuite status verification: **13:09:43–13:09:51 UTC**. Only SuiteQL SELECT queries were issued. Local database writes were disabled on every connection.
- Scanned **1,721 Delivery records**, including local split children. Excluded **10,910 Pick-Up records**.
- Queried **1,706 positive NetSuite IDs**; NetSuite returned **1,699**. Seven IDs were not returned. Follow-up lookups by order number identified four missing orders and three inactive duplicate local records with incorrect IDs.
- **883 stored statuses differ from current NetSuite statuses.** The preview uses verified NetSuite status, not the stale local header.
- The deployed Operator and Dispatch read paths were exercised for 11 representative orders. The source used for the offline quantity/display checks matches the deployed source.

These are point-in-time results. The live application continued running. Re-capture and compare evidence before any eventual apply operation.

## Rules evaluated

1. NetSuite `F` (Pending Billing) or `G` (Billed) counts as fully fulfilled, consistent with the application's existing Sales Order fulfillment policy. An active local split child may inherit full fulfillment from its exact source SO. A partially fulfilled source does not complete its unfinished children.
2. An exact completed Driver **dropoff** counts as local delivery. A completed pickup alone does not. Existing manual Dispatch completion would also qualify; the matching production SO records in this capture use Driver evidence.
3. Propose `operator_status = loaded` and `local_yard_order_status = Loaded` for eligible records. Preserve NetSuite status and fulfillment fields; local delivery alone must not claim NetSuite fulfillment.
4. Reconcile active, pickable line loading against the Operator-required quantity after linked PO/direct-TO allocations. Increase loaded quantity only where needed, preserve existing higher loaded quantities, and clear consumed packing quantities/confirmation flags. Preserve ordered quantities, sales units, inactive lines, service lines, allocations, plans, photos, and existing completion evidence.
5. Where verified fulfillment lacks Dispatch completion, propose a new `netsuite_fulfillment` completion event with an audit trail identifying the NetSuite status and observation. Do not fabricate a Driver visit or a historical delivery timestamp.
6. Hold cancelled records, active reload/reattempt cycles, duplicate identities, and unresolved line/unit/allocation inconsistencies for review.

## Coverage

| Evidence | Matching orders |
| --- | ---: |
| Directly verified as fully fulfilled in NetSuite | 1,577 |
| Active split children inheriting full source fulfillment | 8 |
| Locally completed deliveries | 519 |
| Present in both fulfillment and local-delivery sets | 504 |
| **Distinct qualifying orders** | **1,600** |
| Qualifying orders held for review | 13 |
| **Orders included in the simulation** | **1,587** |

Of the 1,587 simulated orders, **1,425 would receive at least one correction** and **162 already match the proposed state**. Fifteen qualifying orders rely on local delivery alone; their NetSuite fulfillment fields remain unchanged.

## Proposed changes

| Change | Count |
| --- | ---: |
| Open or partially loaded → Loaded | 565 orders |
| Shipped → Loaded display normalization | 767 orders |
| Already labelled Loaded, but operator status needs correction | 3 orders |
| **Total header corrections** | **1,335 orders** |
| Line corrections | 1,075 lines across 451 orders |
| Of those lines, loaded quantity would increase | 1,067 lines |
| Missing Dispatch completion events to add | 313 orders |

The line and completion counts overlap the header counts; they must not be added together as distinct orders.

**A header-only update fails:** 20 otherwise eligible orders would still have an Underpack indication. With the proposed quantity correction, every simulated eligible order displays **Loaded**, with zero open pickable lines, zero Underpack count, and zero loading warnings.

All 212 active SO groups were checked using the existing group-display calculation: **203 would display Loaded**, eight remain open, and one retains an Underpack indication because unresolved work remains. Unfinished sibling splits and held records remain unchanged. A second application of the in-memory line proposal produces no further change.

## Why the full requested behavior is not yet satisfied

The current Dispatch rules exclude billed SO families and reject adding Driver-completed references to a new plan. Changing Operator loading fields or adding fulfillment completion evidence does not change these rules.

- **539** qualifying orders are already excluded by the stored billed-status rule.
- The verified billed statuses cover **1,207** qualifying order targets, including active split children. Applying those fresh statuses would expose the larger billed-planning restriction.
- **504** fully fulfilled targets also have Driver completion and fail the existing Driver replanning guard.

These counts overlap. A scoped application change is required to keep completion evidence visible while allowing the fulfilled SO targets to be planned, as requested. Existing SO billing filters and planning admission must use that same rule. The existing PO/TO reconciliation allowance does not provide this SO behavior.

### Deployed read-path examples

| Order | Evidence | Operator now | Dispatch verification |
| --- | --- | --- | --- |
| SOR00030 | NetSuite F | Open | Search returns it; Driver/closed-order guards allow it; no completion exists |
| SOA08614 | Stored B, verified NetSuite F | Open | Search returns it; no completion exists |
| SOB119972 | NetSuite G | Open | Excluded from Dispatch search |
| SOV02345 | NetSuite B; Driver dropoff complete | Open | Completion is shown; adding it again fails `DISPATCH_ORDER_DRIVER_COMPLETED` |
| SOA07771 | NetSuite E; Driver dropoff complete | Underpack | Local-delivery rule qualifies it; NetSuite fulfillment is preserved |
| SOA07539-S1 | Driver dropoff complete; source fully fulfilled | Open | Exact split qualifies; Driver replanning guard rejects it |
| SOA08404-S2 | No completed dropoff; source still pending | Open | Remains unchanged by this cleanup |
| SOM05681 | Source NetSuite F; reload cycle still packed | Re-load Ready | Held to preserve/review the reload cycle |

No plan-save or browser-after-apply test was run: the exercise deliberately kept production data read-only. The after-state results are an offline simulation using the application's quantity, group, and Operator-label functions.

## Review before applying

Thirteen qualifying orders are held:

| Reason | Orders |
| --- | --- |
| Locally cancelled | SOR00107 |
| Reload/reattempt cycle still active | SOM05681 |
| Packed quantities on inactive lines | SOB108436, SOB111243 |
| Loaded unit differs from current sales unit | SOA04452, SOA04752, SOM04882, SOB114720, SOA05680 |
| Packed line has a sync exception | SOB114506, SOA05157 |
| Linked allocation exceeds the order quantity | SOB116833 |
| Duplicate local order reference | SOM05565, canonical ID 939699 |

Seven additional unverified records are excluded:

- **SOR00085, SOR00086, SOR00087, SOS00002:** not returned by NetSuite by either ID or order number.
- **SOM05565 / 991002001:** inactive duplicate; NetSuite's real ID is **939699**, which already exists locally as Delivery.
- **SOM05566 / 991002002:** inactive duplicate; NetSuite's real ID is **939710**, which already exists locally as Pick-Up.
- **SOM05567 / 991002003:** inactive duplicate; NetSuite's real ID is **939724**, which already exists locally as Pick-Up.

Do not remap or delete these duplicate rows as part of this status-only proposal. They require a separate identity repair. The canonical SOM05565 and its inactive duplicate appear as separate rows in the review export.

## Reviewable artifacts

- [All orders, before/after status and reasons](../test-artifacts/so-delivery-cleanup-20260915/orders.csv)
- [Records held for review](../test-artifacts/so-delivery-cleanup-20260915/review.csv)
- [Proposed line changes](../test-artifacts/so-delivery-cleanup-20260915/line-changes.csv)
- [Complete dry-run result and verification](../test-artifacts/so-delivery-cleanup-20260915/dry-run.json)
- [Direct NetSuite status evidence](../test-artifacts/so-delivery-cleanup-20260915/netsuite-statuses.json)
- [Missing-ID follow-up evidence](../test-artifacts/so-delivery-cleanup-20260915/missing-reference-checks.json)
- [Deployed Operator/Dispatch read-path checks](../test-artifacts/so-delivery-cleanup-20260915/planning-checks.json)

Read-only tooling: [capture](../tools/so-delivery-cleanup-capture.mjs), [NetSuite verification](../tools/so-delivery-cleanup-netsuite-read.mjs), [planning checks](../tools/so-delivery-cleanup-planning-read.mjs), [offline simulation](../tools/so-delivery-cleanup-analyze.mjs). These tools have no apply mode.
