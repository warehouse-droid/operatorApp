// @ts-check
import { AsyncLocalStorage } from "node:async_hooks";
import { hasActiveTransaction, query, withTransaction } from "./db.js";
import { consolidationError } from "./consolidation-load-domain.js";

const batchContext = new AsyncLocalStorage();
const ORDER_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))";
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * @typedef {object} OrderLockOptions
 * @property {number} [lockTimeoutMs] Fail instead of queueing once this wait is exceeded.
 * @property {() => Error} [onLockTimeout] Error to throw when the wait times out.
 */

/** @param {string} batchId @param {() => Promise<any>} callback */
export function withConsolidatedLoadContext(batchId, callback) { return batchContext.run(batchId, callback); }

/**
 * The order identities that every individual, grouped and consolidated load
 * mutation locks for one delivery order.
 *
 * @param {Record<string, any>} order
 */
export function deliveryLoadLockOrderIds(order) {
  return [order.netsuite_id, ...(order.child_orders || []).map((/** @type {any} */ child) => child.netsuite_id)];
}

/** @param {string} id @param {OrderLockOptions} options */
async function lockOrder(id, { lockTimeoutMs, onLockTimeout } = {}) {
  const key = `operator-delivery-load:${id}`;
  if (!lockTimeoutMs || !hasActiveTransaction()) {
    await query(ORDER_LOCK_SQL, [key]);
    return;
  }
  // Bound only this wait. The previous value is restored so later statements in
  // the same transaction keep their normal lock behavior.
  const previous = String((await query("SELECT current_setting('lock_timeout') AS value")).rows[0].value);
  await query("SELECT set_config('lock_timeout', $1, true)", [`${Math.max(1, Math.round(lockTimeoutMs))}ms`]);
  try {
    await query(ORDER_LOCK_SQL, [key]);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === LOCK_NOT_AVAILABLE && onLockTimeout) throw onLockTimeout();
    throw error;
  }
  await query("SELECT set_config('lock_timeout', $1, true)", [previous]);
}

/**
 * Take the per-order load locks in one global (sorted) order without any
 * consolidation-claim check.
 *
 * @param {unknown[]} orderIds @param {OrderLockOptions} [options]
 */
export async function lockDeliveryLoadOrders(orderIds, options = {}) {
  const ids = [...new Set(orderIds.map(String))].sort();
  for (const id of ids) await lockOrder(id, options);
  return ids;
}

/** @param {unknown[]} orderIds @param {OrderLockOptions} [options] */
export async function lockConsolidatedLoadOrders(orderIds, options = {}) {
  const ids = await lockDeliveryLoadOrders(orderIds, options);
  const claimed = await query(`SELECT order_id FROM operator_consolidated_load_claims
    WHERE active AND order_id=ANY($1::text[]) AND batch_id::text<>$2 LIMIT 1`, [ids, batchContext.getStore() || ""]);
  if (claimed.rowCount) throw consolidationError("This order belongs to a pending Consolidation Load.", "CONSOLIDATION_LOAD_ORDER_CLAIMED");
}

/**
 * @param {() => Promise<any>} readOrder @param {() => Promise<any>} callback
 * @param {OrderLockOptions} [options]
 */
export function withConsolidatedLoadMutation(readOrder, callback, options = {}) {
  return withTransaction(async () => {
    const order = await readOrder();
    if (order) await lockConsolidatedLoadOrders(deliveryLoadLockOrderIds(order), options);
    return callback();
  });
}
