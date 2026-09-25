import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const directory = 'test-artifacts/order-update-save';
if (process.argv[2] === 'baseline-read') {
  const { getDispatchPlan } = await import('../test-artifacts/order-update-save/baseline/src/dispatch-plan-repository.js');
  const { closeDb } = await import('../test-artifacts/order-update-save/baseline/src/db.js');
  try {
    const plan = await getDispatchPlan(process.argv[3]);
    assert.equal(plan.trucks[0].parkingSpot, 'ACKNOWLEDGED-BEFORE-ROLLBACK');
    assert.equal(plan.revision, 64);
  } finally { await closeDb(); }
} else {
  const { createDispatchV2Fixture } = await import('../test/dispatch/support/dispatch-v2-fixture.js');
  const { seedMaintenanceIncident, stored } = await import('../test/support/order-update-save-fixture.mjs');
  const { query } = await import('../src/db.js');
  const { enqueueDispatchPlanMaintenance } = await import('../src/dispatch-plan-maintenance-queue.js');
  const { processDispatchPlanMaintenance } = await import('../src/dispatch-plan-maintenance.js');
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const fixture = await createDispatchV2Fixture();
  try {
    const f = await seedMaintenanceIncident(fixture);
    await f.cleanup();
    const move = structuredClone(f.baseline);
    move.trucks[0].parkingSpot = 'ACKNOWLEDGED-BEFORE-ROLLBACK';
    const saved = await f.save(move, 'rollback-save');
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    await enqueueDispatchPlanMaintenance(f.id, { kind: 'co_identity' });
    const queued = (await query('SELECT * FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0];
    await query(await readFile('migrations/205_dispatch_plan_maintenance.sql', 'utf8'));
    assert.deepEqual((await query('SELECT * FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0], queued);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['tools/order-update-save-rollback.mjs', 'baseline-read', f.id], { env: process.env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Old runtime read failed: ${code}`)));
    });
    assert.deepEqual((await query('SELECT * FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0], queued);
    await query('DELETE FROM dispatch_plan_edit_leases WHERE plan_date=$1', [f.plan_date]);
    assert.equal((await processDispatchPlanMaintenance(f.id)).changed, false);
    assert.equal((await query('SELECT 1 FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rowCount, 0);
    assert.equal((await stored(f.id)).revision, 64);
    const report = { completedAt: new Date().toISOString(), oldRuntimeReadsAcknowledgedSave: true, migrationRerunPreservesQueue: true,
      rollbackRetainsQueue: true, forwardResumeDrainsOnce: true,
      limitation: 'Retain migration 205 during application rollback. The prior runtime does not provide the new lease-aware cleanup guarantee.' };
    await writeFile(`${directory}/rollback.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await fixture.close(); }
}
