// @ts-check
/** @typedef {{ id?: string, role?: string, roles?: string[], yardLocationIds?: number[], operatorYardLocationIds?: number[] }} OperatorYardAccount */

export const OPERATOR_YARD_LOCATION_IDS = Object.freeze([1, 28, 15, 26]);

/** @param {unknown} value */
function yardId(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return NaN;
  return Number(value);
}

/** @param {unknown} [values] @returns {number[]} */
export function normalizeOperatorYardLocationIds(values = []) {
  if (!Array.isArray(values) || values.some((value) => !OPERATOR_YARD_LOCATION_IDS.includes(yardId(value)))) {
    throw Object.assign(new Error("Invalid Operator yard authorization."), { status: 400 });
  }
  const selected = new Set(values.map(yardId));
  return OPERATOR_YARD_LOCATION_IDS.filter((id) => selected.has(id));
}

/** @param {OperatorYardAccount | null | undefined} operator */
export function operatorYardLocationIds(operator) {
  const roles = [...(Array.isArray(operator?.roles) ? operator.roles : []), operator?.role];
  if (roles.includes("admin")) return [...OPERATOR_YARD_LOCATION_IDS];
  return normalizeOperatorYardLocationIds(operator?.operatorYardLocationIds);
}

/** @param {OperatorYardAccount | null | undefined} operator */
export function requireAssignedOperatorYards(operator) {
  const allowed = operatorYardLocationIds(operator);
  if (!allowed.length) throw operatorYardForbidden("No Operator yard access assigned. Contact an administrator.");
  return allowed;
}

export function operatorYardForbidden(message = "This yard is outside your assigned Operator yards.") {
  return Object.assign(new Error(message), { status: 403, code: "OPERATOR_YARD_FORBIDDEN" });
}

/** @param {OperatorYardAccount | null | undefined} operator @param {unknown} locationId */
export function assertOperatorYard(operator, locationId) {
  const id = yardId(locationId);
  if (!requireAssignedOperatorYards(operator).includes(id)) throw operatorYardForbidden();
  return id;
}


/** @param {any} order @param {number[] | null} [allowedYards] */
export function deliveryOrderWithinYards(order, allowedYards = null) {
  return allowedYards === null || [order, ...(order.child_orders || [])]
    .every((child) => allowedYards.includes(Number(child.outbound_location_id ?? child.source_location_id)));
}
