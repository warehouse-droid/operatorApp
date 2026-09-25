import { query, withTransaction } from './db.js';
import { writeAudit } from './auth-repository.js';
import { enqueueDelayedStatusRefresh } from './netsuite-delayed-status-refresh-repository.js';
import { enqueueDispatchOrderCatalogRefresh } from './dispatch-order-catalog-repository.js';
import { enqueueScmPurchaseOrderCatalogRefresh } from './scm-purchase-order-catalog-repository.js';
import { enqueueNetSuiteMirrorOrderEvent } from './netsuite-mirror-repository.js';

function positiveIdentity(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError('Invalid NetSuite PO weight identity.');
  }
  return id;
}

function sourceWeight(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0) {
    throw new TypeError('Invalid NetSuite PO item weight.');
  }
  return weight;
}

export function normalizePurchaseOrderWeightLines(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError('NetSuite PO weight lines must be an array.');
  }
  const seen = new Set();
  return lines.map(line => {
    const lineId = positiveIdentity(line.line_id);
    const itemId = positiveIdentity(line.item_id);
    if (seen.has(lineId)) {
      throw new TypeError('Duplicate NetSuite PO weight line identity.');
    }
    seen.add(lineId);
    return { line_id: lineId, item_id: itemId, item_weight: sourceWeight(line.item_weight) };
  });
}

// Traverse only the authoritative active split ledger, never item-name matches.
function weightTargetsSql(roots) {
  return `WITH RECURSIVE targets AS (
    ${roots}
    UNION
    SELECT parent.root_order_id, parent.root_ref, child.id, parent.item_id, parent.item_weight
      FROM targets parent
      JOIN dispatch_scm_po_split_lines ledger ON ledger.source_line_id = parent.line_row_id
      JOIN dispatch_scm_po_splits split ON split.id = ledger.split_id AND split.status = 'active'
      JOIN purchase_order_lines child ON child.id = ledger.split_line_id
        AND child.item_id = parent.item_id AND COALESCE(child.netsuite_active, true)
      JOIN purchase_orders child_order ON child_order.netsuite_id = child.purchase_order_id
        AND COALESCE(child_order.netsuite_active, true)
  )`;
}

export async function enqueuePurchaseOrderWeightRefreshes(itemIds = []) {
  const ids = [...new Set(itemIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) {
    return { queued: 0 };
  }
  const result = await query(`${weightTargetsSql(`
    SELECT po.netsuite_id AS root_order_id, po.tranid AS root_ref,
           line.id AS line_row_id, line.item_id, item.item_weight
      FROM purchase_orders po
      JOIN purchase_order_lines line ON line.purchase_order_id = po.netsuite_id
      JOIN inventory_items item ON item.item_id = line.item_id
     WHERE po.netsuite_id > 0 AND COALESCE(po.netsuite_active, true)
       AND COALESCE(line.netsuite_active, true) AND line.item_id = ANY($1::bigint[])
  `)}
    SELECT DISTINCT target.root_order_id, target.root_ref
      FROM targets target
      JOIN purchase_order_lines line ON line.id = target.line_row_id
     WHERE line.item_weight IS DISTINCT FROM target.item_weight
     ORDER BY target.root_order_id`, [ids]);
  for (const order of result.rows) {
    await enqueueDelayedStatusRefresh({ orderType: 'purchase_order', netsuiteOrderId: order.root_order_id,
      tranid: order.root_ref, availableAt: new Date() });
  }
  return { queued: result.rowCount };
}

async function notifyWeightChanges(orderId, changes) {
  if (!changes.length) {
    return;
  }
  await writeAudit({ actorType: 'system', source: 'netsuite', orderId,
    action: 'netsuite.purchase_order.item_weight_refresh', details: { source: 'live NetSuite item.weight', changes } });
  const orders = await query('SELECT netsuite_id, tranid FROM purchase_orders WHERE netsuite_id = ANY($1::bigint[]) ORDER BY netsuite_id',
    [[...new Set(changes.map(line => line.purchase_order_id))]]);
  for (const order of orders.rows) {
    await enqueueDispatchOrderCatalogRefresh({ orderRef: order.tranid, orderType: 'PO', source: 'po-item-weight-refresh' });
    await enqueueScmPurchaseOrderCatalogRefresh({ orderRef: order.tranid, source: 'po-item-weight-refresh' });
    await enqueueNetSuiteMirrorOrderEvent('purchase_order', order.netsuite_id);
  }
}

export async function applyPurchaseOrderItemWeights({ netsuiteOrderId, lines }) {
  const orderId = positiveIdentity(netsuiteOrderId);
  const weights = normalizePurchaseOrderWeightLines(lines);
  if (!weights.length) {
    return { updated: 0 };
  }
  return withTransaction(async () => {
    const changed = await query(`${weightTargetsSql(`
      SELECT po.netsuite_id AS root_order_id, po.tranid AS root_ref,
             line.id AS line_row_id, line.item_id, weight.item_weight
        FROM purchase_orders po
        JOIN purchase_order_lines line ON line.purchase_order_id = po.netsuite_id
        JOIN jsonb_to_recordset($2::jsonb) AS weight(line_id bigint, item_id bigint, item_weight numeric)
          ON weight.line_id = line.line_id AND weight.item_id = line.item_id
       WHERE po.netsuite_id = $1 AND COALESCE(po.netsuite_active, true)
         AND COALESCE(line.netsuite_active, true)
    `)}, changed AS MATERIALIZED (
      SELECT line.id, line.item_weight AS previous_weight, target.item_weight
        FROM targets target
        JOIN purchase_order_lines line ON line.id = target.line_row_id
          AND line.item_id = target.item_id AND COALESCE(line.netsuite_active, true)
       WHERE line.item_weight IS DISTINCT FROM target.item_weight
       ORDER BY line.id
       FOR UPDATE OF line
    )
    UPDATE purchase_order_lines line SET item_weight = changed.item_weight
      FROM changed WHERE line.id = changed.id
    RETURNING line.purchase_order_id, line.line_id, line.item_id, changed.previous_weight, line.item_weight`,
    [orderId, JSON.stringify(weights)]);
    await notifyWeightChanges(orderId, changed.rows);
    return { updated: changed.rowCount };
  });
}
