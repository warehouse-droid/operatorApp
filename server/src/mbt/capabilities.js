// @ts-check

/** @param {string} reason */
function denied(reason) {
  return {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason
  };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.mbtEnabled]
 * @param {boolean} [options.capabilityEnabled]
 * @param {boolean} [options.requiresNetSuiteWrite]
 * @param {boolean} [options.netSuiteWritesEnabled]
 */
export function evaluateCapability({
  mbtEnabled = false,
  capabilityEnabled = false,
  requiresNetSuiteWrite = false,
  netSuiteWritesEnabled = false
} = {}) {
  if (mbtEnabled !== true) {
    return denied("mbt_disabled");
  }
  if (capabilityEnabled !== true) {
    return denied("capability_disabled");
  }
  if (requiresNetSuiteWrite === true && netSuiteWritesEnabled !== true) {
    return denied("netsuite_writes_disabled");
  }

  return {
    enabled: true,
    code: null,
    reason: null
  };
}
