import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { submitRegularStockRequest } from '../../../src/regular-stock-request-service.js';
import { linkRegularStockSalesOrder, previewRegularStockSalesOrder } from '../../../src/regular-stock-handoff.js';
const actor=`regular-so-${Date.now()}`, itemId=9800000000010;
const context={operatorId:actor,authorizedDestinationLocationIds:[28],allowOverAvailability:true};
const deps={ now:()=>new Date('2026-09-29T14:00:00Z'),refreshAvailability:async()=>{},loadPolicies:async()=>[{itemId,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}] };
before(async()=>{
 await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales'],true)`,[actor]);
 await query(`INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,$2,'EA',1,100) ON CONFLICT(item_id) DO NOTHING`,[itemId,actor]);
 await query(`INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT(item_id,location_id) DO NOTHING`,[itemId]);
});
after(closeDb);
async function request(){return submitRegularStockRequest({destinationLocationId:28,deliveryMethod:'delivery',arrivalDate:'2026-09-29',arrivalTime:'15:00',lines:[{itemId,sourceLocationId:1,pieces:200}]},context,deps);}
function boundary(id,extra={}){return {now:deps.now,liveExecutionEnabled:true,readOrder:async()=>({id,ref:`SO-${id}`,locationId:28,lines:[{remoteLineId:id+1,itemId,quantity:200,uom:'EA',locationId:28,open:true}]}),applyLocation:async()=>{},hydrateOrder:async()=>{},refreshAvailability:async()=>{},syncReplenishments:async()=>{},...extra};}
test('single-source handoff executes once, survives refresh failure and does not revoke approval',async()=>{
 const r=await request();let writes=0,refreshes=0;
 const b=boundary(r.id+800000,{applyLocation:async()=>{writes++;},refreshAvailability:async()=>{if(refreshes++===0)throw Error('temporary inventory refresh error');}});
 const input={expectedRevision:r.revision,salesOrderRef:`SO-${r.id+800000}`};
 input.confirmationToken=(await previewRegularStockSalesOrder(r.id,input,context,b)).confirmationToken;
 await assert.rejects(()=>linkRegularStockSalesOrder(r.id,input,context,b),/temporary inventory/);
 const savedPreview=await previewRegularStockSalesOrder(r.id,input,context,{readOrder:async()=>{throw Error('A retry must use the saved action after its locations changed');}});
 assert.equal(savedPreview.resuming,true);assert.equal(savedPreview.confirmationToken,input.confirmationToken);assert.equal(savedPreview.action.sourceName,'3445');
 await assert.rejects(()=>previewRegularStockSalesOrder(r.id,{salesOrderRef:'SO-DIFFERENT'},context,b),/different SO/);
 const completed=await linkRegularStockSalesOrder(r.id,input,context,b);
 assert.equal(completed.regular.handoffStatus,'complete');assert.equal(writes,1);assert.equal(completed.lines[0].decision,'stock');
 await linkRegularStockSalesOrder(r.id,input,context,b);assert.equal(writes,1);
});
test('remote write timeout is retried through verification boundary without inventing a new order',async()=>{
 const r=await request();let calls=0;
 const b=boundary(r.id+810000,{applyLocation:async()=>{if(calls++===0)throw Error('timeout after remote success');}});
 const input={expectedRevision:r.revision,salesOrderRef:`SO-${r.id+810000}`};
 input.confirmationToken=(await previewRegularStockSalesOrder(r.id,input,context,b)).confirmationToken;
 await assert.rejects(()=>linkRegularStockSalesOrder(r.id,input,context,b),/timeout/);
 const completed=await linkRegularStockSalesOrder(r.id,input,context,b);
 assert.equal(completed.regular.handoffStatus,'complete');assert.equal(calls,2);
});
test('live execution guard rejects before reading or writing NetSuite',async()=>{
 const r=await request();let touched=false;
 await assert.rejects(()=>linkRegularStockSalesOrder(r.id,{expectedRevision:r.revision,salesOrderRef:'SO-1'},context,boundary(1,{liveExecutionEnabled:false,readOrder:async()=>{touched=true;}})),e=>e.status===409);
 assert.equal(touched,false);
});
test('an expired lease cannot allow simultaneous external writes while the worker is still running',async()=>{
 const r=await request();let unblock,entered;
 const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{unblock=resolve;});
 let writes=0;
 const b=boundary(r.id+820000,{applyLocation:async()=>{writes++;entered();await gate;}});
 const input={expectedRevision:r.revision,salesOrderRef:`SO-${r.id+820000}`};
 input.confirmationToken=(await previewRegularStockSalesOrder(r.id,input,context,b)).confirmationToken;
 const first=linkRegularStockSalesOrder(r.id,input,context,b);await started;
 await query("UPDATE regular_stock_handoffs SET lease_until=now()-interval '1 second' WHERE request_id=$1",[r.id]);
 try{await assert.rejects(()=>linkRegularStockSalesOrder(r.id,input,context,{...b,applyLocation:async()=>{writes++;}}),e=>e.status===409);}
 finally{unblock();await first.catch(()=>{});}
 assert.equal(writes,1);
});
test('mixed SO creates one TO and retry does not add local reservations or duplicate transfers',async()=>{
 const r=await request();let confirmations=0,refreshes=0;
 const b=boundary(r.id+830000,{readOrder:async()=>({id:r.id+830000,ref:`SO-${r.id+830000}`,locationId:28,lines:[{remoteLineId:r.id+1,itemId,quantity:200,uom:'EA',locationId:28,open:true},{remoteLineId:r.id+2,itemId:42,quantity:5,uom:'EA',locationId:28,open:true}]}),
 confirmTransfer:async transfer=>{confirmations++;await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete' WHERE id=$1",[transfer.id,transfer.id+900000,`TO-${transfer.id}`]);},linkTransferDependency:async()=>{},
 refreshAvailability:async()=>{if(refreshes++===0)throw Error('refresh failed');}});
 const input={expectedRevision:r.revision,salesOrderRef:`SO-${r.id+830000}`};
 input.confirmationToken=(await previewRegularStockSalesOrder(r.id,input,context,b)).confirmationToken;
 await assert.rejects(()=>linkRegularStockSalesOrder(r.id,input,context,b),/refresh failed/);
 const done=await linkRegularStockSalesOrder(r.id,input,context,b);
 assert.equal(done.transfers.length,1);assert.equal(confirmations,1);
 assert.equal((await query('SELECT count(*)::int AS n FROM sales_stock_transfer_reservations reservation JOIN sales_stock_transfer_lines line ON line.id=reservation.transfer_line_id WHERE line.transfer_id=$1',[done.transfers[0].id])).rows[0].n,0);
});
test('PO approval uses fresh post-commitment inventory and enqueues its priority load through the real handoff',async()=>{
 const {decideRegularStockRequest}=await import('../../../src/regular-stock-request-service.js');
 const {listRegularReplenishments,releaseRegularReplenishment}=await import('../../../src/regular-stock-replenishment.js');
 await query('UPDATE regular_stock_replenishments SET released_at=now() WHERE item_id=$1 AND released_at IS NULL',[itemId]);
 await query("INSERT INTO scm_smart_item_policies(item_id,item_name,to_plt,planning_enabled,pallet_weight_lbs) VALUES($1,'Handoff PO fixture',100,true,2000) ON CONFLICT DO NOTHING",[itemId]);
 await query("INSERT INTO scm_smart_item_yard_policies(item_id,location_id,yard_code,eligible,capacity_pallets,minimum_safety_pallets) VALUES($1,1,'3445',true,30,12) ON CONFLICT DO NOTHING",[itemId]);
 let r=await submitRegularStockRequest({destinationLocationId:28,deliveryMethod:'delivery',arrivalDate:'2026-09-29',arrivalTime:'14:59',lines:[{itemId,sourceLocationId:1,pieces:200}]},context,deps);
 r=await decideRegularStockRequest(r.id,{expectedRevision:r.revision,lineIds:[r.lines[0].id],decision:'po'},context,deps);
 const b=boundary(r.id+840000,{refreshAvailability:async()=>query('UPDATE inventory_balances SET quantity_available=799,quantity_on_order=100,synced_at=now() WHERE item_id=$1 AND location_id=1',[itemId])});
 delete b.syncReplenishments;
 const input={expectedRevision:r.revision,salesOrderRef:`SO-${r.id+840000}`};
 input.confirmationToken=(await previewRegularStockSalesOrder(r.id,input,context,b)).confirmationToken;
 const done=await linkRegularStockSalesOrder(r.id,input,context,b);
 assert.equal(done.regular.handoffStatus,'complete');
 const group=(await listRegularReplenishments()).find(group=>group.requests.some(request=>request.requestId===r.id));assert.equal(group.quantity,301);
 await releaseRegularReplenishment(group.id,{expectedRevision:group.revision},context);
});
test('SO preview disambiguates matching material identities and enforces the Sales yard',async()=>{
 const {previewRegularStockSalesOrder}=await import('../../../src/regular-stock-handoff.js');const r=await request();
 const readOrder=async()=>({id:r.id+850000,locationId:28,ref:'SO-preview',lines:[1,2].map(id=>({remoteLineId:id,itemId,itemName:'Material',quantity:200,uom:'EA',locationId:28,open:true}))});
 const preview=await previewRegularStockSalesOrder(r.id,{salesOrderRef:'SO-preview'},context,{now:deps.now,readOrder});
 assert.equal(preview.choices.length,1);assert.deepEqual(preview.choices[0].lines.map(line=>line.id),[1,2]);
 assert.equal(preview.action,undefined);assert.equal(preview.confirmationToken,undefined);
 const selected=await previewRegularStockSalesOrder(r.id,{salesOrderRef:'SO-preview',selectedLineIds:{[itemId]:2}},context,{now:deps.now,readOrder});
 assert.deepEqual(selected.choices,[]);assert.equal(selected.action.mode,'transfer');assert.equal(selected.confirmationToken.length,64);
 await assert.rejects(()=>previewRegularStockSalesOrder(r.id,{salesOrderRef:'SO-preview',selectedLineIds:{[itemId]:999}},context,{now:deps.now,readOrder}),/Select the exact open SO line/);
 await assert.rejects(()=>previewRegularStockSalesOrder(r.id,{},context,{now:deps.now,readOrder:async()=>({...await readOrder(),locationId:1})}),e=>e.status===409);
});
