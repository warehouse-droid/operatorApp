import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { updateDispatchOrderDetails, setPurchaseOrderVendorYard, listDispatchOrders,
  getSalesOrderPoAllocationOptions, createSalesOrderPoAllocations } from '../../../src/dispatch-repository.js';
import { getDispatchOrderCatalogOrder, upsertDispatchOrderCatalog } from '../../../src/dispatch-order-catalog-repository.js';
import { reconcileDispatchPlanGlobalOrderDefinitions, syncDispatchDeliveryGroupsFromPlan } from '../../../src/dispatch-delivery-group-repository.js';
import { planJobsForDriver } from '../../../src/driver-repository.js';
import { seedLinkGroup } from '../../support/link-to-fix-fixture.mjs';
import { seedSplitAddress } from '../../dispatch/support/split-address-fixture.js';
after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });
const edit = address => ({ type: 'SO', address, pickupAddress: '77 Pickup Road',
  windowStart: '0900', windowEnd: '1200', expectedDeliveryDate: '2096-11-25' });

async function addressFixture() {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  await query("UPDATE sales_orders SET dispatch_address='Old address' WHERE tranid=ANY($1)", [f.members]);
  const children = await listDispatchOrders({ type: 'SO', exactOrderRefs: f.members });
  f.group = { ...children[0], id: f.groupRef, childOrders: f.members, childOrderDetails: children };
  f.plan.orders = [f.group];
  f.plan.trucks[0].loads[0].stops = [{ id: 'group-drop', type: 'drop', orderId: f.groupRef, location: 'Old address' }];
  await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb WHERE group_ref=$1', [f.groupRef, JSON.stringify(f.group)]);
  await upsertDispatchOrderCatalog({ orders: children });
  return f;
}

test('G1 group address edits reach every child, catalog, stale plan and driver route', () => isolated(async () => {
  const f = await addressFixture();
  for (const address of ['123 New Road', '456 Replacement Road']) {
    const result = await updateDispatchOrderDetails(f.groupRef, edit(address));
    assert.deepEqual([...result.child_order_refs].sort(), [...f.members].sort());
    const rows = (await query('SELECT * FROM sales_orders WHERE tranid=ANY($1)', [f.members])).rows;
    for (const row of rows) {
      assert.equal(row.dispatch_address, address);
      assert.equal(row.dispatch_pickup_address, '77 Pickup Road');
      assert.equal(row.dispatch_window_start, '0900');
      assert.equal(new Date(row.expected_delivery_date).toISOString().slice(0, 10), '2096-11-25');
    }
    const current = await getDispatchOrderCatalogOrder(f.groupRef);
    assert.equal(current.address, address);
    assert.ok(current.childOrderDetails.every(child => child.address === address));
    for (const ref of f.members) { assert.equal((await getDispatchOrderCatalogOrder(ref)).address, address); }
    const reconciled = await reconcileDispatchPlanGlobalOrderDefinitions(f.plan);
    assert.equal(reconciled.orders[0].address, address);
    const drop = planJobsForDriver(reconciled, 'co-driver').find(job => job.stopType === 'dropoff');
    assert.equal(drop.address, address);
    assert.deepEqual([...drop.orderRefs].sort(), [...f.members].sort());
  }
}));

