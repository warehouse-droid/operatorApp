// @ts-check
import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { stableCanonicalJson } from './operator-netsuite-posting-domain.js';
import { splitItemFulfillmentPayload } from './item-fulfillment-parts-domain.js';

/** @param {any} value */
const hash = value => crypto.createHash('sha256').update(stableCanonicalJson(value)).digest('hex');
/** @param {any} row */
function part(row) {
  return { id: Number(row.id), locationId: Number(row.location_id), externalId: row.external_id,
    payload: row.payload, status: row.status, attemptToken: row.attempt_token, attemptCount: row.attempt_count,
    transactionId: row.netsuite_transaction_id === null || row.netsuite_transaction_id === undefined ? null : Number(row.netsuite_transaction_id),
    transactionRef: row.netsuite_transaction_ref, response: row.response, lastError: row.last_error };
}
/** @param {any} step */
async function get(step) {
  const plans = await query('SELECT * FROM netsuite_item_fulfillment_plans WHERE external_id=$1', [step.externalId]);
  if (!plans.rowCount) {return null;}
  const plan = plans.rows[0];
  if (Number(plan.source_netsuite_id) !== Number(step.sourceNetSuiteId) || plan.payload_hash !== hash(step.payload)) {
    throw Object.assign(new Error('The immutable IF plan conflicts with the current request.'), { code: 'IF_PLAN_CONFLICT', status: 409 });
  }
  const rows = await query('SELECT * FROM netsuite_item_fulfillment_parts WHERE plan_external_id=$1 ORDER BY location_id', [step.externalId]);
  return { externalId: plan.external_id, parts: rows.rows.map(part) };
}
/** @param {any} step @param {any[]} parts */
async function create(step, parts) {
  if (step.transactionType !== 'IF' || step.sourceOrderKind !== 'SO'
      || parts.length < 2 || stableCanonicalJson(parts) !== stableCanonicalJson(splitItemFulfillmentPayload(step.payload))) {
    throw new Error('An IF split plan must exactly partition one source Sales Order.');
  }
  return withTransaction(async () => {
    await query(`INSERT INTO netsuite_item_fulfillment_plans(external_id,source_netsuite_id,payload_hash,payload)
      VALUES($1,$2,$3,$4) ON CONFLICT(external_id) DO NOTHING`, [step.externalId, step.sourceNetSuiteId, hash(step.payload), step.payload]);
    await query('SELECT external_id FROM netsuite_item_fulfillment_plans WHERE external_id=$1 FOR UPDATE', [step.externalId]);
    await get(step); // Reject a conflicting immutable parent before admitting any part.
    for (const value of parts) {await query(`INSERT INTO netsuite_item_fulfillment_parts
      (plan_external_id,location_id,external_id,payload_hash,payload) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(plan_external_id,location_id) DO NOTHING`, [step.externalId, value.locationId, value.externalId, hash(value.payload), value.payload]);}
    return get(step);
  });
}
/** @param {any} value */
async function claim(value) {
  return withTransaction(async () => {
    const token = crypto.randomUUID();
    const rows = await query(`UPDATE netsuite_item_fulfillment_parts
      SET status='posting',attempt_token=$2,attempt_count=attempt_count+1,last_error=NULL,updated_at=now()
      WHERE id=$1 AND status IN ('pending','failed') RETURNING *`, [value.id, token]);
    if (!rows.rowCount) {
      const current = await query('SELECT * FROM netsuite_item_fulfillment_parts WHERE id=$1', [value.id]);
      if (!current.rowCount) {throw new Error('The IF part no longer exists.');}
      return { ...part(current.rows[0]), fresh: false };
    }
    const row = rows.rows[0];
    await query(`INSERT INTO netsuite_item_fulfillment_part_attempts(id,part_id,attempt_number,outcome)
      VALUES($1,$2,$3,'posting')`, [token, row.id, row.attempt_count]);
    return { ...part(row), fresh: true };
  });
}
/** @param {any} value @param {any} record */
async function complete(value, record) {
  if (!Number.isSafeInteger(Number(record.id)) || Number(record.id) <= 0
      || String(record.externalId ?? record.externalid) !== value.externalId) {throw new Error('IF part evidence has a different identity.');}
  return withTransaction(async () => {
    const rows = await query(`UPDATE netsuite_item_fulfillment_parts
      SET status='posted',netsuite_transaction_id=$2,netsuite_transaction_ref=$3,response=$4,last_error=NULL,updated_at=now()
      WHERE id=$1 AND external_id=$5 AND (netsuite_transaction_id IS NULL OR netsuite_transaction_id=$2) RETURNING attempt_token`,
    [value.id, Number(record.id), String(record.tranId ?? record.tranid ?? record.id),
      { id: Number(record.id), tranId: String(record.tranId ?? record.tranid ?? record.id), externalId: value.externalId }, value.externalId]);
    if (!rows.rowCount) {throw new Error('IF part evidence conflicts with its retained transaction.');}
    if (rows.rows[0].attempt_token) {await query(`UPDATE netsuite_item_fulfillment_part_attempts
      SET outcome=$2,finished_at=now() WHERE id=$1 AND outcome IN ('posting','uncertain')`,
    [rows.rows[0].attempt_token, value.fresh ? 'posted' : 'recovered']);}
  });
}
/** @param {any} value @param {any} error @param {boolean} ambiguous */
async function fail(value, error, ambiguous) {
  return withTransaction(async () => {
    const status = ambiguous ? 'uncertain' : 'failed';
    const rows = await query(`UPDATE netsuite_item_fulfillment_parts SET status=$3,last_error=$4,updated_at=now()
      WHERE id=$1 AND attempt_token=$2 AND status='posting' RETURNING id`,
    [value.id, value.attemptToken, status, String(error?.message || error)]);
    if (rows.rowCount) {await query(`UPDATE netsuite_item_fulfillment_part_attempts
      SET outcome=$2,error=$3,finished_at=now() WHERE id=$1 AND outcome='posting'`, [value.attemptToken, status, String(error?.message || error)]);}
  });
}
export const itemFulfillmentPartsRepository = { get, create, claim, complete, fail };
