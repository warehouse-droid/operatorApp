// Read-only verification through stdin in the live application.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {getScmStockRequest} from '/app/src/stock-request-repository.js';
import {regularStockSalesAction} from '/app/public/regular-stock-status.js';

const references=['STREQ-000015','STREQ-000037','STREQ-000120','STREQ-000163','STREQ-000164'];
try{
  await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const {rows}=await query('SELECT id,request_ref FROM sales_stock_requests WHERE request_ref=ANY($1::text[]) ORDER BY request_ref',[references]);
    assert.equal(rows.length,references.length);
    for(const row of rows){
      const d=await getScmStockRequest(Number(row.id));
      const s=d.statusSummary;
      if(d.requestRef==='STREQ-000163'){
        const open=d.lines.filter(l=>l.supplyStatus!=='already_ordered'&&!['declined','closed'].includes(l.salesDecision));
        const awaitingPo=d.salesOrderId&&!d.purchaseOrderId&&open.length&&open.every(l=>l.supplyStatus&&l.salesDecision==='accepted')
          &&d.informationRequest?.status!=='pending'&&!['completed','closed'].includes(d.stage);
        if(awaitingPo){assert.equal(s.status,'pending_scm');assert.equal(s.detail,'awaiting_po');assert.equal(regularStockSalesAction(d),null);}
        console.log(JSON.stringify({requestRef:d.requestRef,status:s.status,detail:s.detail,waitingReasons:s.waitingReasons,
          salesOrderRef:d.salesOrderRef,purchaseOrderRef:d.purchaseOrderRef,awaitingPoVerified:Boolean(awaitingPo),readOnly:true}));
      }else{
        assert.equal(s.status,'completed',d.requestRef);
        console.log(JSON.stringify({requestRef:d.requestRef,status:s.status,readOnly:true}));
      }
    }
  });
}finally{await closeDb();}
