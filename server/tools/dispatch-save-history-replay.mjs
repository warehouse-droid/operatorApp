// Requires the private capture; never falls back to a live database.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { simulateDispatchSourceEvent } from '../test/support/dispatch-save-source-events.mjs';
import { query, withTransaction, closeDb } from '../src/db.js';
import { persistedDispatchPlan } from '../src/dispatch-plan-fence.js';
import { applyDispatchV2Command, getDispatchV2Bootstrap, syncDispatchPlanOrderAssignments, backfillDispatchPlanProjections } from '../src/dispatch-planner-v2-repository.js';

const directory = path.resolve(process.argv[2] || 'test-artifacts/dispatch-save-reliability/private-history');
const reportFile = path.join(directory, path.basename(process.argv[3] || 'replay-report.json'));
const simulateSources = process.argv.includes('--source-events');
const useStagedInput = process.argv.includes('--staged');
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
const support = await readFile(path.join(directory, 'support/manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
const report = { startedAt: new Date().toISOString(), captureCompletedAt: manifest.completedAt,
  sourceEventSimulation: simulateSources, sourceEvents: 0, sourceRefreshesObserved: 0, tables: {}, records: [], maxUpdateMs: 0, updatesOver500ms: [], unexpected: [],
  gaps: ['Original command requests and historical authoritative source versions are not fully retained.',
    'Command results contain slim order snapshots; missing raw/SCM fields are not invented.',
    'Historical snapshot status/note are reconstructed from retained receipts when present, otherwise current headers.',
    'Source/audit rows are verified losslessly but partial events without executable requests remain evidence gaps.'] };
const runtimeFiles = ['src/dispatch-plan-fence.js', 'src/dispatch-plan-write.js', 'src/dispatch-plan-lease-repository.js',
  'src/dispatch-plan-repository.js', 'src/dispatch-planner-performance.js', 'src/dispatch-planner-v2-repository.js',
  'src/server.js', 'src/scm-dependency-preview-service.js', 'src/scm-dependency-command-service.js', 'src/scm-dependency-plan-reconciler.js', 'src/dispatch-delivery-group-repository.js',
  'public/dispatch.js', 'public/dispatch-save-journal.js', 'public/dispatch-snapshot.js', 'public/dispatch.css'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(runtimeFiles.map(async file =>
  [file, crypto.createHash('sha256').update(await readFile(file)).digest('hex')])));
report.sources = await sourceHashes();
if (process.env.MBT_TEST_ISOLATED !== '1' || !(await query('SELECT current_database() AS name')).rows[0].name.startsWith('mbt_test')) {
  throw new Error('History replay only runs in an isolated mbt_test database.');
}
await query('CREATE TABLE dispatch_save_replay_raw (stream text, ordinal int, record jsonb NOT NULL, PRIMARY KEY (stream, ordinal))');

async function* lines(table, root = directory) {
  const input = createReadStream(path.join(root, `${table}.jsonl.gz`)).pipe(createGunzip());
  for await (const line of createInterface({ input, crlfDelay: Infinity })) if (line) yield line;
}

try {
  // Exact database round trips use the original JSON text, so JS number parsing
  // cannot erase precision, null-vs-missing values, or nested causal evidence.
  const streams = [...Object.entries(manifest.tables).map(([table, expected]) => [table, expected, directory]),
    ...Object.entries(support?.tables || {}).map(([table, expected]) => [table, expected, path.join(directory, 'support')])];
  if (useStagedInput) {
    const cache = JSON.parse(await readFile(path.join(directory, 'staged-input.json'), 'utf8'));
    for (const [file, expected] of Object.entries(cache.manifests)) {
      assert.equal(crypto.createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex'), expected);
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(path.join(directory, 'staged-input.dump'))) hash.update(chunk);
    assert.equal(hash.digest('hex'), cache.dumpSha256, 'Verified staging cache changed');
    await writeFile(`${reportFile}.ready`, os.hostname(), { mode: 0o600 });
    const deadline = Date.now() + 300000;
    while (!await readFile(`${reportFile}.loaded`).then(() => true).catch(() => false)) {
      assert.ok(Date.now() < deadline, 'Staging cache restore did not complete');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const checked = await query(`SELECT stream,count(*)::int AS records,
      bool_and(record = record::text::jsonb) AS equal FROM dispatch_save_replay_raw GROUP BY stream`);
    for (const [table, expected] of streams) {
      const row = checked.rows.find(row => row.stream === table);
      assert.equal(row?.records, expected.rows, `${table} cached records`);
      assert.equal(row?.equal, true, `${table} exact cached JSON round trip`);
      report.tables[table] = { records: row.records, exactStoredRoundTrips: row.records };
    }
    report.stagingCache = { sha256: cache.dumpSha256, originalCapture: report.captureCompletedAt };
    console.log(JSON.stringify({ verifiedStagingCache: checked.rows.length }));
  }
  for (const [table, expected, root] of streams) {
    if (useStagedInput) continue;
    let rows = 0;
    let batch = [], bytes = 0;
    const hash = crypto.createHash('sha256');
    const flush = async () => {
      if (!batch.length) return;
      const result = await query(`WITH restored AS (
        INSERT INTO dispatch_save_replay_raw SELECT $1, $2::int + ordinal::int, record
          FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS input(record,ordinal)
          RETURNING record)
        SELECT count(*)::int AS records, bool_and(record = record::text::jsonb) AS equal FROM restored`,
      [table, rows - batch.length, `[${batch.join(',')}]`]);
      assert.equal(result.rows[0].records, batch.length);
      assert.equal(result.rows[0].equal, true, `${table} exact round trip`);
      batch = []; bytes = 0;
    };
    for await (const raw of lines(table, root)) {
      hash.update(`${raw}\n`);
      rows++;
      batch.push(raw); bytes += Buffer.byteLength(raw);
      if (batch.length >= 64 || bytes >= 4 * 1024 * 1024) await flush();
    }
    await flush();
    assert.equal(rows, expected.rows, `${table} missing records`);
    assert.equal(hash.digest('hex'), expected.uncompressedSha256, `${table} checksum`);
    report.tables[table] = { records: rows, exactStoredRoundTrips: rows };
    console.log(JSON.stringify({ stream: table, verified: rows }));
  }
  // Restore the retained rows verbatim. Missing historical business entities
  // remain explicit context gaps, rather than fabricated FK placeholder rows.
  // This setting is transaction-local in the already verified disposable DB;
  // normal constraints/triggers are enabled for every replayed write below.
  await withTransaction(async () => {
    await query("SET LOCAL session_replication_role='replica'");
    for (const table of [...Object.keys(support?.tables || {}), 'dispatch_plans', 'dispatch_plan_snapshots', 'dispatch_global_order_groups', 'dispatch_global_order_group_members', 'dispatch_global_order_splits', 'dispatch_custom_orders']) {
      await query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table}, record)).* FROM dispatch_save_replay_raw WHERE stream=$1 ON CONFLICT DO NOTHING`, [table]);
    }
  });
  report.support = support ? { capturedAt: support.database.captured_at, tables: support.tables, missing: support.missing } : null;
  report.gaps.push('Supporting order/CO/SCM records describe the later capture time, not the historical command time. Absent parent entities are not synthesized.');
  await query('ANALYZE');
  // Build the same indexes a running installation already has. Otherwise each
  // rollback case would rebuild all 114 plans as an unrelated cold-start repair.
  const preparationStarted = performance.now();
  report.projectionPreparation = await backfillDispatchPlanProjections();
  report.projectionPreparationMs = performance.now() - preparationStarted;
  console.log(JSON.stringify({ preparation: report.projectionPreparation, milliseconds: report.projectionPreparationMs }));
  const headers = new Map((await query('SELECT * FROM dispatch_plans')).rows.map(row => [String(row.id), row]));
  const states = await query(`SELECT stream, ordinal, record->>'id' AS source_id, COALESCE(record->>'plan_id', record->'result'->'plan'->>'id') AS plan_id
    FROM dispatch_save_replay_raw WHERE stream=ANY($1::text[]) ORDER BY stream,ordinal`,
  [['dispatch_plan_snapshots', 'dispatch_plan_snapshot_history', 'dispatch_plan_commands']]);
  for (const entry of states.rows) {
    if (report.records.length % 10 === 0) console.log(JSON.stringify({ replaying: report.records.length, stream: entry.stream, ordinal: entry.ordinal }));
    const source = (await query('SELECT record FROM dispatch_save_replay_raw WHERE stream=$1 AND ordinal=$2', [entry.stream, entry.ordinal])).rows[0].record;
    const header = headers.get(String(source.plan_id));
    const receiptPlan = source.result?.plan;
    const description = { stream: entry.stream, id: String(source.id || source.plan_id),
      classification: receiptPlan ? 'reconstructed_from_slim_receipt' : entry.stream === 'dispatch_plan_snapshots' ? 'exact_current_snapshot' : 'exact_snapshot_reconstructed_header' };
    if (!header || (entry.stream === 'dispatch_plan_commands' && !receiptPlan)) {
      report.records.push({ ...description, classification: 'gap', reason: 'No full plan state retained' });
      continue;
    }
    const orders = receiptPlan ? receiptPlan.orders || receiptPlan.assignedOrderSnapshots || [] : source.orders || [];
    const trucks = receiptPlan ? receiptPlan.trucks || [] : source.trucks || [];
    const summary = receiptPlan ? receiptPlan.summary || {} : source.summary || {};
    const revision = Number(receiptPlan?.revision ?? source.revision ?? header.revision);
    await withTransaction(async () => {
      await query('UPDATE dispatch_plans SET status=$2,note=$3,revision=$4 WHERE id=$1', [header.id, receiptPlan?.status || header.status, receiptPlan?.note ?? header.note, revision]);
      await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb,summary=$4::jsonb WHERE plan_id=$1', [header.id, JSON.stringify(orders), JSON.stringify(trucks), JSON.stringify(summary)]);
      const row = (await query('SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1', [header.id])).rows[0];
      const before = persistedDispatchPlan(row);
      await syncDispatchPlanOrderAssignments(before);
      if (simulateSources) {
        // Load the old fence first, then let a source refresh change the read
        // overlay before the original browser request reaches the write path.
        const loaded = await getDispatchV2Bootstrap({ planId: header.id });
        assert.equal(loaded.plan.digest, before.digest);
        description.sourceEvent = await simulateDispatchSourceEvent(before, `${entry.stream}-${entry.ordinal}`);
        if (description.sourceEvent.simulated) {
          report.sourceEvents++;
          const refreshed = await getDispatchV2Bootstrap({ planId: header.id });
          assert.equal(refreshed.plan.digest, loaded.plan.digest, 'a source event cannot change the persisted fence');
          assert.equal(refreshed.plan.revision, loaded.plan.revision);
          const visible = JSON.stringify(refreshed.plan.assignedOrderSnapshots || []).includes(description.sourceEvent.marker);
          description.sourceEvent.observedInRefresh = visible;
          if (visible) report.sourceRefreshesObserved++;
        }
      }
      const started = performance.now();
      try {
        const applied = await applyDispatchV2Command({ planId: header.id, command: {
          commandId: `retained-replay:${entry.stream}:${entry.ordinal}`, commandType: 'replace_plan',
          baseRevision: before.revision, baseDigest: before.digest, compactReceipt: true,
          payload: { orders, trucks, summary: { ...summary, retainedReplay: entry.ordinal } }
        } });
        const elapsed = performance.now() - started;
        report.maxUpdateMs = Math.max(report.maxUpdateMs, elapsed);
        description.updateMs = elapsed;
        if (elapsed > 500) report.updatesOver500ms.push({ ...description });
        assert.equal(applied.payload.plan.revision, before.revision + 1);
        const reread = await getDispatchV2Bootstrap({ planId: header.id });
        assert.equal(reread.plan.digest, applied.payload.acknowledgement.digest, 'read enrichment must not change the committed fence');
        description.result = 'committed_and_rolled_back';
      } catch (error) {
        description.result = 'rejected';
        description.code = error.code || error.name;
        description.updateMs = performance.now() - started;
        report.maxUpdateMs = Math.max(report.maxUpdateMs, description.updateMs);
        if (description.updateMs > 500) report.updatesOver500ms.push({ ...description });
        if (error.code === 'STALE_DISPATCH_PLAN' || (!error.code?.startsWith('DISPATCH_') && !error.code?.startsWith('NETSUITE_') && !error.code?.startsWith('SCM_'))) {
          report.unexpected.push({ ...description, message: error.message });
        }
        // Current-source business rejection is evidence, never an exact replay
        // of an unavailable historical source state or a claimed successful save.
        description.validationContext = 'retained current definitions; unavailable historical sources are a gap';
      }
    }, { rollback: true });
    report.records.push(description);
    if (report.records.length % 25 === 0) {
      await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ states: report.records.length, unexpected: report.unexpected.length, maxUpdateMs: report.maxUpdateMs }));
    }
  }
  report.completedAt = new Date().toISOString();
  report.sourceUnchanged = JSON.stringify(await sourceHashes()) === JSON.stringify(report.sources);
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ states: report.records.length, maxUpdateMs: report.maxUpdateMs, over500ms: report.updatesOver500ms.length, unexpected: report.unexpected.length }));
  assert.equal(report.unexpected.length, 0, 'Unexpected history replay failures; see private report');
  if (simulateSources) {
    assert.ok(report.sourceEvents > 0, 'No source events were exercised');
    assert.ok(report.sourceRefreshesObserved > 0, 'Source refreshes never changed the visible order data');
  }
  assert.equal(report.sourceUnchanged, true, 'Runtime changed during history replay');
  // Per the user's latest clarification, background completion latency is a
  // measurement. Playwright gates action/paint responsiveness during a held save.
} finally { await closeDb(); }
