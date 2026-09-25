import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { query } from '../../../src/db.js';
import { createDispatchV2Fixture } from '../../dispatch/support/dispatch-v2-fixture.js';
import { seedLinkGroup } from '../../support/link-to-fix-fixture.mjs';
import { listDispatchOrders } from '../../../src/dispatch-repository.js';
import { syncDispatchDeliveryGroupsFromPlan } from '../../../src/dispatch-delivery-group-repository.js';
let http;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => { await http?.close(); });

test('G1 the authenticated group details API returns all children for targeted and acknowledgment saves', async () => {
  const f = await seedLinkGroup();
  const sessionId = `group-address-${f.groupRef}`;
  const token = await http.acquireLease({ planDate: f.plan.planDate, sessionId });
  for (const response of ['targeted', 'ack']) {
    const result = await http.request(`/api/dispatch/orders/${f.groupRef}/details?response=${response}`, {
      method: 'PUT', headers: { 'x-dispatch-edit-lease': token }, body: { planDate: f.plan.planDate,
        type: 'SO', address: `HTTP ${response} address`, pickupAddress: '', windowStart: '', windowEnd: '',
        expectedDeliveryDate: '', audit: { sessionId } } });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.deepEqual(result.payload.updated.child_order_refs.sort(), [...f.members].sort());
    assert.ok(result.payload.updated.order.childOrderDetails.every(child => child.address === `HTTP ${response} address`));
    if (response === 'targeted') { assert.equal(result.payload.order.id, f.groupRef); }
  }
  assert.ok((await query('SELECT dispatch_address FROM sales_orders WHERE tranid=ANY($1)', [f.members])).rows
    .every(row => row.dispatch_address === 'HTTP ack address'));
});

test('G3 Set Yard HTTP response refreshes grouped PO children and ordinary POs', async () => {
  const f = await seedLinkGroup();
  const refs = [1, 2].map(index => `PO-HTTP-${f.transferId}-${index}`);
  for (const [index, ref] of refs.entries()) {
    const id = f.transferId + 10 + index;
    await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
      dispatch_address,destination_location_id,destination_location,netsuite_active)
      VALUES($1,$2,'B','Pending Receipt','HTTP Vendor','Vendor Yard','Old Pickup',26,'150',true)`, [id, ref]);
    await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,quantity,unit,netsuite_active)
      VALUES($1,1,2340,'LINK-ITEM','LINK-ITEM',10,'EA',true)`, [id]);
  }
  const children = await listDispatchOrders({ type: 'PO', exactOrderRefs: refs });
  const group = { ...children[0], id: `GPO-HTTP-${f.transferId}`, childOrders: refs, childOrderDetails: children };
  await syncDispatchDeliveryGroupsFromPlan({ ...f.plan, orders: [group], trucks: [] });
  const yard = (await query("INSERT INTO dispatch_vendor_yards(vendor,yard,address,active) VALUES('HTTP Vendor','HTTP Yard','900 Yard Road',true) RETURNING id")).rows[0];
  const sessionId = `po-yard-${f.groupRef}`;
  const token = await http.acquireLease({ planDate: f.plan.planDate, sessionId });
  for (const ref of [group.id, refs[0]]) {
    const result = await http.request(`/api/dispatch/orders/${ref}/vendor-yard?response=targeted`, {
      method: 'PUT', headers: { 'x-dispatch-edit-lease': token }, body: { planDate: f.plan.planDate,
        vendorYardId: yard.id, audit: { sessionId } } });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.order.id, ref);
    if (ref === group.id) {
      assert.ok(result.payload.order.childOrderDetails.every(child => child.sourceAddress === '900 Yard Road'));
    }
  }
});
