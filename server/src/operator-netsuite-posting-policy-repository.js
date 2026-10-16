// @ts-check

import { config } from "./config.js";
import { query } from "./db.js";
import {
  materializeOperatorNetSuitePostingPolicy,
  operatorNetSuitePostingGateKey
} from "./operator-netsuite-posting-policy.js";

/**
 * Read exactly one live yard/function flag. Missing rows deliberately remain
 * distinguishable from configured-off rows and always fail closed.
 *
 * @param {object} input
 * @param {unknown} [input.functionKey]
 * @param {unknown} [input.locationId]
 * @param {unknown} [input.directAccessEnabled]
 * @param {boolean} [input.lock]
 */
export async function getOperatorNetSuitePostingPolicy({
  functionKey,
  locationId,
  directAccessEnabled = config.netsuite?.directAccessEnabled === true,
  lock = false
} = {}) {
  const gateKey = operatorNetSuitePostingGateKey({ functionKey, locationId });
  let flag = null;
  let creditMemoFlag = null;
  if (gateKey) {
    const creditMemoKey = gateKey.includes("_return_ra_") ? gateKey.replace("_return_ra_", "_return_cm_") : null;
    const result = await query(
      `SELECT flag_key, enabled, revision
         FROM mbt_feature_flags
        WHERE flag_key = ANY($1::text[])
        ORDER BY flag_key
        ${lock ? "FOR SHARE" : ""}`,
      [[gateKey, creditMemoKey].filter(Boolean)]
    );
    flag = result.rows.find(row => row.flag_key === gateKey) || null;
    creditMemoFlag = result.rows.find(row => row.flag_key === creditMemoKey) || null;
  }
  return materializeOperatorNetSuitePostingPolicy({
    functionKey,
    locationId,
    flag,
    creditMemoFlag,
    directAccessEnabled: directAccessEnabled === true
  });
}
