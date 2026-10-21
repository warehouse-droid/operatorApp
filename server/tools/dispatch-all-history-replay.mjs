import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { query, withTransaction, closeDb } from '../src/db.js';
import { persistedDispatchPlan } from '../src/dispatch-plan-fence.js';
import { dispatchPlannedAssignmentMap } from '../src/dispatch-plan-repository.js';
import { applyDispatchV2Command, getDispatchV2Bootstrap, syncDispatchPlanOrderAssignments } from '../src/dispatch-planner-v2-repository.js';
import { historicalReplayFixtureReason, historicalReplayInScope, historicalReplayDraftReason } from './dispatch-all-history-fixture-classification.mjs';
import { hydrateHistoricalDispatchPlanOrders } from '../src/dispatch-historical-order-snapshots.js';

const root = process.env.DISPATCH_HISTORY_REPORT_DIRECTORY || 'test-artifacts/dispatch-all-history-20261002';
await mkdir(root,{recursive: true,mode: 0o700});
const pass = Number(process.argv[2] || 1);
const resume = process.argv.includes('--resume');
const reportPath = `${root}/pass-${pass}.json`;
const sourceFiles = ['src/dispatch-planner-v2-repository.js', 'src/dispatch-plan-repository.js',
  'src/dispatch-delivery-group-repository.js', 'src/order-dependency-repository.js',
  'src/scm-dependency-preview-service.js', 'src/dispatch-pickup-visits.js',
  'src/dispatch-history-mode.js','src/dispatch-load-assignment.js','public/dispatch.js',
  'src/dispatch-historical-order-snapshots.js',
  'src/driver-repository.js','src/dispatch-retained-link-manifests.js',
  'src/co-direct-to-cargo.js',
  'tools/dispatch-history-cargo-oracle.mjs','tools/dispatch-history-cargo-replay.mjs',
  'test/dispatch/unit/linked-stop-cargo.test.js','test/dispatch/integration/linked-driver-stop-content.test.js',
  'src/dispatch-planner-performance.js','src/dispatch-plan-fence.js',
  'tools/dispatch-all-history-fixture-classification.mjs','tools/dispatch-all-history-replay.mjs',
  'test/dispatch/integration/to-dependency-packing-independent.test.js',
  'test/dispatch/integration/co-direct-to.test.js',
  'test/dispatch/integration/dispatch-po-split-link-target.test.js',
  'tools/dispatch-history-cargo-focused.mjs',
  'test/dispatch/integration/retained-history-save.test.js',
  'test/dispatch/integration/historical-missing-order-snapshot.test.js',
  'test/dispatch/unit/historical-replay-fixture-classification.test.js',
  'test/dispatch/unit/historical-group-pickups.test.js',
  'test/dispatch/unit/executed-prefix-historical-reflexivity.test.js',
  'test/dispatch/property/historical-planning-safety.property.test.js',
  'test/mbt/integration/link-to-fix.test.js',
  'test/dispatch/integration/scm-to-untouched-lines.test.js',
  'test/dispatch/integration/scm-dependency-preview-blockers.red.test.js',
  'test/dispatch/integration/transfer-completed-unlink.test.js',
  'test/dispatch/integration/dispatch-required-pickups-save.test.js'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, crypto.createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = resume ? JSON.parse(await readFile(reportPath, 'utf8')) : {
  pass, startedAt: new Date().toISOString(), records: [], failures: [], sourceStages: [],
  limitations: ['Original command requests and complete historical authoritative source versions are not retained.',
    'Compact receipts without full plan states are counted as evidence gaps, never as replayed plans.',
    'Archived header status is taken from a retained receipt where available, otherwise the captured plan header.']
};
report.sourceStages.push({ at: new Date().toISOString(), resumeAt: report.records.length, hashes: await hashes() });
const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
function assignedCargo(plan) {
  const refs = new Set(dispatchPlannedAssignmentMap(plan).keys());
  const cards = new Map();
  const visit = order => {
    const key = String(order.id || '').toLowerCase();
    if (!cards.has(key)) { cards.set(key,order); }
    for (const child of order.childOrderDetails || []) { visit(child); }
  };
  for (const order of plan.orders || []) { visit(order); }
  return [...refs].sort().map(ref => {
    const order = cards.get(ref.toLowerCase());
    return [ref, order ? {
      pallets: Number(order.pallets || 0), layers: Number(order.layers || 0),
      sections: Number(order.sections || 0),pieces: Number(order.pieces || 0),salesQty: Number(order.salesQty || 0),
      salesQuantities: order.salesQuantities || [],
      items: (order.items || []).map(item => [String(item.itemId || item.item_id || item.sku || ''),
        ...['pallets', 'layers', 'sections', 'pieces', 'quantity'].map(field => Number(item[field] || 0))])
    } : null];
  });
}

try {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal((await query('SELECT current_database() AS name')).rows[0].name, 'mbt_test_history');
  const headers = new Map((await query('SELECT *,plan_date::text AS date_text FROM dispatch_plans')).rows.map(row => [String(row.id), row]));
  const cases = (await query(`SELECT * FROM (
    SELECT 'snapshot' AS stream, s.plan_id AS source_id,s.plan_id, s.saved_at AS event_at
      FROM dispatch_plan_snapshots s
    UNION ALL
    SELECT 'history',h.id,h.plan_id,h.archived_at FROM dispatch_plan_snapshot_history h
    UNION ALL
    SELECT 'command',c.id,c.plan_id,c.created_at FROM dispatch_plan_commands c
  ) states ORDER BY event_at,stream,source_id`)).rows;
  const fixturePlans = new Map((await query('SELECT plan_id,orders,summary FROM dispatch_plan_snapshots')).rows
    .map(state => [String(state.plan_id),historicalReplayFixtureReason(headers.get(String(state.plan_id)),state)])
    .filter(([,reason]) => reason));
  const recoveryDrafts = new Map((await query(`SELECT id,plan_id,archive_reason,checkpoint_kind,summary
    FROM dispatch_plan_snapshot_history`)).rows.filter(historicalReplayDraftReason)
    .map(state => [String(state.id),{reason: historicalReplayDraftReason(state),
      planId: String(state.plan_id),validationIssues: state.summary.saveRecovery.validationIssues || []}]));
  report.recoveryDraftControls = [...recoveryDrafts].map(([sourceId,state]) => ({sourceId,...state}));
  report.fixtureControls = [...fixturePlans].map(([planId,reason]) => ({planId,reason,
    planDate: headers.get(planId).date_text,note: headers.get(planId).note}));
  report.scope = {from: '2026-08-01',through: '2026-09-30',basis: 'plan_date',
    sourcePrecedence: 'Newest retained August/September evidence at or before the original save takes precedence over older July evidence.'};
  // Preserve exploratory results from before the user narrowed the scope.
  // Excluded states never count as business passes.
  for (const row of report.records) {
    row.planDate = headers.get(row.planId).date_text;
    if (fixturePlans.has(row.planId)) {
      if (row.result !== 'fixture_control') { row.exploratoryResult ||= row.result; }
      row.result = 'fixture_control'; row.reason = fixturePlans.get(row.planId);
    } else if (!fixturePlans.has(row.planId) && !historicalReplayInScope(headers.get(row.planId))) {
      if (row.result !== 'outside_scope') { row.exploratoryResult ||= row.result; }
      row.result = 'outside_scope'; row.reason = 'User requested August and September plan dates';
    } else if (row.stream === 'history' && recoveryDrafts.has(row.sourceId)) {
      if (row.result !== 'recovery_draft') { row.exploratoryResult ||= row.result; }
      row.result = 'recovery_draft'; row.reason = recoveryDrafts.get(row.sourceId).reason;
    }
  }
  for (const row of report.failures) {
    row.classification = fixturePlans.has(row.planId) ? 'fixture_control'
      : !historicalReplayInScope(headers.get(row.planId)) ? 'outside_scope'
        : row.stream === 'history' && recoveryDrafts.has(row.sourceId) ? 'recovery_draft' : 'operational_history';
  }
  report.inventory = {
    plans: headers.size, retainedStates: cases.length,
    scopedPlans: [...headers.values()].filter(historicalReplayInScope).length,
    scopedStates: cases.filter(entry => historicalReplayInScope(headers.get(String(entry.plan_id)))).length,
    acceptedScopedStates: cases.filter(entry => historicalReplayInScope(headers.get(String(entry.plan_id)))
      && !(entry.stream === 'history' && recoveryDrafts.has(String(entry.source_id)))).length,
    recoveryDraftStates: recoveryDrafts.size,
    scopedRecoveryDraftStates: cases.filter(entry => historicalReplayInScope(headers.get(String(entry.plan_id)))
      && entry.stream === 'history' && recoveryDrafts.has(String(entry.source_id))).length,
    fixturePlans: fixturePlans.size,fixtureStates: cases.filter(entry => fixturePlans.has(String(entry.plan_id))).length,
    operationalStates: cases.filter(entry => !fixturePlans.has(String(entry.plan_id))).length,
    streams: Object.fromEntries(['snapshot','history','command'].map(stream => [stream,cases.filter(entry => entry.stream === stream).length]))
  };
  await persist();
  for (let index = report.records.length; index < cases.length; index++) {
    const entry = cases[index];
    const table = { snapshot: 'dispatch_plan_snapshots', history: 'dispatch_plan_snapshot_history', command: 'dispatch_plan_commands' }[entry.stream];
    const column = entry.stream === 'snapshot' ? 'plan_id' : 'id';
    const source = (await query(`SELECT * FROM ${table} WHERE ${column}=$1`, [entry.source_id])).rows[0];
    const receipt = source.result?.plan;
    const header = headers.get(String(entry.plan_id));
    const row = { index, stream: entry.stream, sourceId: String(entry.source_id), planId: String(entry.plan_id), eventAt: entry.event_at,planDate: header.date_text };
    if (fixturePlans.has(row.planId)) {
      row.result = 'fixture_control'; row.reason = fixturePlans.get(row.planId);
      report.records.push(row);
      continue;
    }
    if (!historicalReplayInScope(header)) {
      row.result = 'outside_scope'; row.reason = 'User requested August and September plan dates';
      report.records.push(row);
      continue;
    }
    if (entry.stream === 'history' && recoveryDrafts.has(row.sourceId)) {
      row.result = 'recovery_draft'; row.reason = recoveryDrafts.get(row.sourceId).reason;
      report.records.push(row);
      continue;
    }
    if (entry.stream === 'command' && !receipt) {
      row.result = 'evidence_gap'; row.reason = 'Command receipt has no retained full plan';
      report.records.push(row);
      continue;
    }
    const orders = receipt?.orders || receipt?.assignedOrderSnapshots || source.orders || [];
    const trucks = receipt?.trucks || source.trucks || [];
    const summary = receipt?.summary || source.summary || {};
    const revision = Number(receipt?.revision ?? source.revision ?? header.revision);
    const started = performance.now();
    try {
      await withTransaction(async () => {
        await query('UPDATE dispatch_plans SET status=$2,note=$3,revision=$4 WHERE id=$1',
          [header.id,receipt?.status || header.status,receipt?.note ?? header.note,revision]);
        await query(`INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary,saved_at)
          VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5) ON CONFLICT(plan_id) DO UPDATE
          SET orders=EXCLUDED.orders,trucks=EXCLUDED.trucks,summary=EXCLUDED.summary,saved_at=EXCLUDED.saved_at`,
        [header.id,JSON.stringify(orders),JSON.stringify(trucks),JSON.stringify(summary),
          receipt?.savedAt || source.original_saved_at || source.saved_at || entry.event_at]);
        const raw = (await query(`SELECT p.*,p.plan_date::text,s.orders,s.trucks,s.summary,s.saved_at
          FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`,[header.id])).rows[0];
        const before = persistedDispatchPlan(raw);
        const hydrated = await hydrateHistoricalDispatchPlanOrders(before);
        row.reconstructedOrderSnapshots = hydrated.reconstructed;
        // A later receipt cannot already occupy the revision being replayed.
        // This removal is confined to the per-case rollback transaction.
        await query('DELETE FROM dispatch_plan_commands WHERE plan_id=$1 AND applied_revision>$2',[header.id,revision]);
        await syncDispatchPlanOrderAssignments(hydrated.plan);
        const command = { commandId: `all-history:${pass}:${index}`, commandType: 'replace_plan',
          baseRevision: before.revision,baseDigest: before.digest,compactReceipt: true,
          payload: { orders,trucks,summary } };
        const applied = await applyDispatchV2Command({ planId: header.id,command });
        assert.equal(applied.payload.plan.revision,before.revision+1);
        const saved = (await query('SELECT orders,trucks,summary FROM dispatch_plan_snapshots WHERE plan_id=$1',[header.id])).rows[0];
        assert.deepEqual(assignedCargo(saved),assignedCargo(hydrated.plan),'Historical assigned orders and cargo must survive the save');
        const reread = await getDispatchV2Bootstrap({ planId: header.id });
        assert.equal(reread.plan.digest,applied.payload.acknowledgement.digest);
        row.assignedOrders = dispatchPlannedAssignmentMap(before).size;
        row.result = 'saved_and_rolled_back';
      }, { rollback: true });
      row.ms = performance.now()-started;
      report.records.push(row);
      if (index % 25 === 0) {
        await persist();
        console.log(JSON.stringify({pass,processed:index+1,total:cases.length,assignedOrders:row.assignedOrders}));
      }
    } catch (error) {
      row.ms = performance.now()-started;
      row.result = 'failed'; row.code = error.code || error.name; row.message = error.message;
      row.classification = 'operational_history';
      row.conflicts = error.conflicts || error.details || null;
      row.stack = error.stack;
      report.failures.push(row); report.stoppedAt = index;
      await writeFile(`${root}/failure-${pass}-${index}.json`,JSON.stringify({case:row,header,orders,trucks,summary},null,2),{mode:0o600});
      await persist();
      console.error(JSON.stringify(row));
      process.exitCode = 1;
      break;
    }
  }
  if (report.records.length === cases.length) {
    report.finalHashes = await hashes();
    report.outcomes = report.records.reduce((counts,row) => ({...counts,[row.result]:(counts[row.result]||0)+1}),{});
    assert.equal(report.outcomes.evidence_gap || 0,0,'A complete replay cannot have missing plan evidence');
    if (pass === 2) {
      assert.deepEqual(report.finalHashes,report.sourceStages[0].hashes,'The final replay source must remain fixed');
    }
    const databaseUrl = new URL(process.env.DATABASE_URL);
    databaseUrl.pathname = '/mbt_test';
    const focused = spawnSync(process.execPath,['tools/dispatch-history-cargo-focused.mjs'],
    {env: {...process.env,MBT_ENABLED: 'true',DATABASE_URL: databaseUrl.toString()},encoding: 'utf8',timeout: 180000,maxBuffer: 8*1024*1024});
    report.focusedSuiteExit = focused.status;
    await writeFile(`${root}/pass-${pass}-focused.log`,focused.stdout+focused.stderr,{mode: 0o600});
    await persist();
    assert.equal(focused.status,0,'Every complete replay must also pass the focused packing and history safety tests');
    report.completedAt = new Date().toISOString();
    delete report.stoppedAt;
    await persist();
    console.log(JSON.stringify({pass,total:cases.length,outcomes:report.outcomes,
      failuresFixed: new Set(report.failures.filter(row => row.classification === 'operational_history').map(row => row.index)).size,
      focusedSuiteExit: report.focusedSuiteExit}));
  }
} finally { await closeDb(); }
