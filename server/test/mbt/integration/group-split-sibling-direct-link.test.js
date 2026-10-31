import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { assertNoActiveOrderDependenciesByRefs } from '../../../src/order-dependency-repository.js';
import { changedDispatchOrderStructureRefs } from '../../../src/server.js';

after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

// Grouping one split must not be blocked by a direct TO link on its sibling,
// which keeps its own target. A link on the parent itself still blocks.
const parent = 'SO-SIBLING-PARENT';
const split = id => ({ id, type: 'SO', originalOrderId: parent, items: [{ itemId: 1, quantity: 1 }] });
const other = { id: 'SO-SIBLING-OTHER', type: 'SO', items: [{ itemId: 2, quantity: 1 }] };
const before = { orders: [split(`${parent}-S1`), split(`${parent}-S2`), other] };
const after_ = { orders: [{ id: 'GSO-SIBLING', type: 'SO', childOrders: [`${parent}-S1`, other.id],
  childOrderDetails: [split(`${parent}-S1`), other] }, split(`${parent}-S2`)] };

async function directLink(targetRef, kind) {
  const id = 8_997_100_000 + Math.floor(Math.random() * 1_000_000);
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,customer,netsuite_active) VALUES($1,$2,'B','Sibling',true)
    ON CONFLICT DO NOTHING`, [id, parent]);
  await query("INSERT INTO transfer_orders(netsuite_id,tranid,netsuite_active) VALUES($1,$2,true)", [id + 1, `TO-SIBLING-${id}`]);
  await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,transfer_order_ref,
    source_location_id,source_location,accounting_destination_location_id,dependency_mode,status,dispatch_target_ref,dispatch_target_kind)
    VALUES($1,$2,$3,$4,1,'3445',26,'direct_to_customer','active',$5,$6)`, [id, parent, id + 1, `TO-SIBLING-${id}`, targetRef, kind]);
}

const guard = () => assertNoActiveOrderDependenciesByRefs(changedDispatchOrderStructureRefs(before, after_),
  'group, ungroup, split, or unsplit these orders');

test('grouping a split leaves its unchanged sibling out of the structure change', () => {
  const refs = changedDispatchOrderStructureRefs(before, after_);
  assert.ok(refs.includes(`${parent}-S1`) && refs.includes(other.id));
  assert.ok(!refs.includes(`${parent}-S2`));
});

test("a sibling split's direct TO link does not block grouping its sibling", () => isolated(async () => {
  await directLink(`${parent}-S2`, 'split');
  await guard();
}));

test("a direct TO link on the split's parent still blocks grouping", () => isolated(async () => {
  await directLink(parent, 'normal');
  await assert.rejects(guard(), { code: 'ORDER_DEPENDENCY_STRUCTURE_LOCK' });
}));
