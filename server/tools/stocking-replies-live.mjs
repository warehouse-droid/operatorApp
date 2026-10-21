import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {query,closeDb} from './src/db.js';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {createSpecialOrderDocumentService} from './src/special-stock-documents.js';

try{
  const row=(await query('SELECT id,destination_location_id,revision FROM sales_stock_requests WHERE request_ref=$1',['SPREQ-000043'])).rows[0];
  assert.ok(row,'SPREQ-000043 must exist');
  const context={audience:'sales',authorizedStoreLocationIds:[Number(row.destination_location_id)]};
  const detail=await getSpecialStockCase(Number(row.id),context);assert.ok(detail.salesOrderId);
  const document=await createSpecialOrderDocumentService().preview(Number(row.id),'sales_order',context);
  assert.equal(document.buffer.subarray(0,5).toString(),'%PDF-');
  const after=(await query('SELECT revision FROM sales_stock_requests WHERE id=$1',[row.id])).rows[0];assert.equal(after.revision,row.revision,'Preview must not edit the request');
  console.log(JSON.stringify({passed:true,requestRef:detail.requestRef,salesOrderId:detail.salesOrderId,salesOrderRef:detail.salesOrderRef,
    salesOrderSource:detail.salesOrderSource,localSoDraftLines:detail.salesOrderLines.length,pdfBytes:document.buffer.length,
    pdfSha256:createHash('sha256').update(document.buffer).digest('hex'),cached:document.cached,requestRevisionUnchanged:true}));
}catch(error){console.log(JSON.stringify({passed:false,code:error.code||null,message:error.message}));process.exitCode=1;}
finally{await closeDb();}
