// Read-only verification. No NetSuite calls, order changes or request updates.
import assert from 'node:assert/strict';
const {query,withTransaction,closeDb}=await import(process.cwd()+'/src/db.js');
const {refreshRegularStockEvidence}=await import(process.cwd()+'/src/regular-stock-request-service.js');
const {getSmartScmSettings}=await import(process.cwd()+'/src/smart-scm-repository.js');
try{
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  assert.equal((await query("SELECT 1 FROM schema_migrations WHERE filename='240_regular_stock_approval_controls.sql'")).rowCount,1);
  const indexes=(await query("SELECT indexname FROM pg_indexes WHERE tablename='regular_stock_handoffs' AND indexname IN ('regular_stock_handoffs_sales_order_unique','regular_stock_handoffs_sales_ref_unique')")).rows;
  assert.equal(indexes.length,2);
  const settings=await getSmartScmSettings();assert.equal(typeof settings.regularStockAutoApprovalEnabled,'boolean');assert(settings.regularStockApprovalMinutes>0);
  const id=(await query("SELECT id FROM sales_stock_requests WHERE request_ref='STREQ-000059'")).rows[0].id;
  let refreshes=0;
  const request=await refreshRegularStockEvidence(id,{refreshAvailability:async()=>{refreshes++;throw Error('Live verification must not refresh stock');}});
  assert.equal(request.regular.handoffStatus,'complete');assert.equal(refreshes,0);assert.equal(request.currentEvidence,undefined);
  const stock=request.lines.find(line=>line.itemId===4757).approvalEvidence;
  assert.equal(stock.availableQuantity,1171.52);assert.equal(stock.groupedRequestedQuantity,523);assert.equal(stock.remainingQuantity,648.52);assert.equal(stock.shortfallQuantity,0);
  return {readOnly:true,settings:{autoApproval:settings.regularStockAutoApprovalEnabled,approvalMinutes:settings.regularStockApprovalMinutes,leadHours:settings.regularStockLeadHours},
   uniqueSalesOrderIndexes:indexes.length,completedSnapshot:{requestRef:request.requestRef,availableAtApproval:stock.availableQuantity,requested:stock.groupedRequestedQuantity,remaining:stock.remainingQuantity,safety:stock.safetyQuantity,unit:stock.unit},netSuiteCalls:0,orderWrites:0};
 });
 console.log(JSON.stringify(result));
}finally{await closeDb();}
