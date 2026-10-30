import { query, afterTransactionCommit } from './db.js';
import { fetchReturnCustomerFromNetSuite } from './return-netsuite.js';
import { normalizeReturnRecipient } from './return-notification-domain.js';
import { returnNotifications } from './return-notification-service.js';

export function preferredReturnRecipient(customer) {
  for (const [field, channel] of [['phone', 'sms'], ['email', 'email']]) {
    try {
      const result = normalizeReturnRecipient(customer?.[field]);
      if (result.channel === channel) { return result; }
    } catch { /* Try the other NetSuite contact field. */ }
  }
  return null;
}

export async function queueReturnAutomaticNotification(batch) {
  if (!(Number(batch.intent_snapshot.version) >= 4) || batch.intent_snapshot.transactionType !== 'credit_memo') { return; }
  await query(`INSERT INTO return_automatic_notifications(batch_id)
    SELECT a.batch_id FROM return_batch_authorizations a
    WHERE a.batch_id=$1 AND a.draft_id IS NULL AND a.sync_status IN ('succeeded','manual_linked')
      AND EXISTS(SELECT 1 FROM return_records r WHERE r.batch_id=a.batch_id AND r.status NOT IN ('voided','rejected'))
    ON CONFLICT(batch_id) DO NOTHING`, [batch.batch_id]);
  afterTransactionCommit(() => automaticReturnNotifications.process({ batchId: batch.batch_id, limit: 1 }));
}

const due = "status IN ('pending','retry','processing') AND next_attempt_at<=now()";

/** @param {{notifications?: typeof returnNotifications, lookupCustomer?: typeof fetchReturnCustomerFromNetSuite}} [options] */
export function createAutomaticReturnNotifications({ notifications,
  lookupCustomer = fetchReturnCustomerFromNetSuite } = {}) {
  async function deliver(row) {
    const batch = (await query(`SELECT a.intent_snapshot,b.operator_id,b.receiving_location_id,min(r.id) AS record_id
      FROM return_batch_authorizations a JOIN return_batches b ON b.id=a.batch_id
      JOIN return_records r ON r.batch_id=a.batch_id
      WHERE a.batch_id=$1 AND a.draft_id IS NULL AND a.sync_status IN ('succeeded','manual_linked')
        AND a.intent_snapshot->>'transactionType'='credit_memo' AND r.status NOT IN ('voided','rejected')
      GROUP BY a.batch_id,b.id`, [row.batch_id])).rows[0];
    if (!batch) { return 'cancelled'; }
    let recipient = row.recipient ? { recipient: row.recipient, channel: row.channel } : null;
    if (!recipient) {
      recipient = preferredReturnRecipient(await lookupCustomer(batch.intent_snapshot.customerId, { force: true }));
      if (!recipient) { return 'no_contact'; }
      // Save the destination before crossing the provider boundary. A crash or
      // contact edit cannot turn recovery into a second send to another recipient.
    }
    const frozen = await query(`UPDATE return_automatic_notifications SET recipient=COALESCE(recipient,$2),
      channel=COALESCE(channel,$3),updated_at=now() WHERE batch_id=$1 AND status='processing'
      AND attempts=$4 AND next_attempt_at>now() RETURNING recipient,channel`,
    [row.batch_id, recipient.recipient, recipient.channel, row.attempts]);
    if (!frozen.rowCount) { return null; }
    recipient = frozen.rows[0];
    const result = await (notifications || returnNotifications).send({ recordId: Number(batch.record_id), recipient: recipient.recipient,
      operator: { id: batch.operator_id, role: 'operator', operatorYardLocationIds: [Number(batch.receiving_location_id)] } });
    return result.status === 'sending' ? 'uncertain' : result.status;
  }

  async function process({ batchId = null, limit = 10 } = {}) {
    const candidates = await query(`SELECT batch_id FROM return_automatic_notifications WHERE ${due}
      AND ($1::bigint IS NULL OR batch_id=$1) ORDER BY next_attempt_at,batch_id LIMIT $2`,
    [batchId, Math.max(1, Math.min(25, Number(limit) || 10))]);
    const results = [];
    for (const candidate of candidates.rows) {
      const claimed = await query(`UPDATE return_automatic_notifications SET status='processing',attempts=attempts+1,
        next_attempt_at=now()+interval '2 minutes',updated_at=now() WHERE batch_id=$1 AND ${due} AND attempts<3 RETURNING *`,
      [candidate.batch_id]);
      if (!claimed.rowCount) {
        await query(`UPDATE return_automatic_notifications SET status='uncertain',updated_at=now()
          WHERE batch_id=$1 AND ${due} AND attempts>=3`, [candidate.batch_id]);
        continue;
      }
      const row = claimed.rows[0];
      let status;
      try { status = await deliver(row); }
      catch { status = 'failed'; }
      if (!status) { continue; }
      if (status === 'failed' && row.attempts < 3) { status = 'retry'; }
      await query(`UPDATE return_automatic_notifications SET status=$2,
        next_attempt_at=now()+interval '5 minutes',updated_at=now() WHERE batch_id=$1 AND attempts=$3 AND status='processing'`,
      [row.batch_id, status, row.attempts]);
      results.push({ batchId: Number(row.batch_id), status });
    }
    return results;
  }
  return { process };
}

export const automaticReturnNotifications = createAutomaticReturnNotifications();
