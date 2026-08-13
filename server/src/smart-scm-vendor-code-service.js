import { query, withTransaction } from "./db.js";
import { fetchVendorItemCodesFromNetSuite } from "./netsuite.js";

const VENDOR_PRICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function ids(values = []) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
}

function mapped(row) {
  return {
    itemId: Number(row.item_id),
    vendorId: Number(row.vendor_id),
    subsidiaryId: Number(row.subsidiary_id) || null,
    vendorCode: row.vendor_code,
    vendorPrice: row.vendor_price === null || row.vendor_price === undefined
      ? null
      : Number(row.vendor_price),
    vendorPriceSyncedAt: row.vendor_price_synced_at || null,
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
    const fetchedItemIds = new Set();
    for (const code of fetched) {
      fetchedItemIds.add(Number(code.itemId));
      await query(
         `INSERT INTO scm_netsuite_vendor_item_codes (
           item_id, vendor_id, subsidiary_id, vendor_code, source,
           preferred_vendor, vendor_price, vendor_price_synced_at, synced_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() ELSE NULL END, now(), now())
         ON CONFLICT (item_id, vendor_id, subsidiary_id) DO UPDATE SET
           vendor_code = EXCLUDED.vendor_code,
           source = EXCLUDED.source,
           preferred_vendor = EXCLUDED.preferred_vendor,
           vendor_price = CASE WHEN $8 THEN EXCLUDED.vendor_price ELSE scm_netsuite_vendor_item_codes.vendor_price END,
           vendor_price_synced_at = CASE WHEN $8 THEN now() ELSE scm_netsuite_vendor_item_codes.vendor_price_synced_at END,
           synced_at = now(),
           updated_at = now()`,
        [code.itemId, vendor, Number(code.subsidiaryId) || 0, code.vendorCode || "", code.source,
          code.preferredVendor === true, code.vendorPrice, code.vendorPriceChecked !== false]
      );
    }
    for (const itemId of itemIdList.filter((id) => !fetchedItemIds.has(id))) {
      const checked = await query(
        `UPDATE scm_netsuite_vendor_item_codes
            SET vendor_price = NULL,
                vendor_price_synced_at = now(),
                updated_at = now()
          WHERE item_id = $1
            AND vendor_id = $2
            AND ($3::bigint = 0 OR subsidiary_id IN (0, $3))`,
        [itemId, vendor, Number(subsidiaryId) || 0]
      );
      if (!checked.rowCount) {
        await query(
          `INSERT INTO scm_netsuite_vendor_item_codes (
             item_id, vendor_id, subsidiary_id, vendor_code, source,
             preferred_vendor, vendor_price, vendor_price_synced_at, synced_at, updated_at
           ) VALUES ($1, $2, $3, '', 'single_vendor_fallback', false, NULL, now(), now(), now())
           ON CONFLICT (item_id, vendor_id, subsidiary_id) DO UPDATE SET
             vendor_price = NULL,
             vendor_price_synced_at = now(),
             updated_at = now()`,
          [itemId, vendor, Number(subsidiaryId) || 0]
        );
      }
    }
  });
  return getSmartScmVendorItemCodes({ vendorId: vendor, itemIds: itemIdList, subsidiaryId });
}

export async function resolveSmartScmVendorItemCodes(options = {}) {
  const cached = await getSmartScmVendorItemCodes(options);
  const requested = ids(options.itemIds);
  const cachedByItem = new Map(cached.map((row) => [row.itemId, row]));
  const staleBefore = Date.now() - VENDOR_PRICE_CACHE_TTL_MS;
  const stale = requested.filter((itemId) => {
    const checkedAt = new Date(cachedByItem.get(itemId)?.vendorPriceSyncedAt || 0).getTime();
    return !Number.isFinite(checkedAt) || checkedAt < staleBefore;
  });
  if (!stale.length) return cached;
  try {
    await refreshSmartScmVendorItemCodes({ ...options, itemIds: stale });
  } catch (error) {
    if (cached.length) return cached.map((row) => ({ ...row, refreshError: error?.message || String(error) }));
    throw error;
  }
  return getSmartScmVendorItemCodes(options);
}
