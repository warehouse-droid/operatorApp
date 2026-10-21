// Read-only release verification: do not contact NetSuite or change orders.
import assert from 'node:assert/strict';
const {query,withTransaction,closeDb}=await import(process.cwd()+'/src/db.js');
const {refreshRegularStockEvidence}=await import(process.cwd()+'/src/regular-stock-request-service.js');
const {evaluateRegularStockApproval,regularApprovalExpired}=await import(process.cwd()+'/src/regular-stock-domain.js');
const {getSmartScmSettings}=await import(process.cwd()+'/src/smart-scm-repository.js');
const {buildSpecialQuote}=await import(process.cwd()+'/src/special-stock-documents.js');
const {quotePdf}=await import(process.cwd()+'/src/field-sales/pdf.js');
try{
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const settings=await getSmartScmSettings();
  const input={deliveryMethod:'pickup',leadHours:12,now:0,lines:[{id:1,itemId:1,sourceLocationId:1,salesQty:200}],policies:[{itemId:1,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}]};
  const pickup=evaluateRegularStockApproval(input);assert.equal(pickup.automatic,true);assert.equal(pickup.leadTimeApplies,false);assert.deepEqual(pickup.lines[0].reasons,[]);
  const stocking=evaluateRegularStockApproval({...input,deliveryMethod:'stocking'});assert.equal(stocking.automatic,false);assert(stocking.lines[0].reasons.includes('stocking_scm_review'));
  assert.equal(evaluateRegularStockApproval({...input,autoApprovalEnabled:false}).automatic,false);
  assert.equal(evaluateRegularStockApproval({...input,lines:[{...input.lines[0],salesQty:201}]}).automatic,false);
  assert.equal(pickup.arrivalAt,null);assert.equal(stocking.arrivalAt,null);
  assert.throws(()=>evaluateRegularStockApproval({...input,deliveryMethod:'delivery'}),{code:'REGULAR_ARRIVAL_INVALID'});
  assert.equal(evaluateRegularStockApproval({...input,deliveryMethod:'delivery',arrivalAt:0}).automatic,false);
  assert.equal(evaluateRegularStockApproval({...input,deliveryMethod:'delivery',arrivalAt:12*3600000}).automatic,true);
  assert.equal(regularApprovalExpired({regular:{deliveryMethod:'pickup',approvalExpiresAt:'2000-01-01T00:00:00Z'}}),true);
  const id=(await query("SELECT id FROM sales_stock_requests WHERE request_ref='STREQ-000059'")).rows[0].id;
  let refreshes=0;
  const request=await refreshRegularStockEvidence(id,{refreshAvailability:async()=>{refreshes++;throw Error('Must not call NetSuite');}});
  assert.equal(request.regular.handoffStatus,'complete');assert.equal(refreshes,0);assert.equal(request.currentEvidence,undefined);
  const stock=request.lines.find(line=>line.itemId===4757).approvalEvidence;
  assert.equal(stock.availableQuantity,1171.52);assert.equal(stock.groupedRequestedQuantity,523);assert.equal(stock.remainingQuantity,648.52);assert.equal(stock.shortfallQuantity,0);
  const packs={palletQty:2,sectionQty:4,layerQty:3.5,pieceQty:6};
  const quote=buildSpecialQuote({requestRef:'SPREQ-VERIFY',revision:1,inquiryDate:'2026-09-29',customerName:'Fictional verification',fulfillmentMethod:'yard_pickup',storeName:'3445',lines:[{productName:'Verification material',packageQuantity:2,uom:'PLT',originalRate:520,discountPercent:5,...packs}]},{name:'MBBS',taxBps:1300});
  assert.equal(quote.snapshot.showPackQuantities,true);assert.deepEqual(quote.snapshot.lines[0].packQuantities,packs);assert.equal(quote.snapshot.totalMinor,111644);
  const pdf=await quotePdf(quote);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  return {readOnly:true,pickupAndStockingWithoutArrival:true,deliveryArrivalRequired:true,specialQuotePacking:true,quoteTotalPreserved:true,quotePdfBytes:pdf.length,stockingAlwaysManual:true,pickupNoMinimumLead:true,pickupSafetyAndEnabledGate:true,pickupExpiryPreserved:true,deliveryGatePreserved:true,settings:{autoApproval:settings.regularStockAutoApprovalEnabled,approvalMinutes:settings.regularStockApprovalMinutes,leadHours:settings.regularStockLeadHours},completedSnapshot:{requestRef:request.requestRef,availableAtApproval:stock.availableQuantity,requested:stock.groupedRequestedQuantity,remaining:stock.remainingQuantity,safety:stock.safetyQuantity,unit:stock.unit},netSuiteCalls:0,orderWrites:0};
 });
 console.log(JSON.stringify(result));
}finally{await closeDb();}
