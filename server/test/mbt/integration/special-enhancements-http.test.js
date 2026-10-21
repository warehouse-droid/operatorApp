import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import {specialSalesReps} from '../../../src/special-stock-sales-reps.js';
const sessions={}, users=[], cases=[], run=crypto.randomUUID();
const testPassword=crypto.randomUUID();
let server,base,flag;
const request=(path,user,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{...(user?{Authorization:`Bearer ${sessions[user].token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
 flag=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 for(const [name,role]of [['requester','sales'],['viewer','sales'],['scm','scm']]){
 const username=`special-enhancement-${name}-${run}`;users.push(username);
 await createOperator({username,displayName:`TEST ${name}`,password:testPassword,role,roles:[role],yardLocationIds:role==='sales'?[1]:[]});
 const response=await request('/api/auth/login',null,{username,password:testPassword});assert.equal(response.status,200);sessions[name]=await response.json();
 }
});
after(async()=>{
 if(server)await new Promise(resolve=>server.close(resolve));
 await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[cases]);await query('DELETE FROM operators WHERE username=ANY($1::text[])',[users]);
 if(flag!==undefined)await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[flag]);await closeDb();
});
const draft=()=>({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'Original customer',vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',lines:[{productName:'Stone',quantity:2,uom:'SQFT',rate:10,requiredDate:'2099-02-01'}]});
test('SCM item-name correction uses the authenticated stock-check endpoint while awaiting confirmation', async()=>{
 const repo=await import('../../../src/special-stock-request-repository.js');
 let detail=await repo.createSpecialStockCase({...draft(),vendorId:330,vendorName:'best wat'},
  {operatorId:sessions.requester.operator.id,authorizedStoreLocationIds:[1]});cases.push(detail.id);
 try {
 const line=()=>({lineId:detail.lines[0].id,kind:'response',supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:330,vendorName:'BWS',vendorYard:'Vendor yard'});
 detail=await repo.saveSpecialStockChecks(detail.id,{expectedRevision:detail.revision,lines:[line()]},{operatorId:sessions.scm.operator.id});
 assert.equal(detail.stage,'await_customer_confirmation');
 const path=`/api/scm/special-stock-requests/${detail.id}/stock-check`;
 const body={expectedRevision:detail.revision,lines:[{...line(),productName:'Fire Pit 32" Square Insert'}]};
 assert.equal((await request(path,null,body)).status,401);
 assert.equal((await request(path,'requester',body)).status,403);
 const response=await request(path,'scm',body);assert.equal(response.status,200);
 const saved=await response.json();assert.equal(saved.lines[0].productName,'Fire Pit 32" Square Insert');assert.equal(saved.lines[0].brand,'BWS');
 assert.equal(saved.revision,detail.revision+1);
 assert.equal((await request(path,'scm',body)).status,409);
 } finally {
  await query('DELETE FROM sales_stock_requests WHERE id=$1',[detail.id]);
  cases.splice(cases.indexOf(detail.id),1);
 }
});
test('HTTP requires active Sales Rep and restricts Sales alerts and own queue to authenticated identity',async()=>{
 const original=specialSalesReps.select;
 specialSalesReps.select=async id=>{if(Number(id)!==123)throw Object.assign(Error('Choose rep'),{status:400,code:'SPECIAL_SALES_REP_REQUIRED'});return {id:123,name:'Validated Rep'};};
 try{
 const path='/api/sales/special-stock-requests';
 const missing=await request(path,'requester',{...draft(),netsuiteSalesRep:{id:999,name:'Forged'}});if(missing.status===201)cases.push((await missing.json()).id);assert.equal(missing.status,400);
 for(const user of ['requester','viewer']){
 const response=await request(path,user,{...draft(),salesRepId:123,netsuiteSalesRep:{id:999,name:'Forged'},requestedBy:'someone-else'});assert.equal(response.status,201);const d=await response.json();cases.push(d.id);
 assert.equal(d.netsuiteSalesRepId,123);assert.equal(d.netsuiteSalesRepName,'Validated Rep');assert.equal(d.requestedBy,sessions[user].operator.id);
 await query("UPDATE sales_special_stock_lines SET supply_status='in_stock' WHERE request_id=$1",[d.id]);
 }
 const endpoint=path+'/alerts';assert.equal((await request(endpoint)).status,401);assert.equal((await request(endpoint,'scm')).status,403);
 const response=await request(endpoint+'?operatorId='+sessions.viewer.operator.id,'requester');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(await response.json(),{awaitCustomerConfirmation:1,dispatchArrangement:0,waitForProduction:0,pendingUpdate:0,total:1});
 const own=await (await request(path+'?mine=1&requestedByOperatorId='+sessions.viewer.operator.id,'requester')).json();assert.deepEqual(own.requests.map(d=>d.id),[cases[0]]);assert.ok(own.vendors.includes('TEST Vendor'));
 const scm=await (await request('/api/scm/special-stock-requests?vendorNames='+encodeURIComponent(JSON.stringify(['TEST Vendor']))+'&requestedByOperatorId=unrelated','scm')).json();
 assert.ok(cases.every(id=>scm.requests.some(d=>d.id===id)));assert.ok(scm.requests.every(d=>d.vendorName==='TEST Vendor'));assert.ok(scm.vendors.includes('TEST Vendor'));
 assert.equal((await request(path+'?vendorNames=invalid','requester')).status,400);
 const changed=await fetch(base+path+'/'+cases[0]+'/expiry',{method:'PUT',headers:{Authorization:`Bearer ${sessions.requester.token}`,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:own.requests[0].revision,expiresOn:'2099-03-01'})});assert.equal(changed.status,200);assert.equal((await changed.json()).expiresOn,'2099-03-01');
 }finally{specialSalesReps.select=original;}
});
