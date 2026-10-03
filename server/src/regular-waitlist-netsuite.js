import {config} from './config.js';
import {suiteqlAll,resolveNetSuiteYardLocations,resolveSpecialOrderUnitsFromNetSuite,createSalesOrderInNetSuite} from './netsuite.js';
import {waitlistId,waitlistKey,waitlistQuantity,normalizeWaitlistFulfillment,waitlistError} from './regular-waitlist-domain.js';

export const waitlistSalesOrderMarker=id=>'MBBS-WAITLIST-SO:'+waitlistKey(id);
export function buildWaitlistSalesOrder(operation,resolved){
  if(!resolved.locationId || !resolved.unitsId || !resolved.subsidiaryId)throw waitlistError('Verify the selling yard, subsidiary and item sales unit before creating the SO.','WAITLIST_SO_MAPPING_REQUIRED',409);
  const fulfillment=normalizeWaitlistFulfillment(operation.fulfillment);
  const payload={externalId:waitlistSalesOrderMarker(operation.id),entity:{id:String(waitlistId(operation.customerId))},
    location:{id:String(waitlistId(resolved.locationId))},subsidiary:{id:String(waitlistId(resolved.subsidiaryId))},
    memo:'Waitlist '+operation.requestRef+' · '+waitlistSalesOrderMarker(operation.id),
    item:{items:[{item:{id:String(waitlistId(operation.itemId))},quantity:waitlistQuantity(operation.quantity),units:String(waitlistId(resolved.unitsId)),location:{id:String(resolved.locationId)}}]}};
  const method=resolved.fulfillmentValues?.[fulfillment.fulfillmentMethod];
  if(method)payload.custbody3={id:String(waitlistId(method))};
  if(fulfillment.fulfillmentMethod==='delivery'){
    if(!method)throw waitlistError('Configure the NetSuite Delivery method.','WAITLIST_SO_MAPPING_REQUIRED',409);
    payload.custbody4=fulfillment.deliveryDate;
  }
  return payload;
}
export async function prepareWaitlistSalesOrder(operation,{resolveYards=resolveNetSuiteYardLocations,resolveUnits=resolveSpecialOrderUnitsFromNetSuite}={}){
  const [yard]=await resolveYards([{locationId:operation.sellingYardId,code:operation.sellingYard}]);
  const [item]=await resolveUnits([{itemId:operation.itemId,itemName:operation.itemCode,uom:operation.salesUom,quantity:operation.quantity}]);
  return buildWaitlistSalesOrder(operation,{locationId:yard?.netsuiteLocationId,subsidiaryId:yard?.subsidiaryId||config.specialStock.subsidiaryId,
    unitsId:item?.unitId,fulfillmentValues:{pickup:config.specialStock.pickupMethodId,delivery:config.specialStock.deliveryMethodId}});
}
export async function findWaitlistSalesOrder(id,{queryAll=suiteqlAll}={}){
  const marker=waitlistSalesOrderMarker(id);
  const rows=await queryAll(`SELECT id,tranid FROM transaction WHERE type='SalesOrd' AND externalid='${marker}'`);
  if(rows.length>1)throw waitlistError('More than one SO uses this conversion marker. Review the NetSuite result.','WAITLIST_SO_MARKER_CONFLICT',409);
  return rows.length?{salesOrderId:waitlistId(rows[0].id),salesOrderRef:String(rows[0].tranid)}:null;
}
export const postWaitlistSalesOrder=payload=>createSalesOrderInNetSuite(payload);
