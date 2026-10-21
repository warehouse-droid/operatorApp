// Read-only live acceptance checks; document retrieval may populate its local PDF cache.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {query,closeDb} from '/app/src/db.js';
import {listSpecialStockCases,getSpecialStockCase} from '/app/src/special-stock-request-repository.js';
import {createSpecialOrderDocumentService} from '/app/src/special-stock-documents.js';
const out='/tmp/special-queue-live';mkdirSync(out,{recursive:true});
const report={queues:[],documents:[],access:{}};
try{
 for(const [audience,options]of [['sales',{authorizedStoreLocationIds:[1]}],['scm',{}]]){
  const start=performance.now(),rows=await listSpecialStockCases({audience,...options});
  assert.ok(rows.length);if(audience==='sales')assert.ok(rows.every(row=>row.storeLocationId===1));
  report.queues.push({audience,cases:rows.length,ms:Math.round(performance.now()-start),yards:[...new Set(rows.map(row=>row.storeLocationId))]});
 }
 assert.deepEqual(await listSpecialStockCases({audience:'sales',authorizedStoreLocationIds:[]}),[]);
 assert.deepEqual(await listSpecialStockCases({audience:'sales',authorizedStoreLocationIds:[28],storeLocationId:1}),[]);
 await assert.rejects(getSpecialStockCase(62,{audience:'sales',authorizedStoreLocationIds:[28]}),{status:403});
 report.access={emptyYardsDenied:true,filterCannotWidenAccess:true,otherYardDetailDenied:true};
 for(const[audience,kind]of [['sales','sales_order'],['scm','sales_order'],['scm','purchase_order']]){
  const service=createSpecialOrderDocumentService(),options={audience,...(audience==='sales'?{authorizedStoreLocationIds:[1]}:{})},start=performance.now();
  const pdf=await service.preview(62,kind,options);assert.equal(pdf.buffer.subarray(0,5).toString(),'%PDF-');
  const cached=await service.preview(62,kind,options);assert.equal(cached.cached,true);assert.deepEqual(cached.buffer,pdf.buffer);
  writeFileSync(`${out}/${audience}-${kind}.pdf`,pdf.buffer);
  report.documents.push({audience,kind,order:kind==='sales_order'?'SOB121380':'POB03934',bytes:pdf.buffer.length,cacheHit:pdf.cached,repeatHit:cached.cached,ms:Math.round(performance.now()-start),sha256:createHash('sha256').update(pdf.buffer).digest('hex')});
 }
 await assert.rejects(createSpecialOrderDocumentService().preview(62,'purchase_order',{audience:'sales',authorizedStoreLocationIds:[1]}),{status:403});
 report.access.salesPoDenied=true;
 report.orders=(await query("SELECT request_ref,request.status,special.sales_order_status,special.purchase_order_status,special.close_status FROM sales_stock_requests request JOIN sales_special_stock_cases special ON special.request_id=request.id WHERE request.id=62")).rows;
 writeFileSync(`${out}/result.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await closeDb();}
