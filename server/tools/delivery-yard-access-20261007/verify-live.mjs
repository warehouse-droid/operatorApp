import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,closeDb} from '../../src/db.js';
import {assertDeliveryStockRequestDestinationAccess} from '../../src/regular-stock-delivery-access.js';
import {deliveryMaterials} from '../../src/regular-stock-delivery-domain.js';
try{
  const health=await fetch('http://127.0.0.1:3000/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  const actor=(await query("SELECT id,yard_location_ids FROM operators WHERE username='2967sales' AND active")).rows[0];assert.ok(actor);
  const sales=(await query("SELECT yard_location_ids FROM operators WHERE active AND (role='sales' OR 'sales'=ANY(roles))")).rows;
  for(const record of [...sales,{yard_location_ids:[]}]) for(const [source,destination] of [[1,28],[28,1]]) assert.equal(assertDeliveryStockRequestDestinationAccess(source,destination,record.yard_location_ids),destination);
  const rows=(await query("SELECT so.tranid,line.line_id,line.item_id,line.location_id,line.quantity,line.netsuite_backordered_qty FROM sales_order_lines line JOIN sales_orders so ON so.netsuite_id=line.sales_order_id WHERE so.tranid IN ('SOA09895','SOA09883') ORDER BY so.tranid,line.line_id")).rows;
  const orders=[];
  for(const ref of ['SOA09895','SOA09883']){
    const lines=rows.filter(row=>row.tranid===ref);assert.ok(lines.length>0);assert.ok(lines.every(row=>Number(row.location_id)===1));
    assert.equal(assertDeliveryStockRequestDestinationAccess(28,1,actor.yard_location_ids),1);
    orders.push({ref,baseYard:'3445',targetYard:'2967',salesYardAccess:'allowed',backorderedLines:lines.filter(row=>Number(row.netsuite_backordered_qty)>0).length});
  }
  const source={id:1,ref:'synthetic-live-readonly',lines:[1,2].map(remoteLineId=>({remoteLineId,itemId:100,locationId:1,quantity:100,backorderedQuantity:10,uom:'EA',open:true}))};
  assert.deepEqual(deliveryMaterials(source,1,[2]).map(line=>line.remoteLineId),[2]);
  for(const file of ['regular-stock-delivery.js','sales-stock-requests.js','stock-requests.css']){
    const response=await fetch('http://127.0.0.1:3000/'+file+'?delivery=20261007-line-selection');assert.equal(response.status,200);assert.equal(await response.text(),readFileSync('public/'+file,'utf8'));
  }
  const page=await fetch('http://127.0.0.1:3000/sales/stock-requests?tab=regular');assert.equal(page.status,200);assert.ok((await page.text()).includes('20261007-line-selection'));
  console.log(JSON.stringify({health:'healthy',allActiveSalesPairedRoutes:'allowed',salesAccountsVerified:sales.length,unassignedSalesPairedRoutes:'allowed',orders,checkedLinesOnly:true,servedAssetsVerified:true,productionOrdersModifiedDuringVerification:0}));
}finally{await closeDb();}
