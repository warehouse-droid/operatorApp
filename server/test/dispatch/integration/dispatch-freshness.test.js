import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query } from '../../../src/db.js';
import { resplitUnfinishedSalesOrder } from '../../../src/dispatch-sales-resplit-repository.js';
import { getDispatchPlanRevision, saveDispatchPlanSnapshot } from '../../../src/dispatch-plan-repository.js';
import { assertDispatchPlanFence } from '../../../src/dispatch-planner-performance.js';
import { persistedDispatchPlan } from '../../../src/dispatch-plan-fence.js';
import { scenario } from '../support/fulfilled-so-fixture.js';
import { seedUnfinishedSplit } from '../support/unfinished-sales-resplit-fixture.js';

after(closeDb);
test('freshness: further split returns the persisted fence and permits the following save', () => scenario(async () => {
  const fixture = await seedUnfinishedSplit();
  const input = { orderRef: fixture.source.id, planId: fixture.current.id, planDate: fixture.current.planDate,
    expectedItems: fixture.source.items, parts: fixture.parts };
  const result = await resplitUnfinishedSalesOrder(input);
  const current = await getDispatchPlanRevision(fixture.current.id);
  assert.equal(typeof result.planDigest, 'string');
  assert.equal(result.planDigest, current.digest);
  assert.equal(result.planRevision, current.revision);
  const stored = persistedDispatchPlan((await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [fixture.current.id])).rows[0]);
  assertDispatchPlanFence(stored, { baseRevision: result.planRevision, baseDigest: result.planDigest }, { required: true });
  const saved = await saveDispatchPlanSnapshot(fixture.current.id, { planDate: fixture.current.planDate,
    orders: result.orders, trucks: [], summary: {}, baseRevision: result.planRevision });
  assert.equal(saved.id, fixture.current.id);
  const replay = await resplitUnfinishedSalesOrder(input);
  assert.equal(replay.planDigest, result.planDigest, 'idempotent replay retains its original acknowledgement');
  assert.equal((await query('SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1', [fixture.source.id])).rows[0].active, false);
}));
