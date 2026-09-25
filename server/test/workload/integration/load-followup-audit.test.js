import assert from 'node:assert/strict';
import http from 'node:http';
import test,{before,after} from 'node:test';
import {config} from '../../../src/config.js';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {enqueueNetSuiteOrderWebhook} from '../../../src/netsuite-order-webhook-queue-repository.js';
import {auditDiscardedOrderUpdates} from '../../../tools/load-followup-audit.mjs';
const id=997900100,ref='SOB-AUDIT-FIXTURE',previous={...config.netsuite};
const source=[{line_id:1,netsuite_order_line:1,item_id:602,item_name:'Fixture',item_type:'InvtPart',quantity:4,unit:'PC',location_id:1,location:'3445',piece_qty:4,to_pcs:1},
 {line_id:8,netsuite_order_line:8,item_id:1784,item_name:'PALLET',item_type:'InvtPart',quantity:2,unit:'PC',location_id:1,location:'3445',piece_qty:2,to_pcs:1}];
let server,calls=[];
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'audit-test-token',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
 server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  calls.push({method:req.method,url:req.url});
  assert.match(req.url,/\/query\/v1\/suiteql/,'Repair audit must only read source queries');
  const sql=JSON.parse(body).q;
  const items=sql.includes('tl.uniquekey AS line_id')?source:[{id,tranid:ref,status:'F',status_text:'Fully Billed',expected_delivery_date:'9/17/2026',outbound_location_id:1,outbound_location:'3445',delivery_method:'Pick-Up',memo:''}];
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({items,hasMore:false,totalResults:items.length}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 Object.assign(config.netsuite,{directAccessEnabled:true,restBaseUrl:`http://127.0.0.1:${server.address().port}/services/rest`});
});
after(async()=>{Object.assign(config.netsuite,previous);await new Promise(resolve=>server.close(resolve));await closeDb();});
async function fixture(run){return withTransaction(async()=>{
 await query('TRUNCATE netsuite_order_webhook_inbox RESTART IDENTITY CASCADE');
 const body=quantity=>({recordType:'sales_order',id,tranid:ref,lastModifiedDate:'2026-09-17T11:37:00Z',lines:[{itemId:602,quantity}]});
 const old=await enqueueNetSuiteOrderWebhook({payload:body(4)}),later=await enqueueNetSuiteOrderWebhook({payload:body(6)});
 await query("UPDATE netsuite_order_webhook_inbox SET status='succeeded',superseded_by_id=NULL,received_at=now()-interval '2 minutes' WHERE id=$1",[old.id]);
 await query("UPDATE netsuite_order_webhook_inbox SET status='superseded',superseded_by_id=$2,received_at=now()-interval '1 minute' WHERE id=$1",[later.id,old.id]);
 await query("INSERT INTO sales_orders(netsuite_id,tranid,status,sales_order_type,outbound_location_id,outbound_location,expected_delivery_date,netsuite_active) VALUES($1,$2,'B','Pick-Up',1,'3445','2026-09-17',true)",[id,ref]);
 await query("INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,item_type,quantity,unit,location_id,location,piece_qty,to_pcs,packed_sales_qty,loaded_qty,netsuite_active) VALUES($1,1,1,602,'Fixture','InvtPart',4,'PC',1,'3445',4,1,2,1,true)",[id]);
 calls=[];return run();
},{rollback:true});}
test('discarded update audit reads current source, preserves confirmed/loaded quantities, and repeats without writes',()=>fixture(async()=>{
 const readonly=await auditDiscardedOrderUpdates();assert.equal(readonly.results[0].status,'stale');
 assert.equal((await query('SELECT count(*)::int n FROM sales_order_lines WHERE sales_order_id=$1',[id])).rows[0].n,1);
 const applied=await auditDiscardedOrderUpdates({apply:true});assert.equal(applied.results[0].status,'refreshed');
 const lines=(await query('SELECT line_id,packed_sales_qty,loaded_qty FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY line_id',[id])).rows;
 assert.equal(lines.length,2);assert.equal(Number(lines[0].packed_sales_qty),2);assert.equal(Number(lines[0].loaded_qty),1);
 assert.equal((await query('SELECT status FROM sales_orders WHERE netsuite_id=$1',[id])).rows[0].status,'F');
 assert.equal((await auditDiscardedOrderUpdates({apply:true})).results[0].status,'current');
 assert.equal((await query('SELECT count(*)::int n FROM operator_load_records WHERE order_id=$1',[id])).rows[0].n,0);
 assert.ok(calls.every(call=>call.url.includes('/query/v1/suiteql')));
}));
test('a newer incoming webhook prevents the source audit from replacing local state',()=>fixture(async()=>{
 await enqueueNetSuiteOrderWebhook({payload:{recordType:'sales_order',id,tranid:ref,lastModifiedDate:'2026-09-17T11:38:00Z'}});
 await query("UPDATE netsuite_order_webhook_inbox SET received_at=now()+interval '1 hour' WHERE status='queued'");
 const result=await auditDiscardedOrderUpdates({apply:true});assert.equal(result.results[0].status,'newer_webhook_pending');
 assert.equal((await query('SELECT status FROM sales_orders WHERE netsuite_id=$1',[id])).rows[0].status,'B');
}));
test('reviewed header-only corrections are exact, bounded and leave every line field unchanged',()=>fixture(async()=>{
 await query("INSERT INTO sales_order_lines(sales_order_id,line_id,netsuite_order_line,item_id,item_name,item_type,quantity,unit,location_id,location,piece_qty,to_pcs,netsuite_active) VALUES($1,8,8,1784,'PALLET','InvtPart',2,'PC',1,'3445',2,1,true)",[id]);
 const preview=await auditDiscardedOrderUpdates();const approvedHeaders={[id]:preview.results[0].differences[0]};
 const before=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id',[id])).rows;
 assert.deepEqual((await auditDiscardedOrderUpdates({apply:true,approvedHeaders:{999999999:approvedHeaders[id]}})).results,[]);
 await assert.rejects(auditDiscardedOrderUpdates({apply:true,approvedHeaders:{[id]:{...approvedHeaders[id],remote:['G','2026-09-17',1,'Pick-Up']}}}),/reviewed before\/after/);
 assert.equal((await query('SELECT status FROM sales_orders WHERE netsuite_id=$1',[id])).rows[0].status,'B');
 assert.equal((await auditDiscardedOrderUpdates({apply:true,approvedHeaders})).results[0].status,'refreshed');
 assert.deepEqual((await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id',[id])).rows,before);
 assert.equal((await auditDiscardedOrderUpdates({apply:true,approvedHeaders})).results[0].status,'current');
}));
