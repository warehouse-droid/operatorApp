// @ts-check
/** @param {unknown} value */
const unit=value=>String(value??'').toUpperCase().replace(/[^A-Z0-9]/gu,'');
/** @param {unknown} value */
const positive=value=>Number.isFinite(Number(value))&&Number(value)>0;

/** The vendor portal takes whole pallets. Unknown conversions need an explicit SCM quantity.
 * @param {Record<string,any>} row */
export function requestCheckQuantity(row) {
  const quantity=Number(row.scm_reviewed_quantity ?? row.sales_package_quantity ?? row.requested_quantity);
  const uom=row.requested_uom;
  let pallets=null;
  if(positive(quantity)) {
    if(['PLT','PALLET','PALLETS','BNDL','BUNDLE','BUNDLES'].includes(unit(uom)))pallets=quantity;
    else if(unit(uom)===unit(row.inventory_unit)&&positive(row.inventory_to_plt))pallets=quantity/Number(row.inventory_to_plt);
    else if(quantity===Number(row.requested_quantity)&&positive(row.pack_pallet_qty)
      &&![row.pack_layer_qty,row.pack_section_qty,row.pack_piece_qty].some(positive))pallets=Number(row.pack_pallet_qty);
  }
  const rounded=pallets===null?null:Math.max(1,Math.ceil(pallets-1e-9));
  return {quantity,uom,requestedQuantity:Number(row.requested_quantity),checkQuantity:rounded,checkUom:'PLT'};
}