test('G1 address edits preserve refreshed group quantities and inherited CO routing', () => isolated(async () => {
  const f = await seedLinkGroup();
  await query('UPDATE sales_order_lines SET quantity=8,piece_qty=8,netsuite_backordered_qty=8 WHERE id=$1', [f.lines[0].id]);
  const before = (await query('SELECT * FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows;
  await updateDispatchOrderDetails(f.groupRef, edit('Fresh quantity address'));
  const current = await getDispatchOrderCatalogOrder(f.groupRef);
  assert.equal(current.items.reduce((sum, item) => sum + Number(item.quantity), 0), 14);
  assert.equal(current.sourceYard, '2967');
  assert.ok(current.childOrderDetails.every(child => child.transitCo?.id === f.coRef && child.sourceYard === '2967'));
  assert.deepEqual((await query('SELECT * FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows, before);
}));

test('G1 group edits reject retired, missing, closed and invalid children without partial writes', () => isolated(async () => {
  const f = await addressFixture();
  for (const kind of ['closed', 'missing', 'retired', 'inactive', 'invalid-date']) {
    await withTransaction(async () => {
      if (kind === 'closed') { await query("UPDATE sales_orders SET status='C',status_text='Closed' WHERE tranid=$1", [f.members[1]]); }
      if (kind === 'missing') { await query('DELETE FROM sales_order_lines WHERE sales_order_id=$1', [f.lines[1].sales_order_id]); await query('DELETE FROM sales_orders WHERE tranid=$1', [f.members[1]]); }
      if (kind === 'retired') { await query('UPDATE dispatch_global_order_groups SET active=false WHERE group_ref=$1', [f.groupRef]); }
      if (kind === 'inactive') { await query('UPDATE sales_orders SET netsuite_active=false WHERE tranid=$1', [f.members[1]]); }
      const before = (await query('SELECT * FROM sales_orders WHERE tranid=ANY($1) ORDER BY tranid', [f.members])).rows;
      const definition = (await query('SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1', [f.groupRef])).rows;
      await assert.rejects(updateDispatchOrderDetails(f.groupRef, { ...edit('Must roll back'),
        ...(kind === 'invalid-date' ? { expectedDeliveryDate: 'not-a-date' } : {}) }));
      assert.deepEqual((await query('SELECT * FROM sales_orders WHERE tranid=ANY($1) ORDER BY tranid', [f.members])).rows, before);
      assert.deepEqual((await query('SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1', [f.groupRef])).rows, definition);
    }, { rollback: true });
  }
}));

test('G1 an unmaterialized split child keeps its address isolated from parent and sibling', () => isolated(async () => {
  const f = await addressFixture();
  const split = await seedSplitAddress();
  const children = [f.group.childOrderDetails[0], split.splits[1]];
  const group = { ...f.group, childOrders: children.map(child => child.id), childOrderDetails: children };
  await syncDispatchDeliveryGroupsFromPlan({ ...f.plan, orders: [group], trucks: [] });
  await updateDispatchOrderDetails(f.groupRef, edit('Group split address'));
  assert.equal((await getDispatchOrderCatalogOrder(split.splits[1].id)).address, 'Group split address');
  assert.equal((await getDispatchOrderCatalogOrder(split.splits[0].id)).address, split.parent.address);
  assert.equal((await query('SELECT dispatch_address FROM sales_orders WHERE tranid=$1', [split.parentRef])).rows[0].dispatch_address, split.parent.address);
}));

test('G1 canonical nested members expand while cycles, empty and wrong-type groups fail closed', () => isolated(async () => {
  const f = await addressFixture();
  const nested = { ...f.group, id: `OUTER-${f.groupRef}`, childOrders: [f.groupRef], childOrderDetails: [] };
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,full_order,card,source_plan_date)
    VALUES($1,'SO',$2::jsonb,$2::jsonb,'2096-11-12')`, [nested.id, JSON.stringify(nested)]);
  const saved = await updateDispatchOrderDetails(nested.id, { ...edit('Nested group address'), childOrders: ['WRONG-CLIENT-MEMBER'] });
  assert.deepEqual([...saved.child_order_refs].sort(), [...f.members].sort());
  assert.equal((await getDispatchOrderCatalogOrder(f.groupRef)).address, 'Nested group address');
  for (const [type, children] of [['SO', []], ['SO', [nested.id]], ['CO', f.members], ['TO', f.members]]) {
    await withTransaction(async () => {
      await query("UPDATE dispatch_global_order_groups SET order_type=$2,full_order=jsonb_set(full_order,'{childOrders}',$3::jsonb) WHERE group_ref=$1",
        [nested.id, type, JSON.stringify(children)]);
      await assert.rejects(updateDispatchOrderDetails(nested.id, edit('Invalid group edit')));
      assert.ok((await query('SELECT dispatch_address FROM sales_orders WHERE tranid=ANY($1)', [f.members])).rows
        .every(row => row.dispatch_address === 'Nested group address'));
    }, { rollback: true });
  }
}));

async function purchase(f, index = 0) {
  const id = f.transferId + 10 + index;
  const ref = `PO-GROUP-${id}`;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
    dispatch_address,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,'B','Pending Receipt','Group Vendor','Vendor Yard','100 Vendor Road',26,'150',true)`, [id, ref]);
  const line = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
    quantity,piece_qty,to_pcs,unit,netsuite_active) VALUES($1,1,2340,'LINK-ITEM','LINK-ITEM',10,10,1,'EA',true) RETURNING id`, [id])).rows[0];
  return { id, ref, line };
}

test('G2 Link PO across dates allocates distinct real child lines', () => isolated(async () => {
  const f = await addressFixture();
  const po = await purchase(f);
  const options = await getSalesOrderPoAllocationOptions(f.groupRef, { planDate: f.nextDate });
  assert.equal(options.salesLines.length, 2);
  const allocations = await createSalesOrderPoAllocations({ dispatchTargetRef: f.groupRef, planDate: f.nextDate,
    poRef: po.ref, targetSignature: options.order.targetSignature, lines: options.salesLines.map((line, index) => ({
      targetLineKey: line.targetLineKey, salesLineId: line.id, poLineId: po.line.id, quantities: { pieces: [4, 6][index] } })) });
  assert.deepEqual(allocations.map(row => row.salesOrderRef).sort(), [...f.members].sort());
  assert.ok(allocations.every(row => row.dispatchTargetRef === f.groupRef));
}));

test('G3 PO group delivery override, clearing and Set Yard reach each PO separately', () => isolated(async () => {
  const f = await addressFixture();
  const pos = [await purchase(f), await purchase(f, 1)];
  const options = await getSalesOrderPoAllocationOptions(f.groupRef, { planDate: f.nextDate });
  const line = options.salesLines[0];
  await createSalesOrderPoAllocations({ dispatchTargetRef: f.groupRef, planDate: f.nextDate,
    poRef: pos[0].ref, targetSignature: options.order.targetSignature, lines: [{
      targetLineKey: line.targetLineKey, salesLineId: line.id, poLineId: pos[0].line.id, quantities: { pieces: 4 } }] });
  const allocations = (await query('SELECT * FROM dispatch_so_po_allocations WHERE po_order_id=ANY($1) ORDER BY id', [pos.map(po => po.id)])).rows;
  const children = await listDispatchOrders({ type: 'PO', exactOrderRefs: pos.map(po => po.ref) });
  const group = { ...children[0], id: `GPO-${f.transferId}`, childOrders: children.map(child => child.id), childOrderDetails: children };
  await syncDispatchDeliveryGroupsFromPlan({ ...f.plan, orders: [group], trucks: [] });
  for (const address of ['700 Group Delivery Road', '']) {
    await updateDispatchOrderDetails(group.id, { ...edit(address), type: 'PO', pickupAddress: '' });
    const rows = (await query('SELECT * FROM purchase_orders WHERE netsuite_id=ANY($1)', [pos.map(po => po.id)])).rows;
    assert.ok(rows.every(row => row.dispatch_delivery_address === address && row.dispatch_address === '100 Vendor Road'));
    const current = await getDispatchOrderCatalogOrder(group.id);
    assert.equal(current.deliveryAddressOverride, address);
    assert.ok(current.childOrderDetails.every(child => child.deliveryAddressOverride === address));
    assert.equal(current.items.reduce((sum, item) => sum + Number(item.quantity), 0), 20);
    assert.equal(current.poRouteProjection.salesQty, 16);
    assert.equal(current.poRouteProjection.pieces, 16);
    const route = { ...f.plan, orders: [current], trucks: structuredClone(f.plan.trucks) };
    route.trucks[0].loads[0].stops = [{ id: 'po-drop', type: 'drop', orderId: group.id, location: 'Old address' }];
    assert.equal(planJobsForDriver(route, 'co-driver').find(job => job.stopType === 'dropoff').address, current.address);
    const reconciled = await reconcileDispatchPlanGlobalOrderDefinitions({ ...route, orders: [group] });
    assert.equal(reconciled.orders[0].poRouteProjection.salesQty, 16);
    assert.equal(planJobsForDriver(reconciled, 'co-driver').find(job => job.stopType === 'dropoff').address, current.address);
  }
  const yard = (await query("INSERT INTO dispatch_vendor_yards(vendor,yard,address,active) VALUES('Group Vendor','New Yard','200 Vendor Road',true) RETURNING id")).rows[0];
  await setPurchaseOrderVendorYard(group.id, yard.id);
  assert.ok((await query('SELECT * FROM purchase_orders WHERE netsuite_id=ANY($1)', [pos.map(po => po.id)])).rows
    .every(row => row.dispatch_vendor_yard === 'New Yard' && row.dispatch_address === '200 Vendor Road'));
  const current = await getDispatchOrderCatalogOrder(group.id);
  assert.ok(current.childOrderDetails.every(child => child.sourceAddress === '200 Vendor Road'));
  assert.equal(current.poRouteProjection.salesQty, 16);
  assert.deepEqual((await query('SELECT * FROM dispatch_so_po_allocations WHERE po_order_id=ANY($1) ORDER BY id', [pos.map(po => po.id)])).rows, allocations);
}));

test('G4 a legacy plan cannot persist a split whose parent is a group', () => isolated(async () => {
  const f = await addressFixture();
  const invalid = { ...f.group, id: `${f.groupRef}-S1`, originalOrderId: f.groupRef };
  await assert.rejects(syncDispatchDeliveryGroupsFromPlan({ ...f.plan, orders: [invalid], trucks: [] }),
    error => error.code === 'DISPATCH_GROUP_SPLIT_UNSUPPORTED');
  assert.equal((await query('SELECT 1 FROM dispatch_global_order_groups WHERE group_ref=$1', [invalid.id])).rowCount, 0);
}));
