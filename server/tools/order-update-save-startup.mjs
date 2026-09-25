import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createDispatchV2Fixture } from '../test/dispatch/support/dispatch-v2-fixture.js';
import { seedMaintenanceIncident, stored } from '../test/support/order-update-save-fixture.mjs';
import { enqueueDispatchPlanMaintenance } from '../src/dispatch-plan-maintenance-queue.js';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const fixture = await createDispatchV2Fixture();
let child;
let output = '';
try {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await enqueueDispatchPlanMaintenance(f.id, { kind: 'sales_family', canonicalRef: f.canonicalRef, refs: f.obsolete });
  child = spawn(process.execPath, ['tools/order-update-save-startup-child.mjs'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = performance.now() + 20000;
  while ((await stored(f.id)).revision === 63 && performance.now() < deadline && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const plan = await stored(f.id);
  assert.equal(plan.revision, 64, output);
  assert.equal(plan.orders.some(order => f.obsolete.includes(order.id)), false);
  assert.match(output, /MBBS Yard Server listening/);
  const report = { completedAt: new Date().toISOString(), actualServerStartupDrainedPersistedWork: true, revision: plan.revision };
  await writeFile('test-artifacts/order-update-save/startup.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (child && child.exitCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  await writeFile('test-artifacts/order-update-save/startup-server.log', output);
  await fixture.close();
}
