// @ts-check

export const DELIVERY_PACK_ROUNDING_TOLERANCE = 0.1;

/** @param {number} required @param {number} loaded @param {number} packed @param {number[]} conversions */
export function deliveryPackingRemainder(required, loaded, packed, conversions) {
  const remaining = Number((required - loaded - packed).toFixed(6));
  const smallestUnit = Math.min(...conversions.filter(value => value > 0));
  // Converted packages can differ slightly from the rounded sales quantity.
  // Never dismiss an unpacked line, sales-only shortage, or whole missing unit.
  const roundingOnly = packed > 0 && Number.isFinite(smallestUnit)
    && remaining <= DELIVERY_PACK_ROUNDING_TOLERANCE && remaining < smallestUnit;
  return remaining <= 0.000001 || roundingOnly ? 0 : remaining;
}

/** @param {string} required @param {string} loaded @param {string} packed @param {string[]} conversions */
export function deliveryPackingRemainderSql(required, loaded, packed, conversions) {
  const remaining = `ROUND(((${required}) - (${loaded}) - (${packed}))::numeric, 6)`;
  const smallestUnit = `LEAST(${conversions.map(value => `CASE WHEN ${value} > 0 THEN ${value} END`).join(", ")})`;
  return `CASE WHEN ${remaining} <= 0.000001
    OR ((${packed}) > 0 AND ${remaining} <= ${DELIVERY_PACK_ROUNDING_TOLERANCE} AND ${remaining} < ${smallestUnit})
    THEN 0 ELSE ${remaining} END`;
}
