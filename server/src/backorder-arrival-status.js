// @ts-check
/** @param {Record<string,any>|null} order @param {Record<string,any>[]} lines */
export function purchaseOrderArrived(order,lines) {
  if (!order || order.netsuite_active === false) return false;
  const status=String(order.status_text || '').trim().toLowerCase().replace(/^purchase order\s*:\s*/,'');
  if (['cancelled','canceled','rejected'].includes(status)) return false;
  if (['fully received','received'].includes(status)) return true;
  const materials=lines.filter(line=>line.netsuite_active!==false && (!line.item_type || ['InvtPart','NonInvtPart'].includes(line.item_type))
    && Number.isFinite(Number(line.quantity)) && Number(line.quantity)>0);
  return materials.length>0 && materials.every(line=>Number.isFinite(Number(line.netsuite_received_qty))
    && Number(line.netsuite_received_qty)>=Number(line.quantity));
}
