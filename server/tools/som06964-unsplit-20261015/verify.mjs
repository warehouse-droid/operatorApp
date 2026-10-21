import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {config} from './src/config.js';
import {getDispatchPlan} from './src/dispatch-plan-repository.js';
import {listDispatchOrders} from './src/dispatch-repository.js';
import {overlayFulfilledSalesDeliveryPlanning} from './src/dispatch-fulfilled-so-repository.js';
import {listDeliveryOrders} from './src/delivery-repository.js';
config.netsuite.directAccessEnabled=false;
try{
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const plan=await getDispatchPlan('359');
  const visiblePlanRefs=plan.orders.filter(o=>o.id.startsWith('SOM06964')).map(o=>o.id);
  assert.ok(visiblePlanRefs.every(ref=>ref==='SOM06964'));
  const orders=await overlayFulfilledSalesDeliveryPlanning(await listDispatchOrders({type:'SO',search:'SOM06964'}));
  const order=orders.find(o=>o.id==='SOM06964');
  assert.equal(order.localOrderReopened,true);assert.equal(order.dispatchPlanningRestricted,false);
  assert.equal(order.dispatchFulfilledSalesPlanningEligible,true);
  const active=await listDeliveryOrders({locationId:26,status:'active',orderType:'sales_order',allowedOperatorYards:[26]});
  const operatorRefs=active.filter(o=>o.tranid.startsWith('SOM06964')).map(o=>o.tranid);
  assert.deepEqual(operatorRefs,['SOM06964']);
  assert.equal((await query("SELECT 1 FROM dispatch_so_po_allocations WHERE status='active' AND sales_order_ref ~ '^SOM06964(-S[0-9]+)*$'")).rowCount,0);
  return{at:new Date().toISOString(),readOnly:true,restored:'SOM06964',visiblePlanRefs,operatorRefs,
   locallyOpen:true,planningEligible:true,activePoAllocations:0,retiredChildrenHidden:true};
 });
 console.log(JSON.stringify(result,null,2));
}finally{await closeDb();}
