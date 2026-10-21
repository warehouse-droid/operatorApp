/* global query, crypto, netsuiteRest, resolveSpecialOrderUnitsFromNetSuite, findSpecialStockOrdersByMarkerFromNetSuite, config */
// Appended to the deployed NetSuite module. Fixed case, operation and amounts.
const r9assert=(await import('node:assert/strict')).default;
const r9fs=await import('node:fs');
const r9db=await import('file:///app/src/db.js');
const r9repo=await import('file:///app/src/special-stock-request-repository.js');
const r9service=await import('file:///app/src/special-stock-request-service.js');
const r9payload=await import('file:///app/src/special-stock-request-netsuite.js');
const r9priority=await import('file:///app/src/operator-netsuite-request-pool.js');
const r9path='/tmp/special-rest-recovery-000009.private.json';
const r9operation='432376e0-2f64-4cad-aa6c-7626bcec17f6';
const r9hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function r9protected(){
 const rows=(await query(`SELECT jsonb_build_object('r',to_jsonb(r),'c',to_jsonb(c),
  'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=r.id),
  'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM sales_special_stock_order_lines o WHERE request_id=r.id)) AS state
  FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.request_ref='SPREQ-000006'`)).rows;
 r9assert.equal(rows.length,1);return r9hash(rows[0].state);
}
function r9validate(detail){
 r9assert.equal(detail.id,64);r9assert.equal(detail.requestRef,'SPREQ-000009');
 r9assert.equal(detail.customerId,8444);r9assert.equal(detail.operationalYardLocationId,1);
 r9assert.equal(detail.salesOrderId,null);r9assert.equal(detail.purchaseOrderId,null);
 r9assert.equal(detail.salesOrderOperationStatus,'attention');r9assert.equal(detail.salesOrderOperationId,r9operation);
 r9assert.match(detail.salesOrderOperationError,/mbbs-1790411348131-280352/);
 r9assert.equal(new Date(detail.salesOrderSubmissionStartedAt).toISOString(),'2026-09-26T08:29:02.710Z');
 r9assert.equal(detail.quantityReviewPending,false);r9assert.equal(detail.dispatchPlanning.anyPlanned,false);
 r9assert.deepEqual(detail.salesOrderLines.map(line=>[line.itemId,line.quantity,line.uom,line.rate]),[[2055,5,'PC',10],[1784,5,'EACH',40]]);
 r9assert.equal(detail.salesOrderLines[0].nativeDiscountPercent,15);
}
async function r9noOrder(){
 r9assert.deepEqual(await findSpecialStockOrdersByMarkerFromNetSuite({caseId:64,orderKind:'sales_order'}),[]);
 try{await netsuiteRest('/record/v1/salesOrder/eid:MBBS-SPECIAL-SO%3A64');throw Error('Recover the existing external ID; do not rearm.');}
 catch(error){r9assert.equal(error.status,404);r9assert.ok(error.netsuiteErrorCodes.includes('NONEXISTENT_EXTERNAL_ID'));}
}
async function r9preflight(){
 r9assert.equal(r9fs.existsSync(r9path),false,'Preserve the existing recovery checkpoint');
 const before=await r9repo.getSpecialStockCase(64,{audience:'scm'});r9validate(before);
 await r9noOrder();
 const lines=await resolveSpecialOrderUnitsFromNetSuite(before.salesOrderLines);
 r9assert.deepEqual(lines.map(line=>line.unitId),[865,246]);
 const payload=r9payload.buildSpecialSalesOrderPayload({caseId:64,netsuiteLocationId:1,pickupMethodId:config.specialStock.pickupMethodId,
  draft:{...before,materialLines:lines.filter(line=>!line.ancillary),ancillaryLines:lines.filter(line=>line.ancillary)}});
 r9assert.equal(payload.externalId,'MBBS-SPECIAL-SO:64');
 r9assert.deepEqual(payload.item.items.map(line=>[line.item.id,line.rate]),[['2055',10],['10716',-7.5],['1784',40]]);
 r9fs.writeFileSync(r9path,JSON.stringify({before,payload,protectedHash:await r9protected()}),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({prepared:true,requestRef:before.requestRef,revision:before.revision,externalIdAbsent:true,markerAbsent:true,
  transport:'restRecord',materialAmount:50,discountAmount:-7.5,palletAmount:200,writes:0}));
}
async function r9verify(checkpoint,detail){
 r9assert.equal(detail.id,64);r9assert.equal(detail.salesOrderOperationStatus,'linked');r9assert.ok(detail.salesOrderId);
 const record=(await netsuiteRest(`/record/v1/salesOrder/${Number(detail.salesOrderId)}?expandSubResources=true`)).data;
 r9assert.equal(record.externalId,'MBBS-SPECIAL-SO:64');r9assert.equal(record.tranId,detail.salesOrderRef);
 r9assert.deepEqual(record.item.items.map(line=>[Number(line.item.id),line.quantity??null,Number(line.rate),Number(line.amount)]),
  [[2055,5,10,50],[10716,null,-7.5,-7.5],[1784,5,40,200]]);
 const markers=await findSpecialStockOrdersByMarkerFromNetSuite({caseId:64,orderKind:'sales_order'});
 r9assert.equal(markers.length,1);r9assert.equal(Number(markers[0].id),detail.salesOrderId);
 r9assert.equal(await r9protected(),checkpoint.protectedHash);
 const result={recovered:true,requestRef:detail.requestRef,salesOrderId:detail.salesOrderId,salesOrderRef:detail.salesOrderRef,
  status:detail.salesOrderStatus,total:record.total,transport:'restRecord',discountAmount:-7.5,discountAfterMaterial:true,
  exactMarkerCount:1,protectedRequestUnchanged:true};
 r9fs.writeFileSync('/tmp/special-rest-recovery-000009-result.json',JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify(result));
}
async function r9apply(checkpoint){
 r9assert.equal(await r9protected(),checkpoint.protectedHash);
 let detail=await r9repo.getSpecialStockCase(64,{audience:'scm'});
 if(detail.salesOrderId)return r9verify(checkpoint,detail);
 const rearmed=(await query("SELECT 1 FROM sales_special_stock_events WHERE request_id=64 AND event_type='special_rest_retry_authorized' AND details->>'operationId'=$1",[r9operation])).rowCount;
 if(!rearmed){
  r9validate(detail);r9assert.equal(detail.revision,checkpoint.before.revision);await r9noOrder();
  await r9db.withTransaction(async()=>{
   const locked=await query('SELECT r.revision FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=64 FOR UPDATE OF r,c');
   r9assert.equal(Number(locked.rows[0].revision),checkpoint.before.revision);
   const current=await r9repo.getSpecialStockCase(64,{audience:'scm'});r9validate(current);
   r9assert.deepEqual(current.salesOrderLines,checkpoint.before.salesOrderLines);
   const updated=await query("UPDATE sales_special_stock_cases SET sales_order_submission_started_at=NULL,updated_at=now() WHERE request_id=64 AND sales_order_operation_id=$1 AND sales_order_operation_status='attention' AND sales_order_netsuite_id IS NULL",[r9operation]);
   r9assert.equal(updated.rowCount,1);
   await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=64');
   await query("INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details) VALUES(64,'special_rest_retry_authorized',NULL,'all',$1::jsonb)",
    [JSON.stringify({operationId:r9operation,previousError:checkpoint.before.salesOrderOperationError,
     reason:'User requested standard REST with calculated currency discounts. Fresh marker and external-ID checks found no SO. Unique external ID prevents duplicate creation.'})]);
  });
  detail=await r9repo.getSpecialStockCase(64,{audience:'scm'});
 }
 detail=await r9service.createSpecialStockRequestService().createSalesOrder(64,{expectedRevision:detail.revision,operationId:r9operation,source:'standalone'});
 await r9verify(checkpoint,detail);
}
try{await r9priority.withOperatorNetSuitePriority(async()=>{
 const mode=process.argv.at(-1);r9assert.ok(['preflight','apply','verify'].includes(mode));
 if(mode==='preflight')return r9preflight();
 const checkpoint=JSON.parse(r9fs.readFileSync(r9path,'utf8'));
 if(mode==='apply')return r9apply(checkpoint);
 return r9verify(checkpoint,await r9repo.getSpecialStockCase(64,{audience:'scm'}));
});}finally{await r9db.closeDb();}process.exit(0);
