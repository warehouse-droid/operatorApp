// Older retained boards include dependency lines before pickup manifests were
// serialized. These lines are dated board evidence; never read live allocations.
export function retainedDirectPickupManifest(order = {}) {
  if (order.directPickupManifest?.length) {return order.directPickupManifest;}
  if (order.type === 'CO') {return [];}
  return (order.orderDependencies || [])
    .filter(dependency => dependency.mode === 'direct_to_customer' && dependency.status !== 'cancelled')
    .map(dependency => ({dependencyId:dependency.id,salesOrderRef:dependency.salesOrderRef,
      transferOrderRef:dependency.transferOrderRef,location:dependency.sourceLocation,
      items:(dependency.lines || []).map(line => ({...line,quantity:Number(line.allocatedQuantity || 0)}))}))
    .filter(entry => entry.items.some(item => item.quantity > 0));
}

export function groupPickupSourceItems(order = {}, location = '') {
  if (order.type === 'CO' || order.transitCo?.toYard || !(order.childOrderDetails || []).some(child => child.items?.length)) {return null;}
  const key = value => String(value || '').split(/\s*:\s*/u)[0].trim().toLowerCase();
  const identity = item => item.lineRowId ? `row:${item.lineRowId}` : item.lineId ? `line:${item.lineId}` : `item:${item.itemId || item.sku}`;
  const selected = new Set((order.childOrderDetails || [])
    .filter(child => key(child.transitCo?.toYard || child.sourceYard || order.sourceYard) === key(location))
    .flatMap(child => (child.items || []).map(identity)));
  return (order.items || []).filter(item => selected.has(identity(item)));
}

export function spreadDirectPickupAllocation(order = {}, item = {}, total = {}) {
  const items = order.items || [];
  const index = items.indexOf(item);
  if (index < 0) {return total;}
  const matches = candidate => item.itemId && candidate.itemId ? String(item.itemId) === String(candidate.itemId)
    : String(item.sku || item.itemName || '') === String(candidate.sku || candidate.itemName || '');
  const fields = {pallets:'poAllocatedPallets',layers:'poAllocatedLayers',sections:'poAllocatedSections',pieces:'poAllocatedPieces',quantity:'poAllocatedSalesQty'};
  const available = (line,field) => Math.max(Number(line[field] ?? (field === 'quantity' ? line.salesQty : 0) ?? 0)-Number(line[fields[field]] || 0),0);
  return Object.fromEntries(Object.keys(fields).map(field => [field,Math.min(available(item,field),
    Math.max(Number(total[field] || 0)-items.slice(0,index).filter(matches).reduce((sum,line)=>sum+available(line,field),0),0))]));
}
