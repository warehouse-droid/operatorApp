import {normalizePackQuantities} from '../public/order-pack-quantities.js';
import {specialQuantity,normalizeSpecialRate,specialLineSubtotal} from '../public/special-stock-pricing.js';

/** @param {string} message */
function invalid(message) {
  return Object.assign(new Error(message),{status:400,code:'SPECIAL_PO_LINES_INVALID'});
}

/** Normalize only PO-owned fields; never copy them into an SO or inquiry.
 * @param {Record<string,any>} line @param {boolean} material */
export function normalizeSpecialPurchaseLine(line, material = false) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) {
    throw invalid('Review a valid PO item.');
  }
  const itemId = material ? 2055 : Number(line.itemId);
  const description = String(line.description ?? '').trim();
  const uom = String(line.uom ?? '').trim().toUpperCase();
  if (!Number.isSafeInteger(itemId) || itemId <= 0 || [1784,4981,10716].includes(itemId)
      || !description || description.length > 4000 || uom.length > 40 || (material && !uom)) {
    throw invalid('Select a PO item and enter its description and NetSuite UOM. Use the PALLET editor for pallets.');
  }
  const quantity = specialQuantity(line.quantity);
  const unitPurchaseCost = normalizeSpecialRate(line.unitPurchaseCost);
  specialLineSubtotal(quantity,unitPurchaseCost);
  return {itemId,description,uom,quantity,unitPurchaseCost,...normalizePackQuantities(line),
    caseLineId:material ? Number(line.caseLineId) : null,ancillary:!material,
    ...(material ? {vendorDiscountPercent:line.vendorDiscountPercent} : {})};
}

/** Caller holds the case lock and transaction.
 * @param {(sql:string,values?:any[])=>Promise<any>} query @param {number} requestId
 * @param {Record<string,any>} line */
export async function saveSpecialPurchaseLine(query, requestId, line) {
  const item = await query('SELECT item_name FROM inventory_items WHERE item_id=$1 FOR SHARE',[line.itemId]);
  if (!item.rowCount) {
    throw invalid('The selected PO item is missing from the synced NetSuite item master.');
  }
  await query(`INSERT INTO sales_special_stock_order_lines
    (request_id,case_line_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_purchase_cost,
     pack_pallet_qty,pack_section_qty,pack_layer_qty,pack_piece_qty)
    VALUES($1,$2,'purchase_order',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (request_id,order_kind,case_line_id) WHERE case_line_id IS NOT NULL
    DO UPDATE SET item_id=EXCLUDED.item_id,item_name=EXCLUDED.item_name,remote_line_id=NULL,
      description=EXCLUDED.description,quantity=EXCLUDED.quantity,uom=EXCLUDED.uom,
      unit_purchase_cost=EXCLUDED.unit_purchase_cost,pack_pallet_qty=EXCLUDED.pack_pallet_qty,
      pack_section_qty=EXCLUDED.pack_section_qty,pack_layer_qty=EXCLUDED.pack_layer_qty,
      pack_piece_qty=EXCLUDED.pack_piece_qty,updated_at=now()`,
  [requestId,line.caseLineId,line.ancillary,line.itemId,item.rows[0].item_name,line.description,line.quantity,line.uom,line.unitPurchaseCost,
    line.palletQty,line.sectionQty,line.layerQty,line.pieceQty]);
  return item.rows[0].item_name;
}
