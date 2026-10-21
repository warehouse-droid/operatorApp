/* global query,crypto,netsuiteRest,suiteqlAll,prepareSpecialClosurePlanInNetSuite,applySpecialClosurePlanInNetSuite,resolveSpecialOrderUnitsFromNetSuite,fetchTransactionStatusFromNetSuite */
// Appended to the deployed authenticated transport. Only the existing PO closed flag may be written.
const closeAssert=(await import('node:assert/strict')).default;
const closeFs=await import('node:fs');
const closeDb=await import('file:///app/src/db.js');
const closeRepo=await import('file:///app/src/special-stock-request-repository.js');
const closeService=await import('file:///app/src/special-stock-closure-service.js');
const closePriority=await import('file:///app/src/operator-netsuite-request-pool.js');
const closePath='/tmp/special-closure-000007-recovery.private.json';
const closeReviewId='337d40bf-597b-471d-a634-fc7ae0a8b82c';
const closeWrites=[];
const closeBoundary={queryAll:suiteqlAll,rest:async(path,options={})=>{
 if(options.method && options.method!=='GET'){
  closeAssert.equal(process.argv.at(-1),'apply');
  closeAssert.equal(options.method,'PATCH');closeAssert.equal(path,'/record/v1/purchaseOrder/1017168');
  closeAssert.deepEqual(options.body,{item:{items:[{line:1,isClosed:true}]}});
  closeWrites.push({path,method:options.method,body:options.body});
 }
 return netsuiteRest(path,options);
}};
async function closeProtected(){
 const rows=(await query(`SELECT jsonb_build_object('request',to_jsonb(r),'case',to_jsonb(c),
  'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=r.id),
  'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM sales_special_stock_order_lines o WHERE request_id=r.id)) AS state
  FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.request_ref='SPREQ-000006'`)).rows;
 closeAssert.equal(rows.length,1);return crypto.createHash('sha256').update(JSON.stringify(rows[0].state)).digest('hex');
}
function closeIdentity(detail){
 closeAssert.deepEqual([detail.id,detail.requestRef,detail.salesOrderId,detail.salesOrderRef,detail.purchaseOrderId,detail.purchaseOrderRef],
  [62,'SPREQ-000007',1017068,'SOB121380',1017168,'POB03934']);
 closeAssert.equal(detail.closureReview.id,closeReviewId);
 closeAssert.ok(detail.closureReview.confirmedAt && detail.closureReview.confirmedBy);
 closeAssert.equal(detail.dispatchPlanning.anyPlanned,false);
 closeAssert.equal(detail.salesOrderSkipped,false);closeAssert.equal(detail.purchaseOrderSkipped,false);
}
async function closePlan(detail){
 const orders=[];
 for(const [kind,id,lines] of [['sales_order',detail.salesOrderId,detail.salesOrderLines],['purchase_order',detail.purchaseOrderId,detail.purchaseOrderLines]]){
  orders.push({kind,id,lines:await resolveSpecialOrderUnitsFromNetSuite(lines),discountCount:lines.filter(line=>line.nativeDiscountPercent>0).length});
 }
 return prepareSpecialClosurePlanInNetSuite({orders},closeBoundary);
}
async function closeVerify(checkpoint){
 const detail=await closeRepo.getSpecialStockCase(62,{audience:'scm'});closeIdentity(detail);
 closeAssert.equal(detail.closeStatus,'closed');closeAssert.equal(detail.status,'cancelled');closeAssert.equal(detail.closureReview.status,'approved');
 const plan=await closePlan(detail);
 for(const order of plan.orders){
  const previous=checkpoint.plan.orders.find(row=>row.id===order.id);closeAssert.equal(order.lines.length,previous.lines.length);
  for(const line of order.lines){
   const before=previous.lines.find(row=>row.remoteLineId===line.remoteLineId);
   closeAssert.ok(before);closeAssert.equal(line.itemId,before.itemId);closeAssert.equal(line.closed,true);
   closeAssert.equal(line.queryFingerprint,before.queryFingerprint);
  }
 }
 const statuses=await Promise.all([fetchTransactionStatusFromNetSuite(1017068,'SalesOrd'),fetchTransactionStatusFromNetSuite(1017168,'PurchOrd')]);
 for(const status of statuses)closeAssert.match(status.status_text,/: Closed$/);
 const local=(await query("SELECT 'SO' AS kind,status,status_text FROM sales_orders WHERE netsuite_id=1017068 UNION ALL SELECT 'PO',status,status_text FROM purchase_orders WHERE netsuite_id=1017168")).rows;
 closeAssert.equal(local.length,2);for(const order of local)closeAssert.equal(order.status,'closed');
 closeAssert.equal(await closeProtected(),checkpoint.protectedHash);
 const result={verified:true,requestRef:detail.requestRef,requestStatus:detail.status,closureStatus:detail.closeStatus,
  salesOrder:{reference:detail.salesOrderRef,status:statuses[0].status_text},purchaseOrder:{reference:detail.purchaseOrderRef,status:statuses[1].status_text},
  localOrders:local,reviewStatus:detail.closureReview.status,protectedRequestUnchanged:true,writes:closeWrites};
 closeFs.writeFileSync('/tmp/special-closure-000007-result.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}
try{await closePriority.withOperatorNetSuitePriority(async()=>{
 const mode=process.argv.at(-1);closeAssert.ok(['preflight','apply','verify'].includes(mode));
 if(mode==='preflight'){
  closeAssert.equal(closeFs.existsSync(closePath),false,'Preserve the existing checkpoint');
  const detail=await closeRepo.getSpecialStockCase(62,{audience:'scm'});closeIdentity(detail);
  closeAssert.equal(detail.closeStatus,'closure_pending');closeAssert.equal(detail.closureReview.status,'attention');
  const plan=await closePlan(detail),so=plan.orders.find(o=>o.kind==='sales_order'),po=plan.orders.find(o=>o.kind==='purchase_order');
  closeAssert.ok(so.lines.every(l=>l.closed && l.queryOnly && l.queryFingerprint));
  closeAssert.deepEqual(so.lines.map(l=>l.remoteLineId).sort((a,b)=>a-b),[5028178,5028784,5028785]);
  closeAssert.deepEqual(po.lines.map(l=>[l.remoteLineId,l.itemId,l.quantity,l.rate,l.closed]),[[5028378,2055,50,'5',false]]);
  closeFs.writeFileSync(closePath,JSON.stringify({detail,plan,protectedHash:await closeProtected()},null,2),{mode:0o600,flag:'wx'});
  return console.log(JSON.stringify({prepared:true,requestRef:detail.requestRef,closedSalesOrderVerified:true,openPurchaseOrderVerified:true,writes:0}));
 }
 const checkpoint=JSON.parse(closeFs.readFileSync(closePath,'utf8'));
 if(mode==='apply'){
  const detail=await closeRepo.getSpecialStockCase(62,{audience:'scm'});closeIdentity(detail);
  closeAssert.equal(await closeProtected(),checkpoint.protectedHash);
  if(detail.closureReview.status!=='approved'){
   closeAssert.equal(detail.revision,checkpoint.detail.revision);
   const service=closeService.createSpecialClosureService({
    preparePlan:input=>prepareSpecialClosurePlanInNetSuite(input,closeBoundary),
    applyPlan:plan=>applySpecialClosurePlanInNetSuite(plan,closeBoundary)});
   await service.reviewClosure(62,{decision:'approve',reviewId:closeReviewId,expectedRevision:detail.revision},{operatorId:null});
  }
 }
 await closeVerify(checkpoint);
});}finally{await closeDb.closeDb();}process.exit(0);
