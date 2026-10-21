// Read-only release verification: do not contact NetSuite or change orders.
import assert from 'node:assert/strict';
const {query,withTransaction,closeDb}=await import(process.cwd()+'/src/db.js');
const {refreshRegularStockEvidence}=await import(process.cwd()+'/src/regular-stock-request-service.js');
const {evaluateRegularStockApproval,regularApprovalExpired}=await import(process.cwd()+'/src/regular-stock-domain.js');
const {getSmartScmSettings}=await import(process.cwd()+'/src/smart-scm-repository.js');
try{
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const settings=await getSmartScmSettings();
  const input={deliveryMethod:'pickup',arrivalAt:5*3600000,now:0,lines:[{id:1,itemId:1,sourceLocationId:1,salesQty:200}],policies:[{itemId:1,sourceLocationId:1,availableQuantity:1000,safetyQuantity:800}]};
  const pickup=evaluateRegularStockApproval(input);assert.equal(pickup.automatic,false);assert(pickup.lines[0].reasons.includes('pickup_scm_review'));
  assert.equal(evaluateRegularStockApproval({...input,deliveryMethod:'delivery'}).automatic,true);
  assert.equal(regularApprovalExpired({regular:{deliveryMethod:'pickup',approvalExpiresAt:'2000-01-01T00:00:00Z'}}),false);
  const id=(await query("SELECT id FROM sales_stock_requests WHERE request_ref='STREQ-000059'")).rows[0].id;
  let refreshes=0;
  const request=await refreshRegularStockEvidence(id,{refreshAvailability:async()=>{refreshes++;throw Error('Must not call NetSuite');}});
  assert.equal(request.regular.handoffStatus,'complete');assert.equal(refreshes,0);assert.equal(request.currentEvidence,undefined);
  const stock=request.lines.find(line=>line.itemId===4757).approvalEvidence;
  assert.equal(stock.availableQuantity,1171.52);assert.equal(stock.groupedRequestedQuantity,523);assert.equal(stock.remainingQuantity,648.52);assert.equal(stock.shortfallQuantity,0);
  return {readOnly:true,pickupAlwaysManual:true,deliveryGatePreserved:true,settings:{autoApproval:settings.regularStockAutoApprovalEnabled,approvalMinutes:settings.regularStockApprovalMinutes,leadHours:settings.regularStockLeadHours},completedSnapshot:{requestRef:request.requestRef,availableAtApproval:stock.availableQuantity,requested:stock.groupedRequestedQuantity,remaining:stock.remainingQuantity,safety:stock.safetyQuantity,unit:stock.unit},netSuiteCalls:0,orderWrites:0};
 });
 console.log(JSON.stringify(result));
}finally{await closeDb();}
