// @ts-check
import { query, withTransaction } from './db.js';
import { writeAudit } from './auth-repository.js';
import { trackSemanticAudit } from './audit-context.js';
import { assertOperatorOrderYard } from './operator-yard-authorization.js';
import { assertOperatorYard, operatorYardForbidden } from './operator-yard-access.js';
import { outboundOrderYards } from './outbound-location-domain.js';

/** @param {string} message */
function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'OPERATOR_POPUP_INVALID' });
}

/** @param {unknown} value @param {string} name @param {number} max @param {boolean} [optional] */
function text(value, name, max, optional = false) {
  if (optional && (value === undefined || value === null)) { return ''; }
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw invalid(`Invalid popup ${name}.`);
  }
  return value.trim();
}

/** @param {Record<string, any>} body */
export function normalizeOperatorPopupEvent(body) {
  const popupId = text(body.popupId, 'ID', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(popupId)) { throw invalid('Invalid popup ID.'); }
  const action = text(body.action, 'action', 12);
  if (!['queued', 'displayed', 'opened', 'dismissed'].includes(action)) { throw invalid('Invalid popup action.'); }
  const visibility = text(body.visibility, 'visibility', 7);
  if (!['visible', 'hidden'].includes(visibility) || (action === 'displayed' && visibility !== 'visible')) { throw invalid('Invalid popup visibility.'); }
  const clientTime = text(body.clientTime, 'client time', 35);
  if (!Number.isFinite(Date.parse(clientTime))) { throw invalid('Invalid popup client time.'); }
  const permission = text(body.notificationPermission, 'notification permission', 12);
  if (!['granted', 'denied', 'default', 'unsupported'].includes(permission)) { throw invalid('Invalid notification permission.'); }
  return {
    popupId: popupId.toLowerCase(), action, visibility, clientTime, notificationPermission: permission,
    orderId: text(body.orderId, 'order', 100), notificationKey: text(body.notificationKey, 'key', 512),
    planDate: text(body.planDate, 'plan date', 10, true), truck: text(body.truck, 'truck', 100, true),
    load: text(body.load, 'load', 100, true), parkingSpot: text(body.parkingSpot, 'parking spot', 100, true)
  };
}

/** @param {import('./operator-yard-access.js').OperatorYardAccount} operator @param {Record<string, any>} body */
export async function recordOperatorPopupEvent(operator, body = {}) {
  const event = normalizeOperatorPopupEvent(body);
  const locationId = assertOperatorYard(operator, body.locationId);
  const order = await assertOperatorOrderYard(operator, event.orderId);
  if (!outboundOrderYards(order).includes(locationId)) { throw operatorYardForbidden(); }
  const action = `delivery.popup.${event.action}`;
  return withTransaction(async () => {
    // The indexed action/time range bounds retries; client retries expire in seconds.
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`operator-popup:${operator.id}:${event.popupId}:${event.action}`]);
    const previous = await query(`SELECT id FROM delivery_audit_log
      WHERE action=$1 AND actor_operator_id=$2 AND source='operator-popup'
        AND created_at >= now() - interval '48 hours' AND details->>'popupId'=$3 LIMIT 1`,
    [action, operator.id, event.popupId]);
    if (previous.rowCount) {
      await trackSemanticAudit(Promise.resolve());
      return { recorded: true, replay: true };
    }
    await writeAudit({ actorOperatorId: operator.id, source: 'operator-popup', action,
      orderId: /^-?\d+$/.test(String(order.netsuite_id)) ? order.netsuite_id : null,
      details: { ...event, orderRef: order.tranid, orderId: String(order.netsuite_id), locationId,
        channel: 'in_app', clientReported: true } });
    return { recorded: true, replay: false };
  });
}
