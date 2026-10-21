import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { syncDispatchDeliveryGroupsFromPlan } from '../../../src/dispatch-delivery-group-repository.js';
import { syncDispatchPlanOrderAssignments, listDispatchPlanOrderAssignmentsProjection } from '../../../src/dispatch-planner-v2-repository.js';
import { scenario } from '../support/fulfilled-so-fixture.js';
import { seedUnfinishedSplit, seedResplitPoLink } from '../support/unfinished-sales-resplit-fixture.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';

let http;
after(async () => http ? http.close() : closeDb());
test('a group from existing splits saves with sibling PO allocations and never creates a split for the group', () => scenario(async () => {
  const f = await seedUnfinishedSplit();
  await seedResplitPoLink(f, f.first.id);
  await query(`UPDATE dispatch_so_po_allocations SET sales_order_ref=$1,dispatch_target_ref=$2,dispatch_target_kind='group'
    WHERE po_order_ref=$3`, [f.parent, f.group.id, `PO-${f.parent}`]);
  const before = await f.history();
  const allocations = () => query('SELECT to_jsonb(a) value FROM dispatch_so_po_allocations a WHERE po_order_ref=$1', [`PO-${f.parent}`]).then(r => r.rows);
  const oldLinks = await allocations();
  const group = { ...structuredClone(f.source), id: `GO-NEW-${f.id}`, childOrders: [f.source.id],
    childOrderDetails: [structuredClone(f.source)], globalOrderDefinitionKind: 'split', isSplit: true };
  await syncDispatchDeliveryGroupsFromPlan({ ...f.current, orders: [group], trucks: [] });
  assert.equal((await query('SELECT 1 FROM dispatch_global_order_splits WHERE split_ref=$1', [group.id])).rowCount, 0);
  const saved = (await query('SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1 AND active', [group.id])).rows[0]?.full_order;
  assert.ok(saved);
  assert.ok(!saved.originalOrderId);
  assert.notEqual(saved.globalOrderDefinitionKind, 'split');
  assert.deepEqual(saved.items, f.source.items);
  assert.deepEqual(saved.childOrderDetails[0].items, f.source.items);
  assert.deepEqual(await allocations(), oldLinks);
  assert.deepEqual(await f.history(), before);
}));

test('lightweight assignment projection preserves all ownership fields but omits cargo snapshots', () => scenario(async () => {
  const f = await seedUnfinishedSplit();
  const plan = { ...f.current, orders: [f.source], trucks: [{ id: 'T', plate: 'TRUCK', loads: [{ id: 'L', name: 'Load 1',
    stops: [{ id: 'D', type: 'drop', orderId: f.source.id }] }] }] };
  await syncDispatchPlanOrderAssignments(plan);
  const options = { orderRefs: [f.source.id] };
  const full = await listDispatchPlanOrderAssignmentsProjection(options);
  const light = await listDispatchPlanOrderAssignmentsProjection({ ...options, includeSnapshots: false });
  assert.ok(full.some(row => row.assignment.plannedOrderSnapshot));
  assert.deepEqual(light, full.map(row => {
    const assignment = { ...row.assignment }; delete assignment.plannedOrderSnapshot;
    return { ...row, assignment };
  }));
  assert.ok(JSON.stringify(light).length < JSON.stringify(full).length);
}));

test('HTTP lightweight assignment refresh remains compatible with the full endpoint', async () => {
  http = await createDispatchV2Fixture();
  const f = await seedUnfinishedSplit({ date: '2097-10-27' });
  await syncDispatchPlanOrderAssignments({ ...f.current, orders: [f.source],
    trucks: [{ id: 'HTTP-T', plate: 'TRUCK', loads: [{ id: 'HTTP-L', name: 'Load 1',
      stops: [{ id: 'HTTP-D', type: 'drop', orderId: f.source.id }] }] }] });
  const full = await http.request('/api/dispatch/planned-assignments');
  const light = await http.request('/api/dispatch/planned-assignments?includeSnapshots=false');
  assert.equal(full.response.status, 200);
  assert.equal(light.response.status, 200);
  assert.ok(full.payload.some(row => row.orderRef === f.source.id));
  assert.ok(full.payload.some(row => row.plannedOrderSnapshot));
  assert.deepEqual(light.payload, full.payload.map(row => {
    const copy = { ...row }; delete copy.plannedOrderSnapshot; return copy;
  }));
});
