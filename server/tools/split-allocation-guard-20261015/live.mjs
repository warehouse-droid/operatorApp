import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {config} from './src/config.js';
import {assertSalesOrderSplitUnallocated} from './src/dispatch-sales-split-allocation.js';
import {getDispatchSplitPreview} from './src/dispatch-split-preview-repository.js';
import {getDispatchPlan} from './src/dispatch-plan-repository.js';
import {listDispatchOrders} from './src/dispatch-repository.js';
import {overlayFulfilledSalesDeliveryPlanning} from './src/dispatch-fulfilled-so-repository.js';
import {listDeliveryOrders} from './src/delivery-repository.js';
config.netsuite.directAccessEnabled=false;
try{
 const health=await fetch('http://127.0.0.1:3000/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const linked=(await query(`SELECT 'PO' kind,COALESCE(NULLIF(dispatch_target_ref,''),sales_order_ref) ref
    FROM dispatch_so_po_allocations WHERE status='active' LIMIT 1`)).rows;
  linked.push(...(await query(`SELECT 'TO' kind,COALESCE(NULLIF(dispatch_target_ref,''),sales_order_ref) ref
    FROM order_dependencies WHERE status<>'cancelled' LIMIT 1`)).rows);
  for(const row of linked)await assert.rejects(assertSalesOrderSplitUnallocated([row.ref]),{code:'DISPATCH_SPLIT_ALLOCATED',status:409});
  const preview=await getDispatchSplitPreview({orderRef:'SOM06964',type:'SO'});
  assert.equal(preview.id,'SOM06964');
  const plan=await getDispatchPlan('359');
  assert.ok(plan.orders.filter(row=>row.id.startsWith('SOM06964')).every(row=>row.id==='SOM06964'));
  assert.equal((await query("SELECT 1 FROM dispatch_global_order_splits WHERE parent_order_ref='SOM06964' AND active")).rowCount,0);
  assert.equal((await query("SELECT 1 FROM dispatch_so_po_allocations WHERE status='active' AND sales_order_ref ~ '^SOM06964(-S[0-9]+)*$'")).rowCount,0);
  const root=(await overlayFulfilledSalesDeliveryPlanning(await listDispatchOrders({type:'SO',search:'SOM06964'}))).find(row=>row.id==='SOM06964');
  assert.equal(root.localOrderReopened,true);assert.equal(root.dispatchPlanningRestricted,false);assert.equal(root.dispatchFulfilledSalesPlanningEligible,true);
  const operator=await listDeliveryOrders({locationId:26,status:'active',orderType:'sales_order',allowedOperatorYards:[26]});
  assert.deepEqual(operator.filter(row=>row.tranid.startsWith('SOM06964')).map(row=>row.tranid),['SOM06964']);
  const status=(await query('SELECT status,status_text FROM sales_orders WHERE netsuite_id=1049213')).rows[0];
  assert.equal(status.status,'G');
  return{health:true,inspectionReadOnly:true,existingLinkedOrderKindsBlocked:linked.map(row=>row.kind),
   repairedOrder:'SOM06964',activePoAllocations:0,activeSplits:0,retiredChildrenHidden:true,operatorVisible:true,
   locallyOpen:true,dispatchPlanningEligible:true,netsuiteStatus:status.status_text};
 });
 console.log(JSON.stringify(result));
}finally{await closeDb();}
