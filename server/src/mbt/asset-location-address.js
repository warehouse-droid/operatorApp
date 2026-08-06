// @ts-check

/** @param {unknown} value */
function text(value) {
  return String(value ?? "").trim();
}

/** @param {unknown[]} parts */
function address(parts) {
  return parts.map(text).filter(Boolean).join(", ");
}

/**
 * Resolve an asset address from local master data. Callers pass the query
 * surface that belongs to their current transaction, so the movement and its
 * materialized address can never commit independently.
 *
 * @param {{query: (sql: string, values?: unknown[]) => Promise<{rows: Record<string, unknown>[], rowCount?: number | null}>}} database
 * @param {{kind: string, reference?: string | null, yardId?: string | null, customerSiteProfileId?: string | null, dumpSiteId?: string | null, truckId?: string | null}} location
 */
// eslint-disable-next-line complexity
export async function resolveMbtAssetLocationAddress(database, location) {
  const fallback = text(location.reference) || "Unknown";
  if (location.kind === "yard" && location.yardId) {
    const result = await database.query(
      `SELECT address_line_1, address_line_2, city, region, postal_code
         FROM mbt_yards WHERE yard_id = $1 FOR KEY SHARE`,
      [location.yardId]
    );
    const row = result.rows[0];
    return row ? address([
      row.address_line_1, row.address_line_2, row.city, row.region, row.postal_code
    ]) || fallback : fallback;
  }
  if (location.kind === "customer_site" && location.customerSiteProfileId) {
    const result = await database.query(
      `SELECT address.address_line_1, address.address_line_2, address.address_line_3,
              address.city, address.region, address.postal_code
         FROM mbt_customer_site_profiles site
         JOIN netsuite_customer_addresses address
           ON address.customer_netsuite_id = site.customer_netsuite_id
          AND address.address_id = site.address_id
        WHERE site.site_profile_id = $1
        FOR KEY SHARE OF site, address`,
      [location.customerSiteProfileId]
    );
    const row = result.rows[0];
    return row ? address([
      row.address_line_1, row.address_line_2, row.address_line_3,
      row.city, row.region, row.postal_code
    ]) || fallback : fallback;
  }
  if (location.kind === "dump_site" && location.dumpSiteId) {
    const result = await database.query(
      `SELECT address_line_1, address_line_2, city, region, postal_code
         FROM mbt_dump_sites WHERE dump_site_id = $1 FOR KEY SHARE`,
      [location.dumpSiteId]
    );
    const row = result.rows[0];
    return row ? address([
      row.address_line_1, row.address_line_2, row.city, row.region, row.postal_code
    ]) || fallback : fallback;
  }
  if (location.kind === "truck" && location.truckId) {
    const result = await database.query(
      "SELECT plate FROM dispatch_trucks WHERE id = $1 FOR KEY SHARE",
      [location.truckId]
    );
    const plate = text(result.rows[0]?.plate);
    return plate ? `In transit on ${plate}` : fallback === "Unknown" ? "In transit" : fallback;
  }
  return fallback;
}
