# POB03535 remaining quantity — root-cause investigation

Investigated read-only on 2026-09-15, using the running
`mbbs-operator-app:to-cleanup-20260915-v1` application. No production data or
application source was changed by this investigation.

## Finding

**The local SCM PO list calculates unallocated original quantity and presents it
as remaining quantity, ignoring current cumulative NetSuite receipts.**

POB03535 is NetSuite internal ID **900265**. A fresh NetSuite read found **zero
remaining on all 37 lines**, with status **F / Pending Bill**. The local parent
already contains the same ordered and received quantities. Both the direct SCM
repository and its cached catalog nevertheless return **32 PLT** and **31 EACH
of PALLET**, while also marking the PO **Completed**.

| Item | Current ordered | Current NetSuite received | Active split allocations | Wrong local residual |
| --- | ---: | ---: | ---: | ---: |
| PER-EKO70S-RDM-FOS | 15,376.2 SQFT / 147 PLT | 15,376.2 SQFT / 147 PLT | 13,075 SQFT / 125 PLT | 2,301.2 SQFT / 22 PLT |
| PER-MEL60S-RDM-SCG | 3,148.2 SQFT / 27 PLT | 3,148.2 SQFT / 27 PLT | 1,982.2 SQFT / 17 PLT | 1,166 SQFT / 10 PLT |
| PALLET | 983 EACH | 983 EACH | 952 EACH | 31 EACH |

The correct receiving remainder for every row is **0**. Quantities with different
units must not be combined into a meaningful physical total; the application's
raw `salesQty` value of 3498.2 is retained only as evidence of its existing output.

## Mechanism

1. Migration `025_purchase_order_received_baseline.sql` defines
   `netsuite_received_baseline_qty` as the received amount when a line first
   entered local tracking. It deliberately stays fixed. It is **0** on every
   line of this PO.
2. `upsertPurchaseOrderLines` correctly updates the live `quantity` and
   `netsuite_received_qty` on synchronization while retaining that baseline.
3. The SCM/Dispatch PO query uses:

   ```text
   sales quantity = max(ordered - coalesce(initial baseline, current received) - active split allocations, 0)
   pallet quantity = max(ordered pallets - active split pallets, 0)
   ```

   Since zero is a valid, non-null baseline, the current received amount is never
   selected. For EKO70S-RDM-FOS, it displays `147 - 125 = 22 PLT`, despite all
   147 PLT already being received.
4. Reconciliation independently calculates the source residual as fully received,
   with `remaining: 0`, and sets the status to Completed. Its receipt allocation
   state is not used to calculate the PO list's quantity columns. Consequently
   status and quantities disagree. A fresh direct repository call and the cached
   catalog return the same incorrect values, so a cache refresh alone does not
   resolve this.

The deployed query is in the captured `src/dispatch-repository.js`, lines
1230–1232 and 1259–1268. The receiving module also chooses the fixed baseline
in `src/receiving-repository.js:21` and subtracts it in `remainingLineQuantities`.

## Event evidence

- **17:46:53 UTC:** webhook 5706 recorded the PO as partially received. For
  example, EKO70S-RDM-FOS was ordered at 41,840 SQFT / 400 PLT and received at
  15,376.2 SQFT / 147 PLT.
- **17:56:53 UTC:** webhook 5725 carried amended ordered quantities equal to
  received quantities and status F / Pending Bill. EKO70S-RDM-FOS became
  15,376.2 SQFT / 147 PLT; MEL60S-RDM-SCG became 3,148.2 SQFT / 27 PLT;
  PALLET became 983 EACH. The webhook succeeded at **17:56:54 UTC**, on its
  first attempt, with no error.
- **18:00:19 UTC:** the local parent and all 37 source lines were synchronized.
  Reconciliation audit events 67505/67506 proposed/applied Completed with
  remaining and destinationRemaining both zero.
- **18:35 UTC onward:** fresh NetSuite and live local repository reads reproduced
  the discrepancy described above.

