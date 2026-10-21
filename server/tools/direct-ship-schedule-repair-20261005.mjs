// Run through stdin in the live app container. Default mode is read-only.
// The user's confirmation closes these two TOs in Dispatch only; the recorded
// allocation discrepancy and receiving quantities remain available for audit.
import assert from 'node:assert/strict';
import { closeDb, query, withTransaction } from './src/db.js';
import { listScmSchedule } from './src/dispatch-repository.js';
import { enrichScmScheduleWithReconciliation } from './src/scm-reconciliation-repository.js';
import { assertNoClosedNetSuiteOrders } from './src/netsuite-closed-order-repository.js';

const repairId = 'direct-ship-schedule-tob01190-tob01191-20261005';
const mode = process.env.DIRECT_SHIP_SCHEDULE_REPAIR_MODE || 'preview';
assert.ok(['preview', 'apply', 'verify'].includes(mode));
const targets = [
  { ref: 'TOB01190', id: '1037048', dependencyId: '270', driverId: '5653', operatorId: '2825',
    postingId: '6ce5f5e9-632e-495f-80ca-64c6d736c7e0', fulfillmentRef: 'IF156515', salesRefs: ['SOA09690'] },
  { ref: 'TOB01191', id: '1037331', dependencyId: '271', driverId: '5687', operatorId: '2826',
    postingId: 'fc32db6f-6bbf-4039-9c68-428c33eaa0b3', fulfillmentRef: 'IF156516', salesRefs: ['SOA09694', 'SOA09702'] }
];
const refs = targets.map(target => target.ref);
const ids = targets.map(target => target.id);
const rows = async (sql, params = []) => (await query(sql, params)).rows;

async function retainedRecords() {
  return {
    orders: await rows('SELECT * FROM transfer_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id', [ids]),
    lines: await rows('SELECT * FROM transfer_order_lines WHERE transfer_order_id=ANY($1::bigint[]) ORDER BY id', [ids]),
    dependencies: await rows('SELECT * FROM order_dependencies WHERE transfer_order_id=ANY($1::bigint[]) ORDER BY id', [ids]),
    dependencyLines: await rows(`SELECT line.* FROM order_dependency_lines line JOIN order_dependencies dependency
      ON dependency.id=line.dependency_id WHERE dependency.transfer_order_id=ANY($1::bigint[]) ORDER BY line.id`, [ids]),
    postings: await rows('SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=ANY($1::bigint[]) ORDER BY id', [ids]),
    operators: await rows('SELECT id,order_id,response FROM operator_load_records WHERE order_id=ANY($1::bigint[]) ORDER BY id', [ids]),
    receipts: await rows('SELECT id,order_id,receipt_status,payload,response FROM receiving_receipt_records WHERE order_id=ANY($1::bigint[]) ORDER BY id', [ids]),
    driver: await rows(`SELECT id,job_id,plan_id,plan_date,load_id,stop_type,order_refs,status,completed_at,
      mbt_assignment_withdrawn_at FROM driver_job_records WHERE id=ANY($1::bigint[]) ORDER BY id`, [targets.map(target => target.driverId)])
  };
}

