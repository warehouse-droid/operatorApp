import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import crypto from 'node:crypto';
import { query } from '../../../src/db.js';
import { createDispatchV2Fixture, dispatchOrder } from '../support/dispatch-v2-fixture.js';
import { stored, seedMaintenanceIncident } from '../../support/order-update-save-fixture.mjs';
import { seed, sourceCo, command as transferCommand } from '../../support/co-direct-to-fixture.mjs';
import { listDispatchOrders } from '../../../src/dispatch-repository.js';
import { resolveDispatchSalesTarget } from '../../../src/dispatch-order-target-repository.js';
import { executeScmDependencyCommand, scmDependencyPayloadHash } from '../../../src/scm-dependency-command-service.js';
import { seedSplitAddress, heatherside, mossbrook } from '../support/split-address-fixture.js';

let fixture;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks(plate,active) VALUES ('DP-V2-TEST',true)");
});
after(async () => { await fixture?.close(); });

async function addOrders(f, orders) {
  const plan = await stored(f.id);
  plan.orders.push(...orders);
  plan.trucks[0].loads[0].stops.push(...orders.map(order => ({ id: `drop-${order.id}`, type: 'drop', orderId: order.id, orderRefs: [order.id] })));
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1', [f.id, JSON.stringify(plan.orders), JSON.stringify(plan.trucks)]);
  f.baseline = await stored(f.id);
}

async function autosave(f, id) {
  const draft = await stored(f.id);
  draft.trucks[0].startYard = '2967';
  const result = await f.save(draft, id);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const final = await stored(f.id);
  assert.equal(final.trucks[0].startYard, '2967');
  assert.equal(final.orders.some(order => f.obsolete.includes(order.id)), false);
  return final;
}

for (const action of ['group_orders', 'split_order']) {
  test(`MAINT-ACTION: ${action} and its following move autosave while order cleanup is pending`, async () => {
    const f = await seedMaintenanceIncident(fixture);
    const ref = f.refs[0];
    const other = `${ref}-SECOND`;
    if (action === 'group_orders') await addOrders(f, [dispatchOrder(other, 2)]);
    await f.cleanup();
    const payload = action === 'group_orders' ? { orderRefs: [ref, other] }
      : { sourceOrderRef: ref, parts: [{ refNumber: `${ref}-S1` }, { refNumber: `${ref}-S2` }] };
    const saved = await fixture.request(`/api/dispatch/v2/plans/${f.id}/commands`, { method: 'POST',
      headers: { 'x-dispatch-edit-lease': f.token }, body: { commandId: `${action}-${f.id}`, sessionId: f.sessionId,
        commandType: action, baseRevision: f.baseline.revision, baseDigest: f.baseline.digest, payload } });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    assert.equal((await stored(f.id)).revision, 64);
    const final = await autosave(f, `move-after-${action}`);
    if (action === 'group_orders') {
      const group = final.orders.find(order => order.id === saved.payload.patch.group.ref);
      assert.deepEqual([...group.childOrders].sort(), [ref, other].sort());
      assert.equal((await query('SELECT active FROM dispatch_global_order_groups WHERE group_ref=$1', [group.id])).rows[0].active, true);
    } else {
      const refs = saved.payload.patch.split.parts.map(part => part.refNumber).sort();
      assert.deepEqual(final.orders.filter(order => order.originalOrderId === ref).map(order => order.id).sort(), refs);
      assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_global_order_splits WHERE split_ref=ANY($1) AND active', [refs])).rows[0].n, 2);
    }
  });
}

test('MAINT-ACTION: real CO cargo and placement survive cleanup plus autosave', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const source = await seed();
  const co = await sourceCo(source);
  const order = (await listDispatchOrders({ type: 'CO', exactOrderRefs: [co.co_ref] })).find(entry => entry.id === co.co_ref);
  assert.ok(order, 'real local CO must be available to Dispatch');
  await addOrders(f, [order]);
  await f.cleanup();
  const final = await autosave(f, 'co-move');
  const savedCo = final.orders.find(entry => entry.id === co.co_ref);
  assert.ok(savedCo);
  assert.deepEqual(savedCo.items.map(item => [Number(item.itemId), Number(item.quantity)]), [[1356, 52.25], [1784, 7]]);
  assert.ok(final.trucks[0].loads[0].stops.some(stop => stop.orderId === co.co_ref));
});

