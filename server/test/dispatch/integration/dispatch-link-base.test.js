import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import { createSalesOrderPoAllocation, enrichDispatchOrdersWithPoTargetAllocations, getSalesOrderPoAllocationOptions } from '../../../src/dispatch-repository.js';
import { createOrderDependency, getOrderDependencyOptions } from '../../../src/order-dependency-repository.js';
import { resolveDispatchSalesTarget } from '../../../src/dispatch-order-target-repository.js';
import { dispatchRequiredPickupVisitLocations } from '../../../src/dispatch-pickup-visits.js';

after(closeDb);
const SO='SO-BASE-QUANTITY', PO='PO-BASE-QUANTITY', TO='TO-BASE-QUANTITY';
async function rollback(run) { const tx=await beginRollbackContext();try{await tx.run(run);}finally{await tx.rollback();} }
async function seed({quantity=1673.6,sourceQuantity=2301.2,unit='SQFT',pallets=16,pieces=0,sourcePallets=22,toPlt=104.6,toLyr=0}={}) {
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,sales_order_type,
    outbound_location_id,outbound_location,dispatch_address,fulfillment_status,netsuite_active)
    VALUES (9422301590,$1,'Base Customer','B','Pending Fulfillment','Delivery',28,'2967','30 Isolated Customer Road','not_fulfilled',true)`,[SO]);
  const line=(await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,pallet_qty,piece_qty,to_plt,to_lyr,netsuite_backordered_qty,netsuite_committed_qty,netsuite_active)
    VALUES (9422301590,1,10374,'BASE-ITEM','BASE-ITEM','InvtPart',$1,$2,$3,$4,$5,$6,$1,0,true) RETURNING *`,[quantity,unit,pallets,pieces,toPlt,toLyr])).rows[0];
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,vendor,status,status_text,
    destination_location_id,destination_location,dispatch_vendor_yard,dispatch_address,receipt_status,netsuite_active)
    VALUES (9422301585,$1,'Base Vendor','B','Pending Receipt',28,'2967','Base Vendor','20 Isolated Vendor Road','not_received',true)`,[PO]);
  const poLine=(await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,pallet_qty,to_plt,location_id,location,netsuite_active)
    VALUES (9422301585,1,10374,'BASE-ITEM','BASE-ITEM','InvtPart',$1,$2,$3,$4,28,'2967',true) RETURNING *`,[sourceQuantity,unit,sourcePallets,toPlt])).rows[0];
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,netsuite_active)
    VALUES (9422301595,$1,'B','Pending Fulfillment',1,'3445',28,'2967',true)`,[TO]);
  for(const stage of ['outbound','receiving']) await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,line_stage,netsuite_active) VALUES (9422301595,1,10374,'BASE-ITEM','BASE-ITEM','InvtPart',$1,$2,$3,true)`,[sourceQuantity,unit,stage]);
  const item={lineRowId:String(line.id),lineId:1,itemId:10374,itemName:'BASE-ITEM',sku:'BASE-ITEM',itemType:'InvtPart',unit,quantity,pallets,pieces,toPlt,toLyr};
  const so={id:SO,type:'SO',netsuiteId:9422301590,sourceYard:'2967',pickupLocations:['2967'],items:[item]};
  const po={id:PO,type:'PO',netsuiteId:9422301585,sourceYard:'Base Vendor',pickupLocations:['Base Vendor'],destinationYard:'2967',destinationLocationId:28,
    items:[{...item,lineRowId:String(poLine.id),quantity:sourceQuantity,pallets:sourcePallets,pieces:0,destinationYard:'2967',destinationLocationId:28}]};
  return {line,poLine,so,po};
}
async function poLink(fixture,qty) {
  const target=await resolveDispatchSalesTarget({dispatchTargetRef:SO});
  return createSalesOrderPoAllocation({dispatchTargetRef:SO,targetLineKey:target.lines[0].targetLineKey,
    poLineId:fixture.poLine.id,poRef:PO,targetSignature:target.signature,quantities:{salesQty:qty}});
}
async function toLink(qty) {
  const target=await resolveDispatchSalesTarget({dispatchTargetRef:SO});
  return createOrderDependency({dispatchTargetRef:SO,transferOrderRef:TO,targetSignature:target.signature,
    allocations:[{targetLineKey:target.lines[0].targetLineKey,quantities:{salesQty:qty}}]});
}

test('PO base SQFT quantity derives 16 linked pallets and leaves 6 source pallets',()=>rollback(async()=>{
  const f=await seed();const link=await poLink(f,1673.6);
  assert.equal(link.salesQty,1673.6);assert.equal(link.pallets,16);
  const [so,po]=await enrichDispatchOrdersWithPoTargetAllocations([f.so,f.po]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(so),['Base Vendor']);
  assert.equal(po.poRouteProjection.items[0].pallets,6);assert.equal(po.poRouteProjection.items[0].quantity,627.6);
  const options=await getSalesOrderPoAllocationOptions(SO);assert.equal(options.salesLines[0].available.salesQty,0);
}));

