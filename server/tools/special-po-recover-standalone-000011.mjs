// Bounded fallback explicitly requested by the user after native creation failed.
// Retain the original submission timestamp and journal a single REST attempt.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const root=process.cwd();
const {config}=await import(`${root}/src/config.js`);
const {query,withTransaction,closeDb}=await import(`${root}/src/db.js`);
const repo=await import(`${root}/src/special-stock-request-repository.js`);
const ns=await import(`${root}/src/netsuite.js`);
const {getNetSuiteM2mAccessToken}=await import(`${root}/src/netsuite-m2m-runtime.js`);
const {buildSpecialPurchaseOrderPayload}=await import(`${root}/src/special-stock-request-netsuite.js`);
const {createSpecialPurchaseOrder}=await import(`${root}/src/special-stock-request-service.js`);
const marker='MBBS-SPECIAL-PO:67',eventType='special_standalone_po_fallback_submitted';
const financialHash=record=>createHash('sha256').update(JSON.stringify({discountItem:record.discountItem,discountRate:record.discountRate,
  salesRep:record.salesRep,item:record.item.items.map(l=>({line:l.line,item:l.item,quantity:l.quantity,rate:l.rate,amount:l.amount,units:l.units,description:l.description}))})).digest('hex');
const read=async path=>{
  const token=await getNetSuiteM2mAccessToken();
  const response=await fetch(config.netsuite.restBaseUrl+path,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  assert.equal(response.status,200,'NetSuite read failed');return response.json();
};
const checkSalesOrder=async()=>{
  const so=await read('/record/v1/salesOrder/1022888?expandSubResources=true');
  assert.equal(so.tranId,'SOM06738');assert.equal(so.orderStatus.id,'B');
  assert.equal(financialHash(so),'3fccd31f957d6f427d766251aaa39be16479311d577782f2b5c85e4229dfc14e','Protected SO commercial values changed');
  assert.ok(so.item.items.every(l=>!l.createPo&&!l.createdPo),'A native PO is linked or pending');
  assert.deepEqual(await ns.suiteqlAll('SELECT nextdoc,previousline,nextline,linktype FROM NextTransactionLineLink WHERE previousdoc=1022888'),[]);
};
const markedOrders=()=>ns.suiteqlAll("SELECT id,tranid FROM transaction WHERE type='PurchOrd' AND (externalid='MBBS-SPECIAL-PO:67' OR memo LIKE '%MBBS-SPECIAL-PO:67%')");
const verifyPurchase=async(id,payload)=>{
  const po=await read(`/record/v1/purchaseOrder/${Number(id)}?expandSubResources=true`);
  assert.equal(po.createdFrom,undefined);assert.equal(po.entity.id,payload.entity.id);assert.equal(po.location.id,payload.location.id);
  assert.equal(po.externalId,marker);assert.ok(po.memo.includes(marker));
  const tuple=l=>[String(l.item.id),Number(l.quantity),String(l.units?.id??l.units??''),Number(l.rate),l.description];
  assert.deepEqual(po.item.items.map(tuple),payload.item.items.map(tuple),'PO differs from submitted SCM review');
  return po;
};
let claimed,context,finalMessage='Standalone PO exists; recover the existing marker to finish the application association.';
try{
  let d=await repo.getSpecialStockCase(67,{audience:'scm'});
  assert.equal(d.requestRef,'SPREQ-000011');assert.equal(d.salesOrderId,1022888);assert.equal(d.salesOrderRef,'SOM06738');
  assert.equal(d.purchaseOrderOperationId,'b155cdc3-467a-4491-a01d-d4df78da9542');
  const submittedAt=new Date(d.purchaseOrderSubmissionStartedAt).toISOString();
  assert.equal(submittedAt,'2026-09-28T16:50:42.645Z');
  assert.equal(d.vendorDiscountReview.amount,0);assert.equal(d.purchaseOrderLines.length,6);
  for(const po of d.purchaseOrderLines){const so=d.salesOrderLines.find(l=>l.caseLineId===po.caseLineId&&!l.ancillary);assert.ok(so);assert.deepEqual([po.quantity,po.uom,po.description],[so.quantity,so.uom,so.description]);}
  const locations=await ns.resolveNetSuiteYardLocations([{locationId:d.operationalYardLocationId,code:String(d.storeName)}]);assert.equal(locations.length,1);
  const payload=buildSpecialPurchaseOrderPayload({caseId:d.id,vendorId:d.vendorId,netsuiteLocationId:locations[0].netsuiteLocationId,
    subsidiaryId:locations[0].subsidiaryId,lines:await ns.resolveSpecialOrderUnitsFromNetSuite(d.purchaseOrderLines),vendorDiscountReview:d.vendorDiscountReview});
  assert.equal(payload.item.items.length,6);assert.equal(payload.createdFrom,undefined);assert.equal(payload.externalId,marker);
  await checkSalesOrder();
  let existing=await markedOrders();assert.ok(existing.length<=1,'Duplicate PO markers');
  if(d.purchaseOrderId){assert.equal(existing.length,1);assert.equal(Number(existing[0].id),d.purchaseOrderId);await verifyPurchase(d.purchaseOrderId,payload);
    assert.equal(d.purchaseOrderOperationStatus,'linked');
    console.log(JSON.stringify({alreadyLinked:true,readOnly:true,request:d.requestRef,purchaseOrderId:d.purchaseOrderId,purchaseOrderRef:d.purchaseOrderRef,
      standalone:true,markerCount:existing.length,nativeLinks:0,materialsMatched:6,soCommercialValuesUnchanged:true,attention:d.attention,
      canonicalPoLinesMatched:d.purchaseOrderLines.filter(line=>line.remoteLineId).length}));
  } else if(!process.argv.includes('--apply'))console.log(JSON.stringify({readOnly:true,request:d.requestRef,existingPo:existing[0]?.id||null,reviewedMaterials:6,vendorDiscount:0,soCommercialValuesUnchanged:true}));
  else {
    assert.ok(readFileSync(`${root}/src/special-stock-request-service.js`,'utf8').includes('createPurchaseOrder: createPurchaseOrderInNetSuite,'),'Deploy standalone creation first');
    context={operatorId:d.vendorDiscountReview.confirmedBy,authorizedStoreLocationIds:[d.storeLocationId]};
    claimed=await repo.claimSpecialOrderOperation(67,{expectedRevision:d.revision,orderKind:'purchase_order',operationId:d.purchaseOrderOperationId},context);
    await checkSalesOrder();existing=await markedOrders();assert.ok(existing.length<=1);
    let remoteId=existing[0]?.id;
    if(!remoteId){
      await withTransaction(async()=>{
        const row=(await query('SELECT purchase_order_operation_status,purchase_order_operation_id FROM sales_special_stock_cases WHERE request_id=67 FOR UPDATE')).rows[0];
        assert.equal(row.purchase_order_operation_status,'creating');assert.equal(row.purchase_order_operation_id,d.purchaseOrderOperationId);
        assert.equal((await query('SELECT id FROM sales_special_stock_events WHERE request_id=67 AND event_type=$1',[eventType])).rowCount,0,'Fallback already submitted; recover its marker without resubmission');
        await query('INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details) VALUES(67,$1,$2,\'scm\',$3::jsonb)',
          [eventType,context.operatorId,JSON.stringify({operationId:d.purchaseOrderOperationId,salesOrderId:d.salesOrderId,externalId:marker,performedBy:'codex',reason:'User requested standalone REST API fallback after native PO creation failed',originalSubmissionStartedAt:submittedAt})]);
      });
      remoteId=(await ns.createPurchaseOrderInNetSuite(payload)).id;
      assert.ok(remoteId,'No durable REST PO ID returned; recover its marker');
    }
    const po=await verifyPurchase(remoteId,payload);await checkSalesOrder();
    await repo.failSpecialOrderOperation(67,{orderKind:'purchase_order',operationId:d.purchaseOrderOperationId,errorMessage:finalMessage},context);claimed=null;
    d=await repo.getSpecialStockCase(67,{audience:'scm'});
    const result=await createSpecialPurchaseOrder(67,{expectedRevision:d.revision,operationId:d.purchaseOrderOperationId},context);
    assert.equal(result.purchaseOrderId,Number(remoteId));assert.equal(result.purchaseOrderOperationStatus,'linked');
    assert.equal(new Date(result.purchaseOrderSubmissionStartedAt).toISOString(),submittedAt);
    existing=await markedOrders();assert.equal(existing.length,1);await checkSalesOrder();
    console.log(JSON.stringify({recovered:true,request:result.requestRef,salesOrderRef:result.salesOrderRef,purchaseOrderId:result.purchaseOrderId,
      purchaseOrderRef:po.tranId,materials:result.purchaseOrderLines.length,standalone:true,markerCount:existing.length,status:result.purchaseOrderOperationStatus,
      attention:result.attention,soCommercialValuesUnchanged:true,originalSubmissionPreserved:true}));
  }
}catch(error){finalMessage=error.message;throw error;}
finally{
  if(claimed)await repo.failSpecialOrderOperation(67,{orderKind:'purchase_order',operationId:claimed.purchaseOrderOperationId,errorMessage:finalMessage},context);
  await closeDb();
}
