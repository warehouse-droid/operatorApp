import assert from "node:assert/strict";
import {assertSalesDeliveryPlanningAllowed} from "./src/dispatch-fulfilled-so-repository.js";
import { beginRollbackContext, closeDb, query } from "./src/db.js";
import { listScmSchedule, listDispatchOrders, enrichDispatchOrdersWithPoTargetAllocations } from "./src/dispatch-repository.js";
import { getDispatchOrderCatalogOrder } from "./src/dispatch-order-catalog-repository.js";
import { assertNoDriverPwaCompletedDispatchRefs } from "./src/dispatch-history-mode.js";
import {listFulfilledTransferStates} from "./src/dispatch-fulfilled-to-repository.js";

const context = await beginRollbackContext();
try {
  await context.run(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='20s'");
    const poRef = "LOINC-035925";
    const [schedule] = (await listScmSchedule({ exactRef: poRef, audience: "scm", status: ["Completed"] }))
      .filter((row) => row.orderRef === poRef);
    assert.equal(schedule?.calculatedStatus, "Completed");
    const card = await getDispatchOrderCatalogOrder(poRef);
    assert.equal(card?.dispatchCompletionStatus, "completed");
    assert.equal(card?.dispatchPlanningRestricted, true);
    for (const ref of [poRef, "POB03921"]) {
      await assert.rejects(assertNoDriverPwaCompletedDispatchRefs([ref]), { code: "DISPATCH_ORDER_DRIVER_COMPLETED" });
    }
    const source = (await listDispatchOrders({ type: "PO", search: poRef, includeHiddenScm: true }))
      .find((order) => order.id === poRef);
    assert.ok(source, "PO source remains available for history");
    const [projected] = await enrichDispatchOrdersWithPoTargetAllocations([source]);
    assert.equal(projected.poRouteProjection?.hasResidual, false);
    const [completion] = (await query(`SELECT dispatch_completed_at, completion_evidence_id
      FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=$1`, [poRef])).rows;
    const [driver] = (await query("SELECT completed_at, status, stop_type FROM driver_job_records WHERE job_id=$1",
      [completion.completion_evidence_id])).rows;
    assert.equal(driver.status, "complete");
    assert.equal(driver.stop_type, "dropoff");
    assert.equal(new Date(completion.dispatch_completed_at).toISOString(), new Date(driver.completed_at).toISOString());
    const corrections=(await query(`SELECT correction.order_ref, event.id,
      EXISTS(SELECT 1 FROM dispatch_effective_order_completion_events effective WHERE effective.id=event.id) AS effective
      FROM dispatch_direct_ship_completion_corrections correction
      JOIN dispatch_order_completion_events event ON event.id=correction.completion_event_id ORDER BY correction.order_ref`)).rows;
    const expectedCorrections=EXPECTED_CORRECTIONS;
    assert.ok(expectedCorrections.every(id=>corrections.some(row=>String(row.id)===String(id))));
    assert.ok(corrections.every(row=>!row.effective));
    const correctedCards=[];
    const transferStates=await listFulfilledTransferStates(corrections.map(row=>row.order_ref));
    for (const ref of new Set(corrections.map(row=>row.order_ref))) {
      const canonical=await query("SELECT 1 FROM dispatch_order_completion_status WHERE order_kind='TO' AND order_ref=$1",[ref]);
      if (canonical.rowCount) {continue;}
      const correctedCard=await getDispatchOrderCatalogOrder(ref);
      const state=transferStates.get(ref.toLowerCase());
      assert.notEqual(state?.locallyCompleted,true);
      if(state?.fulfilled && !state.blocked) {
        assert.equal(correctedCard?.dispatchFulfilledTransferPlanningEligible,true);
        assert.equal(correctedCard?.dispatchPlanningRestricted,false);
        await assertSalesDeliveryPlanningAllowed([ref]);
      } else {
        assert.notEqual(correctedCard?.dispatchCompletionStatus,"completed");
      }
      const correctedSchedule=(await listScmSchedule({exactRef:ref,audience:"scm"})).find(row=>row.orderRef===ref);
      assert.notEqual(correctedSchedule?.calculatedStatus,"Completed");
      correctedCards.push({ref,present:Boolean(correctedCard),scheduleStatus:correctedSchedule?.calculatedStatus||null,
        remainingQuantity:correctedCard?.toRouteProjection?.salesQty??null,
        netSuiteFulfilled:state?.fulfilled===true,locallyCompleted:state?.locallyCompleted===true,
        planningRestricted:correctedCard?.dispatchPlanningRestricted===true});
    }
    const linked=(await query(`SELECT po.tranid,po.dispatch_ref FROM purchase_orders po
      WHERE EXISTS(SELECT 1 FROM dispatch_so_po_allocations a WHERE a.po_order_id=po.netsuite_id AND a.status='active')
        AND dispatch_po_link_fully_covers(po.netsuite_id)`)).rows;
    for(const po of linked) for(const ref of new Set([po.tranid,po.dispatch_ref].filter(Boolean))) {
      await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]),error=>
        ['DISPATCH_LINKED_CARGO_ONLY','DISPATCH_ORDER_DRIVER_COMPLETED'].includes(error.code));
    }
    console.log(JSON.stringify({ poRef, scheduleStatus: schedule.calculatedStatus,
      planningRestricted: card.dispatchPlanningRestricted, bothPoAliasesBlocked: true,
      hasResidual: projected.poRouteProjection.hasResidual,
      completedAt: new Date(completion.dispatch_completed_at).toISOString(),
      driverEvidenceVerified: true, readOnly: true,
      correctedPartialTransfers:corrections.map(row=>row.order_ref), correctedCards, fullyLinkedPoGuardsChecked:linked.length }));
  });
} finally { await context.rollback(); await closeDb(); }
