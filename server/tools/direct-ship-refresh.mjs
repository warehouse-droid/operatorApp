import assert from "node:assert/strict";
import {query,closeDb} from "../src/db.js";
import {loadDispatchOrdersForResponse} from "../src/server.js";
import {getDispatchOrderCatalogOrder,upsertDispatchOrderCatalog,removeDispatchOrderCatalogOrder} from "../src/dispatch-order-catalog-repository.js";
import {listFulfilledTransferStates} from "../src/dispatch-fulfilled-to-repository.js";
import {assertSalesDeliveryPlanningAllowed} from "../src/dispatch-fulfilled-so-repository.js";

/** Rebuild derived planner cards from the authoritative sources after migration. */
export async function refreshDirectShipCatalog() {
  const {rows:refs}=await query(`SELECT DISTINCT transfer_order_ref AS ref FROM order_dependencies WHERE dependency_mode='direct_to_customer'
    UNION SELECT DISTINCT COALESCE(NULLIF(po.dispatch_ref,''),po.tranid) AS ref
      FROM purchase_orders po JOIN dispatch_so_po_allocations allocation ON allocation.po_order_id=po.netsuite_id`);
  const result={requested:refs.length,upserted:0,removed:0,correctedCards:[]};
  for (const {ref} of refs) {
    const orders=await loadDispatchOrdersForResponse({search:ref,exactOrderRefs:[ref],includeCompletedScmSearch:true});
    if (orders.length) {
      const saved=await upsertDispatchOrderCatalog({orders,source:"direct-ship-lifecycle-release"});
      result.upserted+=saved.upserted;
    } else {
      const removed=await removeDispatchOrderCatalogOrder(ref);
      result.removed+=Number(removed.deleted);
    }
  }
  const {rows:corrected}=await query(`SELECT DISTINCT correction.order_ref AS ref FROM dispatch_direct_ship_completion_corrections correction
    WHERE NOT EXISTS(SELECT 1 FROM dispatch_order_completion_status status WHERE status.order_kind='TO' AND status.order_ref=correction.order_ref)`);
  const states=await listFulfilledTransferStates(corrected.map(row=>row.ref));
  for (const {ref} of corrected) {
    const card=await getDispatchOrderCatalogOrder(ref);
    const state=states.get(ref.toLowerCase());
    assert.notEqual(state?.locallyCompleted,true,ref+" retained an obsolete local completion");
    if (state?.fulfilled && !state.blocked) {
      assert.equal(card?.dispatchFulfilledTransferPlanningEligible,true);
      assert.equal(card?.dispatchPlanningRestricted,false);
      await assertSalesDeliveryPlanningAllowed([ref]);
    } else {
      assert.notEqual(card?.dispatchCompletionStatus,"completed",ref+" retained an obsolete completion label");
    }
    result.correctedCards.push({ref,present:Boolean(card),completion:card?.dispatchCompletionStatus||null,
      netSuiteFulfilled:state?.fulfilled===true,locallyCompleted:state?.locallyCompleted===true,
      planningRestricted:card?.dispatchPlanningRestricted===true});
  }
  return result;
}

if (process.argv[1]?.endsWith("/direct-ship-refresh.mjs")) {
  try {process.stdout.write(JSON.stringify(await refreshDirectShipCatalog())+"\n");} finally {await closeDb();}
}
