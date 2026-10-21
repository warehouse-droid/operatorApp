import assert from 'node:assert/strict';
import test, {after, before} from 'node:test';
import {beginRollbackContext,closeDb,query} from '../../../src/db.js';
import {setOutboundLocationDirectory} from '../../../src/outbound-location-domain.js';
import {getDeliveryOrder,getDeliveryBootstrap,getCurrentOperatorDeliveryDraft,listDeliveryOrders,listDeliveryLoadOrders,listDeliveryLoadTrucks,listSavedDeliveryOrderKeysForOperator} from '../../../src/delivery-repository.js';
import {listReceivingOrders,listReceivingSources,searchReceivingItems} from '../../../src/receiving-repository.js';
import {upsertOutboundTransferOrders,upsertInboundTransferOrders} from '../../../src/order-sync-repository.js';
import {writeAudit} from '../../../src/auth-repository.js';

before(()=>setOutboundLocationDirectory([{id:1},{id:28},{id:15},{id:26},{id:37,parent:28},{id:10,parent:1}]));
after(closeDb);
let sequence=0;
async function seed() {
  const id=9980121000+(sequence+=10),ref=`TO-RECEIVED-${id}`,actor=`received-to-${id}`;
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
    VALUES($1,$1,'Completed TO fixture','test','test','operator',ARRAY['operator'],true)`,[actor]);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,
    outbound_operator_status,local_yard_order_status,receiving_status,fulfillment_status,netsuite_active,dispatch_planned,dispatch_plan_date,dispatch_truck_plate,dispatch_load_name)
    VALUES($1,$2,'B','Transfer Order : Pending Fulfillment',37,'2967 : 2967 Damage',10,'3445 : 3445 Damage',
    'open','Open','not_received','not_fulfilled',true,true,'2026-10-07',$3,'Load 1')`,[id,ref,`TRUCK-${id}`]);
  await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,item_name,sku,item_type,quantity,unit,location_id,location,
    piece_qty,to_pcs,loaded_qty,netsuite_received_qty,netsuite_active)
    VALUES($1,1,'outbound',2299,'RECEIVED-TO-ITEM','RECEIVED-TO-ITEM','InvtPart',10,'PC',37,'2967 Damage',10,1,0,0,true),
    ($1,2,'receiving',2299,'RECEIVED-TO-ITEM','RECEIVED-TO-ITEM','InvtPart',10,'PC',10,'3445 Damage',10,1,0,0,true)`,[id]);
  return {id,ref,actor,truck:`TRUCK-${id}`};
}
async function fixture(operation) {
  const rollback=await beginRollbackContext();
  try{return await rollback.run(async()=>operation(await seed()));}
  finally{await rollback.rollback();}
}
async function listed(f,status='active') {
  return (await listDeliveryOrders({locationId:28,status,orderType:'transfer_order',allowedOperatorYards:[28]}))
    .filter(order=>String(order.netsuite_id)===String(f.id));
}
async function progress(f) {
  return {header:(await query(`SELECT outbound_operator_status,local_yard_order_status,receiving_status,fulfillment_status,preparing_operator_id FROM transfer_orders WHERE netsuite_id=$1`,[f.id])).rows,
    lines:(await query(`SELECT id,loaded_qty,received_sales_qty,received_pallet_qty,received_layer_qty,received_piece_qty,packed_piece_qty,packed_sales_qty FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY id`,[f.id])).rows};
}
function snapshot(f,status='G',statusText='Transfer Order : Received') {
  return {id:f.id,tranid:f.ref,status,status_text:statusText,source_location_id:37,source_location:'2967 : 2967 Damage',
    destination_location_id:10,destination_location:'3445 : 3445 Damage'};
}

test('TOB01210 shape: a Received header sync hides outstanding local-open damage-yard work and preserves history',()=>fixture(async f=>{
  assert.equal((await listed(f)).length,1);
  const before=await progress(f);
  await upsertOutboundTransferOrders([snapshot(f)]);
  assert.deepEqual(await listed(f),[]);
  assert.ok(!(await listDeliveryLoadOrders({locationId:28,planDate:'2026-10-07',truckPlate:f.truck})).some(o=>String(o.netsuite_id)===String(f.id)));
  assert.ok(!(await listDeliveryLoadTrucks({locationId:28,planDate:'2026-10-07'})).some(o=>o.truck_plate===f.truck));
  assert.ok(!(await getDeliveryBootstrap({locationId:28,allowedOperatorYards:[28]})).orders.transferOrder.some(o=>String(o.netsuite_id)===String(f.id)));
  assert.deepEqual(await progress(f),before);
  assert.equal((await getDeliveryOrder(f.id)).status,'G','completed order detail remains available for recorded history');
}));

test('inbound Received sync also hides the source-yard work list',()=>fixture(async f=>{
  await upsertInboundTransferOrders([snapshot(f)]);
  assert.deepEqual(await listed(f),[]);
  assert.equal((await query('SELECT receiving_status FROM transfer_orders WHERE netsuite_id=$1',[f.id])).rows[0].receiving_status,'not_received');
}));

test('exact Received status labels and padded G codes hide completed work without partial-label matching',()=>fixture(async f=>{
  for(const [code,label] of [[' g ','Unknown'],[null,' Received '],[null,' transfer   order : received ']]) {
    await query('UPDATE transfer_orders SET status=$2,status_text=$3 WHERE netsuite_id=$1',[f.id,code,label]);
    assert.deepEqual(await listed(f),[],`${code}/${label}`);
  }
}));

test('pending and partial transfer statuses keep local work visible and a later source reopen restores it',()=>fixture(async f=>{
  for(const [code,label] of [['B','Transfer Order : Pending Fulfillment'],['D','Transfer Order : Partially Fulfilled'],
    ['E','Transfer Order : Pending Receipt/Partially Fulfilled'],['F','Transfer Order : Pending Receipt'],[null,'Transfer Order : Partially Received']]) {
    await query('UPDATE transfer_orders SET status=$2,status_text=$3 WHERE netsuite_id=$1',[f.id,code,label]);
    assert.equal((await listed(f)).length,1,`${code}/${label}`);
  }
  await upsertOutboundTransferOrders([snapshot(f)]);
  assert.deepEqual(await listed(f),[]);
  await upsertOutboundTransferOrders([snapshot(f,'B','Transfer Order : Pending Fulfillment')]);
  assert.equal((await listed(f)).length,1);
}));

test('a completed transfer cannot reappear through a group while unfinished members remain visible',()=>fixture(async f=>{
  const other=await seed(),group=`GO-RECEIVED-TO-${f.id}`,plan=f.id+5;
  await query("INSERT INTO dispatch_plans(id,plan_date,status) VALUES($1,current_date,'draft')",[plan]);
  await query(`INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type,active)
    VALUES($1,$2,current_date,'transfer_order',true)`,[group,plan]);
  await query('INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position) VALUES($1,$2,0),($1,$3,1)',[group,f.ref,other.ref]);
  await upsertOutboundTransferOrders([snapshot(f)]);
  const rows=await listDeliveryOrders({locationId:28,orderType:'transfer_order'});
  const card=rows.find(o=>o.netsuite_id===group);
  assert.ok(card);assert.deepEqual(card.child_order_refs,[other.ref]);
  assert.equal((await getDeliveryOrder(group)).lines[0].quantity,10);
  await upsertOutboundTransferOrders([snapshot(other)]);
  assert.ok(!(await listDeliveryOrders({locationId:28,orderType:'transfer_order'})).some(o=>o.netsuite_id===group));
}));

test('Received transfer headers suppress stale packed cards and operator preparation drafts without clearing progress',()=>fixture(async f=>{
  await query("UPDATE transfer_order_lines SET packed_piece_qty=2 WHERE transfer_order_id=$1 AND line_stage='outbound'",[f.id]);
  await query("UPDATE transfer_orders SET outbound_operator_status='packed',preparing_operator_id=$2,preparing_started_at=now() WHERE netsuite_id=$1",[f.id,f.actor]);
  assert.equal((await listed(f,'packed')).length,1);
  assert.ok(await getCurrentOperatorDeliveryDraft(f.actor,{locationId:28}));
  const before=await progress(f);
  await upsertOutboundTransferOrders([snapshot(f)]);
  assert.deepEqual(await listed(f,'packed'),[]);
  assert.equal(await getCurrentOperatorDeliveryDraft(f.actor,{locationId:28}),null);
  assert.deepEqual(await progress(f),before);
}));

test('Received transfers with real shipment evidence leave inbound order, item and source pickers',()=>fixture(async f=>{
  await writeAudit({actorType:'system',source:'admin',action:'operator.to.legacy_receiving_enabled',orderId:f.id,
    details:{orderRef:f.ref,sourceNetSuiteId:String(f.id),verifiedLoadLines:[{sourceLineKey:'1',itemId:2299,quantity:10,unit:'PC',transactionId:990}]}});
  assert.equal((await listReceivingOrders({orderType:'transfer_order',destinationLocationId:10,search:f.ref})).length,1);
  const before=await progress(f);
  await upsertInboundTransferOrders([snapshot(f)]);
  assert.deepEqual(await listReceivingOrders({orderType:'transfer_order',destinationLocationId:10,search:f.ref}),[]);
  assert.ok(!(await listReceivingSources({destinationLocationId:10})).some(row=>Number(row.source_location_id)===37));
  assert.deepEqual(await searchReceivingItems({orderType:'transfer_order',destinationLocationId:10,search:f.ref}),[]);
  assert.deepEqual(await progress(f),before);
}));

test('completed transfer saved keys stay out of operator work while their saved history is retained',()=>fixture(async f=>{
  await query(`INSERT INTO operator_saved_delivery_orders(operator_id,location_id,order_key,order_ref,order_type)
    VALUES($1,28,$2,$3,'transfer_order')`,[f.actor,String(f.id),f.ref]);
  await upsertOutboundTransferOrders([snapshot(f)]);
  const before=(await query('SELECT * FROM operator_saved_delivery_orders WHERE operator_id=$1',[f.actor])).rows;
  assert.deepEqual(await listSavedDeliveryOrderKeysForOperator(f.actor,{locationId:28,allowedOperatorYards:[28]}),[]);
  const bootstrap=await getDeliveryBootstrap({operatorId:f.actor,locationId:28,allowedOperatorYards:[28]});
  assert.deepEqual(bootstrap.savedOrderKeys,[]);
  assert.deepEqual((await query('SELECT * FROM operator_saved_delivery_orders WHERE operator_id=$1',[f.actor])).rows,before);
}));
