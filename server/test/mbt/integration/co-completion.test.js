import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { assertSalesDeliveryPlanningAllowed } from '../../../src/dispatch-fulfilled-so-repository.js';
import { listDriverPwaCompletedDispatchRefs } from '../../../src/dispatch-history-mode.js';
import { claimSalesOrderAutoFulfillmentCandidate, prepareSalesOrderAutoFulfillmentCandidate, previewHistoricalSalesOrderAutoFulfillmentEvents } from '../../../src/sales-order-auto-fulfillment-repository.js';
import { seedCoFixture, insertCoJob, insertLegacyCoJob } from '../../support/co-completion-fixture.mjs';
import { planJobsForDriver } from '../../../src/driver-repository.js';
import { completeDriverJobOperationalEffects } from '../../../src/server.js';
import { coCompletionCandidates, repairCoCompletionCandidates } from '../../../tools/co-completion-live.mjs';
import { listTransferDependencyCandidates } from '../../../src/order-dependency-repository.js';
after(closeDb);
const isolated = operation => withTransaction(operation, { rollback: true });

test('operational effects of a stale offline job use its corrected durable CO identity', () => isolated(async () => {
  const f = await seedCoFixture();
  const job = planJobsForDriver(f.plan, 'co-driver').find(candidate => candidate.stopId === 'co-drop');
  job.orderRefs = f.members;
  job.orderTypes = ['SO'];
  const result = await completeDriverJobOperationalEffects({ driverLogin: 'co-driver', job,
    photoDataUrls: ['r2://co-test/original-a', 'r2://co-test/original-b'], occurredAt: '2039-09-18T18:27:33Z' });
  assert.deepEqual(result.record.order_refs, [f.coRef]);
  assert.deepEqual(result.jobResults[0].job.orderRefs, [f.coRef]);
  await assert.doesNotReject(() => assertSalesDeliveryPlanningAllowed(f.members));
}));

