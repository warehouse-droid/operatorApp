import { query } from "./db.js";
import { normalizeSmartScmVendorUnitPrice } from "./smart-scm-vendor-unit-price.js";

export async function applySmartScmVendorPalletUnitPrice(proposalId, values = {}) {
  if (!Object.hasOwn(values || {}, "palletUnitPrice")) {
    return { provided: false, unitPrice: null };
  }
  const unitPrice = normalizeSmartScmVendorUnitPrice(values.palletUnitPrice, "PALLET unit price");
  if (unitPrice === null) {
    await query(
      `UPDATE scm_smart_proposals
          SET pallet_item_id = NULL,
              pallet_item_name = NULL,
              pallet_unit = NULL,
              pallet_purchase_unit = NULL,
              pallet_last_purchase_price = NULL,
              pallet_price_synced_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [Number(proposalId)]
    );
    return { provided: true, unitPrice: null };
  }

  const pallet = await query(
    `SELECT item_id, item_name, stock_unit, purchase_unit
       FROM inventory_items
      WHERE UPPER(BTRIM(COALESCE(item_name, ''))) = 'PALLET'
      ORDER BY item_id
      LIMIT 2`
  );
  if (pallet.rowCount !== 1) {
    throw Object.assign(new Error("Vendor Replies needs exactly one active PALLET item before its unit price can be edited."), { status: 409 });
  }
  const item = pallet.rows[0];
  await query(
    `UPDATE scm_smart_proposals
        SET pallet_item_id = $2,
            pallet_item_name = $3,
            pallet_unit = $4,
            pallet_purchase_unit = $5,
            pallet_last_purchase_price = $6,
            pallet_price_synced_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [Number(proposalId), item.item_id, item.item_name, item.stock_unit,
      item.purchase_unit, unitPrice]
  );
  return { provided: true, unitPrice };
}
