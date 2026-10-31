import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { query } from '../../../src/db.js';
import { createDispatchV2Fixture } from '../../dispatch/support/dispatch-v2-fixture.js';
import { seedLinkGroup } from '../../support/link-to-fix-fixture.mjs';

let http;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => { await http?.close(); });

// Unlinking frees the TO for independent planning, so the targeted refresh
// must return the TO card as well as the Sales Order it was linked to.
test('unlinking a TO refreshes the TO card, not only the Sales Order', async () => {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  await query('DELETE FROM dispatch_global_order_groups WHERE group_ref=$1', [f.groupRef]);
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks='[]'::jsonb WHERE plan_id=$1",
    [f.plan.id, JSON.stringify(f.group.childOrderDetails)]);
  const sessionId = `unlink-refresh-${crypto.randomUUID()}`;
  const token = await http.acquireLease({ planDate: f.plan.planDate, sessionId });
  const target = f.members[0];
  const options = await http.request(`/api/dispatch/order-dependencies/options?${new URLSearchParams({
    dispatchTargetRef: target, planDate: f.plan.planDate, transferOrderRef: f.transferRef.toLowerCase()
  })}`);
  assert.equal(options.response.status, 200, JSON.stringify(options.payload));
  const linked = await http.request('/api/dispatch/order-dependencies?response=targeted', {
    method: 'POST', headers: { 'x-dispatch-edit-lease': token }, body: {
      dispatchTargetRef: target, planDate: f.plan.planDate, transferOrderRef: f.transferRef.toLowerCase(),
      mode: 'direct_to_customer', requestId: crypto.randomUUID(), targetSignature: options.payload.targetSignature,
      allocations: options.payload.matchingLines.map(line => ({ targetLineKey: line.targetLineKey, quantities: line.suggestedQuantities })),
      audit: { sessionId }
    }
  });
  assert.equal(linked.response.status, 201, JSON.stringify(linked.payload));
  const unlinked = await http.request(`/api/dispatch/order-dependencies/${linked.payload.dependency.id}?response=targeted`, {
    method: 'DELETE', headers: { 'x-dispatch-edit-lease': token },
    body: { orderRefs: [target], planDate: f.plan.planDate, audit: { sessionId } }
  });
  assert.equal(unlinked.response.status, 200, JSON.stringify(unlinked.payload));
  const refs = (unlinked.payload.orders || []).map(order => String(order.id).toLowerCase());
  assert.ok(refs.includes(target.toLowerCase()), `refreshed: ${refs.join(', ')}`);
  assert.ok(refs.includes(f.transferRef.toLowerCase()), `refreshed: ${refs.join(', ')}`);
  const transfer = unlinked.payload.orders.find(order => String(order.id).toLowerCase() === f.transferRef.toLowerCase());
  assert.notEqual(transfer.dependencyHidden, true);
});