async function validateEvidence() {
  await assertNoClosedNetSuiteOrders(refs, 'be completed in Dispatch');
  const evidence = [];
  for (const target of targets) {
    const [order] = await rows('SELECT netsuite_id,tranid,fulfillment_status FROM transfer_orders WHERE netsuite_id=$1', [target.id]);
    assert.equal(order?.tranid, target.ref);
    assert.equal(order.fulfillment_status, 'fulfilled');
    const [dependency] = await rows('SELECT * FROM order_dependencies WHERE id=$1', [target.dependencyId]);
    assert.equal(dependency?.transfer_order_id, target.id);
    assert.equal(dependency.status, 'received_local');
    assert.equal(dependency.dependency_mode, 'direct_to_customer');
    const [driver] = await rows(`SELECT id,job_id,plan_id,plan_date,load_id,stop_type,order_refs,status,completed_at,
      mbt_assignment_withdrawn_at FROM driver_job_records WHERE id=$1`, [target.driverId]);
    assert.equal(driver?.status, 'complete');
    assert.equal(driver.stop_type, 'dropoff');
    assert.equal(driver.mbt_assignment_withdrawn_at, null);
    assert.ok(driver.completed_at);
    assert.equal(driver.job_id, dependency.direct_receipt_job_id);
    assert.equal(driver.plan_id, dependency.planned_plan_id);
    assert.equal(driver.load_id, dependency.planned_load_id);
    assert.equal(driver.plan_date.toISOString(), dependency.planned_date.toISOString());
    assert.ok(target.salesRefs.every(ref => driver.order_refs.includes(ref)));
    const [posting] = await rows('SELECT * FROM transfer_order_posting_jobs WHERE id=$1', [target.postingId]);
    assert.equal(posting?.local_to_id, target.id);
    assert.equal(posting.transaction_type, 'IF');
    assert.equal(posting.status, 'completed');
    assert.equal(posting.operator_record_id, target.operatorId);
    assert.equal(posting.snapshot.planId, driver.plan_id);
    assert.equal(posting.snapshot.loadId, driver.load_id);
    assert.equal(posting.snapshot.planDate, driver.plan_date.toISOString().slice(0, 10));
    assert.deepEqual([...posting.snapshot.driverTarget.orderRefs].sort(), [...target.salesRefs].sort());
    assert.ok(posting.result.transactions.some(transaction => transaction.transactionRef === target.fulfillmentRef));
    const [operator] = await rows('SELECT id,order_id,response FROM operator_load_records WHERE id=$1', [target.operatorId]);
    assert.equal(operator?.order_id, target.id);
    assert.equal(operator.response.remainingLines, 0);
    const sourceLines = await rows(`SELECT id,line_id,quantity FROM transfer_order_lines
      WHERE transfer_order_id=$1 AND line_stage='outbound' AND netsuite_active ORDER BY id`, [target.id]);
    for (const line of sourceLines) {
      const captured = posting.snapshot.lines.filter(item => String(item.lineId) === line.id && String(item.sourceLineKey) === line.line_id);
      assert.equal(captured.length, 1);
      assert.equal(Number(captured[0].quantity), Number(line.quantity));
    }
    assert.equal(sourceLines.length, posting.snapshot.lines.length);
    const completions = await rows(`SELECT order_ref,completion_event_id FROM dispatch_order_completion_status
      WHERE order_kind='SO' AND order_ref=ANY($1::text[]) AND completion_evidence_type='driver_job'
        AND completion_evidence_id=$2 AND plan_id=$3 AND load_id=$4`, [target.salesRefs, driver.job_id, driver.plan_id, driver.load_id]);
    assert.equal(completions.length, target.salesRefs.length);
    assert.deepEqual(completions.map(event => event.completion_event_id).sort(), [...posting.snapshot.completionEventIds].sort());
    const residual = await rows(`SELECT line.id,line.sku,line.quantity,
      COALESCE(allocated.quantity,0) AS allocated_quantity,
      GREATEST(line.quantity-COALESCE(allocated.quantity,0),0) AS unlinked_quantity
      FROM transfer_order_lines line LEFT JOIN LATERAL (
        SELECT SUM(dl.allocated_quantity) AS quantity FROM order_dependency_lines dl JOIN order_dependencies d ON d.id=dl.dependency_id
        WHERE d.transfer_order_id=line.transfer_order_id AND dl.item_id=line.item_id
          AND d.dependency_mode='direct_to_customer' AND d.status<>'cancelled'
      ) allocated ON true WHERE line.transfer_order_id=$1 AND line.line_stage='outbound' AND line.netsuite_active ORDER BY line.id`, [target.id]);
    evidence.push({ ...target, completedAt: driver.completed_at.toISOString(), driverJobId: driver.job_id,
      planId: driver.plan_id, planDate: driver.plan_date.toISOString().slice(0, 10), loadId: driver.load_id,
      linkedCompletionEventIds: completions.map(event => event.completion_event_id), residual });
  }
  return evidence;
}

