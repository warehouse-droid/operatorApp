// Operational readback only: run through stdin in the live application.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {getScmStockRequest} from '/app/src/stock-request-repository.js';
const references=['STREQ-000015','STREQ-000037','STREQ-000120','STREQ-000164'];
try{
  await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const {rows}=await query('SELECT id,request_ref FROM sales_stock_requests WHERE request_ref=ANY($1::text[]) ORDER BY request_ref',[references]);
    assert.equal(rows.length,references.length);
    for(const row of rows){
      const request=await getScmStockRequest(Number(row.id));
      assert.equal(request.requestRef,row.request_ref);
      assert.equal(request.statusSummary.status,'completed',request.requestRef);
      console.log(JSON.stringify({reference:request.requestRef,status:request.status,statusSummary:request.statusSummary,
        transfers:request.transfers.map(t=>({reference:t.netsuiteTransferOrderRef||t.transferRef,status:t.status}))}));
    }
    const drafts=(await query('SELECT id,status FROM sales_stock_transfers WHERE id=ANY($1::bigint[]) ORDER BY id',[[9,21]])).rows;
    assert.equal(drafts.length,2);assert(drafts.every(row=>row.status==='cancelled'));
    console.log(JSON.stringify({obsoleteDrafts:drafts,readOnly:true,verifiedAt:new Date().toISOString()}));
  });
}finally{await closeDb();}
