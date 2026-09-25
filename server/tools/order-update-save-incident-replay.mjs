// Private archived structure is optional input; this never connects to production.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { query, withTransaction } from '../src/db.js';
import { persistedDispatchPlan } from '../src/dispatch-plan-fence.js';
import { assertDispatchPlanFence } from '../src/dispatch-planner-performance.js';
import { reconcileSalesOrderFamilyInDispatchPlans } from '../src/dispatch-plan-repository.js';
import { applyPendingDispatchPlanMaintenance } from '../src/dispatch-plan-maintenance.js';
import { createDispatchV2Fixture } from '../test/dispatch/support/dispatch-v2-fixture.js';
import { stored } from '../test/support/order-update-save-fixture.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const directory = 'test-artifacts/order-update-save';
const raw = await readFile(`${directory}/private-incident.json`);
const capture = JSON.parse(raw);
const [before, after] = capture.snapshots;
assert.equal(before.id, '17722');
assert.equal(after.id, '17723');
assert.deepEqual(before.trucks, after.trucks);
const removed = before.orders.filter(order => !after.orders.some(next => next.id === order.id)).map(order => order.id).sort();
assert.deepEqual(removed, ['SOA07539-S2', 'SOA07539-S3']);
const historical = persistedDispatchPlan({ ...before, id: before.plan_id, status: capture.command.status, note: capture.command.note });
assert.equal(historical.digest, capture.failure.digest);
assert.equal(historical.revision, Number(capture.failure.revision));
const fixture = await createDispatchV2Fixture();
try {
  const seed = await fixture.seedPlan({ date: before.plan_date, refs: [] });
  await query('UPDATE dispatch_plans SET revision=63,status=$2,note=$3 WHERE id=$1', [seed.id, historical.status, historical.note]);
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb,summary=$4::jsonb WHERE plan_id=$1',
    [seed.id, JSON.stringify(before.orders), JSON.stringify(before.trucks), JSON.stringify(before.summary)]);
  for (const [index, ref] of ['SOA07539', ...removed].entries()) {
    const sourceId = index ? -9997100 - index : 9997100;
    await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES($1,$2,'G','Billed',false)", [sourceId, ref]);
    if (index) await query(`INSERT INTO dispatch_scm_so_splits(source_so_id,source_so_ref,split_so_id,split_so_ref)
      VALUES(9997100,'SOA07539',$1,$2)`, [sourceId, ref]);
  }
  await fixture.acquireLease({ planDate: before.plan_date, sessionId: 'archived-maintenance' });
  const baseline = await stored(seed.id);
  await reconcileSalesOrderFamilyInDispatchPlans({ canonicalRef: 'SOA07539', familyRefs: removed, billed: true });
  assert.deepEqual(await stored(seed.id), baseline, 'cleanup cannot invalidate the archived draft fence');
  await withTransaction(async () => {
    const current = await stored(seed.id);
    assertDispatchPlanFence(current, { baseRevision: baseline.revision, baseDigest: baseline.digest }, { required: true });
    const move = structuredClone(current);
    move.trucks[0].parkingSpot = 'ARCHIVED-REPLAY-MOVE';
    const final = await applyPendingDispatchPlanMaintenance(move);
    assert.deepEqual(final.orders, after.orders);
    assert.deepEqual(final.trucks, move.trucks);
    // Cleanup audit metadata is recalculated from today's reconstructed source
    // family, whose historical eligibility and timestamp were not retained.
    const { billedSalesOrderCleanup, ...summary } = final.summary;
    const { billedSalesOrderCleanup: archivedCleanup, ...archivedSummary } = after.summary;
    assert.deepEqual(summary, archivedSummary);
    assert.equal(billedSalesOrderCleanup.canonicalRef, archivedCleanup.canonicalRef);
    assert.deepEqual(billedSalesOrderCleanup.removedOrderRefs, ['SOA07539', ...removed]);
    assert.ok(Number.isFinite(Date.parse(billedSalesOrderCleanup.cleanedAt)));
  }, { rollback: true });
  const report = { completedAt: new Date().toISOString(), captureSha256: createHash('sha256').update(raw).digest('hex'),
    historyIds: [before.id, after.id], ordersBefore: before.orders.length, ordersAfter: after.orders.length,
    trucksPreserved: before.trucks.length, originalFenceMatched: true, deferredCleanupAndMovement: true,
    scope: 'Actual archived plan structure and save fence; source eligibility reconstructed. Full original request/source history is unavailable; real HTTP save coverage uses the minimized incident fixture.' };
  await writeFile(`${directory}/incident-replay.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await fixture.close(); }
