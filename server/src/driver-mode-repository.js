// @ts-check

import { query } from "./db.js";

export const DRIVER_OFFLINE_MODE_FLAG_KEY = "driver_offline_mode";

/**
 * Offline capability is opt-in. A deployment that has not applied the setting
 * migration therefore remains usable online without silently enabling local
 * route or evidence storage.
 *
 * @param {{queryFn?: typeof query}} [options]
 */
export async function getDriverOfflineMode({ queryFn = query } = {}) {
  const result = await queryFn(
    `SELECT enabled, revision, updated_at
       FROM mbt_feature_flags
      WHERE flag_key = $1
      LIMIT 1`,
    [DRIVER_OFFLINE_MODE_FLAG_KEY]
  );
  const row = result.rows?.[0];
  if (!row) {
    return { enabled: false, revision: null, updatedAt: null };
  }
  return {
    enabled: row.enabled === true,
    revision: Number(row.revision),
    updatedAt: row.updated_at ?? null
  };
}