test('database boundary corrects a stale grouped CO completion and leaves source deliveries planable', () => isolated(async () => {
  const f = await seedCoFixture();
  const row = await insertCoJob(f);
  assert.deepEqual(row.order_refs, [f.coRef]);
  assert.equal((await query('SELECT status FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows[0].status, 'completed');
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_order_completion_events WHERE completion_evidence_id=$1', [f.jobId])).rows[0].n, 0);
  await assert.doesNotReject(() => assertSalesDeliveryPlanningAllowed(f.members));
  const completed = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [...f.members, f.coRef] });
  assert.equal(completed.has(f.coRef.toLowerCase()), true);
  for (const ref of f.members) { assert.equal(completed.has(ref.toLowerCase()), false); }
}));

test('repaired transfer evidence cannot be claimed by an already queued fulfillment candidate', () => isolated(async () => {
  const f = await seedCoFixture();
  const before = await insertLegacyCoJob(f);
  await query(`UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='dispatch_netsuite_sales_order_if_2967'`);
  const candidate = (await query(`UPDATE dispatch_sales_order_if_candidates SET status='queued',
    gate_key='dispatch_netsuite_sales_order_if_2967',resolution_action='historical_backfill'
    WHERE dispatch_order_ref=$1 RETURNING id`, [f.members[0]])).rows[0];
  await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1', [before.id]);
  const claimed = await claimSalesOrderAutoFulfillmentCandidate({ candidateId: candidate.id, workerId: 'co-test', payload: {}, liveOrder: {}, selectedLines: [] });
  assert.equal(claimed, null);
  const prepared = await prepareSalesOrderAutoFulfillmentCandidate(candidate.id);
  assert.equal(prepared.status, 'attention');
}));

test('independent customer delivery and manual completion stay blocked after transfer repair', () => isolated(async () => {
  const f = await seedCoFixture();
  const transfer = await insertLegacyCoJob(f);
  const delivery = await insertCoJob(f, { jobId: `${f.jobId}:customer`, refs: [f.members[0]], stopId: 'customer-drop', location: 'Customer address' });
  await query(`SELECT dispatch_record_order_completion('SO',$1,now(),'manual_dispatch',$2,NULL,NULL,NULL,
    'operator','co-test','Actual customer delivery confirmed','{}'::jsonb)`, [f.members[1], `${f.jobId}:manual`]);
  await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1', [transfer.id]);
  for (const ref of f.members) { await assert.rejects(() => assertSalesDeliveryPlanningAllowed([ref])); }
  assert.deepEqual((await query('SELECT * FROM driver_job_records WHERE id=$1', [delivery.id])).rows[0], delivery);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_effective_order_completion_events WHERE order_ref=ANY($1)', [f.members])).rows[0].n, 2);
}));

test('historical repair rolls back completely and its correction audit is immutable', () => isolated(async () => {
  const f = await seedCoFixture();
  const before = await insertLegacyCoJob(f);
  const coBefore = (await query('SELECT * FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows[0];
  await withTransaction(async () => {
    await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1', [before.id]);
    assert.deepEqual((await query('SELECT order_refs FROM driver_job_records WHERE id=$1', [before.id])).rows[0].order_refs, [f.coRef]);
  }, { rollback: true });
  assert.deepEqual((await query('SELECT * FROM driver_job_records WHERE id=$1', [before.id])).rows[0], before);
  assert.deepEqual((await query('SELECT * FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows[0], coBefore);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_driver_co_identity_corrections WHERE driver_job_record_id=$1', [before.id])).rows[0].n, 0);
  await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1', [before.id]);
  const audit = (await query('SELECT * FROM dispatch_driver_co_identity_corrections WHERE driver_job_record_id=$1', [before.id])).rows[0];
  assert.deepEqual(audit.original_order_refs, before.order_refs);
  assert.deepEqual(audit.original_job_details, before.job_details);
  for (const sql of ['DELETE FROM dispatch_driver_co_identity_corrections WHERE driver_job_record_id=$1',
    "UPDATE dispatch_driver_co_identity_corrections SET co_ref='OTHER' WHERE driver_job_record_id=$1"]) {
    const operation = sql.startsWith('DELETE') ? 'DELETE' : 'UPDATE';
    await assert.rejects(() => withTransaction(() => query(sql, [before.id])), {
      message: `dispatch_driver_co_identity_corrections is append-only; ${operation} is not permitted`
    });
  }
}));

test('pickup and in-progress stale jobs keep the CO identity without completing the transfer', () => isolated(async () => {
  const f = await seedCoFixture();
  for (const options of [{ stopId: 'co-pick', stopType: 'pickup', location: '150', jobId: `${f.jobId}:pick` }, { status: 'in_progress' }]) {
    const row = await insertCoJob(f, options);
    assert.deepEqual(row.order_refs, [f.coRef]);
  }
  assert.equal((await query('SELECT status FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows[0].status, 'pending_load');
}));

test('ambiguous or unmatched context cannot rewrite completion history', () => isolated(async () => {
  for (const mismatch of ['location', 'stop', 'members', 'plan', 'duplicate', 'phase', 'created_after']) {
    const f = await seedCoFixture();
    const options = {};
    if (mismatch === 'location') { options.location = '3445'; }
    if (mismatch === 'stop') { options.stopId = 'contains-' + f.coRef; }
    if (mismatch === 'members') { options.refs = [...f.members, 'UNRELATED']; }
    if (mismatch === 'plan') { options.planId = null; }
    if (mismatch === 'phase') { options.stopType = 'pickup'; options.location = '150'; }
    if (mismatch === 'created_after') { await query("UPDATE local_co_orders SET created_at='2039-09-19' WHERE co_ref=$1", [f.coRef]); }
    if (mismatch === 'duplicate') { await query('UPDATE dispatch_plan_snapshots SET orders=orders||orders WHERE plan_id=$1', [f.plan.id]); }
    const row = await insertCoJob(f, options);
    assert.deepEqual(row.order_refs, options.refs || f.members, mismatch);
    assert.equal((await query('SELECT status FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows[0].status, 'pending_load');
  }
}));

test('malformed and reordered reference sets fail closed or normalize without changing membership', () => isolated(async () => {
  for (const refs of [null, {}, 'bad', [null], [''], ['SO-A', 1]]) {
    const result = await query('SELECT dispatch_co_identity_ref_set($1::jsonb) AS refs', [JSON.stringify(refs)]);
    assert.equal(result.rows[0].refs, null);
  }
  const f = await seedCoFixture();
  const row = await insertCoJob(f, { refs: [...f.members].reverse().map(ref => '  ' + ref.toLowerCase() + '  ') });
  assert.deepEqual(row.order_refs, [f.coRef]);
}));

test('CO references cannot produce universal SO completion from stale SO details', () => isolated(async () => {
  const f = await seedCoFixture();
  await insertCoJob(f, { refs: [f.coRef] });
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_order_completion_events WHERE completion_evidence_id=$1', [f.jobId])).rows[0].n, 0);
}));

test('historical repair preserves original evidence and removes only incorrect delivery effects', () => isolated(async () => {
  const f = await seedCoFixture();
  const before = await insertLegacyCoJob(f);
  const eventsBefore = (await query('SELECT * FROM dispatch_order_completion_events WHERE completion_evidence_id=$1 ORDER BY id', [f.jobId])).rows;
  assert.equal(eventsBefore.length, 2);
  await assert.rejects(() => assertSalesDeliveryPlanningAllowed(f.members), { code: 'DISPATCH_ORDER_DRIVER_COMPLETED' });
  await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1', [before.id]);
  const repairedRow = (await query('SELECT * FROM driver_job_records WHERE id=$1', [before.id])).rows[0];
  assert.deepEqual(repairedRow.order_refs, [f.coRef]);
  for (const key of Object.keys(before).filter(field => !['order_refs', 'job_details'].includes(field))) { assert.deepEqual(repairedRow[key], before[key], key); }
  assert.deepEqual((await query('SELECT * FROM dispatch_order_completion_events WHERE completion_evidence_id=$1 ORDER BY id', [f.jobId])).rows, eventsBefore);
  await assert.doesNotReject(() => assertSalesDeliveryPlanningAllowed(f.members));
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_order_completion_status WHERE order_ref=ANY($1)', [f.members])).rows[0].n, 0);
  assert.deepEqual(await previewHistoricalSalesOrderAutoFulfillmentEvents({ search: f.members[0] }), []);
  await query('UPDATE driver_job_records SET order_refs=$2::jsonb WHERE id=$1', [before.id, JSON.stringify(f.members)]);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_driver_co_identity_corrections WHERE driver_job_record_id=$1', [before.id])).rows[0].n, 1);
  assert.deepEqual((await query('SELECT order_refs FROM driver_job_records WHERE id=$1', [before.id])).rows[0].order_refs, [f.coRef]);
}));

test('a stale retry cannot undo an audited correction after the completed stop leaves the current plan', () => isolated(async () => {
  const f = await seedCoFixture();
  const before = await insertLegacyCoJob(f);
  await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1', [before.id]);
  await query("UPDATE dispatch_plan_snapshots SET orders='[]',trucks='[]' WHERE plan_id=$1", [f.plan.id]);
  await query('UPDATE driver_job_records SET order_refs=$2::jsonb WHERE id=$1', [before.id, JSON.stringify(f.members)]);
  assert.deepEqual((await query('SELECT order_refs FROM driver_job_records WHERE id=$1', [before.id])).rows[0].order_refs, [f.coRef]);
  await assert.doesNotReject(() => assertSalesDeliveryPlanningAllowed(f.members));
}));

test('the deployment repair detects opaque stop IDs and preserves all protected fields', () => isolated(async () => {
  const f = await seedCoFixture();
  const legacy = await insertLegacyCoJob(f);
  await query("UPDATE dispatch_sales_order_if_candidates SET status='gate_disabled' WHERE dispatch_order_ref=ANY($1)", [f.members]);
  const candidates = (await coCompletionCandidates()).filter(row => row.id === legacy.id);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].proven, true);
  const repaired = await repairCoCompletionCandidates(candidates);
  assert.equal(repaired.repairedTransfers, 1);
  assert.equal(repaired.skippedCandidates, 2);
  assert.equal(repaired.protectedFieldsUnchanged, true);
  assert.deepEqual((await query('SELECT DISTINCT status FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=ANY($1)', [f.members])).rows, [{ status: 'skipped' }]);
  assert.equal((await coCompletionCandidates()).filter(row => row.id === legacy.id).length, 0);
  assert.equal((await repairCoCompletionCandidates([])).repairedTransfers, 0);
}));

test('transfer repair restores source shortage eligibility without changing its quantity', () => isolated(async () => {
  const f = await seedCoFixture();
  const sourceId = (await query('SELECT netsuite_id FROM sales_orders WHERE tranid=$1', [f.members[0]])).rows[0].netsuite_id;
  await query(`INSERT INTO sales_order_lines(id,sales_order_id,line_id,item_id,item_name,sku,quantity,unit,netsuite_backordered_qty,netsuite_active)
    VALUES ($1,$1,1,991001,'Concrete Paver','CO-PAVER',5,'EA',5,true)`, [sourceId]);
  const legacy = await insertLegacyCoJob(f);
  const before = await listTransferDependencyCandidates({ salesOrderId: sourceId, reviewStatus: 'all' });
  assert.deepEqual(before, [], 'A falsely completed source is hidden by the existing shortage API');
  await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1', [legacy.id]);
  const corrected = (await listTransferDependencyCandidates({ salesOrderId: sourceId, reviewStatus: 'all' }))[0];
  assert.equal(corrected.dispatchCompleted, false);
  assert.equal(corrected.uncoveredQuantity, 5);
  assert.equal(Number((await query('SELECT quantity FROM sales_order_lines WHERE id=$1', [sourceId])).rows[0].quantity), 5);
}));
