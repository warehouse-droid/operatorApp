import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {createOperator,loginOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
let server,base;
const tokens={};
before(async()=>{
 for(const role of ['admin','dispatcher','operator']){
  const username=`sor-${role}-${randomUUID()}`,password=randomUUID();
  await createOperator({username,password,displayName:username,role,roles:[role]});
  tokens[role]=(await loginOperator(username,password)).token;
 }
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});
async function request(path,{role='admin',body}={}){
 const response=await fetch(base+path,{method:body?'PUT':'GET',headers:{'Content-Type':'application/json',...(tokens[role]?{Authorization:`Bearer ${tokens[role]}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
}
test('SOR gate can be audited and toggled independently by Admin only',async()=>{
 const path='/api/mbt/config/gates/sor_rental_workflow';
 const inventory=await request('/api/mbt/config/gates');
 let gate=inventory.body.gates.find(g=>g.flagKey==='sor_rental_workflow');
 assert.ok(gate);assert.equal(gate.effective,false);
 async function change(role,enabled,revision=gate.revision){
  const response=await fetch(base+path,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:`Bearer ${tokens[role]}`,'idempotency-key':randomUUID()},body:JSON.stringify({enabled,expectedRevision:revision,reason:'Isolated SOR gate verification'})});
  return {status:response.status,body:await response.json()};
 }
 const auditBefore=Number((await query("SELECT count(*) FROM mbt_audit_events WHERE entity_id='sor_rental_workflow'")).rows[0].count);
 assert.equal((await change('dispatcher',true)).status,403);
 const on=await change('admin',true);assert.equal(on.status,200);assert.equal(on.body.flag.enabled,true);
 assert.equal((await request('/api/admin/sor-auto-returns/settings')).body.featureEnabled,true);
 assert.equal((await change('admin',false)).status,409);
 gate=on.body.flag;
 const off=await change('admin',false);assert.equal(off.status,200);
 assert.equal((await request('/api/admin/sor-auto-returns/settings')).body.featureEnabled,false);
 assert.equal(Number((await query("SELECT count(*) FROM mbt_audit_events WHERE entity_id='sor_rental_workflow'")).rows[0].count),auditBefore+2);
});
test('SOR-2 real Admin API rejects anonymous and non-admin edits, validates terms, prevents stale writes',async()=>{
 const path='/api/admin/sor-auto-returns/settings';
 assert.equal((await request(path,{role:''})).status,401);
 for(const role of ['dispatcher','operator'])assert.equal((await request(path,{role,body:{terms:'Unauthorized change',expectedRevision:1}})).status,403);
 const initial=await request(path);assert.equal(initial.status,200);assert.match(initial.cache,/no-store/);
 const settings=initial.body.signature;
 assert.equal((await request(path,{body:{terms:' ',expectedRevision:settings.revision}})).status,400);
 const changed=await request(path,{body:{terms:`Authorized ${randomUUID()}`,expectedRevision:settings.revision}});
 assert.equal(changed.status,200);assert.equal(changed.body.revision,settings.revision+1);
 assert.equal((await request(path,{body:{terms:'Stale edit',expectedRevision:settings.revision}})).status,409);
 await request(path,{body:{terms:settings.terms,expectedRevision:changed.body.revision}});
});
test('SOR-2 item overrides persist through actual Admin endpoint and stale edits cannot win',async()=>{
 await query("INSERT INTO sor_item_policies(item_id,item_name,full_name,item_type) VALUES(98800881,'Lift/Day','Lift/Day','Service') ON CONFLICT(item_id) DO NOTHING");
 const items=await request('/api/admin/sor-auto-returns/items?search=98800881');assert.equal(items.body.total,1);
 const initial=items.body.items[0];assert.equal(initial.defaultAutoReturn,true);
 const path='/api/admin/sor-auto-returns/items/98800881';
 const saved=await request(path,{body:{override:false,expectedRevision:initial.revision}});assert.equal(saved.status,200);assert.equal(saved.body.item.override,false);
 assert.equal((await request(path,{body:{override:true,expectedRevision:initial.revision}})).status,409);
 assert.equal((await request(path,{body:{override:'yes',expectedRevision:saved.body.item.revision}})).status,400);
 await query('DELETE FROM sor_item_policies WHERE item_id=98800881');
});
