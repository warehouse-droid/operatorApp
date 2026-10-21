// Read-only diagnosis: inspect the order and eligibility without creating a request.
import {readRegularStockSalesOrderFromNetSuite,suiteqlAll} from './src/netsuite.js';
import {deliveryBaseYard,deliveryMaterials} from './src/regular-stock-delivery-domain.js';
import {assertDeliveryStockRequestDestinationAccess} from './src/regular-stock-delivery-access.js';
import {closeDb} from './src/db.js';
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
  if(new URL(url).pathname.includes('/record/v1/') && String(options.method||'GET').toUpperCase()!=='GET') {
    throw Error('Read-only diagnosis refuses NetSuite record writes');
  }
  return originalFetch(url,options);
};
try {
  const order=await readRegularStockSalesOrderFromNetSuite('SOB122874');
  const rows=await suiteqlAll(`SELECT t.status,tl.uniquekey AS line_id,tl.quantity,
    tl.quantitybackordered AS backorder,tl.quantityshiprecv AS fulfilled,tl.quantitybilled AS billed,
    tl.isclosed AS closed,tl.location FROM transaction t JOIN transactionline tl ON tl.transaction=t.id
    WHERE t.id=${order.id} AND tl.mainline='F' AND tl.taxline='F' ORDER BY tl.uniquekey`);
  const base=deliveryBaseYard(order);
  assertDeliveryStockRequestDestinationAccess(1,base.locationId,[1],{preview:true});
  let validation;
  try {validation={eligible:true,selected:deliveryMaterials(order,base.locationId).map(line=>line.remoteLineId)};}
  catch(error){validation={eligible:false,code:error.code,message:error.message};}
  console.log(JSON.stringify({readOnly:true,salesOrder:order.ref,id:order.id,headerYard:order.locationId,
    baseYard:base.yardCode,sales3445Access:true,lines:order.lines.map(line=>({remoteLineId:line.remoteLineId,
      itemId:line.itemId,itemName:line.itemName,itemType:line.itemType,locationId:line.locationId,
      quantity:line.quantity,backorder:line.backorderedQuantity,uom:line.uom,ancillary:line.ancillary,open:line.open})),
    authoritativeLines:rows,validation,orderWrites:0},null,2));
} finally {globalThis.fetch=originalFetch;await closeDb();}
