// Re-evaluate the user's reported request through read-only service/domain paths.
import assert from 'node:assert/strict';
const root=process.cwd();
const {query,withTransaction,closeDb}=await import(root+'/src/db.js');
const {getScmStockRequest}=await import(root+'/src/stock-request-repository.js');
const {readRegularStockSalesOrderFromNetSuite}=await import(root+'/src/netsuite.js');
const {previewRegularStockSalesOrder}=await import(root+'/src/regular-stock-handoff.js');
const {planRegularStockRouting}=await import(root+'/src/regular-stock-domain.js');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
 if(new URL(url).pathname.includes('/record/v1/')&&String(options.method||'GET').toUpperCase()!=='GET')throw Error('Preview refuses NetSuite record writes');
 return originalFetch(url,options);
};
try{
 const {request,handoff}=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  return{request:await getScmStockRequest(71),handoff:(await query('SELECT status,plan FROM regular_stock_handoffs WHERE request_id=71')).rows[0]};
 });
 assert.equal(request.requestRef,'STREQ-000059');
 if(handoff?.status==='complete'){
  console.log(JSON.stringify({readOnly:true,requestRef:request.requestRef,alreadyCompleted:true,mode:handoff.plan.mode,
   sourceLocationId:handoff.plan.sourceLocationId,netSuiteOrderWrites:0}));
 }else{
  const order=globalThis.regularVerifiedOrder || await readRegularStockSalesOrderFromNetSuite('SOB121631');
  const preview=await previewRegularStockSalesOrder(71,{salesOrderRef:order.ref},{authorizedDestinationLocationIds:[request.destinationLocationId]},
   {readOrder:async()=>order});
  assert.deepEqual(preview.choices,[]);
  const quantities=new Map();
  for(const line of request.lines.filter(line=>['stock','po'].includes(line.decision)))quantities.set(line.itemId,(quantities.get(line.itemId)||0)+line.salesQty);
  const differences=[...quantities].map(([itemId,requested])=>({itemId,requested,
   salesOrder:order.lines.filter(line=>!line.ancillary&&line.itemId===itemId).reduce((sum,line)=>sum+line.quantity,0)}))
   .filter(line=>Math.abs(line.requested-line.salesOrder)>1e-6);
  if(differences.length){
   assert.throws(()=>planRegularStockRouting({request,salesOrder:order}),error=>error.code==='REGULAR_SO_MISMATCH');
   console.log(JSON.stringify({readOnly:true,requestRef:request.requestRef,salesOrder:order.ref,
    blocked:true,reason:'quantity_mismatch',differences,quantityGuardVerified:true,netSuiteOrderWrites:0}));
  }else{
  const plan=planRegularStockRouting({request,salesOrder:order});
  assert.equal(plan.mode,'location');assert.equal(plan.sourceLocationId,28);assert.equal(plan.materialLineIds.length,2);
  assert.deepEqual(plan.groups,[]);
  const moving=order.lines.filter(line=>plan.materialLineIds.includes(line.remoteLineId)||line.ancillary);
  assert.equal(moving.length,3);assert(moving.some(line=>line.itemId===1784));
  console.log(JSON.stringify({readOnly:true,requestRef:request.requestRef,salesOrder:order.ref,mode:plan.mode,
   targetYard:'2967',sourceLocationId:28,materialLines:2,linesMoving:3,palletIncluded:true,transferOrdersRequired:0,netSuiteOrderWrites:0}));
  }
 }
}finally{globalThis.fetch=originalFetch;await closeDb();}
