import { query, withTransaction } from './db.js';

/** @typedef {{operatorId?:string,audience?:string}} Recipient */
/** @param {string} message @param {number} status */
const invalid = (message, status) => Object.assign(new Error(message), { status, code: 'SPECIAL_DELIVERY_METHOD_ALERT' });

/** @param {Recipient} context */
function assertRecipient(context) {
  if (!context.operatorId || !['scm', 'dispatch'].includes(context.audience || '')) {
    throw invalid('An authenticated SCM or Dispatch recipient is required.', 400);
  }
}

/** @param {Recipient} [context] */
export async function listSpecialDeliveryMethodAlerts(context = {}) {
  assertRecipient(context);
  const { rows } = await query(`SELECT event.id, event.request_id, request.request_ref, event.details, event.created_at
    FROM sales_special_stock_events event JOIN sales_stock_requests request ON request.id=event.request_id
    WHERE event.event_type='special_delivery_method_updated' AND event.details->>'notifyTeams'='true'
      AND NOT EXISTS (SELECT 1 FROM special_delivery_method_alert_receipts receipt
        WHERE receipt.event_id=event.id AND receipt.operator_id=$1 AND receipt.audience=$2)
    ORDER BY event.id LIMIT 50`, [context.operatorId, context.audience]);
  return { alerts: rows.map(/** @param {Record<string,any>} row */ row => ({ id: Number(row.id), requestId: Number(row.request_id),
    requestRef: row.request_ref, audience: context.audience, beforeMethod: row.details.before,
    fulfillmentMethod: row.details.fulfillmentMethod, yardName: row.details.yardName || '',
    salesOrderRef: row.details.salesOrderRef || '', purchaseOrderRef: row.details.purchaseOrderRef || '',
    purchaseOrderReference: row.details.purchaseOrderReference || '', createdAt: row.created_at })) };
}

/** @param {unknown} eventId @param {Record<string,unknown>} [_input] @param {Recipient} [context] */
export async function acknowledgeSpecialDeliveryMethodAlert(eventId, _input = {}, context = {}) {
  assertRecipient(context);
  const id = Number(eventId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw invalid('A valid delivery change notice is required.', 400);
  }
  return withTransaction(async () => {
    const { rows } = await query(`SELECT id FROM sales_special_stock_events WHERE id=$1
      AND event_type='special_delivery_method_updated' AND details->>'notifyTeams'='true' FOR SHARE`, [id]);
    if (!rows.length) {
      throw invalid('This delivery change notice is unavailable.', 404);
    }
    await query(`INSERT INTO special_delivery_method_alert_receipts(operator_id,audience,event_id)
      VALUES($1,$2,$3) ON CONFLICT(operator_id,audience,event_id) DO NOTHING`, [context.operatorId, context.audience, id]);
    return { acknowledged: true };
  });
}
