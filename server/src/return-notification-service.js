import { query, withTransaction } from './db.js';
import { getReturnRecordDetail, listReturnRecords } from './return-repository.js';
import { assertOperatorYard } from './operator-yard-access.js';
import { normalizeReturnRecipient, buildReturnNotification } from './return-notification-domain.js';
import { returnNotificationTransport } from './return-notification-transport.js';

function result(row, replayed = false) {
  return { status: row.status, channel: row.channel, recipient: row.recipient, replayed };
}

async function authorizedReturn(recordId, operator) {
  const record = await getReturnRecordDetail(recordId, { operatorId: operator.id });
  if (!record) { throw Object.assign(new Error('Return record was not found.'), { status: 404 }); }
  assertOperatorYard(operator, record.receivingLocationId);
  return record;
}

async function existingNotification(batchId, message, recipient) {
  await query(`UPDATE return_customer_notifications SET status='uncertain',updated_at=now()
    WHERE batch_id=$1 AND status='sending' AND updated_at<now()-interval '2 minutes'`, [batchId]);
  const existing = await query(`SELECT * FROM return_customer_notifications
    WHERE batch_id=$1 AND reference_key=$2 AND channel=$3 AND recipient=$4`,
  [batchId, message.referenceKey, recipient.channel, recipient.recipient]);
  return existing.rows[0];
}

async function reserveNotification(record, message, recipient, operator) {
  const attempts = await query(`SELECT COALESCE(sum(attempts_today),0) AS total FROM return_customer_notifications
    WHERE batch_id=$1 AND attempt_date=CURRENT_DATE`, [record.batchId]);
  if (Number(attempts.rows[0].total) >= 10) {
    throw Object.assign(new Error('This return has reached its daily customer message limit. Contact an administrator.'), { status: 429 });
  }
  const saved = await query(`INSERT INTO return_customer_notifications
    (batch_id,reference_key,channel,recipient,status,message_text,operator_id)
    VALUES($1,$2,$3,$4,'sending',$5,$6)
    ON CONFLICT(batch_id,reference_key,channel,recipient) DO UPDATE
      SET status='sending',updated_at=now(),attempt_date=CURRENT_DATE,
          attempts_today=CASE WHEN return_customer_notifications.attempt_date=CURRENT_DATE
            THEN return_customer_notifications.attempts_today+1 ELSE 1 END
      WHERE return_customer_notifications.status='failed'
    RETURNING *`, [record.batchId, message.referenceKey, recipient.channel, recipient.recipient, message.text, operator.id]);
  if (!saved.rows[0]) { throw Object.assign(new Error('This message is already being processed.'), { status: 409 }); }
  return saved.rows[0];
}

export function createReturnNotificationService({ transport = returnNotificationTransport } = {}) {
  async function claim({ recordId, operator, recipient }) {
    return withTransaction(async () => {
      const first = await authorizedReturn(recordId, operator);
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`return-notification:${first.batchId}`]);
      await query('SELECT id FROM return_records WHERE batch_id=$1 ORDER BY id FOR SHARE', [first.batchId]);
      const record = await authorizedReturn(recordId, operator);
      const batch = await listReturnRecords({ batchId: record.batchId, limit: 10 });
      for (const sibling of batch.records) {
        if (sibling.operatorId !== operator.id) { throw Object.assign(new Error('Return record was not found.'), { status: 404 }); }
        assertOperatorYard(operator, sibling.receivingLocationId);
      }
      const message = buildReturnNotification(batch.records);
      const existing = await existingNotification(record.batchId, message, recipient);
      if (existing && existing.status !== 'failed') { return { replay: result(existing, true) }; }
      await transport.checkReady(recipient.channel);
      const row = await reserveNotification(record, message, recipient, operator);
      return { row, message: { ...message, ...recipient } };
    });
  }
  async function send(input) {
    const recipient = normalizeReturnRecipient(input.recipient);
    const claimed = await claim({ ...input, recipient });
    if (claimed.replay) { return claimed.replay; }
    let status = 'sent';
    let providerId = '';
    try { providerId = (await transport.send(claimed.message)).providerId || ''; }
    catch (error) { status = error.deliveryStatus === 'failed' ? 'failed' : 'uncertain'; }
    const saved = await query(`UPDATE return_customer_notifications SET status=$2,provider_id=$3,updated_at=now()
      WHERE id=$1 RETURNING *`, [claimed.row.id, status, providerId]);
    return result(saved.rows[0]);
  }
  return { send };
}

export const returnNotifications = createReturnNotificationService();
