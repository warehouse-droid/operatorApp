// @ts-check

import { query } from "./db.js";

export const SALES_STOCK_REQUEST_OVER_AVAILABILITY_FLAG_KEY = "sales_stock_request_over_availability";

/**
 * Sales over-availability requests are opt-in and fail closed. This policy
 * affects request submission/editing only. SCM still refreshes inventory, but
 * an authorized SCM user may intentionally convert or revise the full demand
 * as a Transfer Order backorder.
 *
 * @param {{queryFn?: typeof query}} [options]
 */
export async function getSalesStockRequestAvailabilityPolicy({ queryFn = query } = {}) {
  const result = await queryFn(
    `SELECT enabled, revision, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = $1
      LIMIT 1`,
    [SALES_STOCK_REQUEST_OVER_AVAILABILITY_FLAG_KEY]
  );
  const row = result.rows?.[0];
  return {
    allowOverAvailability: row?.enabled === true,
    revision: row ? Number(row.revision) : null,
    updatedAt: row?.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row?.updated_at ?? null
  };
}
