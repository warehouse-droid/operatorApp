import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFileSync} from 'node:fs';
import {beginRollbackContext,query,closeDb} from '../../../src/db.js';
import {getDispatchOrderCatalogOrder,upsertDispatchOrderCatalog} from '../../../src/dispatch-order-catalog-repository.js';
import {dispatchRequiredPickupVisitLocations} from '../../../src/dispatch-pickup-visits.js';
import {planner} from '../frontend/dispatch-required-pickups.test.js';
import {repairLinkedPoFeedDefinitions} from '../../../tools/linked-po-pickup-repair.mjs';

after(closeDb);
const cases=JSON.parse(readFileSync(new URL('../fixtures/linked-po-pickup-history-20261028.json',import.meta.url),'utf8'));
let identity=8800000000;
async function seed(example) {
  const order=structuredClone(example.catalog),po=++identity,poRef=order.poPickupManifest[0].poOrderRef;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor,dispatch_vendor_yard,netsuite_active) VALUES($1,$2,'Test vendor','TECHO BLOC Vaughan',true)",[po,poRef]);
  const sources=[];
  for(const [position,child] of order.childOrderDetails.entries()) {
    const so=++identity;
    await query("INSERT INTO sales_orders(netsuite_id,tranid,customer,status,netsuite_active,sales_order_type) VALUES($1,$2,'Test customer','B',true,'Delivery')",[so,child.id]);
    for(const [index,item] of child.items.entries()) {
      if(![1784,2055].includes(Number(item.itemId))) continue;
      const line=(await query('INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING id',[so,index+1,item.itemId,item.sku,item.quantity,item.unit])).rows[0];
      const pl=(await query('INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING id',[po,++identity,item.itemId,item.sku,item.quantity,item.unit])).rows[0];
      await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_sales_qty,allocated_piece_qty,status,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,'active',$11,'group',$12)`,[so,child.id,line.id,po,poRef,pl.id,item.itemId,item.sku,item.quantity,Number(item.itemId)===1784?item.quantity:0,order.id,`${order.id}::${child.id}::${item.lineRowId}`]);
    }
    const source={...child,sourceTable:'sales_orders',netsuiteActive:true,eligible:true};
    if(child.originalOrderId) {
      const split=structuredClone(source);
      for(const item of split.items) for(const key of Object.keys(item)) if(key.startsWith('poAllocated')) delete item[key];
      await query("INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_date,full_order,card) VALUES($1,'SO',$2,'2098-10-28',$3::jsonb,$3::jsonb)",[child.id,child.originalOrderId,JSON.stringify(split)]);
      sources.push({...source,id:child.originalOrderId});
    } else sources.push(source);
    child.sourceTable='sales_orders';
    child.testPosition=position;
  }
  await query("INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_date,full_order,card) VALUES($1,'SO','2098-10-28',$2::jsonb,$2::jsonb)",[order.id,JSON.stringify(order)]);
  for(const [index,child] of order.childOrderDetails.entries()) await query('INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES($1,$2,$3)',[order.id,child.id,index]);
  return {order,sources};
}

for(const example of cases) test(`history replay: ${example.ref} retains PO sales allocations through feed rebuild and browser reload`,async()=>{
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const {order,sources}=await seed(example);
    for(let refresh=0;refresh<2;refresh++) {
      await upsertDispatchOrderCatalog({orders:sources,source:'isolated historical replay'});
      const feed=await getDispatchOrderCatalogOrder(order.id);
      assert.deepEqual(dispatchRequiredPickupVisitLocations(feed),['TECHO BLOC Vaughan']);
      const ui=planner([feed]);
      assert.equal(ui.addOrderToLoad(feed.id,'LOAD','drop'),true);
      ui.syncPickupStops();ui.cleanupOrphanPickupStops();
      assert.deepEqual(ui.load.stops.filter(s=>s.type==='pick').map(s=>s.location),['TECHO BLOC Vaughan']);
      for(const item of feed.items.filter(i=>[1784,2055].includes(Number(i.itemId)))) assert.equal(item.poAllocatedSalesQty,item.quantity);
    }
    const generation=(await query('SELECT generation FROM dispatch_order_catalog_state')).rows;
    for(let read=0;read<3;read++) await getDispatchOrderCatalogOrder(order.id);
    assert.deepEqual((await query('SELECT generation FROM dispatch_order_catalog_state')).rows,generation,'Detail reads must not rebuild the feed');
    await query("UPDATE dispatch_so_po_allocations SET allocated_sales_qty=allocated_sales_qty/2,allocated_piece_qty=allocated_piece_qty/2 WHERE dispatch_target_ref=$1",[order.id]);
    await upsertDispatchOrderCatalog({orders:sources,source:'isolated partial replay'});
    const partial=await getDispatchOrderCatalogOrder(order.id);
    assert.deepEqual(new Set(dispatchRequiredPickupVisitLocations(partial)),new Set([order.sourceYard,'TECHO BLOC Vaughan']));
    for(const item of partial.items.filter(i=>[1784,2055].includes(Number(i.itemId)))) assert.equal(item.poAllocatedSalesQty,item.quantity/2);
    await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE dispatch_target_ref=$1",[order.id]);
    await upsertDispatchOrderCatalog({orders:sources,source:'isolated cancellation replay'});
    const unlinked=await getDispatchOrderCatalogOrder(order.id);
    assert.deepEqual(dispatchRequiredPickupVisitLocations(unlinked),[order.sourceYard]);
    assert.ok(unlinked.items.every(i=>!i.poAllocatedSalesQty));
  });} finally {await rollback.rollback();}
});

test('failed group publication rolls back source, split, group and catalog generation together',async()=>{
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const {order,sources}=await seed(cases.find(example=>example.ref==='GOM-6894S1-6895S1'));
    const snapshot=async()=>({
      groups:(await query('SELECT full_order,card,updated_at FROM dispatch_global_order_groups WHERE group_ref=$1',[order.id])).rows,
      splits:(await query('SELECT full_order,card,updated_at FROM dispatch_global_order_splits ORDER BY split_ref')).rows,
      catalog:(await query('SELECT order_ref,full_order FROM dispatch_order_catalog_entries ORDER BY order_ref')).rows,
      state:(await query('SELECT * FROM dispatch_order_catalog_state')).rows
    });
    await query(`CREATE FUNCTION fail_linked_feed_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected publication failure'; END $$`);
    await query(`CREATE TRIGGER fail_linked_feed_publish BEFORE UPDATE ON dispatch_global_order_groups FOR EACH ROW EXECUTE FUNCTION fail_linked_feed_publish()`);
    const before=await snapshot();
    await assert.rejects(upsertDispatchOrderCatalog({orders:sources,source:'isolated failure replay'}),/injected publication failure/);
    assert.deepEqual(await snapshot(),before);
  });} finally {await rollback.rollback();}
});

test('one-time feed correction preserves cargo, rolls back preview, and repairs only missing allocations',async()=>{
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    const {order}=await seed(cases.find(example=>example.ref==='GOM-6894S1-6895S1'));
    const read=async()=>(await query('SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1',[order.id])).rows[0].full_order;
    const before=await read();
    const preview=await repairLinkedPoFeedDefinitions({refs:[order.id]});
    assert.deepEqual(preview.corrected,[order.id]);assert.deepEqual(await read(),before);
    const applied=await repairLinkedPoFeedDefinitions({apply:true,refs:[order.id]});
    assert.deepEqual(applied.corrected,[order.id]);
    const corrected=await read();assert.deepEqual(corrected.items.map(i=>i.quantity),before.items.map(i=>i.quantity));
    assert.deepEqual(dispatchRequiredPickupVisitLocations(corrected),['TECHO BLOC Vaughan']);
    assert.deepEqual((await repairLinkedPoFeedDefinitions({apply:true,refs:[order.id]})).corrected,[]);
    assert.equal(Number((await query("SELECT count(*) AS n FROM dispatch_audit_log WHERE action='dispatch.linked_po_feed_corrected' AND order_id=$1",[order.id])).rows[0].n),1);
  });} finally {await rollback.rollback();}
});
