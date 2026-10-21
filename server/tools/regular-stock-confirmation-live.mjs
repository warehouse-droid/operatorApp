// Validate the reported case without confirming or writing an order.
import assert from 'node:assert/strict';
const {query,withTransaction,closeDb}=await import(process.cwd()+'/src/db.js');
const {getScmStockRequest}=await import(process.cwd()+'/src/stock-request-repository.js');
const {previewRegularStockSalesOrder}=await import(process.cwd()+'/src/regular-stock-handoff.js');
try{
 const snapshot=globalThis.regularVerifiedOrder;assert.equal(snapshot.ref,'SOB121631');
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const request=await getScmStockRequest(71);assert.equal(request.requestRef,'STREQ-000059');
  const before=(await query('SELECT status FROM regular_stock_handoffs WHERE request_id=71')).rows;
  const input={salesOrderRef:snapshot.ref},context={authorizedDestinationLocationIds:[request.destinationLocationId]};
  let preview,error;
  try{preview=await previewRegularStockSalesOrder(71,input,context,{readOrder:async()=>snapshot});}catch(caught){error=caught;}
  assert.deepEqual((await query('SELECT status FROM regular_stock_handoffs WHERE request_id=71')).rows,before);
  if(before.length)return {alreadyLinked:true,status:before[0].status,action:preview?.action};
  if(error){
   assert.equal(error.code,'REGULAR_SO_MISMATCH');assert.equal(error.status,409);
   const line=request.lines.find(line=>line.itemId===9736);
   const actual=snapshot.lines.filter(row=>row.itemId===9736&&!row.ancillary).reduce((sum,row)=>sum+row.quantity,0);
   assert.equal(error.message,`Quantity mismatch for ${line.itemName}: the stock request approves ${line.salesQty} ${line.salesUom}, but SOB121631 has ${actual} ${line.salesUom}. Quantities must match before linking the SO.`);
   return {rejected:true,requested:line.salesQty,salesOrderQuantity:actual,message:error.message};
  }
  assert(['location','transfer'].includes(preview.action.mode));assert.equal(preview.action.lineCount,snapshot.lines.length);
  assert.equal(preview.confirmationToken.length,64);
  return {rejected:false,confirmationRequired:true,action:preview.action};
 });
 console.log(JSON.stringify({readOnly:true,requestRef:'STREQ-000059',salesOrder:'SOB121631',...result,netSuiteOrderWrites:0}));
}finally{await closeDb();}
