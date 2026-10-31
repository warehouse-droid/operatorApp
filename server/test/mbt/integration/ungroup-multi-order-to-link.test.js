import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import {
  assertNoActiveOrderDependenciesByRefs,
  createOrderDependency,
  getOrderDependencyOptions,
  syncOrderDependenciesFromDispatchPlan
} from '../../../src/order-dependency-repository.js';
import { seedLinkGroup } from '../../support/link-to-fix-fixture.mjs';

after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

// One TO can carry only one active link. A link made on a group may cover
// several of its orders; ungrouping cannot hand it to one of them without
// leaving the others waiting for nothing.
async function seedGroupLink({ allMembers }) {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  const options = await getOrderDependencyOptions({ dispatchTargetRef: f.groupRef, transferOrderRef: f.transferRef,
    planDate: f.plan.planDate });
  const lines = allMembers ? options.matchingLines : options.matchingLines.slice(0, 1);
  f.dependency = await createOrderDependency({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate,
    transferOrderRef: f.transferRef, mode: 'yard_replenishment', targetSignature: options.targetSignature,
    allocations: lines.map(line => ({ targetLineKey: line.targetLineKey, quantities: line.suggestedQuantities })) });
  f.ungroupTargets = f.members.map(member => ({ sourceOrderRef: member, groupRef: f.groupRef }));
  f.ungroupedPlan = { id: f.plan.id, planDate: f.plan.planDate, trucks: [],
    orders: f.group.childOrderDetails.map(child => ({ ...child, address: 'Customer address' })) };
  return f;
}

const target = id => query('SELECT dispatch_target_ref, dispatch_target_kind FROM order_dependencies WHERE id=$1', [id])
  .then(result => result.rows[0]);

test('ungroup is refused while one TO link covers several of its orders', () => isolated(async () => {
  const f = await seedGroupLink({ allMembers: true });
  await assert.rejects(assertNoActiveOrderDependenciesByRefs([f.groupRef, ...f.members], 'ungroup these orders',
    { allowEstablishedUngroupTargets: f.ungroupTargets }), new RegExp(`${f.transferRef}[\\s\\S]*${f.members[1]}`, 'u'));
}));

test('a multi-order group link is never handed to only one of its orders', () => isolated(async () => {
  const f = await seedGroupLink({ allMembers: true });
  await syncOrderDependenciesFromDispatchPlan(f.ungroupedPlan, { allowEstablishedUngroupTargets: f.ungroupTargets });
  assert.deepEqual(await target(f.dependency.id), { dispatch_target_ref: f.groupRef, dispatch_target_kind: 'group' });
}));

test('a group link covering one order still returns to that order on ungroup', () => isolated(async () => {
  const f = await seedGroupLink({ allMembers: false });
  await assertNoActiveOrderDependenciesByRefs([f.groupRef, ...f.members], 'ungroup these orders',
    { allowEstablishedUngroupTargets: f.ungroupTargets });
  await syncOrderDependenciesFromDispatchPlan(f.ungroupedPlan, { allowEstablishedUngroupTargets: f.ungroupTargets });
  assert.deepEqual(await target(f.dependency.id), { dispatch_target_ref: f.members[0], dispatch_target_kind: 'normal' });
}));
