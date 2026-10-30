import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { confirmDeliveryLine, getDeliveryOrder, getDeliveryOrdersBatch, listDeliveryOrders,
  recordDeliveryLoad, updateDeliveryStatus } from '../../../src/delivery-repository.js';
import { packingGroup, packingOrder, packingState } from '../../support/group-underpack-fixture.mjs';

after(closeDb);
const scenario = run => withTransaction(run, { rollback: true });
const photos = { photoDataUrls: ['data:image/png;base64,dGVzdDE=', 'data:image/png;base64,dGVzdDI='] };

async function fixture(linked = 1) {
  const material = await packingOrder({ quantity: 20, loaded: 20, packed: 0, salesOnly: true });
  await query("UPDATE sales_orders SET operator_status='loaded',local_yard_order_status='Loaded' WHERE netsuite_id=$1", [material.id]);
  const pallet = await packingOrder({ quantity: 8, salesOnly: true, packed: 0 });
  await query("UPDATE sales_orders SET operator_status='open' WHERE netsuite_id=$1", [pallet.id]);
  await query(`UPDATE sales_order_lines SET item_id=1784,item_name='PALLET',sku='PALLET',unit='EACH',
    pallet_qty=0,layer_qty=0,section_qty=0,piece_qty=0,to_plt=0,to_lyr=0,to_sec=0,to_pcs=0 WHERE id=$1`, [pallet.lineId]);
  const poId = pallet.id + 300000000;
  const poRef = `PO-PCS-${poId}`;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,trandate,vendor,status,status_text,
    destination_location_id,destination_location,receipt_status,netsuite_active)
    VALUES($1,$2,current_date,'PCS fixture vendor','B','Pending Receipt',1,'3445','open',true)`, [poId, poRef]);
  const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,
    quantity,unit,location_id,location,netsuite_active)
    VALUES($1,1,1784,'PALLET','PALLET','InvtPart',$2,'EACH',1,'3445',true) RETURNING id`, [poId, linked])).rows[0];
  const groupId = await packingGroup([material, pallet]);
  const allocation = (await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
    po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_piece_qty,allocated_sales_qty,
    status,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
    VALUES($1,$2,$3,$4,$5,$6,1784,'PALLET','PALLET',$7,$7,'active',$8,'group',$9) RETURNING *`,
  [pallet.id, pallet.ref, pallet.lineId, poId, poRef, poLine.id, linked, groupId,
    `${groupId}::${pallet.ref}::${pallet.lineId}`])).rows[0];
  const actor = `pcs-sales-${pallet.id}`;
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
    VALUES($1,$1,'PCS fixture','test','test','operator',ARRAY['operator'],true)`, [actor]);
  return { material, pallet, groupId, allocation, actor };
}

test('PCS5 grouped 3445 pallet line accepts its valid link and packs/loads the remaining seven EACH', () => scenario(async () => {
  const f = await fixture();
  const before = await packingState(f.pallet);
  const group = await getDeliveryOrder(f.groupId);
  const pallet = group.lines.find(line => line.sku === 'PALLET');
  assert.equal(pallet.linked_quantity_blocked, false);
  assert.equal(pallet.quantity, 7);
  assert.equal(group.underpack_count, 1, 'seven unrecorded yard units are still open');
  const standalone = await getDeliveryOrder(f.pallet.id);
  assert.equal(standalone.lines[0].linked_quantity_blocked, false);
  assert.equal(standalone.lines[0].quantity, 7);
  const batch = (await getDeliveryOrdersBatch([f.groupId]))[0];
  assert.equal(batch.lines.find(line => line.sku === 'PALLET').linked_quantity_blocked, false);
  assert.equal((await listDeliveryOrders({ locationId: 1 })).find(order => order.netsuite_id === f.groupId)?.underpack_count, 1);

  await confirmDeliveryLine(f.groupId, pallet.id, { salesQty: 7 }, f.actor);
  assert.equal((await getDeliveryOrder(f.groupId)).underpack_count, 0);
  await updateDeliveryStatus(f.groupId, 'packed', f.actor);
  await recordDeliveryLoad(f.groupId, f.actor, photos);
  const loadedState = await packingState(f.pallet);
  assert.equal(Number(loadedState.lines[0].loaded_qty), 7);
  assert.equal(Number(loadedState.lines[0].packed_sales_qty), 0);
  assert.equal(loadedState.lines[0].quantity, before.lines[0].quantity);
  assert.equal(loadedState.lines[0].piece_qty, before.lines[0].piece_qty);
  assert.deepEqual((await query('SELECT * FROM dispatch_so_po_allocations WHERE id=$1', [f.allocation.id])).rows[0], f.allocation);
  assert.equal((await getDeliveryOrder(f.groupId)).underpack_count, 0);
}));

test('PCS5 nine linked EACH against eight still blocks Operator packing without a write', () => scenario(async () => {
  const f = await fixture(9);
  const before = await packingState(f.pallet);
  const group = await getDeliveryOrder(f.groupId);
  const pallet = group.lines.find(line => line.sku === 'PALLET');
  assert.equal(pallet.linked_quantity_blocked, true);
  assert.deepEqual(pallet.linked_quantity_errors.map(({ unit, required, linked }) => ({ unit, required, linked })),
    [{ unit: 'sales', required: 8, linked: 9 }]);
  await assert.rejects(confirmDeliveryLine(f.groupId, pallet.id, { salesQty: 1 }, f.actor),
    { code: 'DELIVERY_LINKED_QUANTITY_BLOCKED' });
  assert.deepEqual(await packingState(f.pallet), before);
}));

test('PCS5 a fully linked pallet line remains visible with no yard requirement or false block', () => scenario(async () => {
  const f = await fixture(8);
  const group = await getDeliveryOrder(f.groupId);
  const pallet = group.lines.find(line => line.sku === 'PALLET');
  assert.equal(pallet.linked_quantity_blocked, false);
  assert.equal(pallet.quantity, 0);
  assert.equal(pallet.no_yard_load_required, true);
  assert.equal(group.underpack_count, 0);
}));
