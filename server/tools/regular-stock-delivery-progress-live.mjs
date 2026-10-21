// Read-only release checks. No NetSuite order or printer operation is invoked.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {deliveryRoute,deliveryBaseYard,deliveryMaterials,deliveryQuantities} from '../src/regular-stock-delivery-domain.js';
import {evaluateRegularStockApproval} from '../src/regular-stock-domain.js';
import {config} from '../src/config.js';
import {listYardPrinters} from '../src/smart-scm-print-repository.js';
try{
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const routes=[];
  for(const from of [1,28,15,26])for(const to of [1,28,15,26]){
   if(from===to){assert.throws(()=>deliveryRoute(from,to));continue;}
   const route=deliveryRoute(from,to);assert.equal(route.automatic,[1,28].includes(from)&&[1,28].includes(to));routes.push(route);
  }
  const input={deliveryMethod:'pickup',now:0,lines:[{id:1,itemId:1,sourceLocationId:1,salesQty:200}],policies:[{itemId:1,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}]};
  assert.equal(evaluateRegularStockApproval(input).automatic,true);
  assert.equal(evaluateRegularStockApproval({...input,autoApprovalEnabled:false}).automatic,false);
  assert.equal(evaluateRegularStockApproval({...input,deliveryMethod:'stocking'}).automatic,false);
  const material={remoteLineId:1,itemId:1,quantity:200,backorderedQuantity:20,uom:'EA',locationId:28,open:true};
  const order={id:1,locationId:15,lines:[material]};
  assert.equal(deliveryBaseYard(order).locationId,28);
  const selected=deliveryMaterials(order,28);
  const quantities=[200,199].map(available=>deliveryQuantities(selected,[{itemId:1,requestableAvailable:available}])[0].quantity);
  assert.deepEqual(quantities,[200,20]);
  assert.throws(()=>deliveryQuantities(selected,[{itemId:1,requestableAvailable:19}]),{code:'REGULAR_DELIVERY_STOCK_SHORTAGE'});
  assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='241_regular_stock_delivery_operations.sql'")).rows[0].n,1);
  assert.ok((await query("SELECT to_regclass('regular_stock_delivery_operations') AS table_name")).rows[0].table_name);
  const printers=(await listYardPrinters()).filter(row=>[1,28].includes(Number(row.locationId)))
    .map(row=>({locationId:row.locationId,yardCode:row.yardCode,transferOrderReady:row.transferOrderReady}));
  return {readOnly:true,autoRoutes:routes.filter(row=>row.automatic).map(row=>`${row.sourceName} → ${row.destinationName}`),manualRoutes:routes.filter(row=>!row.automatic).length,
    pickupAndStockingPoliciesPreserved:true,baseFollowsLineLocations:true,fullLineThenBackorderFallback:quantities,insufficientBackorderStockBlocked:true,liveExecutionEnabled:config.smartScm.liveExecutionEnabled,printers,netSuiteCalls:0,orderWrites:0,printJobsCreated:0};
 });
 console.log(JSON.stringify(result));
}finally{await closeDb();}
