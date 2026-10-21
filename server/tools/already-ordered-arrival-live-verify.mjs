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
    const ordered=(await query(`SELECT special.request_id FROM sales_special_stock_cases special
      JOIN sales_stock_requests request ON request.id=special.request_id
      WHERE request.status<>'cancelled' AND special.workflow_kind='backorder' AND special.close_status='active' AND EXISTS(
        SELECT 1 FROM sales_special_stock_lines line WHERE line.request_id=special.request_id AND line.removed_at IS NULL AND line.supply_status='already_ordered')
      ORDER BY special.request_id`)).rows;
    const statuses={arrival:0,arrived:0};
    for(const row of ordered){
      const d=await getScmStockRequest(Number(row.request_id));
      assert(d.alreadyOrderedArrival);
      assert(d.statusSummary.waitingReasons.includes(d.alreadyOrderedArrival.status));
      if(d.lines.every(line=>line.supplyStatus==='already_ordered'||['declined','closed'].includes(line.salesDecision)))assert.equal(d.statusSummary.status,'completed');
      statuses[d.alreadyOrderedArrival.status]++;
      console.log(JSON.stringify({reference:d.requestRef,mainStatus:d.statusSummary.status,supplyWaiting:d.alreadyOrderedArrival.status,
        receivedOrders:d.alreadyOrderedArrival.orders.filter(po=>po.arrived).length,totalOrders:d.alreadyOrderedArrival.orders.length}));
    }
    assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='299_backorder_arrival_reads.sql'")).rows[0].n,1);
    console.log(JSON.stringify({alreadyOrderedRequests:ordered.length,statuses,readOnly:true}));

  });
}finally{await closeDb();}
