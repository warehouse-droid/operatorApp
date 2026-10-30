import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {createSpecialStockCase,requestSpecialStockInformation} from '../../../src/special-stock-request-repository.js';

let server,base;
const users={},sku=88998901,run=randomUUID();
async function http(path,role,body){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(role?{Authorization:'Bearer '+users[role].token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,headers:response.headers,body:await response.json()};
}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,vendor_id,to_pcs) VALUES($1,'TEST-ALERT-LIST','Alert list material','EA','TEST Vendor',331,1)",[sku]);
  server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));base=`http://127.0.0.1:${server.address().port}`;
  for(const [name,role,yards] of [['sales','sales',[1]],['peer','sales',[1]],['foreign','sales',[28]],['scm','scm',[]],['dispatch','dispatcher',[]]]){
    const username=`alert-list-${name}-${run}`,password=randomUUID();
    const operator=await createOperator({username,password,displayName:name,role,roles:[role],yardLocationIds:yards});
    const login=await http('/api/auth/login',null,{username,password});assert.equal(login.status,200);users[name]={...operator,token:login.body.token};
  }
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));await closeDb();});
async function special(name='sales',yard=1){
  return createSpecialStockCase({storeLocationId:yard,inquiryDate:'2099-01-01',customerName:'TEST Alert Customer',vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST Alert Material',quantity:1,uom:'PCS',rate:1,requiredDate:'2099-02-01'}]},
    {operatorId:users[name].id,authorizedStoreLocationIds:[yard]});
}
async function pending(d){return requestSpecialStockInformation(d.id,{expectedRevision:d.revision,question:'Please confirm the details'},{operatorId:users.scm.id});}

test('Special alert list includes every counted request beyond 60, preserving counts-only polling and access checks',async()=>{
  const ids=[];for(let i=0;i<65;i++)ids.push((await special()).id);
  const ordinary=await http('/api/scm/special-stock-requests/alerts','scm');assert.equal(ordinary.status,200);assert.equal(ordinary.body.total,65);assert.ok(!('requests' in ordinary.body));
  const all=await http('/api/scm/special-stock-requests/alerts?includeRequests=1','scm');
  assert.equal(all.status,200);assert.equal(all.headers.get('cache-control'),'private, no-store');assert.equal(all.body.requests.length,65);
  assert.deepEqual(new Set(all.body.requests.map(row=>row.id)),new Set(ids));assert.equal(all.body.total,ordinary.body.total);
  const search=all.body.requests.map(row=>row.requestRef.toLowerCase()).join(', ');
  const matching=await http('/api/scm/special-stock-requests?'+new URLSearchParams({search,limit:'100'}),'scm');
  assert.equal(matching.status,200);assert.deepEqual(new Set(matching.body.requests.map(row=>row.id)),new Set(ids));
  assert.equal((await http('/api/scm/special-stock-requests/alerts?includeRequests=1')).status,401);
  assert.equal((await http('/api/scm/special-stock-requests/alerts?includeRequests=1','sales')).status,403);
});
test('Sales Special alert list contains only that requester’s alerts in authorized yards',async()=>{
  const own=[await pending(await special()),await pending(await special())];
  const peer=await pending(await special('peer')),foreign=await pending(await special('foreign',28));
  const all=await http('/api/sales/special-stock-requests/alerts?includeRequests=1&mine=0&storeLocationId=28','sales');
  assert.equal(all.status,200);assert.equal(all.body.total,2);assert.equal(all.body.requests.length,2);
  assert.deepEqual(new Set(all.body.requests.map(row=>row.id)),new Set(own.map(row=>row.id)));
  assert.ok(all.body.requests.every(row=>![peer.id,foreign.id].includes(row.id)));
  const search=[...own,peer,foreign].map(row=>row.requestRef).join(', ');
  const matching=await http('/api/sales/special-stock-requests?'+new URLSearchParams({search,mine:'1'}),'sales');
  assert.equal(matching.status,200);assert.deepEqual(new Set(matching.body.requests.map(row=>row.id)),new Set(own.map(row=>row.id)));

  assert.ok(all.body.requests.every(row=>Object.keys(row).sort().join(',')==='customerName,id,requestRef,stage'));
});
test('SCM Regular alert list returns every regular and Backorder request represented in its count',async()=>{
  const ids=[];
  for(const deliveryMethod of ['stocking','backorder'])for(let i=0;i<2;i++){
    const response=await http('/api/sales/stock-requests','sales',{deliveryMethod,stockingType:'purchase',customerName:'TEST Customer',destinationLocationId:1,fulfillmentMethod:'yard_pickup',lines:[{itemId:sku,pieces:2}]});
    assert.equal(response.status,201,JSON.stringify(response.body));ids.push(response.body.id);
  }
  const ordinary=await http('/api/scm/stock-requests/alerts','scm');
  const all=await http('/api/scm/stock-requests/alerts?includeRequests=1','scm');
  assert.equal(all.status,200);assert.equal(all.body.manualReview,ordinary.body.manualReview);assert.equal(all.body.requests.length,all.body.manualReview);
  assert.deepEqual(new Set(all.body.requests.map(row=>row.id)),new Set(ids));assert.equal(all.body.total,ordinary.body.total);
  for (const audience of ['sales','scm']) {
    const search=all.body.requests.map(row=>row.requestRef).join(', ');
    const matching=await http(`/api/${audience}/stock-requests?`+new URLSearchParams({search,allStatuses:'1'}),audience);
    assert.equal(matching.status,200);assert.deepEqual(new Set(matching.body.requests.map(row=>row.id)),new Set(ids));
  }

});
test('Conversation alert list expands beyond 100 requests without marking messages read or crossing Sales yards',async()=>{
  const requests=(await query(`INSERT INTO sales_stock_requests(destination_location_id,destination_name,requested_by,workflow_version,regular_details)
    SELECT 1,'3445',$1,2,'{"deliveryMethod":"stocking","stockingType":"transfer","requestingLocationId":1}'::jsonb
    FROM generate_series(1,105) RETURNING id`,[users.sales.id])).rows;
  const hidden=(await query(`INSERT INTO sales_stock_requests(destination_location_id,destination_name,requested_by,workflow_version,regular_details)
    VALUES(28,'2967',$1,2,'{"deliveryMethod":"stocking","stockingType":"transfer","requestingLocationId":28}') RETURNING id`,[users.foreign.id])).rows[0];
  await query(`INSERT INTO sales_stock_request_events(request_id,event_type,actor_id,details)
    SELECT unnest($1::bigint[]),'stock_request_conversation_message',$2,'{"audience":"scm","message":"Please review"}'::jsonb`,[[...requests.map(row=>row.id),hidden.id],users.scm.id]);
  const before=(await query('SELECT * FROM stock_request_conversation_reads ORDER BY request_id,operator_id')).rows;
  const ordinary=await http('/api/sales/stock-request-conversation-alerts','sales');
  assert.equal(ordinary.body.requests.length,100);assert.equal(ordinary.body.count,105);
  const all=await http('/api/sales/stock-request-conversation-alerts?includeRequests=1','sales');
  assert.equal(all.status,200);assert.equal(all.body.requests.length,105);assert.equal(all.body.count,105);
  assert.ok(all.body.requests.every(row=>row.id!==Number(hidden.id)));
  assert.deepEqual((await query('SELECT * FROM stock_request_conversation_reads ORDER BY request_id,operator_id')).rows,before);
});
