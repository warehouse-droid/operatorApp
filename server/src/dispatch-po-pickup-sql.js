// PO cards and their linked SO cargo must use the same SCM-selected pickup.
// Aliases are internal SQL identifiers, never request values.
export function purchaseOrderPickupSql(alias) {
  const schedule = `${alias}_pickup_schedule`;
  const yard = `${alias}_pickup_yard`;
  const location = `COALESCE(NULLIF(${schedule}.pickup_point, ''), NULLIF(${alias}.dispatch_vendor_yard, ''), NULLIF(${alias}.source_location, ''), NULLIF(${alias}.vendor, ''))`;
  const scheduleJoin = `LEFT JOIN scm_transport_schedule ${schedule}
    ON ${schedule}.order_kind = 'PO'
   AND lower(${schedule}.order_ref) = lower(COALESCE(NULLIF(${alias}.dispatch_ref, ''), ${alias}.tranid))`;
  return {
    location,
    address: `COALESCE(NULLIF(${alias}.dispatch_pickup_address, ''), NULLIF(${yard}.address, ''), NULLIF(${alias}.dispatch_address, ''))`,
    scheduleJoin,
    joins: `${scheduleJoin}
      LEFT JOIN LATERAL (
        SELECT y.address FROM dispatch_vendor_yards y
         WHERE y.active = true
           AND lower(y.yard) = lower(COALESCE(NULLIF(${schedule}.pickup_point, ''), NULLIF(${alias}.dispatch_vendor_yard, '')))
         ORDER BY CASE WHEN y.day_label = 'Mon-Fri' THEN 0 ELSE 1 END, y.id
         LIMIT 1
      ) ${yard} ON true`
  };
}
