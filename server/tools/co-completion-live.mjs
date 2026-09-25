import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { closeDb, query, withTransaction } from '../src/db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../src/dispatch-fleet-status.js';
import { writeDispatchAudit } from '../src/dispatch-audit-repository.js';
import { syncDispatchGlobalOrderTransitCo } from '../src/dispatch-delivery-group-repository.js';
import { enqueueDispatchOrderCatalogRefresh, getDispatchOrderCatalogOrder } from '../src/dispatch-order-catalog-repository.js';
import { assertSalesDeliveryPlanningAllowed } from '../src/dispatch-fulfilled-so-repository.js';

export const migration = '209_driver_co_execution_identity.sql';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function coCompletionCandidates() {
  const result = await query(`SELECT record.id,record.job_id,record.order_refs,record.plan_id,record.completed_at,
      co.co_ref,co.source_order_ref,proof.value AS proof,
      (proof.value IS NOT NULL AND proof.value->>'coRef'=co.co_ref
       AND dispatch_co_identity_ref_set(record.order_refs)=dispatch_co_identity_ref_set(proof.value->'sourceRefs')
       AND lower(btrim(record.job_details->>'location'))=lower(btrim(co.to_location))
       AND record.completed_at >= co.created_at) IS TRUE AS proven
    FROM driver_job_records record
    LEFT JOIN LATERAL (SELECT dispatch_driver_co_identity_proof(record.plan_id,record.load_id,record.stop_id) AS value) proof ON true
    JOIN local_co_orders co ON co.co_ref=proof.value->>'coRef' OR position(co.co_ref IN record.stop_id)>0
    WHERE record.status='complete' AND record.stop_type='dropoff'
      AND NOT record.order_refs @> jsonb_build_array(co.co_ref)
    ORDER BY record.id,co.co_ref`);
  return result.rows;
}

async function protectedState(ids, refs) {
  const [drivers, events, sales, lines, plans] = await Promise.all([
    query(`SELECT to_jsonb(r)-'order_refs'-'job_details' AS protected FROM driver_job_records r WHERE id=ANY($1::bigint[]) ORDER BY id`, [ids]),
    query(`SELECT e.* FROM dispatch_order_completion_events e JOIN driver_job_records r ON e.completion_evidence_type='driver_job'
      AND e.completion_evidence_id=r.job_id WHERE r.id=ANY($1::bigint[]) ORDER BY e.id`, [ids]),
    query('SELECT to_jsonb(s) AS protected FROM sales_orders s WHERE tranid=ANY($1::text[]) ORDER BY netsuite_id', [refs]),
    query(`SELECT to_jsonb(l) AS protected FROM sales_order_lines l JOIN sales_orders s ON s.netsuite_id=l.sales_order_id
      WHERE s.tranid=ANY($1::text[]) ORDER BY l.id`, [refs]),
    query(`SELECT to_jsonb(s) AS protected FROM dispatch_plan_snapshots s WHERE plan_id IN
      (SELECT plan_id FROM driver_job_records WHERE id=ANY($1::bigint[])) ORDER BY plan_id`, [ids])
  ]);
  return Object.fromEntries([drivers, events, sales, lines, plans].map((result, index) =>
    [['driverPhotosTimesAndIds', 'originalCompletionEvents', 'salesOrders', 'salesLines', 'planSnapshots'][index], digest(result.rows)]));
}

async function skipInvalidCandidates(ids) {
  const result = await query(`SELECT candidate.* FROM dispatch_sales_order_if_candidates candidate
    JOIN dispatch_order_completion_events event ON event.id=candidate.completion_event_id
    JOIN driver_job_records record ON event.completion_evidence_type='driver_job' AND event.completion_evidence_id=record.job_id
    WHERE record.id=ANY($1::bigint[]) ORDER BY candidate.id FOR UPDATE OF candidate`, [ids]);
  for (const row of result.rows) {
    assert.ok(['gate_disabled', 'skipped'].includes(row.status) && !row.netsuite_transaction_id,
      `Candidate ${row.id} requires review before identity repair: ${row.status}`);
    if (row.status === 'skipped') { continue; }
    const reason = 'CO yard-transfer completion was misassigned to a source SO; retained evidence is superseded by the audited CO identity correction.';
    await query(`UPDATE dispatch_sales_order_if_candidates SET status='skipped',resolution_action='skip',resolution_reason=$2,
      resolved_by='co-execution-identity-repair',resolved_at=now(),updated_at=now() WHERE id=$1`, [row.id, reason]);
    await query(`INSERT INTO dispatch_sales_order_if_audit_events(candidate_id,action,actor_id,reason,details)
      VALUES ($1,'co_identity_correction','co-execution-identity-repair',$2,$3::jsonb)`, [row.id, reason,
    JSON.stringify({ previousStatus: row.status, completionEventId: row.completion_event_id, netSuiteUpdated: false })]);
  }
  return result.rows.length;
}

