import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

if (process.argv[2] === 'baseline-read') {
  const { getDispatchPlan } = await import('../test-artifacts/dispatch-save-reliability/baseline/src/dispatch-plan-repository.js');
  const { closeDb } = await import('../test-artifacts/dispatch-save-reliability/baseline/src/db.js');
  try {
    const plan = await getDispatchPlan(process.argv[3]);
    assert.equal(plan.summary.rollbackFixture.zero, 0);
    assert.equal(plan.summary.rollbackFixture.fraction, 0.125);
    assert.equal(plan.summary.rollbackFixture.note, 'acknowledged before rollback');
    assert.equal(plan.revision, Number(process.argv[4]));
    console.log(JSON.stringify({ priorSourceReadsAcknowledgedPlan: true, revision: plan.revision }));
  } finally { await closeDb(); }
} else {
  const { createDispatchV2Fixture } = await import('../test/dispatch/support/dispatch-v2-fixture.js');
  const { getDispatchPlan } = await import('../src/dispatch-plan-repository.js');
  const fixture = await createDispatchV2Fixture();
  try {
    const date = '2027-09-01', sessionId = 'save-rollback';
    const seeded = await fixture.seedPlan({ date, refs: [] });
    const token = await fixture.acquireLease({ planDate: date, sessionId });
    const before = await getDispatchPlan(seeded.id);
    const result = await fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
      method: 'POST', headers: { 'x-dispatch-edit-lease': token }, body: {
        commandId: 'save-rollback', commandType: 'replace_plan', sessionId,
        baseRevision: before.revision, baseDigest: before.digest,
        payload: { orders: [], trucks: [], summary: { rollbackFixture: { zero: 0, fraction: 0.125, note: 'acknowledged before rollback' } } }
      }
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    let output = '';
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['tools/dispatch-save-rollback.mjs', 'baseline-read', String(seeded.id), String(result.payload.plan.revision)],
        { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.on('data', data => { output += data; });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Prior source could not read the new snapshot (${code})`)));
    });
    const report = { ...JSON.parse(output), migrationsRequired: false, completedAt: new Date().toISOString() };
    await writeFile('test-artifacts/dispatch-save-reliability/rollback-compatibility.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await fixture.close(); }
}
