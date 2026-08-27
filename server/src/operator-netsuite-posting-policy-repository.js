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
  if (gateKey) {
    const result = await query(
      `SELECT enabled, revision
         FROM mbt_feature_flags
        WHERE flag_key = $1
        ${lock ? "FOR SHARE" : ""}`,
      [gateKey]
    );
    if (result.rows[0]) {
      flag = {
        enabled: result.rows[0].enabled === true,
        revision: Number(result.rows[0].revision)
      };
    }
  }
  return materializeOperatorNetSuitePostingPolicy({
    functionKey,
    locationId,
    flag,
    directAccessEnabled: directAccessEnabled === true
  });
}
