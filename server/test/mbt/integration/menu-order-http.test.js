import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {app} from '../../../src/server.js';
import {createOperator,loginOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import {MENU_CATALOG} from '../../../public/menu-order-model.js';

let server,base;
const accounts={};
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const role of ['admin','sales','dispatcher','operator']) {
    const username=`menu-order-${role}-${crypto.randomUUID()}`,password=crypto.randomUUID();
    await createOperator({username,password,displayName:'Menu order test',role,yardLocationIds:[1],operatorYardLocationIds:[1]});
    accounts[role]=await loginOperator(username,password);
    accounts[role].credentials={username,password};
  }
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(async()=>{await query("UPDATE app_menu_order_settings SET orders='{}',revision=revision+1 WHERE id=true");});
after(async()=>{server?.closeAllConnections();if(server) {await new Promise(resolve=>server.close(resolve));}await closeDb();});
async function request(path='/api/admin/menu-order',role='admin',body) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'PUT',
    headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${accounts[role].token}`}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,headers:response.headers,data:await response.json()};
}
test('public order is safe while admin catalog and writes require Admin',async()=>{
  const publicView=await request('/api/navigation/menu-order',null);
  assert.equal(publicView.status,200);assert.deepEqual(Object.keys(publicView.data).sort(),['orders','revision']);
  assert.equal(publicView.headers.get('cache-control'),'no-store');
  assert.equal((await request('/api/admin/menu-order',null)).status,401);
  for(const role of ['sales','dispatcher','operator']) {
    assert.equal((await request('/api/admin/menu-order',role)).status,403);
    assert.equal((await request('/api/admin/menu-order',role,{orders:{},expectedRevision:publicView.data.revision})).status,403);
  }
  const admin=await request();assert.equal(admin.status,200);assert.deepEqual(admin.data.catalog,MENU_CATALOG);
});
test('saved order is global, audited, survives another login and resets',async()=>{
  const initial=(await request()).data;
  const orders={sales:['/sales/printing','/sales/delivery-requests'],main:['/sales','/dispatch']};
  const saved=await request('/api/admin/menu-order','admin',{orders,expectedRevision:initial.revision});
  assert.equal(saved.status,200);assert.deepEqual(saved.data.orders,orders);assert.equal(saved.data.revision,initial.revision+1);
  assert.deepEqual((await request('/api/navigation/menu-order','sales')).data.orders,orders);
  const relogin=await loginOperator(accounts.admin.credentials.username,accounts.admin.credentials.password);
  const reloaded=await fetch(base+'/api/admin/menu-order',{headers:{Authorization:`Bearer ${relogin.token}`}});
  assert.deepEqual((await reloaded.json()).orders,orders);
  const audit=await query("SELECT details FROM delivery_audit_log WHERE action='menu_order.saved' AND actor_operator_id=$1 ORDER BY id DESC LIMIT 1",[accounts.admin.operator.id]);
  assert.deepEqual(audit.rows[0].details.orders,orders);
  const reset=await request('/api/admin/menu-order','admin',{orders:{},expectedRevision:saved.data.revision});
  assert.equal(reset.status,200);assert.deepEqual((await request('/api/navigation/menu-order',null)).data.orders,{});
});
test('invalid shapes, unknown links and missing revision cannot change saved settings',async()=>{
  const initial=(await request()).data;
  for(const body of [null,[],{}, {orders:{},expectedRevision:'1'}, {orders:{sales:['/admin']},expectedRevision:initial.revision},
    {orders:{sales:['/sales/printing','/sales/printing']},expectedRevision:initial.revision},
    {orders:{main:['https://evil.example/']},expectedRevision:initial.revision},
    {orders:{},expectedRevision:initial.revision,operatorId:accounts.admin.operator.id}]) {
    assert.equal((await request('/api/admin/menu-order','admin',body)).status,400);
  }
  assert.deepEqual((await request()).data,initial);
});
test('concurrent saves from one revision have exactly one winner',async()=>{
  const initial=(await request()).data;
  const orders=[{sales:['/sales/printing']},{dispatch:['/dispatch/planning']}];
  const replies=await Promise.all(orders.map(value=>request('/api/admin/menu-order','admin',{orders:value,expectedRevision:initial.revision})));
  assert.deepEqual(replies.map(reply=>reply.status).sort(),[200,409]);
  const final=(await request()).data;
  assert.equal(final.revision,initial.revision+1);assert.deepEqual(final.orders,orders[replies.findIndex(reply=>reply.status===200)]);
});
test('migration is repeatable without resetting saved order',async()=>{
  const initial=(await request()).data;
  const saved=(await request('/api/admin/menu-order','admin',{orders:{scm:['/scm/smart']},expectedRevision:initial.revision})).data;
  await query(await fs.readFile(new URL('../../../migrations/266_app_menu_order.sql',import.meta.url),'utf8'));
  assert.deepEqual((await request()).data.orders,saved.orders);assert.equal((await request()).data.revision,saved.revision);
  assert.equal((await fetch(base+'/admin/menu-order')).status,200);
});
test('stored links removed in a future release do not break navigation or the editor',async()=>{
  await query('UPDATE app_menu_order_settings SET orders=$1 WHERE id=true',[JSON.stringify({sales:['/retired-page','/sales/printing']})]);
  assert.deepEqual((await request()).data.orders,{sales:['/sales/printing']});
  assert.deepEqual((await request('/api/navigation/menu-order',null)).data.orders,{sales:['/sales/printing']});
});
