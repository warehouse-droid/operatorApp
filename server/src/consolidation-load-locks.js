// @ts-check
import { AsyncLocalStorage } from "node:async_hooks";
import { query, withTransaction } from "./db.js";
import { consolidationError } from "./consolidation-load-domain.js";

const batchContext = new AsyncLocalStorage();
/** @param {string} batchId @param {() => Promise<any>} callback */
export function withConsolidatedLoadContext(batchId, callback) { return batchContext.run(batchId, callback); }
/** @param {unknown[]} orderIds */
export async function lockConsolidatedLoadOrders(orderIds) {
  const ids = [...new Set(orderIds.map(String))].sort();
  for (const id of ids) await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${id}`]);
  const claimed = await query(`SELECT order_id FROM operator_consolidated_load_claims
    WHERE active AND order_id=ANY($1::text[]) AND batch_id::text<>$2 LIMIT 1`, [ids, batchContext.getStore() || ""]);
  if (claimed.rowCount) throw consolidationError("This order belongs to a pending Consolidation Load.", "CONSOLIDATION_LOAD_ORDER_CLAIMED");
}
/** @param {() => Promise<any>} readOrder @param {() => Promise<any>} callback */
export function withConsolidatedLoadMutation(readOrder, callback) {
  return withTransaction(async () => {
    const order = await readOrder();
    if (order) await lockConsolidatedLoadOrders([order.netsuite_id, ...(order.child_orders || []).map((/** @type {any} */ child) => child.netsuite_id)]);
    return callback();
  });
}
