// @ts-check

import { MbtError } from "./errors.js";
import { canonicalJson } from "./canonical-json.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function objectRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {unknown} order @returns {order is Record<string, unknown>} */
export function isBinDispatchOrder(order) {
  if (!objectRecord(order)) {
    return false;
  }
  return String(order.type || "").trim().toUpperCase() === "BIN"
    || objectRecord(order.mbt);
}

/** @param {unknown} plan @returns {Record<string, unknown>[]} */
export function binDispatchOrders(plan) {
  const planRecord = objectRecord(plan) ? plan : {};
  /** @type {Record<string, unknown>[]} */
  const found = [];
  /** @type {Set<object>} */
  const seen = new Set();
  /** @param {unknown} order */
  const visit = (order) => {
    const pending = [order];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!objectRecord(current) || seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (isBinDispatchOrder(current)) {
        found.push(current);
      }
      const children = Array.isArray(current.childOrderDetails) ? current.childOrderDetails : [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push(children[index]);
      }
    }
  };
  for (const order of Array.isArray(planRecord.orders) ? planRecord.orders : []) {
    visit(order);
  }
  for (const truck of Array.isArray(planRecord.trucks) ? planRecord.trucks : []) {
    if (!objectRecord(truck)) {
      continue;
    }
    for (const load of Array.isArray(truck.loads) ? truck.loads : []) {
      if (!objectRecord(load)) {
        continue;
      }
      for (const stop of Array.isArray(load.stops) ? load.stops : []) {
        visit(stop);
      }
    }
  }
  return found;
}

/** @param {unknown} order */
export function serializeBinDispatchSnapshot(order) {
  if (!isBinDispatchOrder(order)) {
    throw new TypeError("A BIN dispatch order snapshot is required.");
  }
  return canonicalJson(order);
}

/**
 * @param {unknown} plan
 * @param {object} [options]
 * @param {string} [options.operation]
 * @param {boolean} [options.environmentEnabled]
 * @param {boolean} [options.databaseEnabled]
 */
export function assertBinDispatchCapability(plan, {
  operation = "save",
  environmentEnabled = false,
  databaseEnabled = false
} = {}) {
  if (binDispatchOrders(plan).length === 0) {
    return true;
  }
  if (environmentEnabled === true && databaseEnabled === true) {
    return true;
  }
  throw new MbtError({
    status: 409,
    code: "MBT_CAPABILITY_DISABLED",
    message: "BIN dispatch is disabled.",
    details: { capability: "bin_dispatch", operation: String(operation) }
  });
}

/** @param {unknown} plan */
export function assertNoDriverBinMaterialization(plan) {
  if (binDispatchOrders(plan).length === 0) {
    return true;
  }
  throw new MbtError({
    status: 409,
    code: "MBT_DRIVER_BIN_DISABLED",
    message: "Driver BIN execution is disabled in Phase 1."
  });
}
