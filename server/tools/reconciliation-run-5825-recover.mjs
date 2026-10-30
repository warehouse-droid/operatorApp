import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, closeDb } from '../src/db.js';
import { queueScmReconciliationRunResume, approveInitialScmReconciliationRun } from '../src/scm-reconciliation-repository.js';
import { writeAudit } from '../src/auth-repository.js';

const actor = 'maintenance:run-5825-recovery-20261022';
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
try {
  const run = (await query('SELECT * FROM scm_reconciliation_runs WHERE id=5825')).rows[0];
  assert.equal(run.scope_kind, 'SO');
  assert.equal(run.dry_run, false);
  assert.equal(Number(run.resume_of_run_id), 5819);
  const preserved = (await query('SELECT id,status,attempts,result,completed_at FROM scm_reconciliation_run_targets WHERE run_id=5825 AND id BETWEEN 34678 AND 34838 ORDER BY id')).rows;
  assert.equal(preserved.length, 161);
  assert.equal(digest(preserved), 'b03acfed9c30ec8be2d77460f9e801e7c6254a80fc1c50cdff2088da2695cabf');
  const preservedBeforeFix = (await query("SELECT id,status,attempts,result,completed_at FROM scm_reconciliation_run_targets WHERE run_id=5825 AND completed_at<'2026-10-22T02:39:01.811Z' ORDER BY id")).rows;
  assert.equal(preservedBeforeFix.length, 191);
  assert.equal(digest(preservedBeforeFix), 'd1ccf842e45d0096a5e73775f7ae0832b054da78a4822a01279c9940210b1ca5');
  const counts = (await query('SELECT status,count(*)::int AS count FROM scm_reconciliation_run_targets WHERE run_id=5825 GROUP BY status')).rows;
  assert.equal(counts.reduce((total, row) => total + row.count, 0), 1044);
  const phase = process.argv[2];
  let result;
  if (phase === 'resume') {
    assert.equal(run.status, 'interrupted');
    const terminal = (await query("SELECT id,status,attempts,result,completed_at FROM scm_reconciliation_run_targets WHERE run_id=5825 AND status IN ('succeeded','review','skipped') ORDER BY id")).rows;
    const resumed = await queueScmReconciliationRunResume(5825, actor);
    const unchanged = (await query('SELECT id,status,attempts,result,completed_at FROM scm_reconciliation_run_targets WHERE id=ANY($1::bigint[]) ORDER BY id', [terminal.map(row => row.id)])).rows;
    assert.deepEqual(unchanged, terminal);
    result = { runId: 5825, action: 'resume', status: resumed.status, resumeCount: resumed.checkpoint.resumeCount,
      completedTargetsPreserved: terminal.length, preservedDigest: digest(terminal), original161Preserved: true,
      queuedAt: new Date().toISOString() };
  } else {
    assert.equal(phase, 'finalize');
    assert.equal(run.status, 'succeeded');
    assert.equal(Number(run.summary.failedOrders), 0);
    assert.ok(counts.every(row => ['succeeded', 'review', 'skipped'].includes(row.status)));
    const settingsBefore = (await query('SELECT nightly_enabled FROM scm_reconciliation_settings WHERE singleton_id=1')).rows[0];
    const proposal = (await query('SELECT status FROM scm_reconciliation_runs WHERE id=5819')).rows[0];
    if (proposal.status === 'awaiting_approval') {
      await approveInitialScmReconciliationRun(5819, actor);
    }
    const settingsAfter = (await query('SELECT nightly_enabled FROM scm_reconciliation_settings WHERE singleton_id=1')).rows[0];
    assert.deepEqual(settingsAfter, settingsBefore);
    result = { runId: 5825, action: 'finalize', status: run.status, completedAt: run.completed_at,
      targetCounts: Object.fromEntries(counts.map(row => [row.status, row.count])), original161Preserved: true, original191Preserved: true,
      failedOrders: 0, reviewOrders: Number(run.summary.reviewOrders), proposalRunId: 5819,
      proposalFinalized: true, nightlyEnabled: settingsAfter.nightly_enabled, verifiedAt: new Date().toISOString() };
  }
  await writeAudit({ actorType: 'system', source: 'maintenance', action: `scm.reconciliation.run5825.${result.action}`, details: result });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