for (const action of ['link_to', 'link_po']) {
  test(`MAINT-ACTION: ${action} remains live and survives pending cleanup and autosave`, async () => {
    const f = await seedMaintenanceIncident(fixture);
    const source = await seed();
    if (action === 'link_po') {
      await query("UPDATE sales_orders SET operator_status='open' WHERE netsuite_id=$1", [source.salesId]);
      await query('UPDATE sales_order_lines SET confirmed=false,confirmed_at=null,packed_sales_qty=0 WHERE sales_order_id=$1', [source.salesId]);
    }
    const sales = (await listDispatchOrders({ type: 'SO', exactOrderRefs: [source.salesRef] })).find(order => order.id === source.salesRef);
    assert.ok(sales);
    await addOrders(f, [sales]);
    await f.cleanup();
    let command;
    if (action === 'link_to') command = await transferCommand(source);
    else {
      const poId = source.transferId + 2;
      const poRef = `PO-LINK-${poId}`;
      await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
        dispatch_address,destination_location_id,destination_location,netsuite_active)
        VALUES($1,$2,'B','Pending Receipt','Link vendor','Vendor Yard','100 Vendor Road',26,'150',true)`, [poId, poRef]);
      const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,quantity,unit,netsuite_active)
        VALUES($1,1,1356,'TREVISTA','TREVISTA',52.25,'SQFT',true) RETURNING id`, [poId])).rows[0];
      const target = await resolveDispatchSalesTarget({ dispatchTargetRef: source.salesRef });
      command = { requestId: crypto.randomUUID(), action, targetRef: source.salesRef, targetSignature: target.signature,
        payload: { poRef, salesLineId: source.materialId, poLineId: poLine.id, quantities: { salesQty: 52.25 } } };
      command.payloadHash = scmDependencyPayloadHash(command);
    }
    command.planId = f.id;
    command.planDate = f.plan_date;
    command.expectedPlanRevision = 63;
    command.expectedPlanDigest = f.baseline.digest;
    command.payloadHash = scmDependencyPayloadHash(command);
    const result = await executeScmDependencyCommand(command, { id: fixture.operator.id, sessionId: f.sessionId,
      editLease: { planDate: f.plan_date, operatorId: fixture.operator.id, sessionId: f.sessionId, token: f.token } });
    assert.equal(result.status, 'applied');
    assert.equal(result.planRevision, 64, 'the explicit link command saves its plan and maintenance atomically');
    assert.equal((await stored(f.id)).revision, result.planRevision);
    const final = await autosave(f, `${action}-move`);
    const savedSales = final.orders.find(order => order.id === source.salesRef);
    assert.ok(savedSales);
    assert.match(JSON.stringify(savedSales), new RegExp(action === 'link_to' ? source.transferRef : command.payload.poRef));
  });
}

test('MAINT-ACTION: split address change survives source refresh and pending cleanup', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const address = await seedSplitAddress({ planDate: '2096-12-01' });
  await addOrders(f, address.splits);
  await f.cleanup();
  const updated = await fixture.request(`/api/dispatch/orders/${address.splits[1].id}/details?response=ack`, {
    method: 'PUT', headers: { 'x-dispatch-edit-lease': f.token }, body: {
      planId: f.id, planDate: f.plan_date, sessionId: f.sessionId, type: 'SO', sourceTable: 'sales_orders',
      address: heatherside, pickupAddress: '', windowStart: '', windowEnd: '', expectedDeliveryDate: '', audit: { sessionId: f.sessionId }
    }
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  const final = await autosave(f, 'address-change-save');
  assert.equal(final.orders.find(order => order.id === address.splits[1].id).destinationAddress, heatherside);
  assert.equal(final.orders.find(order => order.id === address.splits[0].id).destinationAddress, mossbrook);
});

test('MAINT-ACTION: PO address override and clearing preserve vendor pickup and autosave', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const ref = 'PO-MAINT-ADDRESS';
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
    dispatch_address,destination_location_id,destination_location,netsuite_active)
    VALUES(9989955,$1,'B','Pending Receipt','Address vendor','Vendor Yard','100 Vendor Road',1,'3445',true)`, [ref]);
  await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,quantity,unit,netsuite_active)
    VALUES(9989955,1,1784,'PALLET','PALLET',1,'EA',true)`);
  const order = (await listDispatchOrders({ type: 'PO', exactOrderRefs: [ref] })).find(entry => entry.id === ref);
  assert.ok(order);
  await addOrders(f, [order]);
  for (const address of ['777 Override Road, Toronto, ON', '']) {
    await f.cleanup();
    const edited = await fixture.request(`/api/dispatch/orders/${ref}/details?response=targeted`, { method: 'PUT',
      headers: { 'x-dispatch-edit-lease': f.token }, body: { planId: f.id, planDate: f.plan_date, sessionId: f.sessionId,
        type: 'PO', sourceTable: 'purchase_orders', address, pickupAddress: '', expectedDeliveryDate: '', windowStart: '', windowEnd: '', audit: { sessionId: f.sessionId } } });
    assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
    // Apply the targeted response just as the browser does before autosave.
    const draft = await stored(f.id);
    draft.orders = draft.orders.map(entry => entry.id === ref ? edited.payload.order : entry);
    draft.trucks[0].startYard = address ? '2967' : '3445';
    const saved = await f.save(draft, `override-${address || 'clear'}`);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    const persisted = (await query('SELECT dispatch_address,dispatch_delivery_address FROM purchase_orders WHERE netsuite_id=9989955')).rows[0];
    assert.equal(persisted.dispatch_address, '100 Vendor Road');
    assert.equal(persisted.dispatch_delivery_address || '', address);
    assert.equal((await stored(f.id)).orders.find(entry => entry.id === ref).deliveryAddressOverride || '', address);
  }
});
