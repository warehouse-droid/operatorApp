import { query, withTransaction } from "./db.js";
import { fetchVendorItemCodesFromNetSuite } from "./netsuite.js";

function ids(values = []) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
}

function mapped(row) {
  return {
    itemId: Number(row.item_id),
    vendorId: Number(row.vendor_id),
    subsidiaryId: Number(row.subsidiary_id) || null,
    vendorCode: row.vendor_code,
    source: row.source,
    preferredVendor: row.preferred_vendor === true,
    syncedAt: row.synced_at
  };
}

export async function getSmartScmVendorItemCodes({ vendorId, itemIds = [], subsidiaryId = null } = {}) {
  const vendor = Number(vendorId);
  const itemIdList = ids(itemIds);
  if (!Number.isInteger(vendor) || vendor <= 0 || !itemIdList.length) return [];
  const subsidiary = Number(subsidiaryId);
  const requestedSubsidiary = Number.isInteger(subsidiary) && subsidiary > 0 ? subsidiary : 0;
  const result = await query(
    `SELECT *
       FROM scm_netsuite_vendor_item_codes
      WHERE vendor_id = $1
        AND item_id = ANY($2::bigint[])
        AND ($3::bigint = 0 OR subsidiary_id IN (0, $3))
      ORDER BY item_id,
               CASE
                 WHEN $3 > 0 AND subsidiary_id = $3 THEN 0
                 WHEN $3 > 0 AND subsidiary_id = 0 THEN 1
                 ELSE 0
               END,
               CASE WHEN source = 'item_vendor' THEN 0 ELSE 1 END,
               preferred_vendor DESC,
               CASE WHEN subsidiary_id = 0 THEN 1 ELSE 0 END,
               subsidiary_id,
               synced_at DESC,
               vendor_code`,
    [vendor, itemIdList, requestedSubsidiary]
  );
  const unique = new Map();
  for (const row of result.rows) if (!unique.has(Number(row.item_id))) unique.set(Number(row.item_id), mapped(row));
  return [...unique.values()];
}

export async function refreshSmartScmVendorItemCodes({ vendorId, itemIds = [], subsidiaryId = null } = {}) {
  const vendor = Number(vendorId);
  const itemIdList = ids(itemIds);
  if (!Number.isInteger(vendor) || vendor <= 0) throw Object.assign(new Error("A valid NetSuite vendor is required."), { status: 400 });
  if (!itemIdList.length) return [];
  const fetched = await fetchVendorItemCodesFromNetSuite({ vendorId: vendor, itemIds: itemIdList, subsidiaryId });
  await withTransaction(async () => {
    for (const code of fetched) {
      await query(
        `INSERT INTO scm_netsuite_vendor_item_codes (
           item_id, vendor_id, subsidiary_id, vendor_code, source,
           preferred_vendor, synced_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now(), now())
         ON CONFLICT (item_id, vendor_id, subsidiary_id) DO UPDATE SET
           vendor_code = EXCLUDED.vendor_code,
           source = EXCLUDED.source,
           preferred_vendor = EXCLUDED.preferred_vendor,
           synced_at = now(),
           updated_at = now()`,
        [code.itemId, vendor, Number(code.subsidiaryId) || 0, code.vendorCode, code.source, code.preferredVendor === true]
      );
    }
  });
  return getSmartScmVendorItemCodes({ vendorId: vendor, itemIds: itemIdList, subsidiaryId });
}

export async function resolveSmartScmVendorItemCodes(options = {}) {
  const cached = await getSmartScmVendorItemCodes(options);
  const requested = ids(options.itemIds);
  const cachedIds = new Set(cached.map((row) => row.itemId));
  const missing = requested.filter((itemId) => !cachedIds.has(itemId));
  if (!missing.length) return cached;
  await refreshSmartScmVendorItemCodes({ ...options, itemIds: missing });
  return getSmartScmVendorItemCodes(options);
}
