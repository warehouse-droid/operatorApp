// @ts-check
import { isDeepStrictEqual } from 'node:util';
import { query, withTransaction } from './db.js';
import { writeAudit } from './auth-repository.js';
import { buildReturnCreditMemoPayload, verifyReturnCreditMemoSnapshot } from './return-credit-memo.js';
import { specialLineSubtotal } from '../public/special-stock-pricing.js';

function invalid() {
  return Object.assign(new Error('The Credit Memo adjustment does not match its verified original return.'),
    { status: 409, code: 'RETURN_CM_ADJUSTMENT_INVALID' });
}

/** @param {Record<string, any>} batch */
function verifiedOriginalIntent(batch) {
  const original = batch.intent_snapshot;
  if (!original || original.transactionType !== 'credit_memo' || !(Number(original.version) >= 4)
      || batch.draft_id || !(Number(batch.netsuite_transaction_id) > 0)
      || Number(batch.netsuite_snapshot?.id) !== Number(batch.netsuite_transaction_id)) { throw invalid(); }
  return original;
}

/** @param {Record<string, any>} batch @param {Record<string, any>} request */
function assertAdjustmentRequest(batch, request) {
  if (request?.version !== 1 || request.batchId !== Number(batch.batch_id)
      || request.creditMemoId !== Number(batch.netsuite_transaction_id)
      || !isDeepStrictEqual(request.baseIntent, batch.intent_snapshot) || request.useDefaultItemDescriptions !== true
      || typeof request.reason !== 'string' || !request.reason.trim()
      || !Array.isArray(request.stockRates) || !request.stockRates.length) { throw invalid(); }
}

/** @param {Record<string, any>} effective @param {Record<string, any>} change @param {Set<number>} seen */
function applyStockRate(effective, change, seen) {
  const line = effective.lines[change?.lineIndex];
  if (!Number.isInteger(change?.lineIndex) || seen.has(change.lineIndex) || line?.kind !== 'stock'
      || change.fromRate !== line.rate || typeof change.rate !== 'number'
      || !Number.isFinite(change.rate) || change.rate < 0) { throw invalid(); }
  seen.add(change.lineIndex);
  line.rate = change.rate;
}

/** A separate, explicitly authorized correction never rewrites the admitted intent.
 * @param {Record<string, any>} batch @param {Record<string, any>} request */
export function buildAdjustedReturnCreditMemoIntent(batch, request) {
  const original = verifiedOriginalIntent(batch);
  assertAdjustmentRequest(batch, request);
  const effective = structuredClone(original);
  const seen = new Set();
  for (const change of request.stockRates) {
    applyStockRate(effective, change, seen);
  }
  effective.version = Math.max(5, Number(effective.version));
  return effective;
}

/** @param {Record<string, any>} batch @param {Record<string, any>} request @param {Record<string, any>} snapshot */
export function verifyReturnCreditMemoAdjustment(batch, request, snapshot) {
  const effective = buildAdjustedReturnCreditMemoIntent(batch, request);
  verifyReturnCreditMemoSnapshot({ ...effective, netSuiteTransactionId: request.creditMemoId }, snapshot);
  const rows = buildReturnCreditMemoPayload(effective).item.items;
  for (const [index, row] of rows.entries()) {
    const expected = row.quantity === undefined ? row.rate : specialLineSubtotal(row.quantity, row.rate);
    const actual = snapshot.item.items[index].amount;
    if (actual === null || actual === undefined || actual === '' || !Number.isFinite(Number(actual))
        || Number(actual).toFixed(2) !== Number(expected).toFixed(2)) { throw invalid(); }
  }
  return effective;
}

/** @param {Record<string, any>} batch */
export async function returnCreditMemoReconciliationIntent(batch) {
  const result = await query(`SELECT e.request_snapshot,e.response_snapshot FROM return_sync_events e
    JOIN return_records r ON r.id=e.return_record_id
    WHERE r.batch_id=$1 AND e.event_type='credit_memo_adjustment' AND e.status='succeeded'
    ORDER BY e.id DESC LIMIT 1`, [batch.batch_id]);
  const event = result.rows[0];
  return event ? verifyReturnCreditMemoAdjustment(batch, event.request_snapshot, event.response_snapshot) : batch.intent_snapshot;
}

/** Operational entry point: call only after an explicitly authorized, read-back-verified edit.
 * No HTTP route exposes price adjustment or enables automatic repricing.
 * @param {{batchId: number|string, request: Record<string, any>, snapshot: Record<string, any>, actorOperatorId?: string|null}} input */
export async function recordVerifiedReturnCreditMemoAdjustment({ batchId, request, snapshot, actorOperatorId = null }) {
  return withTransaction(async () => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`return-batch-ra:${batchId}`]);
    const batch = (await query('SELECT * FROM return_batch_authorizations WHERE batch_id=$1', [batchId])).rows[0];
    if (!batch) { throw invalid(); }
    const effective = verifyReturnCreditMemoAdjustment(batch, request, snapshot);
    const inserted = await query(`INSERT INTO return_sync_events
      (return_record_id,event_type,status,request_snapshot,response_snapshot,actor_operator_id)
      SELECT min(id),'credit_memo_adjustment','succeeded',$2::jsonb,$3::jsonb,$4
      FROM return_records WHERE batch_id=$1 HAVING count(*)>0 RETURNING id`,
    [batchId, JSON.stringify(request), JSON.stringify(snapshot), actorOperatorId]);
    if (!inserted.rowCount) { throw invalid(); }
    await writeAudit({ actorOperatorId, source: 'returns', action: 'returns.netsuite.batch_cm.adjusted',
      orderId: effective.sourceSalesOrderId, details: { batchId: Number(batchId), creditMemoId: request.creditMemoId,
        adjustmentEventId: Number(inserted.rows[0].id), stockRates: request.stockRates, reason: request.reason,
        useDefaultItemDescriptions: true, originalIntentPreserved: true } });
    return { eventId: Number(inserted.rows[0].id), effectiveIntent: effective };
  });
}
