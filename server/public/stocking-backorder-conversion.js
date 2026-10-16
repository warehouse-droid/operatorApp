/** @param {string} message */
const invalid=message=>Object.assign(new Error(message),{status:400,code:'STOCKING_BACKORDER_INVALID'});
const open=new Set(['submitted','changes_requested','approved']);
/** @param {Record<string,any>|null|undefined} request */
export function canConvertStockingToBackorder(request) {
  return Boolean(request?.requestType==='regular' && request.workflowVersion===2
    && request.regular?.deliveryMethod==='stocking' && ['submitted','active'].includes(request.status)
    && !request.regular.resolution && !request.regular.pickupTransfer && !request.regular.handoffStatus
    && !Object.values(request.regular.stockingLines || {}).some((/** @type {any} */ state)=>state.resolution)
    && !(request.transfers || []).length && request.lines?.length>=1 && request.lines.length<=100
    && request.lines.every((/** @type {any} */ line)=>open.has(line.status) && !line.transferId && !line.purchase?.demandId));
}
/** Copy saved quantities rather than reinterpreting them through today's item master.
 * @param {Array<Record<string,any>>} lines @param {Map<number,Record<string,any>>} items
 * @param {{requiredDate:string,vendors?:unknown}} options */
export function stockingBackorderMaterials(lines,items,{requiredDate,vendors=[]}) {
  if (!Array.isArray(vendors) || vendors.length>lines.length) throw invalid('Confirm a vendor for each material.');
  const changes=new Map();
  for (const entry of vendors) {
    const id=entry?.stockingLineId;
    if (!['string','number'].includes(typeof id) || !/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))
        || !lines.some(line=>Number(line.id)===Number(id)) || changes.has(Number(id))) throw invalid('The vendor material does not belong to this request.');
    if (typeof entry.vendorName!=='string') throw invalid('Enter a vendor for each material.');
    changes.set(Number(id),entry.vendorName.trim());
  }
  return lines.map(line=>{
    const item=items.get(Number(line.item_id));
    if (!item || [1784,1987,2055].includes(Number(line.item_id))) throw invalid('Only regular stock materials can convert to Backorder.');
    const vendorName=changes.get(Number(line.id)) ?? String(item.vendor || '').trim();
    if (!vendorName || vendorName.length>200) throw invalid('Enter a vendor for each material (up to 200 characters).');
    const sameVendor=vendorName.toLowerCase()===String(item.vendor || '').trim().toLowerCase();
    return {regularItemId:Number(line.item_id),regularItemCode:line.item_name,productName:line.item_name,
      detailSpec:line.item_description || '',quantity:Number(line.sales_qty),uom:line.sales_uom,
      palletQty:Number(line.pallet_qty || 0),layerQty:Number(line.layer_qty || 0),sectionQty:Number(line.section_qty || 0),pieceQty:Number(line.piece_qty || 0),
      brand:vendorName,regularVendorId:sameVendor && item.vendor_id!=null?Number(item.vendor_id):null,
      destinationLocationId:Number(line.destination_location_id),requiredDate,rate:null,discountPercent:0};
  });
}
