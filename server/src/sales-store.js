export const SALES_STORE_LOCATION_BY_ORDER_PREFIX = Object.freeze({
  SOA: 28,
  SOB: 1,
  SOM: 26
});

export function salesStoreLocationIdForOrderRef(value) {
  const prefix = String(value || "").trim().slice(0, 3).toUpperCase();
  return SALES_STORE_LOCATION_BY_ORDER_PREFIX[prefix] || null;
}

export function salesStoreLocationIdSql(orderRefExpression) {
  return `CASE LEFT(UPPER(BTRIM(COALESCE(${orderRefExpression}, ''))), 3)
    WHEN 'SOA' THEN 28::bigint
    WHEN 'SOB' THEN 1::bigint
    WHEN 'SOM' THEN 26::bigint
    ELSE NULL::bigint
  END`;
}