try {
  const result = await withTransaction(async () => {
    if (mode !== 'apply') await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='30s'");
    await query("SET LOCAL lock_timeout='5s'");
    if (mode === 'apply') {
      // Serialize this exact maintenance action and hold its source proof stable.
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [repairId]);
      await query('SELECT netsuite_id FROM transfer_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id FOR UPDATE', [ids]);
      await query('SELECT id FROM order_dependencies WHERE transfer_order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
      await query('SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=ANY($1::bigint[]) ORDER BY id FOR SHARE', [ids]);
      await query('SELECT id FROM driver_job_records WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE', [targets.map(target => target.driverId)]);
    }
    const evidence = await validateEvidence();
    const before = await retainedRecords();
    const scheduleBefore = await listScmSchedule({ exactRefs: refs, statusProjectionOnly: true });
    const existing = await rows("SELECT completion_event_id,order_ref,completion_evidence_type,completion_evidence_id,dispatch_completed_at FROM dispatch_order_completion_status WHERE order_kind='TO' AND order_ref=ANY($1::text[]) ORDER BY order_ref", [refs]);
    if (mode === 'apply') {
      for (const item of evidence) {
        if (existing.some(event => event.order_ref === item.ref)) continue;
        await query(`SELECT dispatch_record_order_completion('TO',$1,$2::timestamptz,'manual_dispatch',$3,
          $4::bigint,$5::date,$6,'operator',$7,$8,$9::jsonb)`, [item.ref, item.completedAt,
          `manual:TO:${item.ref}`, item.planId, item.planDate, item.loadId, 'codex-maintenance:user-confirmed:20261005',
          'User reviewed TO versus Direct Ship quantities and confirmed that the residual 6 PCS on TOB01190 and 1 PCS on TOB01191 are also completed. Recover missing Dispatch completion with linked Driver drop-off, complete Operator loading and existing NetSuite IF evidence.',
          JSON.stringify({ repairId, recoveredDriverCompletion: true, userConfirmedWholeTransferComplete: true,
            originalReport: 'TOB01190 + TOB01191: Direct Ships已做, schedule still shows',
            confirmationAfterQuantityReview: 'yes, they are completed',
            driverJobRecordId: item.driverId, driverJobId: item.driverJobId, dependencyId: item.dependencyId,
            operatorLoadRecordId: item.operatorId, transferPostingJobId: item.postingId,
            fulfillmentRef: item.fulfillmentRef, linkedCompletionEventIds: item.linkedCompletionEventIds,
            allocationDiscrepancy: item.residual.filter(line => Number(line.unlinked_quantity) > 0) })]);
      }
    }
    const completions = await rows("SELECT completion_event_id,order_ref,completion_evidence_type,completion_evidence_id,dispatch_completed_at,actor_id,reason,metadata FROM dispatch_order_completion_status WHERE order_kind='TO' AND order_ref=ANY($1::text[]) ORDER BY order_ref", [refs]);
    const schedule = await listScmSchedule({ exactRefs: refs, statusProjectionOnly: true });
    let activeRows = null;
    let reconciliationStatuses = null;
    if (mode !== 'preview') {
      assert.equal(completions.length, 2);
      assert.equal(schedule.length, 2);
      for (const row of schedule) {
        assert.equal(row.calculatedStatus, 'Completed');
        assert.equal(row.dispatchCompleted, true);
        assert.equal(row.dispatchCompletionEvidenceType, 'manual_dispatch');
      }
      activeRows = await listScmSchedule({ orderSearch: 'TOB0119', kind: 'TO' });
      assert.equal(activeRows.some(row => refs.includes(row.orderRef)), false);
      const enriched = await enrichScmScheduleWithReconciliation(await listScmSchedule({ exactRefs: refs }));
      reconciliationStatuses = enriched.map(row => ({ ref: row.orderRef, status: row.calculatedStatus }));
      assert.equal(enriched.length, 2);
      assert.ok(enriched.every(row => row.calculatedStatus === 'Completed'));
    }
    assert.deepEqual(await retainedRecords(), before, 'Source, stock, Driver and posting records must stay unchanged');
    return { mode, repairId, evidence, scheduleBefore, existing, completions, schedule,
      activeScheduleContainsTargets: activeRows === null ? null : false,
      reconciliationStatuses, retainedOperationalRecordsUnchanged: true, netSuiteWrites: 0 };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDb();
}
