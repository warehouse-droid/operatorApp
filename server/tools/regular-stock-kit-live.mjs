import assert from 'node:assert/strict';
import {query,closeDb} from '../src/db.js';
import {readRegularStockSalesOrderFromNetSuite,suiteqlAll} from '../src/netsuite.js';
import {previewDeliveryStockRequest} from '../src/regular-stock-delivery.js';
import {withOperatorNetSuitePriority} from '../src/operator-netsuite-request-pool.js';
import {config} from '../src/config.js';

const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname,method=String(options.method||'GET').toUpperCase();
 if(path.includes('/record/v1/'))assert.equal(method,'GET','Preview refuses NetSuite record writes');
 return originalFetch(url,options);
};
config.netsuite.requestTimeoutMs=45000;
try{
 const result=await withOperatorNetSuitePriority(async()=>{
  const actor=(await query(`SELECT actor_id FROM regular_stock_delivery_operations
   WHERE input->>'salesOrderRef'='SOB121863' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert(actor,'No original Sales actor');
  const operator=(await query("SELECT id,active,role,roles,yard_location_ids FROM operators WHERE username='admin' AND active AND role='admin'")).rows[0];
  assert(operator?.active);
  const roles=new Set([operator.role,...(operator.roles||[])]);
  assert(roles.has('admin')||roles.has('sales'));
  const context={operatorId:operator.id,authorizedDestinationLocationIds:roles.has('admin')?[1,28,15,26]:operator.yard_location_ids};
  const order=await readRegularStockSalesOrderFromNetSuite('SOB121863');
  const kit=order.lines.find(line=>line.itemId===10126);
  assert.equal(kit?.itemType,'Kit');assert.equal(kit.kitComponents.length,1);
  const preview=await previewDeliveryStockRequest({salesOrderRef:'SOB121863',sourceLocationId:1},context);
  assert.equal(preview.baseLocationId,28);assert.equal(preview.lines.length,1);assert.equal(preview.lines[0].itemId,1189);
  const rows=await suiteqlAll(`SELECT tl.quantitycommitted AS committed_quantity,tl.quantitybackordered AS backordered_quantity
   FROM transactionline tl WHERE tl.transaction=${order.id} AND tl.uniquekey=${preview.lines[0].remoteLineId}`);
  assert.equal(rows.length,1);
  return {checkedAt:new Date().toISOString(),salesOrderId:order.id,salesOrderRef:order.ref,
   visibleLines:order.lines.length,kitComponents:kit.kitComponents.length,route:'3445 to 2967',
   previewLines:preview.lines.map(line=>({itemId:line.itemId,itemName:line.itemName,quantity:line.salesQty,
    soQuantity:line.soQuantity,backorderedQuantity:line.backorderedQuantity,quantityBasis:line.quantityBasis,salesUom:line.salesUom})),
   palletQuantity:preview.palletQuantity,authoritativeBackorder:rows[0],netSuiteOrderWrites:0};
 });
 console.log(JSON.stringify(result));
}finally{globalThis.fetch=originalFetch;await closeDb();}
