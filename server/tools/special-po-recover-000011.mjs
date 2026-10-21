// Recover the user's failed native PO attempt after verifying the first PATCH
// retained only vendor/rate fields. Never POST a standalone PO or reset its journal.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=process.cwd();
const {query,closeDb}=await import(`${root}/src/db.js`);
const repo=await import(`${root}/src/special-stock-request-repository.js`);
let source=readFileSync(`${root}/src/netsuite.js`,'utf8').replace(/from (["'])\.\/([^"']+)\1/g,(_m,q,n)=>`from ${q}file://${root}/src/${n}${q}`);
source+='\nexport const repairRest=netsuiteRest; export const repairMutation=queueNetSuiteMutation;';
const {repairRest:rest,repairMutation:mutate,suiteqlAll}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const hash=r=>createHash('sha256').update(JSON.stringify({entity:r.entity?.id,location:r.location?.id,status:r.orderStatus?.id,discountItem:r.discountItem?.id,discountRate:r.discountRate,
  lines:r.item.items.map(l=>[l.line,l.lineUniqueKey,l.item?.id,l.quantity,l.units,l.rate,l.amount,l.description,l.isClosed])})).digest('hex');
const links=()=>suiteqlAll("SELECT nextdoc,previousline,nextline,linktype FROM NextTransactionLineLink WHERE previousdoc=1022888");
const read=async()=> (await rest('/record/v1/salesOrder/1022888?expandSubResources=true')).data;
let claimed;
try{
 const d=await repo.getSpecialStockCase(67,{audience:'scm'});
 assert.equal(d.requestRef,'SPREQ-000011');assert.equal(d.salesOrderId,1022888);assert.equal(d.purchaseOrderId,null);
 assert.equal(d.purchaseOrderOperationId,'b155cdc3-467a-4491-a01d-d4df78da9542');assert.equal(d.purchaseOrderOperationStatus,'attention');
 assert.ok(d.purchaseOrderSubmissionStartedAt);assert.equal(d.vendorDiscountReview.amount,0);assert.equal(d.purchaseOrderLines.length,6);
 const so=await read();assert.equal(so.tranId,'SOM06738');assert.equal(so.orderStatus.id,'B');
 assert.deepEqual(await links(),[]);
 assert.deepEqual(await suiteqlAll("SELECT id FROM transaction WHERE type='PurchOrd' AND memo LIKE '%MBBS-SPECIAL-PO:67%'"),[]);
 assert.ok(so.item.items.every(l=>!l.createPo && !l.createdPo));
 const selected=d.purchaseOrderLines.map(po=>{
  const sales=d.salesOrderLines.find(l=>l.caseLineId===po.caseLineId&&!l.ancillary);
  const line=so.item.items.find(l=>Number(l.lineUniqueKey)===sales.remoteLineId);
  assert.ok(line);assert.equal(line.item.id,'2055');assert.equal(line.quantity,po.quantity);assert.equal(line.description,po.description);
  assert.equal(line.rate,sales.rate);assert.equal(Number(line.poVendor?.id),d.vendorId);assert.equal(line.poRate,po.unitPurchaseCost);
  assert.equal(Number(line.quantityFulfilled||0),0);return {line:line.line,createPo:{id:'SpecOrd'}};
 });
 const report={case:d.requestRef,readOnly:!process.argv.includes('--apply'),noExistingPo:true,vendorCostsAlreadyPersisted:true,soCommercialHash:hash(so)};
 if(process.argv.includes('--apply')){
  claimed=await repo.claimSpecialOrderOperation(67,{expectedRevision:d.revision,orderKind:'purchase_order',operationId:d.purchaseOrderOperationId},{operatorId:d.vendorDiscountReview.confirmedBy});
  await mutate(async()=>{
   const latest=await read();assert.equal(hash(latest),hash(so));assert.ok(latest.item.items.every(l=>!l.createPo&&!l.createdPo));assert.deepEqual(await links(),[]);
   try{
    const response=await rest('/record/v1/salesOrder/1022888',{method:'PATCH',headers:{'X-NetSuite-PropertyNameValidation':'Error','X-NetSuite-PropertyValueValidation':'Error'},body:{item:{items:selected}}});report.http=response.status;
   }catch(e){report.error={status:e.status,codes:e.netsuiteErrorCodes,details:e.netsuiteErrorDetails};}
  });
  const after=await read();assert.equal(hash(after),hash(so),'SO commercial values changed');
  report.nativeLinks=await links();report.materialLinks=after.item.items.filter(l=>l.item?.id==='2055').map(l=>({line:l.line,createPo:l.createPo?.id||null,createdPo:l.createdPo?.id||null}));
  report.soCommercialValuesUnchanged=true;
 }
 console.log(JSON.stringify(report));
}finally{
 if(claimed)await repo.failSpecialOrderOperation(67,{orderKind:'purchase_order',operationId:claimed.purchaseOrderOperationId,errorMessage:'Native PO recovery checked the SO creation flag after confirming vendor costs. Recover the existing operation; do not create a separate PO.'},{operatorId:claimed.vendorDiscountReview.confirmedBy});
 await closeDb();
}