export async function repairCoCompletionCandidates(candidates) {
  const proven = candidates.filter(row => row.proven);
  assert.equal(new Set(proven.map(row => row.id)).size, proven.length, 'Ambiguous CO identity');
  const ids = proven.map(row => row.id);
  const sourceRefs = [...new Set(proven.flatMap(row => row.order_refs))];
  await query('SELECT id FROM driver_job_records WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
  const before = await protectedState(ids, sourceRefs);
  const skippedCandidates = await skipInvalidCandidates(ids);
  for (const row of proven) {
    const updated = (await query('UPDATE driver_job_records SET order_refs=order_refs WHERE id=$1 RETURNING order_refs', [row.id])).rows[0];
    assert.deepEqual(updated.order_refs, [row.co_ref]);
    const co = (await query('SELECT * FROM local_co_orders WHERE co_ref=$1', [row.co_ref])).rows[0];
    assert.equal(co.status, 'completed');
    await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: row.source_order_ref, co });
    for (const orderRef of [row.co_ref, row.source_order_ref, ...row.order_refs]) {
      await enqueueDispatchOrderCatalogRefresh({ orderRef, source: 'co-execution-identity-repair' });
    }
  }
  const after = await protectedState(ids, sourceRefs);
  assert.deepEqual(after, before, 'Protected operational evidence changed');
  if (ids.length) {
    await writeDispatchAudit({ action: 'driver.co_execution_identity.repaired', entityType: 'driver_job',
      entityId: ids.join(','), actorType: 'system', actorId: 'co-execution-identity-repair',
      details: { records: proven.map(row => ({ id: row.id, coRef: row.co_ref, sourceRefs: row.order_refs })),
        protectedHashes: after, skippedCandidates, netSuiteUpdated: false } });
  }
  return { repairedTransfers: ids.length, sourceOrderCount: sourceRefs.length, skippedCandidates,
    protectedFieldsUnchanged: true, records: proven.map(row => ({ id: row.id, coRef: row.co_ref, sourceRefs: row.order_refs })) };
}

export async function verifyReportedGroup() {
  await assertSalesDeliveryPlanningAllowed(['SOM06531', 'SOM06537']);
  const group = await getDispatchOrderCatalogOrder('GOM-6531-6537');
  assert.ok(group && group.dispatchPlanningRestricted === false, 'Reported group is still restricted');
  assert.equal(group.transitCo?.status, 'completed');
  assert.equal(group.sourceYard, '2967');
  return { groupRef: group.id, planable: true, sourceYard: group.sourceYard, transferStatus: group.transitCo.status };
}

async function main() {
  const mode = process.argv[2] || '--rehearse';
  assert.ok(['--rehearse', '--repair', '--verify'].includes(mode));
  try {
    const result = await withTransaction(async () => {
      await query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
      if (mode === '--verify') { await query('SET TRANSACTION READ ONLY'); return { passed: true, ...await verifyReportedGroup() }; }
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
      const installed = (await query('SELECT 1 FROM schema_migrations WHERE filename=$1', [migration])).rowCount;
      if (!installed) {
        assert.equal(mode, '--rehearse', 'Install the tested migration before committing repairs');
        await query(readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
      }
      const candidates = await coCompletionCandidates();
      assert.equal(candidates.filter(row => !row.proven).length, 0, 'Unproven cases require separate review');
      const repaired = await repairCoCompletionCandidates(candidates);
      assert.equal((await coCompletionCandidates()).length, 0, 'Misassigned CO completion remains');
      const repeat = await repairCoCompletionCandidates([]);
      assert.equal(repeat.repairedTransfers, 0);
      return { passed: true, mode, rolledBack: mode === '--rehearse', ...repaired, ...await verifyReportedGroup() };
    }, { rollback: mode === '--rehearse' });
    console.log(JSON.stringify(result));
  } finally { await closeDb(); }
}

if (process.argv[1]?.endsWith('/co-completion-live.mjs') || process.argv[1] === 'tools/co-completion-live.mjs') { await main(); }