## Related split-record inconsistency

This PO has 44 split definitions: 42 active and 2 cancelled. All **105 lines in
the active splits** retain zero NetSuite received counters and zero initial
baselines. Their receiving records retain older receipt statuses. The live
receiving list can still find all 42 active children.

Reconciliation stores receipt allocation evidence separately. Its latest target
state has 42 Completed targets including the parent, plus one Queued child
whose manual operational status is intentionally preserved. All 43 targets have
zero calculated remainder. The stale raw child counters therefore do not mean
that NetSuite missed the receipts.

The current Smart SCM Blanket **available source pool** correctly returns no
POB03535 lines, because Pending Bill is excluded by its status filter. The
incorrect 32-PLT value was reproduced specifically in the SCM purchase-order
list and its cached catalog. Operator receiving has the related baseline/split
projection inconsistency described above.

## Confirmed screen: PO Split

The user confirmed that the discrepancy appears in **PO Split**. The captured
deployed `public/dispatch-scm.js` identifies this page as "SCM PO Split" at line
1005. It loads the list through `/api/dispatch/scm/v2/purchase-orders` at line
578 and the selected PO through `/api/dispatch/scm/v2/purchase-orders/:ref` at
line 435. Source-line availability is rendered from that order's quantities at
line 838. The detail route uses `getScmPurchaseOrderCatalogOrder`, the same
catalog getter whose live POB03535 result was tested above.

Thus the observed PO Split values follow the affected calculation directly.
**POB03535 should offer zero quantity for new splits**, because all current
ordered quantities have already been received. Existing split quantities must
remain available as historical assignments; they are not evidence of additional
quantity available to split.

## Correction required

Use current cumulative receipt/reconciliation evidence for available and
receivable quantities. Keep historical split assignments and the fixed baseline
for their original accounting/tracking purpose. Account for overlap between
NetSuite receipts, confirmed local receipts and received split allocations so
the same receipt is not deducted twice. Apply the resulting availability
consistently to native quantities, pallet quantities, source residuals and
split receiving projections.

Refreshing NetSuite again or overwriting the historical baseline is not a
complete correction. The calculation must be corrected; implementation and
deployment were not part of this investigation request.

## Follow-up: exact local split versus IR memo comparison

Fresh reads at 18:53–18:54 UTC on 2026-09-15 found 44 NetSuite IR references
against 42 active local splits. There are 41 exact reference matches. Receipt
references **3022050548 / IR13515** and **3022053250 / IR13528** are missing
locally and account for the 10-PLT and 22-PLT material residuals respectively.
Reference **3022047670 / IR13524** has no exact local match but all six lines
and destination match **TBA-Milton**, strongly indicating a placeholder reference
that was not aligned with the receipt memo.

The only native quantity mismatch among exact reference matches is PALLET on
**3022182749 / IR14456**: 29 EACH allocated locally versus 28 EACH received in
NetSuite. The two missing references contribute 32 PALLET units, while that
one-unit excess local allocation reduces the displayed residual to 31 EACH.

The complete comparison and evidence are retained in
`/home/ubuntu/operatorapp-investigations/pob03535-20260915/ir-memo-comparison.md`
and its adjacent JSON/CSV files. No production data was changed.

## Retained evidence

`/home/ubuntu/operatorapp-investigations/pob03535-20260915/` contains:

- `inspect.mjs`: read-only parent/split/receipt/reconciliation inspection plus
  NetSuite read-only PO and linked transaction queries.
- `inspection.jsonl`: captured local evidence, the fresh NetSuite snapshot and
  109 linked transaction-line records.
- `surfaces.mjs` and `surfaces.jsonl`: live SCM list, catalog, schedule, Blanket
  pool and exact source-line calculation results.
- `deployed/` and `deployed-manifest.json`: source copies and SHA256 values from
  the deployed application, isolated from concurrent worktree edits.

Both scripts enforce PostgreSQL read-only transactions. No receipt was created,
no NetSuite record was edited, and no service was restarted.
