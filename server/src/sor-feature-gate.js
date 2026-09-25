import { query } from './db.js';

export async function isSorFeatureEnabled() {
  const result = await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='sor_rental_workflow'");
  return result.rows[0]?.enabled === true;
}

export function containsSorOrder(order = {}) {
  if (order.orderKind === 'sor_rental_return') { return true; }
  if ([order.id, order.refNumber, order.parentOrderRef, ...(order.childOrders || [])]
    .some(ref => /^SOR\d+(?:-S\d+)?(?:-Return)?$/iu.test(String(ref || '').trim()))) { return true; }
  return (order.childOrderDetails || []).some(containsSorOrder);
}

export async function filterSorPlanningOrders(orders = []) {
  if (!orders.some(containsSorOrder) || await isSorFeatureEnabled()) { return orders; }
  return orders.filter(order => !containsSorOrder(order));
}
