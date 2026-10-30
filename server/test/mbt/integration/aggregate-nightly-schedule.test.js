import assert from 'node:assert/strict';
import test, { after, beforeEach, afterEach } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { claimAggregateNightlyRun } from '../../../src/aggregate-reconciliation-repository.js';
import { getScmReconciliationSettings, updateScmReconciliationSettings, finishScmReconciliationRun, createScmReconciliationRun } from '../../../src/scm-reconciliation-repository.js';
import { executeScmReconciliationRun } from '../../../src/scm-reconciliation-service.js';
import { aggregateReconciliationNightlyTick } from '../../../src/aggregate-reconciliation-service.js';
after(closeDb);
const now = new Date('2026-10-23T02:00:00Z');
let settingsBefore;
beforeEach(async () => { settingsBefore = (await query('SELECT * FROM scm_reconciliation_settings')).rows[0]; });
afterEach(async () => {
  await query("DELETE FROM scm_reconciliation_runs WHERE requested_by='nightly-aggregate' AND scheduled_local_date IN ('2026-10-22','2026-10-23')");
  await query("DELETE FROM scm_reconciliation_runs WHERE requested_by='aggregate-test-blocker'");
  await query(`UPDATE scm_reconciliation_settings SET nightly_enabled=$1,nightly_time=$2,
    aggregate_nightly_enabled=$3,aggregate_nightly_time=$4,so_initial_dry_run_approved_at=$5,
    so_initial_dry_run_approved_by=$6,last_nightly_local_date=$7`, [settingsBefore.nightly_enabled,
    settingsBefore.nightly_time,settingsBefore.aggregate_nightly_enabled,settingsBefore.aggregate_nightly_time,
    settingsBefore.so_initial_dry_run_approved_at,settingsBefore.so_initial_dry_run_approved_by,settingsBefore.last_nightly_local_date]);
});

test('S1/S2/S3 durable nightly claim survives concurrency and restart without consuming the broad nightly date', async () => {
  assert.equal((await aggregateReconciliationNightlyTick({ now, operationalSyncRunning: () => true })).reason, 'operational_sync_running');
  assert.equal((await aggregateReconciliationNightlyTick({ now })).reason, 'disabled');
  assert.equal((await claimAggregateNightlyRun({ now })).reason, 'disabled');
  await updateScmReconciliationSettings({ aggregateNightlyEnabled: true, aggregateNightlyTime: '21:30' }, 'test');
  assert.equal((await claimAggregateNightlyRun({ now })).reason, 'initial_so_not_approved');
  await query("UPDATE scm_reconciliation_settings SET so_initial_dry_run_approved_at=now(),so_initial_dry_run_approved_by='test',last_nightly_local_date=NULL");
  assert.equal((await claimAggregateNightlyRun({ now: new Date('2026-10-23T01:00:00Z') })).reason, 'before_scheduled_time');
  const blocker = await createScmReconciliationRun({ scope: 'SO', requestedBy: 'aggregate-test-blocker' });
  assert.equal((await claimAggregateNightlyRun({ now })).reason, 'reconciliation_active');
  await finishScmReconciliationRun(blocker.id, { status: 'succeeded' });
  const attempts = await Promise.all(Array.from({ length: 8 }, () => claimAggregateNightlyRun({ now })));
  assert.equal(attempts.filter(result => result.started).length, 1);
  const run = attempts.find(result => result.started).run;
  assert.equal(run.scope, 'SO'); assert.equal(run.soOrderType, 'all');
  assert.equal(run.sourceFilter, 'pending_fulfillment_aggregate'); assert.equal(run.scheduledLocalDate, '2026-10-22');
  assert.equal(run.dryRun, false); assert.equal(run.applyUnambiguous, true);
  const executed = await executeScmReconciliationRun(run.id, { operationalSyncRunning: () => false });
  assert.equal(executed.status, 'succeeded');
  assert.equal(executed.apiRequestCount, 0, 'An empty scoped selection must never discover unrelated orders remotely');
  assert.equal((await getScmReconciliationSettings()).lastNightlyLocalDate, null);
  assert.equal((await claimAggregateNightlyRun({ now })).reason, 'already_attempted');
  await assert.rejects(createScmReconciliationRun({ triggerSource: 'nightly', scope: 'SO', soOrderType: 'all', sourceFilter: run.sourceFilter, scheduledLocalDate: run.scheduledLocalDate }), error => error.status === 409);
  await query("UPDATE scm_reconciliation_runs SET status='interrupted' WHERE id=$1", [run.id]);
  assert.equal((await claimAggregateNightlyRun({ now })).reason, 'already_attempted');
  const nextNight = await aggregateReconciliationNightlyTick({ now: new Date('2026-10-24T02:00:00Z') });
  assert.equal(nextNight.started, true); assert.equal(nextNight.run.status, 'succeeded');
  assert.equal(nextNight.run.scheduledLocalDate, '2026-10-23');
  await updateScmReconciliationSettings({ aggregateNightlyEnabled: false }, 'test');
});

test('U2 settings reject invalid input and parallel independent patches preserve both changes', async () => {
  for (const aggregateNightlyTime of ['24:00', '2:30', '21:60', '21:30;drop table']) {
    await assert.rejects(updateScmReconciliationSettings({ aggregateNightlyTime }), { status: 400 });
  }
  await assert.rejects(updateScmReconciliationSettings({ aggregateNightlyEnabled: 'yes' }), { status: 400 });
  await Promise.all([updateScmReconciliationSettings({ aggregateNightlyTime: '22:45' }), updateScmReconciliationSettings({ nightlyTime: '23:15' })]);
  const settings = await getScmReconciliationSettings();
  assert.equal(settings.aggregateNightlyTime, '22:45'); assert.equal(settings.nightlyTime, '23:15');
  assert.equal(settings.nightlyEnabled, false);
});
