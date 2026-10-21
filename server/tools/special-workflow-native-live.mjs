// Only PDF cache entries for SPREQ-000007 may be written. No order writer is imported.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
const root=process.cwd();
const {query,withTransaction,closeDb}=await import(`${root}/src/db.js`);
const {getSpecialStockCase}=await import(`${root}/src/special-stock-request-repository.js`);
const {createSpecialOrderDocumentService}=await import(`${root}/src/special-stock-documents.js`);
const {fetchSalesOrderPdfFromNetSuite,fetchPurchaseOrderPdfFromNetSuite}=await import(`${root}/src/netsuite.js`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const protectedHash=()=>withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  const {rows:[row]}=await query("SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000006'");
  const {dispatchPlanning:_planning,...original}=await getSpecialStockCase(row.id,{audience:'scm'});
  return hash(JSON.stringify(original));
});
try{
  const expected='096eb965548b9bd078ec4bae5d1078efc97c52eba14e7cd2aa2089449efb58ef';
  assert.equal(await protectedHash(),expected,'Protected request changed');
  const before=await getSpecialStockCase(62,{audience:'scm'});
  assert.equal(before.requestRef,'SPREQ-000007');assert.equal(before.quantityReview.status,'approved');
  assert.equal(before.salesOrderId,1017068);assert.equal(before.purchaseOrderId,1017168);
  assert.equal(before.salesOrderLines.find(l=>l.itemId===2055).quantity,50);assert.equal(before.purchaseOrderLines[0].quantity,50);
  const documents=[];await mkdir('/tmp/special-native-documents-live',{recursive:true,mode:0o700});
  for(const [audience,kind] of [['sales','sales_order'],['scm','sales_order'],['scm','purchase_order']]){
    let remoteHash=null,calls=0;
    const service=createSpecialOrderDocumentService({fetchPdf:async(k,id)=>{
      calls++;const result=await (k==='sales_order'?fetchSalesOrderPdfFromNetSuite:fetchPurchaseOrderPdfFromNetSuite)(id);
      remoteHash=hash(result.buffer);return result;
    }});
    const context={audience,authorizedStoreLocationIds:[before.storeLocationId]};
    const first=await service.preview(62,kind,context),repeat=await createSpecialOrderDocumentService({fetchPdf:async()=>{throw Error('Cached preview must not refetch');}}).preview(62,kind,context);
    assert.equal(repeat.cached,true);assert.deepEqual(repeat.buffer,first.buffer);assert.ok(first.buffer.length>1000);
    if(!first.cached){assert.equal(calls,1);assert.equal(hash(first.buffer),remoteHash);}
    assert.equal(first.buffer.subarray(0,5).toString(),'%PDF-');
    await writeFile(`/tmp/special-native-documents-live/${kind}-${audience}.pdf`,first.buffer,{mode:0o600});
    documents.push({audience,kind,initiallyCached:first.cached,repeatCached:true,remoteCalls:calls,bytes:first.buffer.length,sha256:hash(first.buffer)});
  }
  await assert.rejects(createSpecialOrderDocumentService().preview(62,'purchase_order',{audience:'sales',authorizedStoreLocationIds:[before.storeLocationId]}),{status:403});
  assert.deepEqual(await getSpecialStockCase(62,{audience:'scm'}),before);
  assert.equal(await protectedHash(),expected);
  console.log(JSON.stringify({requestRef:before.requestRef,documents,salesPoForbidden:true,businessCaseUnchanged:true,protectedRequestUnchanged:true,dispatchPlanning:before.dispatchPlanning}));
}finally{await closeDb();}
