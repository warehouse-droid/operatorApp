import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from './dispatch-fleet-status.js';
import { persistedDispatchPlan } from './dispatch-plan-fence.js';
import { assertDispatchPlanFence } from './dispatch-planner-performance.js';
import { lockDispatchPlanEditLease, assertDispatchPlanEditLease } from './dispatch-plan-lease-repository.js';

function stable(value) {
  if (Array.isArray(value)) {return value.map(stable);}
  if (!value || typeof value !== 'object') {return value;}
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

async function selectStored(planId) {
  const result = await query(`SELECT p.*, s.orders, s.trucks, s.summary, s.saved_at
    FROM dispatch_plans p LEFT JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.id=$1 FOR UPDATE OF p`, [planId]);
  if (!result.rows[0]) {throw Object.assign(new Error('Dispatch plan not found.'), { status: 404, code: 'DISPATCH_PLAN_NOT_FOUND' });}
  return persistedDispatchPlan(result.rows[0]);
}

function writeIdentity({ planId, editLease, operation, request = {} }) {
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(stable({ planId: String(planId), operation, request }))).digest('hex');
  return { requestHash, commandId: String(request.commandId || request.idempotencyKey || `dispatch-${operation}:${editLease.sessionId}:${requestHash}`) };
}

// Call only after the HTTP lease check. A replay is read-only; the transaction
// repeats this lookup to handle a first request that commits during validation.
export async function getDispatchPlanWriteReplay(options) {
  const { requestHash, commandId } = writeIdentity(options);
  const receipt = await query('SELECT plan_id, request_hash, result FROM dispatch_plan_commands WHERE command_id=$1', [commandId]);
  if (!receipt.rows[0]) {return null;}
  if (String(receipt.rows[0].plan_id) !== String(options.planId) || receipt.rows[0].request_hash !== requestHash || !receipt.rows[0].result.writeResult) {
    throw Object.assign(new Error('This save ID already belongs to a different request.'), { status: 409, code: 'DISPATCH_COMMAND_ID_REUSED' });
  }
  return { ...receipt.rows[0].result.writeResult, idempotentReplay: true };
}

// Only the commit boundary belongs here. External followups remain outside the
// transaction. All callers take fleet -> date lease -> plan locks in this order.
export async function withDispatchPlanWrite({ planId, editLease, operation, request = {} }, commit) {
  const options = { planId, editLease, operation, request };
  const { requestHash, commandId } = writeIdentity(options);
  return withTransaction(async () => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    await lockDispatchPlanEditLease(editLease);
    const stored = await selectStored(planId);
    if (stored.planDate !== String(editLease.planDate).slice(0, 10)) {
      throw Object.assign(new Error('Edit Mode belongs to another plan date.'), { status: 409, code: 'DISPATCH_PLAN_EDIT_LEASE_REQUIRED' });
    }
    const receipt = await getDispatchPlanWriteReplay(options);
    if (receipt) {return receipt;}
    assertDispatchPlanFence(stored, {
      baseRevision: request.baseRevision ?? request.expectedRevision,
      baseDigest: request.baseDigest || request.expectedDigest
    }, { required: true });
    const result = await commit(stored);
    await assertDispatchPlanEditLease(editLease);
    const committed = await selectStored(planId);
    // Confirmation and reopening change status/note, both covered by the digest.
    await query('UPDATE dispatch_plan_snapshots SET plan_digest=$2 WHERE plan_id=$1 AND plan_digest IS DISTINCT FROM $2', [planId, committed.digest]);
    const plan = result.plan || result;
    Object.assign(plan, { revision: committed.revision, digest: committed.digest });
    if (committed.revision !== stored.revision) {
      await query(`INSERT INTO dispatch_plan_commands (command_id, plan_id, plan_date, command_type,
        request_hash, base_revision, applied_revision, session_id, actor_id, result)
        VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [commandId, planId, committed.planDate, operation, requestHash, stored.revision, committed.revision,
        editLease.sessionId, editLease.operatorId, JSON.stringify({ plan, writeResult: result })]);
    }
    return result;
  });
}
