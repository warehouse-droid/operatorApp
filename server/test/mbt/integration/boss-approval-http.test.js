import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {app,processNetSuiteOrderWebhook} from '../../../src/server.js';
import {createOperator,loginOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
let server,base,adminToken,plainToken;
async function request(path,token=null,method='GET',body){
 const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 return {status:response.status,body:await response.json()};
}
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 for(const role of ['admin','sales']){
  const username=`boss-http-${crypto.randomUUID()}`;await createOperator({username,role,password:'isolated-boss-test'});
  const {token}=await loginOperator(username,'isolated-boss-test');if(role==='admin'){adminToken=token;}else{plainToken=token;}
 }
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();});
test('account create and edit API persists email with admin-only access',async()=>{
 const created=await request('/api/operators',adminToken,'POST',{username:`boss-email-${crypto.randomUUID()}`,password:'isolated-boss-test',role:'boss',email:'BOSS@Example.TEST'});
 assert.equal(created.status,200);assert.equal(created.body.email,'boss@example.test');
 assert.equal((await request(`/api/operators/${created.body.id}/email`,plainToken,'PUT',{email:'hack@example.test'})).status,403);
 assert.equal((await request(`/api/operators/${created.body.id}/email`,adminToken,'PUT',{email:'bad-address'})).status,400);
 const edited=await request(`/api/operators/${created.body.id}/email`,adminToken,'PUT',{email:'updated@example.test'});
 assert.equal(edited.status,200);assert.equal(edited.body.email,'updated@example.test');
});
test('BOSS APIs deny unauthenticated, public Sales, and admin-only accounts',async()=>{
 for(const path of ['/api/boss/requests','/api/boss/notifications','/api/boss/requests/1']){
  assert.equal((await request(path)).status,401);assert.equal((await request(path,plainToken)).status,403);assert.equal((await request(path,adminToken)).status,403);
 }
 assert.equal((await request('/api/admin/boss-approvals',plainToken)).status,403);
 assert.equal((await request('/api/admin/boss-approvals',adminToken)).status,200);
});
test('SOT webhook queues a delayed status check without publishing an approval or dispatch order',async()=>{
 const id=crypto.randomInt(973000000,973999999);
 const result=await processNetSuiteOrderWebhook({recordType:'salesorder',id,tranid:'SOT-BOSS-TEST',status:'A'});
 assert.equal(result.ignored,true);
 assert.equal((await query('SELECT count(*)::int AS n FROM sales_orders WHERE netsuite_id=$1',[id])).rows[0].n,0);
 assert.equal((await query('SELECT count(*)::int AS n FROM boss_approval_sources WHERE order_id=$1',[id])).rows[0].n,0);
 const delayed=await query('SELECT * FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=$1',[id]);
 assert.equal(delayed.rows.length,1);assert(new Date(delayed.rows[0].available_at)>new Date());
});
