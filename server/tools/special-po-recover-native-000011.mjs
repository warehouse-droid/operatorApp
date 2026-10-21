// Complete the user's original, submitted PO review. Native linkage only;
// no standalone PO POST, SO commercial correction, or submission reset.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),module=name=>import(pathToFileURL(`${root}/src/${name}.js`));
const {closeDb}=await module('db');
const repo=await module('special-stock-request-repository');
const ns=await module('netsuite');
const {buildSpecialPurchaseOrderPayload}=await module('special-stock-request-netsuite');
const {createSpecialPurchaseOrder}=await module('special-stock-request-service');
let claimed,context,failMessage='Native PO exists. Recover the existing operation to finish verification.';
try{
 let d=await repo.getSpecialStockCase(67,{audience:'scm'});
 assert.equal(d.requestRef,'SPREQ-000011');assert.equal(d.salesOrderId,1022888);assert.equal(d.salesOrderRef,'SOM06738');
 assert.equal(d.purchaseOrderOperationId,'b155cdc3-467a-4491-a01d-d4df78da9542');assert.ok(d.purchaseOrderSubmissionStartedAt);
 if(d.purchaseOrderId){console.log(JSON.stringify({alreadyLinked:true,request:d.requestRef,purchaseOrderId:d.purchaseOrderId,purchaseOrderRef:d.purchaseOrderRef}));}
 else {
  assert.equal(d.vendorDiscountReview.amount,0);assert.equal(d.purchaseOrderLines.length,6);
  for(const po of d.purchaseOrderLines){const so=d.salesOrderLines.find(l=>l.caseLineId===po.caseLineId&&!l.ancillary);assert.ok(so);assert.deepEqual([po.quantity,po.uom,po.description],[so.quantity,so.uom,so.description]);}
  const locations=await ns.resolveNetSuiteYardLocations([{locationId:d.operationalYardLocationId,code:String(d.storeName)}]);assert.equal(locations.length,1);
  const payload=buildSpecialPurchaseOrderPayload({caseId:d.id,vendorId:d.vendorId,netsuiteLocationId:locations[0].netsuiteLocationId,
   lines:await ns.resolveSpecialOrderUnitsFromNetSuite(d.purchaseOrderLines),vendorDiscountReview:d.vendorDiscountReview});
  assert.equal(payload.item.items.length,6);
  const native={salesOrderId:d.salesOrderId,salesOrderLines:d.salesOrderLines,purchaseOrderLines:d.purchaseOrderLines,payload};
  const existing=await ns.findSpecialLinkedPurchaseOrderInNetSuite(native);
  if(!process.argv.includes('--apply'))console.log(JSON.stringify({readOnly:true,request:d.requestRef,existingPo:existing?.id||null,reviewedMaterials:6,vendorDiscount:0}));
  else {
   await ns.assertSpecialNativePurchaseReady();
   context={operatorId:d.vendorDiscountReview.confirmedBy,authorizedStoreLocationIds:[d.storeLocationId]};
   claimed=await repo.claimSpecialOrderOperation(67,{expectedRevision:d.revision,orderKind:'purchase_order',operationId:d.purchaseOrderOperationId},context);
   const created=await ns.createSpecialLinkedPurchaseOrderInNetSuite(payload,native);
   assert.ok(created.id);assert.equal(created.nativeLink,true);
   await repo.failSpecialOrderOperation(67,{orderKind:'purchase_order',operationId:d.purchaseOrderOperationId,errorMessage:failMessage},context);claimed=null;
   d=await repo.getSpecialStockCase(67,{audience:'scm'});
   const result=await createSpecialPurchaseOrder(67,{expectedRevision:d.revision,operationId:d.purchaseOrderOperationId},context);
   assert.equal(result.purchaseOrderId,created.id);assert.equal(result.purchaseOrderOperationStatus,'linked');
   console.log(JSON.stringify({recovered:true,request:result.requestRef,salesOrderRef:result.salesOrderRef,purchaseOrderId:result.purchaseOrderId,purchaseOrderRef:result.purchaseOrderRef,materials:result.purchaseOrderLines.length,status:result.purchaseOrderOperationStatus}));
  }
 }
}catch(error){failMessage=error.message;throw error;}
finally{
 if(claimed)await repo.failSpecialOrderOperation(67,{orderKind:'purchase_order',operationId:claimed.purchaseOrderOperationId,errorMessage:failMessage},context);
 await closeDb();
}
