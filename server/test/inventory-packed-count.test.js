import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {query,closeDb,withTransaction} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {packedStockQuantity,packedInventorySnapshot} from '../src/inventory-packed-stock.js';
import {createCountSheet,changeCountSheet,getCountSheet} from '../src/count-sheet-repository.js';
import {confirmCycleCountLine} from '../src/inventory-repository.js';

const itemId=982300,orderId=982300001;
let operator,manager;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const role of ['operator','yard_manager']) {
    const actor=await createOperator({username:`packed-count-${crypto.randomUUID()}`,password:crypto.randomUUID(),displayName:role,role,operatorYardLocationIds:[1],yardLocationIds:[1]});
    if(role==='operator') {operator=actor;} else {manager=actor;}
  }
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt,to_lyr) VALUES($1,'Packed Huntington','SQFT',102.3,12.79) ON CONFLICT DO NOTHING",[itemId]);
  await query("INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand,quantity_available) VALUES($1,1,767.24,76.70) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_on_hand=767.24,quantity_available=76.70",[itemId]);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,operator_status,fulfillment_status,outbound_location_id,netsuite_active) VALUES($1,'SO-PACKED-COUNT','B','Sales Order : Pending Fulfillment','packed','not_fulfilled',1,true) ON CONFLICT(netsuite_id) DO UPDATE SET operator_status='packed',fulfillment_status='not_fulfilled',netsuite_active=true,status='B'",[orderId]);
  await query('DELETE FROM sales_order_lines WHERE sales_order_id=$1',[orderId]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,unit,location_id,netsuite_active,to_plt,to_lyr,packed_pallet_qty,packed_layer_qty)
    VALUES($1,1,$2,'Packed Huntington','InvtPart',690.54,'SQFT',1,true,102.3,12.79,6,6)`,[orderId,itemId]);
});
after(closeDb);
test('P1: packed physical units produce the requested actual-on-hand and variance',async()=>{
  const packed=packedStockQuantity({to_plt:102.3,to_lyr:12.79,packed_pallet_qty:6,packed_layer_qty:6});
  assert.equal(packed,690.54);assert.equal(Number((767.24-packed).toFixed(2)),76.7);assert.equal(Number((63.95-(767.24-packed)).toFixed(2)),-12.75);
  const snapshot=await packedInventorySnapshot([itemId],1);
  assert.equal(snapshot.get(itemId).quantity,690.54);assert.deepEqual(snapshot.get(itemId).lines.map(line=>line.orderRef),['SO-PACKED-COUNT']);
});
test('P2: fulfilled or loaded quantities are deducted once; sales-only packing and legacy pieces convert correctly',()=>{
  assert.equal(packedStockQuantity({to_plt:100,packed_pallet_qty:3,fulfilled_pallet_qty:1,loaded_qty:0}),200);
  assert.equal(packedStockQuantity({to_plt:100,packed_pallet_qty:3,fulfilled_pallet_qty:1,loaded_qty:100}),300,'earlier local loads have already cleared their packing');
  assert.equal(packedStockQuantity({to_plt:100,packed_pallet_qty:3,fulfilled_pallet_qty:3,loaded_qty:0}),0);
  assert.equal(packedStockQuantity({packed_sales_qty:50,loaded_qty:10}),50);
  assert.equal(packedStockQuantity({packed_piece_qty:7,fulfilled_piece_qty:2}),5);
  assert.equal(packedStockQuantity({packed_pallet_qty:2,pallet_qty:2,packed_sales_qty:500}),500);
  assert.equal(packedStockQuantity({to_plt:100,packed_pallet_qty:2,packed_sales_qty:200}),200,'physical and sales fields must not double count');
});
test('P2: generated packing never exceeds packed stock and is reduced by shipped stock only once',()=>{
  fc.assert(fc.property(fc.integer({min:0,max:100}),fc.integer({min:0,max:100}),fc.integer({min:1,max:1000}),(packed,fulfilled,factor)=>{
    assert.equal(packedStockQuantity({packed_pallet_qty:packed,fulfilled_pallet_qty:fulfilled,to_plt:factor,loaded_qty:0}),Math.max(0,packed-fulfilled)*factor);
  }),{seed:3102026,numRuns:100});
});
test('P2: other yards and unassigned SKUs do not contribute',async()=>{
  assert.equal((await packedInventorySnapshot([itemId],28)).get(itemId).quantity,0);
  assert.equal((await packedInventorySnapshot([982399],1)).get(982399).quantity,0);
});
test('P3: Count Sheet confirmation freezes on hand, packed, actual and the new variance',async()=>{
  let sheet=await createCountSheet(manager,{locationId:1,title:'Packed comparison',itemIds:[itemId],requestId:crypto.randomUUID()});
  sheet=await changeCountSheet(operator,sheet.id,'take',{});
  sheet=await changeCountSheet(operator,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId,values:{layers:5}});
  assert.equal('packed_qty' in sheet.items[0].count,false);
  const review=await getCountSheet(manager,sheet.id,{management:true}),count=review.items[0].count;
  assert.equal(Number(count.system_on_hand),767.24);assert.equal(Number(count.packed_qty),690.54);
  assert.equal(Number(count.actual_on_hand),76.7);assert.equal(Number(count.variance),-12.75);assert.ok(count.packed_snapshot_at);
});
test('P3: regular Cycle Count confirmation uses the same packed-stock comparison',async()=>{
  const draft=await confirmCycleCountLine(operator.id,{itemId,locationId:1,layers:5},{yardLocationIds:[1]});
  const line=draft.lines.find(row=>Number(row.item_id)===itemId);
  assert.equal(Number(line.system_on_hand_qty),767.24);assert.equal(Number(line.system_packed_qty),690.54);
  assert.equal(Number(line.actual_on_hand_qty),76.7);assert.equal(Number(line.variance_qty),-12.75);assert.ok(line.packed_snapshot_at);
});
test('P2: completed, closed and inactive SO stock is excluded while partial fulfillment is retained',async()=>{
  try {
    for(const update of ["fulfillment_status='fulfilled'","status='H'","netsuite_active=false","operator_status='loaded'"]) {
      await query("UPDATE sales_orders SET fulfillment_status='not_fulfilled',status='B',netsuite_active=true,operator_status='packed' WHERE netsuite_id=$1",[orderId]);
      await query("UPDATE sales_orders SET "+update+' WHERE netsuite_id=$1',[orderId]);
      assert.equal((await packedInventorySnapshot([itemId],1)).get(itemId).quantity,0,update);
    }
  } finally {await query("UPDATE sales_orders SET fulfillment_status='not_fulfilled',status='B',netsuite_active=true,operator_status='packed' WHERE netsuite_id=$1",[orderId]);}
});
test('P2: outbound TO, CO, VRMA and reload packing contributes once; inbound and completed sources do not',async()=>{
  await withTransaction(async()=>{
    await query("UPDATE sales_order_lines SET packed_pallet_qty=0,packed_layer_qty=0 WHERE sales_order_id=$1",[orderId]);
    await query("INSERT INTO transfer_orders(netsuite_id,tranid,from_location_id,to_location_id,outbound_operator_status,fulfillment_status,netsuite_active) VALUES($1,'TO-PACK-TEST',1,28,'packed','not_fulfilled',true)",[orderId]);
    for(const stage of ['outbound','receiving']) {
      await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,packed_piece_qty,to_pcs,netsuite_active) VALUES($1,$2,1,$3,10,1,true)`,[orderId,stage,itemId]);
    }
    const co=(await query("INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,to_location_id,status) VALUES('CO-PACK-TEST','SO-PACKED-COUNT',1,28,'packed') RETURNING id")).rows[0];
    await query("INSERT INTO local_co_order_lines(co_id,line_id,item_id,packed_sales_qty) VALUES($1,1,$2,20)",[co.id,itemId]);
    const vrma=(await query("INSERT INTO scm_vrma_orders(vrma_ref,pickup_location,status,operator_status) VALUES('VRMA-PACK-TEST','3445','Queued','packed') RETURNING id")).rows[0];
    await query("INSERT INTO scm_vrma_order_lines(vrma_order_id,item_id,item_name,packed_sales_qty) VALUES($1,$2,'Test',30)",[vrma.id,itemId]);
    const cycle=(await query("INSERT INTO operator_reload_cycles(sales_order_id,order_ref,outbound_location_id,cycle_number,request_id,reason,status) VALUES($1,'SO-PACKED-COUNT',1,1,$2,'Test','packed') RETURNING id",[orderId,crypto.randomUUID()])).rows[0];
    const soLine=(await query('SELECT id FROM sales_order_lines WHERE sales_order_id=$1',[orderId])).rows[0];
    await query("INSERT INTO operator_reload_cycle_lines(cycle_id,sales_order_line_id,item_id,target_sales_qty,packed_sales_qty,reloaded_sales_qty,selected_for_reattempt,selection_reason) VALUES($1,$2,$3,100,40,20,true,'Test')",[cycle.id,soLine.id,itemId]);
    const snapshot=(await packedInventorySnapshot([itemId],1)).get(itemId);
    assert.equal(snapshot.quantity,100);assert.deepEqual(snapshot.lines.map(line=>line.source),['CO','RELOAD','TO','VRMA']);
    assert.equal((await packedInventorySnapshot([itemId],28)).get(itemId).quantity,0,'inbound transfer is not yard packing');
    await query("UPDATE local_co_orders SET status='planned',loaded_at=now() WHERE id=$1",[co.id]);
    await query('UPDATE scm_vrma_orders SET loaded_at=now() WHERE id=$1',[vrma.id]);
    await query("UPDATE transfer_orders SET fulfillment_status='fulfilled' WHERE netsuite_id=$1",[orderId]);
    await query("UPDATE operator_reload_cycles SET status='completed',completed_at=now() WHERE id=$1",[cycle.id]);
    assert.equal((await packedInventorySnapshot([itemId],1)).get(itemId).quantity,0);
  },{rollback:true});
});
test('P2: local partial loading does not erase new packing; native fulfillment without local loading does',async()=>{
  await withTransaction(async()=>{
    await query("UPDATE sales_orders SET fulfillment_status='partial_fulfilled',operator_status='partial_loaded' WHERE netsuite_id=$1",[orderId]);
    await query('UPDATE sales_order_lines SET packed_pallet_qty=3,packed_layer_qty=0,to_plt=100,fulfilled_pallet_qty=1,loaded_qty=100 WHERE sales_order_id=$1',[orderId]);
    assert.equal((await packedInventorySnapshot([itemId],1)).get(itemId).quantity,300);
    await query('UPDATE sales_order_lines SET loaded_qty=0 WHERE sales_order_id=$1',[orderId]);
    assert.equal((await packedInventorySnapshot([itemId],1)).get(itemId).quantity,200);
  },{rollback:true});
});
