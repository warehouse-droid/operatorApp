import {query, withTransaction} from './db.js';
import {writeAudit} from './auth-repository.js';
import {normalizeMenuOrders,sanitizeStoredMenuOrders} from '../public/menu-order-model.js';

function snapshot(row) {
  return {revision: row.revision, orders: sanitizeStoredMenuOrders(row.orders),
    updatedAt: new Date(row.updated_at).toISOString()};
}

export async function getMenuOrder() {
  const result = await query('SELECT revision,orders,updated_at FROM app_menu_order_settings WHERE id=true');
  return snapshot(result.rows[0]);
}

export async function saveMenuOrder(input, operatorId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['orders', 'expectedRevision'].includes(key))
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw Object.assign(new Error('Menu orders and the current revision are required.'), {status:400});
  }
  const orders = normalizeMenuOrders(input.orders);
  return withTransaction(async () => {
    const result = await query(`UPDATE app_menu_order_settings
      SET orders=$1::jsonb, revision=revision+1, updated_by=$2, updated_at=now()
      WHERE id=true AND revision=$3 RETURNING revision,orders,updated_at`,
    [JSON.stringify(orders), operatorId, input.expectedRevision]);
    if (!result.rowCount) {
      throw Object.assign(new Error('Menu order changed since you loaded it. Reload before saving.'), {status:409});
    }
    const saved = snapshot(result.rows[0]);
    await writeAudit({actorOperatorId:operatorId, source:'admin', action:'menu_order.saved',
      details:{revision:saved.revision, orders:saved.orders}});
    return saved;
  });
}