test('PO base count consumes target pieces and source balances without packaging input',()=>rollback(async()=>{
  const f=await seed({quantity:16,sourceQuantity:22,unit:'EACH',pallets:0,pieces:16,sourcePallets:0,toPlt:0});
  const link=await poLink(f,16);assert.equal(link.pieces,16);
  const [so,po]=await enrichDispatchOrdersWithPoTargetAllocations([f.so,f.po]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(so),['Base Vendor']);
  assert.equal(po.poRouteProjection.items[0].quantity,6);
}));

test('PO partial base coverage uses each line packing and conserves differing source pallets',()=>rollback(async()=>{
  const f=await seed({quantity:100,sourceQuantity:120,unit:'EACH',pallets:10,sourcePallets:6,toPlt:0});
  await poLink(f,40);
  let [so,po]=await enrichDispatchOrdersWithPoTargetAllocations([f.so,f.po]);
  assert.equal(so.items[0].poAllocatedPallets,4);assert.equal(po.poRouteProjection.items[0].pallets,4);
  await poLink(f,60);
  [so,po]=await enrichDispatchOrdersWithPoTargetAllocations([f.so,f.po]);
  assert.equal(so.items[0].poAllocatedPallets,10);assert.equal(po.poRouteProjection.items[0].pallets,1);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(so),['Base Vendor']);
  await assert.rejects(poLink(f,1),/open sales quantity/u);
  assert.equal(Number((await query('SELECT SUM(allocated_sales_qty) AS qty FROM dispatch_so_po_allocations')).rows[0].qty),100);
}));

test('TO suggestions and persisted fractional quantity remain in base UOM with derived packing',()=>rollback(async()=>{
  await seed({quantity:10.46,sourceQuantity:5.23,pallets:0.1,sourcePallets:0.05,toLyr:10.46});
  const options=await getOrderDependencyOptions({dispatchTargetRef:SO,transferOrderRef:TO});
  assert.equal(options.matchingLines[0].unit,'SQFT');
  assert.equal(options.matchingLines[0].available.salesQty,5.23);
  assert.equal(options.matchingLines[0].suggestedQuantities.salesQty,5.23);
  await toLink(5.23);
  const line=(await query("SELECT * FROM order_dependency_lines WHERE line_role='sales_allocation'")).rows[0];
  assert.equal(Number(line.allocated_quantity),5.23);assert.equal(Number(line.pallet_qty),0.05);
  assert.equal((await getOrderDependencyOptions({dispatchTargetRef:SO,transferOrderRef:TO})).matchingLines.length,0);
}));

test('TO matching and writes reject a different base UOM and do not mix source capacity',()=>rollback(async()=>{
  await seed({quantity:20,sourceQuantity:10,unit:'EACH',pallets:0,sourcePallets:0,toPlt:0});
  await query("UPDATE transfer_order_lines SET unit='SQFT'");
  const options=await getOrderDependencyOptions({dispatchTargetRef:SO,transferOrderRef:TO});
  assert.equal(options.matchingLines.length,0);
  await assert.rejects(toLink(5),/UOM/u);
  assert.equal(Number((await query('SELECT count(*) FROM order_dependencies')).rows[0].count),0);
  await query("INSERT INTO transfer_order_lines(transfer_order_id,line_id,item_id,item_name,quantity,unit,line_stage,netsuite_active) VALUES (9422301595,2,10374,'BASE-ITEM',3,'EACH','outbound',true)");
  const mixed=await getOrderDependencyOptions({dispatchTargetRef:SO,transferOrderRef:TO});
  assert.equal(mixed.matchingLines[0].suggestedQuantity,3);
  await assert.rejects(toLink(4),/quantity 3/u);
  await toLink(3);
  assert.equal((await getOrderDependencyOptions({dispatchTargetRef:SO,transferOrderRef:TO})).matchingLines.length,0);
}));

test('invalid base quantities are rejected without turning negatives positive',()=>rollback(async()=>{
  const f=await seed();
  for(const qty of [-1,Infinity,'not-a-number']) {
    await assert.rejects(poLink(f,qty),/quantity/u);
    await assert.rejects(toLink(qty),/quantity/u);
  }
  assert.equal(Number((await query('SELECT count(*) FROM dispatch_so_po_allocations')).rows[0].count),0);
  assert.equal(Number((await query('SELECT count(*) FROM order_dependencies')).rows[0].count),0);
}));

test('TO partial base links extend exactly and cannot exceed the remaining source quantity',()=>rollback(async()=>{
  await seed({quantity:10.46,sourceQuantity:5.23,pallets:0.1,sourcePallets:0.05,toLyr:10.46});
  await toLink(2.615);
  const options=await getOrderDependencyOptions({dispatchTargetRef:SO,transferOrderRef:TO});
  assert.equal(options.matchingLines[0].available.salesQty,2.615);
  await assert.rejects(toLink(3),/quantity 2.615/u);
  assert.equal(Number((await query("SELECT allocated_quantity FROM order_dependency_lines WHERE line_role='sales_allocation'")).rows[0].allocated_quantity),2.615);
  await toLink(2.615);
  const lines=(await query("SELECT * FROM order_dependency_lines WHERE line_role='sales_allocation'")).rows;
  assert.equal(lines.length,1);assert.equal(Number(lines[0].allocated_quantity),5.23);assert.equal(Number(lines[0].pallet_qty),0.05);
}));
