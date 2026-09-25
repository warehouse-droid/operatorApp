export const RENTAL_YARD = { code: '3445', locationId: 1, address: '3445 Kennedy Road, Toronto, ON' };
const GROUPS = new Set(['01 mbbs', '02 mbt', '03 mbr - repair', '05 mbr equip', '06 tm']);
const clean = value => String(value ?? '').trim();
export const isSorDeliveryRef = value => /^SOR\d+(?:-S\d+)?$/iu.test(clean(value));

export function rentalItemDecision(item = {}, policy = {}) {
  const type = clean(policy.itemType || policy.item_type || item.itemType || item.item_type).toLowerCase();
  const name = clean(policy.itemName || policy.item_name || item.itemName || item.item_name || item.sku);
  const fullName = clean(policy.fullName || policy.full_name || item.fullName || item.full_name || name);
  const fee = /othcharge|other.?charge|markup|discount|subtotal|description|payment/u.test(type)
    || /delivery\s*(charge|fee)|shipping\s*(charge|fee)|protection plan|price adjustment/iu.test(name);
  const inventory = /^(invtpart|assembly|serialized inventory item|lot numbered inventory item|inventory item)$/u.test(type);
  const namedRental = fullName.split(':').some(part => GROUPS.has(part.trim().toLowerCase()))
    || /\/\s*(day|month)\s*$/iu.test(name);
  const defaultAutoReturn = !fee && !inventory && namedRental;
  const override = typeof policy.override === 'boolean' ? policy.override : null;
  return {
    rentalEquipment: !fee && (defaultAutoReturn || override === true),
    autoReturn: !fee && (override ?? defaultAutoReturn),
    defaultAutoReturn,
    reason: fee ? 'fee' : override !== null ? (override ? 'admin_enabled' : 'admin_disabled')
      : inventory ? 'inventory_sale' : namedRental ? 'rental_rule' : 'no_rental_rule'
  };
}

export function projectSorOrder(order = {}, policies = new Map()) {
  if (Array.isArray(order.childOrderDetails) && order.childOrderDetails.length) {
    const children = order.childOrderDetails.map(child => projectSorOrder(child, policies));
    const byLine = new Map(children.flatMap(child => (child.items || []).filter(item=>item.lineRowId !== null && item.lineRowId !== undefined).map(item => [String(item.lineRowId), item])));
    const items = (order.items || []).map(item => byLine.has(String(item.lineRowId))
      ? {...item, rentalEquipment: byLine.get(String(item.lineRowId)).rentalEquipment,
        sorAutoReturn: byLine.get(String(item.lineRowId)).sorAutoReturn} : item);
    const rentalPickupChanged = children.some((child,index) => child.sourceYard === RENTAL_YARD.code
      && order.childOrderDetails[index].sourceYard !== RENTAL_YARD.code);
    const pickupLocations = [...new Set(children.flatMap(child => child.pickupLocations?.length
      ? child.pickupLocations : [child.sourceYard]).filter(Boolean))];
    const allRentalYard = children.every(child => child.sourceYard === RENTAL_YARD.code);
    return {...order, childOrderDetails:children, items, ...(rentalPickupChanged ? {
      pickupLocations, sourceYard:children[0].sourceYard,sourceAddress:children[0].sourceAddress
    } : {}), ...(allRentalYard ? {
      sourceYard:RENTAL_YARD.code,sourceAddress:RENTAL_YARD.address,pickupLocations:[RENTAL_YARD.code]
    } : {})};
  }
  if (!isSorDeliveryRef(order.id) || order.type !== 'SO') {return order;}
  const items = (order.items || []).map(item => {
    const decision = rentalItemDecision(item, policies.get(String(item.itemId ?? item.item_id)) || {});
    return {...item,rentalEquipment:decision.rentalEquipment,sorAutoReturn:decision.autoReturn};
  });
  const rental = items.some(item => item.rentalEquipment && Number(item.quantity ?? item.salesQty) > 0);
  return {...order, items, sorOrder:true, ...(rental ? {
    sourceYard:RENTAL_YARD.code,sourceAddress:RENTAL_YARD.address,
    defaultSourceAddress:RENTAL_YARD.address,pickupLocations:[RENTAL_YARD.code],
    pickupAddressOverride:'',rentalSourceLocation:order.rentalSourceLocation || order.sourceYard
  } : {})};
}

export function sorReturnDraft(order = {}) {
  if (!isSorDeliveryRef(order.id) || order.childOrders?.length
    || order.deliveryMethod === 'Pick-Up' || order.netsuiteActive === false) {return null;}
  const items = (order.items || []).filter(item => item.sorAutoReturn === true && Number(item.quantity ?? item.salesQty) > 0);
  if (!items.length) {return null;}
  return {
    refNumber:`${order.id}-Return`,parentOrderRef:order.id,parentSalesOrderId:order.netsuiteId || null,
    pickupLocation:clean(order.address || order.destinationAddress),dropoffLocation:RENTAL_YARD.address,
    expectedDeliveryDate:'',lineSnapshot:items.map(item => ({...item})),
    orderDetails:`Rental equipment return for ${order.id}`,
    weightLbs:items.reduce((sum,item) => sum + Number(item.lineWeight || 0),0),
    salesQty:items.reduce((sum,item) => sum + Number(item.quantity ?? item.salesQty),0),
    customer:order.customer || ''
  };
}

export function sorSignatureRefs(job = {}) {
  if (job.stopType !== 'dropoff') {return [];}
  return [...new Set([...(job.orderRefs || []),...(job.orders || []).flatMap(order =>
    [order.orderRef || order.id,...(order.childOrders || [])])].filter(isSorDeliveryRef))].sort();
}
