// @ts-check
import {query} from './db.js';
import {locallyReopenedSalesOrderSql} from './local-sales-order-reopen.js';
import {operatorRoundedSalesQuantity} from './operator-load-quantity.js';

/** @typedef {Record<string,any>} Row */
const reference = value => String(value || '').trim().toUpperCase();
const status = value => String(value || '').trim().toLowerCase().replaceAll('_',' ').replace(/^.*:\s*/,'');

/** Use current fulfillment or complete local cargo quantities, never a stale
 * timestamp, a partial load, an inactive order or an ambiguous reference.
 * @param {Row|null} order @param {Row[]} lines */
export function linkedSalesOrderCompletion(order, lines) {
  if (!order || order.netsuite_active === false || order.locally_reopened
    || ['closed','cancelled','canceled','voided'].includes(status(order.status_text))) return null;
  if (['fulfilled','fully fulfilled','billed','fully billed','pending billing'].includes(status(order.status_text))
    || ['fulfilled','fully fulfilled'].includes(status(order.fulfillment_status))) return 'so_fulfilled';
  if (![order.local_yard_order_status,order.operator_status].some(value => ['loaded','fully loaded','shipped','fulfilled'].includes(status(value)))) return null;
  const cargo = lines.filter(line => line.netsuite_active !== false
    && !/^(othcharge|discount|markup|subtotal|description|payment|service)$/i.test(String(line.item_type || ''))
    && Number(line.quantity) !== 0);
  return cargo.length > 0 && cargo.every(line => Number.isFinite(Number(line.quantity)) && Number(line.quantity) > 0
    && Number.isFinite(Number(line.loaded_qty)) && operatorRoundedSalesQuantity(Number(line.loaded_qty),line.unit)
      >= operatorRoundedSalesQuantity(Number(line.quantity),line.unit)) ? 'so_loaded' : null;
}

/** Batch read-only evidence for both canonical and optional Backorder SO links.
 * This display projection does not replace canonical links or workflow stages.
 * @param {Row[]} details */
export async function backorderSalesOrderProgress(details) {
  const eligible = details.filter(d => d.workflowKind === 'backorder' && d.closeStatus !== 'closed' && d.status !== 'cancelled');
  const refs = [...new Set(eligible.map(d => reference(d.salesOrderRef || d.alreadyOrderedSalesOrderRef)).filter(Boolean))];
  const ids = [...new Set(eligible.map(d => d.salesOrderId).filter(Boolean))];
  const result = new Map();
  if (!refs.length && !ids.length) return result;
  const orders = (await query(`SELECT sales.netsuite_id,sales.tranid,sales.status_text,sales.netsuite_active,
      sales.fulfillment_status,sales.operator_status,sales.local_yard_order_status,
      ${locallyReopenedSalesOrderSql('sales')} AS locally_reopened
    FROM sales_orders sales WHERE sales.netsuite_id=ANY($1::bigint[]) OR upper(btrim(sales.tranid))=ANY($2::text[])`,[ids,refs])).rows;
  const lines = orders.length ? (await query(`SELECT sales_order_id,item_type,quantity,unit,loaded_qty,netsuite_active
    FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])`,[orders.map(order => order.netsuite_id)])).rows : [];
  for (const detail of eligible) {
    const ref = reference(detail.salesOrderRef || detail.alreadyOrderedSalesOrderRef);
    if (!ref && !detail.salesOrderId) continue;
    const matches = orders.filter(order => detail.salesOrderId ? String(order.netsuite_id) === String(detail.salesOrderId) : reference(order.tranid) === ref);
    const order = matches.length === 1 ? matches[0] : null;
    const source = linkedSalesOrderCompletion(order,lines.filter(line => String(line.sales_order_id) === String(order?.netsuite_id)));
    result.set(detail.id,{reference:ref,salesOrderId:order ? Number(order.netsuite_id) : null,completed:Boolean(source),source});
  }
  return result;
}
