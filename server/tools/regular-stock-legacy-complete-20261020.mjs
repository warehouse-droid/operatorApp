// Run in the production app with stdin, after the user-approved dry run.
// Reads NetSuite only; mutations affect the two named local stock requests.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {getScmStockRequest,getStockTransfer,rejectPendingStockTransfer,recordStockRequestEvent} from '/app/src/stock-request-repository.js';
import {fetchTransferOrderByIdFromNetSuite,findTransferOrdersByStockRequestMarkerFromNetSuite} from '/app/src/netsuite.js';
const apply=process.argv.includes('--apply');
const targets=[{id:15,ref:'STREQ-000015',draft:9,orders:{8:'TOB00935'}},{id:38,ref:'STREQ-000037',draft:21,orders:{19:'TOB01040',20:'TOB01014'}}];
const reason='User confirmed obsolete local draft on 2026-10-20 after actual NetSuite TO verification; close remaining draft and complete the request.';
try{
  const plans=[];
  for(const target of targets){
    const before=await getScmStockRequest(target.id);assert.equal(before.requestRef,target.ref);assert.equal(before.workflowVersion,1);
    const draft=await getStockTransfer(target.draft);assert.equal(draft.requestId,target.id);assert(['pending_local','cancelled'].includes(draft.status));
    assert.equal(draft.netsuiteTransferOrderId,null);assert.equal(draft.netsuiteTransferOrderRef,null);
    const matches=await findTransferOrdersByStockRequestMarkerFromNetSuite({transferId:target.draft,sourceLocationId:draft.sourceLocationId,destinationLocationId:draft.destinationLocationId});
    assert.equal(matches.length,0,'A remote TO now matches this draft; do not cancel it.');
    const orders=[];
    for(const [id,ref] of Object.entries(target.orders)){
      const local=await getStockTransfer(Number(id));assert.equal(local.requestId,target.id);
      const actual=await fetchTransferOrderByIdFromNetSuite(local.netsuiteTransferOrderId);assert.equal(actual?.tranid,ref);
      const status=/\bclosed\b/i.test(actual.status_text)?'closed':/\breceived\b/i.test(actual.status_text)?'received':null;
      assert(status,'The actual TO is not terminal; do not complete this request.');
      orders.push({local,actual,status});
    }
    const reservations=(await query(`SELECT reservation.* FROM sales_stock_transfer_reservations reservation
      JOIN sales_stock_transfer_lines line ON line.id=reservation.transfer_line_id WHERE line.transfer_id=ANY($1::bigint[])`,[[target.draft,...Object.keys(target.orders).map(Number)]])).rows;
    plans.push({target,before,draft,orders,reservations});
  }
  console.log(JSON.stringify({mode:apply?'apply':'preview',verifiedAt:new Date().toISOString(),reason,plans}));
  if(apply)await withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='5s'");
    for(const plan of plans){
      const {target,before,draft,orders}=plan;
      await query('SELECT id FROM sales_stock_transfers WHERE request_id=$1 ORDER BY id FOR UPDATE',[target.id]);
      const current=(await query('SELECT revision FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[target.id])).rows[0];
      assert.equal(Number(current.revision),before.revision,'Request changed after verification.');
      for(const {local,actual,status} of orders){
        const current=await getStockTransfer(local.id);assert.equal(current.revision,local.revision);assert.equal(current.netsuiteTransferOrderId,local.netsuiteTransferOrderId);
        await query(`UPDATE sales_stock_transfers SET status=$2,netsuite_status=$3,netsuite_status_text=$4,netsuite_updated_at=now(),updated_at=now() WHERE id=$1`,[local.id,status,actual.status,actual.status_text]);
        await query(`UPDATE sales_stock_request_lines request_line SET status=$2,updated_at=now()
          FROM sales_stock_transfer_lines transfer_line WHERE transfer_line.request_line_id=request_line.id AND transfer_line.transfer_id=$1`,[local.id,status]);
        await query(`UPDATE sales_stock_transfer_reservations reservation SET status=$2,updated_at=now()
          FROM sales_stock_transfer_lines line WHERE line.id=reservation.transfer_line_id AND line.transfer_id=$1 AND reservation.status='active'`,[local.id,status==='received'?'executed':'released']);
      }
      if(draft.status==='pending_local')await rejectPendingStockTransfer(draft.id,{expectedRevision:draft.revision,expectedRequestRevision:before.revision,reason});
      const after=await getScmStockRequest(target.id);
      assert.equal(after.status,'completed');assert.equal(after.statusSummary.status,'completed');
      assert(after.lines.every(line=>['received','closed','rejected','cancelled','fulfilled'].includes(line.status)));
      await recordStockRequestEvent({requestId:target.id,eventType:'regular_legacy_completion_verified',details:{reason,
        actualTransfers:orders.map(({actual,status})=>({id:Number(actual.id),reference:actual.tranid,status,actualStatus:actual.status_text})),obsoleteDraftId:draft.id,previousRevision:before.revision}});
      console.log(JSON.stringify({completed:target.ref,revision:after.revision,status:after.statusSummary.status,
        transfers:after.transfers.map(t=>({id:t.id,ref:t.netsuiteTransferOrderRef,status:t.status}))}));
    }
  });
}finally{await closeDb();}
