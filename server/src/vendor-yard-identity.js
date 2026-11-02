import { query } from "./db.js";

// A vendor yard is stored as several dispatch_vendor_yards schedule rows that share
// vendor + yard name: an optional legacy summary row (for example "Mon-Fri") and one
// row per weekday. Planning data references one of those rows by id, so two
// references to the same physical yard can carry different row ids. Compare yards
// through their canonical row: the lowest active row id for the vendor + yard name,
// or the lowest row id when every row is inactive. The Item Master vendor-yard
// picker offers that same row.

export function canonicalVendorYardIdSql(idExpression) {
  return `COALESCE((
    SELECT canonical_yard.id
      FROM dispatch_vendor_yards source_yard
      JOIN dispatch_vendor_yards canonical_yard
        ON LOWER(canonical_yard.vendor) = LOWER(source_yard.vendor)
       AND LOWER(canonical_yard.yard) = LOWER(source_yard.yard)
     WHERE source_yard.id = ${idExpression}
     ORDER BY canonical_yard.active DESC, canonical_yard.id
     LIMIT 1
  ), ${idExpression})`;
}

// Same identity as a derived table (id, canonical_id) for joins over many rows,
// such as the planning policy load, so the yard table is ranked only once.
export function vendorYardIdentityTableSql() {
  return `(SELECT yard_row.id,
            FIRST_VALUE(yard_row.id) OVER (
              PARTITION BY LOWER(yard_row.vendor), LOWER(yard_row.yard)
              ORDER BY yard_row.active DESC, yard_row.id
            ) AS canonical_id
       FROM dispatch_vendor_yards yard_row)`;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function canonicalVendorYardIds(ids = []) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(positiveId).filter(Boolean))];
  const canonical = new Map();
  if (!unique.length) return canonical;
  const result = await query(
    `SELECT requested.id, ${canonicalVendorYardIdSql("requested.id")} AS canonical_id
       FROM UNNEST($1::bigint[]) AS requested(id)`,
    [unique]
  );
  for (const row of result.rows) canonical.set(Number(row.id), Number(row.canonical_id));
  return canonical;
}

export async function canonicalVendorYardId(id) {
  const requested = positiveId(id);
  if (!requested) return null;
  return (await canonicalVendorYardIds([requested])).get(requested) ?? requested;
}
