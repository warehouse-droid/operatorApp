// @ts-check
import { query } from './db.js';
import { assertSplitLineQuantities, splitLineIdentity, splitQuantityError } from './dispatch-split-quantity-domain.js';

/** @param {any} value */
const text = value => String(value ?? '').trim();
/** @param {any} order */
function signature(order) {
  const items = /** @type {any[]} */ (order.items || []);
  return JSON.stringify(items.map(line => [
    splitLineIdentity(line), text(line.itemId ?? line.item_id), text(line.unit || 'QTY').toUpperCase(),
    Number(line.quantity), ...['pallets', 'layers', 'sections', 'pieces'].map(field => Number(line[field] || 0))
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
/** @param {any[]} orders @param {Map<string, any>} [found] @param {number} [depth] */
function collect(orders, found = new Map(), depth = 0) {
  if (depth > 20) throw splitQuantityError('Split order nesting is too deep. Refresh Orders.');
  for (const order of orders) {
    const ref = text(order.id), kind = text(order.type).toUpperCase();
    if (['SO', 'TO'].includes(kind) && /-S[1-9][0-9]*$/u.test(ref)) {
      const parent = text(order.originalOrderId) || ref.replace(/-S[0-9]+$/u, '');
      if (ref.replace(/-S[0-9]+$/u, '') !== parent) throw splitQuantityError(`${ref}: split parent does not match its reference.`);
      const previous = found.get(ref);
      if (previous && (previous.kind !== kind || signature(previous.order) !== signature(order))) {
        throw splitQuantityError(`${ref}: conflicting copies of the split were submitted.`);
      }
      found.set(ref, { ref, kind, parent, order });
    }
    if (Array.isArray(order.childOrderDetails)) collect(order.childOrderDetails, found, depth + 1);
  }
  return found;
}
/** Called under the existing fleet transaction lock, before either plan-save path writes.
 * Unchanged historical definitions are evidence, not a request to repair old totals.
 * @param {any} plan @param {{previousPlan?: any}} [options] */
export async function assertDispatchSplitQuantityChanges(plan, { previousPlan = {} } = {}) {
  const incoming = collect(plan.orders || []);
  if (!incoming.size) return;
  const parents = [...new Set([...incoming.values()].map(row => row.parent))];
  /** @type {any[]} */
  const stored = (await query(`SELECT split_ref,order_type,parent_order_ref,full_order,active
    FROM dispatch_global_order_splits WHERE parent_order_ref=ANY($1::text[]) AND definition_kind='split'`,
  [parents])).rows;
  const byRef = new Map(stored.map(row => [row.split_ref, row]));
  const previous = collect(previousPlan.orders || []);
  const changed = [...incoming.values()].filter(row => {
    const saved = byRef.get(row.ref);
    if (saved?.active && saved.order_type === row.kind && saved.parent_order_ref === row.parent
        && signature(saved.full_order) === signature(row.order)) return false;
    const old = previous.get(row.ref);
    return !old || old.kind !== row.kind || old.parent !== row.parent || signature(old.order) !== signature(row.order);
  });
  const families = new Map(changed.map(row => [`${row.kind}:${row.parent}`, row]));
  for (const { kind, parent } of families.values()) {
    const family = new Map(stored.filter(row => row.active && row.order_type === kind && row.parent_order_ref === parent)
      .map(row => [row.split_ref, { ...row.full_order, id: row.split_ref }]));
    for (const row of incoming.values()) {
      if (row.kind === kind && row.parent === parent) family.set(row.ref, row.order);
    }
    const source = await sourceOrder(kind, parent);
    assertSplitLineQuantities(source, [...family.values()]);
  }
}
/** @param {string} kind @param {string} ref */
async function sourceOrder(kind, ref) {
  const table = kind === 'SO' ? 'sales_orders' : 'transfer_orders';
  const lines = kind === 'SO' ? 'sales_order_lines' : 'transfer_order_lines';
  const parentKey = kind === 'SO' ? 'sales_order_id' : 'transfer_order_id';
  const result = await query(`SELECT o.netsuite_id,l.id AS "lineRowId",l.line_id AS "lineId",l.item_id AS "itemId",
    l.sku,l.item_name AS "itemName",l.quantity,l.unit,l.to_plt AS "toPlt",
    l.to_lyr AS "toLyr",l.to_sec AS "toSec",l.to_pcs AS "toPcs"
    FROM ${table} o JOIN ${lines} l ON l.${parentKey}=o.netsuite_id
    WHERE o.tranid=$1 AND o.netsuite_id>0 AND l.netsuite_active IS DISTINCT FROM false
    ${kind === 'TO' ? "AND l.line_stage='outbound'" : ''}
    ORDER BY o.netsuite_id,l.id FOR SHARE OF o,l`, [ref]);
  const rows = /** @type {any[]} */ (result.rows);
  if (!rows.length || new Set(rows.map(row => String(row.netsuite_id))).size !== 1) {
    throw splitQuantityError(`${ref}: authoritative source quantities are unavailable. Refresh Orders before splitting.`);
  }
  return { id: ref, items: rows };
}
