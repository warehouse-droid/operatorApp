import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {closeDb} from '../../../src/db.js';
import {createMbtRouter} from '../../../src/mbt/router.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
after(closeDb);
test('Transport HTTP: Dispatcher can read and save trips; server owns actor; Aggregate Routing remains Admin only',async()=>{
  const f=await transportFixture(),app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.operator={id:f.actor.operatorId,roles:[req.get('x-test-role') || 'dispatcher']};next();});
  app.use('/api/mbt',createMbtRouter({authorizePhase3Capability:async()=>({})}));
  app.use((error,_req,res,_next)=>res.status(error.status || 500).json({error:error.message,code:error.code}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}/api/mbt`;
  try {
    const response=await fetch(`${base}/planning/transport?planDate=${f.planDate}&search=${f.sourceRef}`);
    assert.equal(response.status,200);assert.ok((await response.json()).pool.items.length);
    const input=await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]);
    const saved=await fetch(`${base}/planning/transport/trips`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':input.idempotencyKey},
      body:JSON.stringify({...input,actor:{operatorId:'forged',roles:['admin']}})});
    assert.equal(saved.status,201,await saved.clone().text());
    for (const role of ['operator','mbt_frontdesk','mbt_billing']) {
      assert.equal((await fetch(`${base}/planning/transport?planDate=${f.planDate}`,{headers:{'x-test-role':role}})).status,403);
    }
    assert.equal((await fetch(`${base}/config/aggregate-routing`)).status,403);
    const rules=await fetch(`${base}/config/aggregate-routing`,{headers:{'x-test-role':'admin'}});
    assert.equal(rules.status,200);assert.ok((await rules.json()).items.some(i=>i.itemId==='9909' && i.binOnly));
  } finally {await new Promise(resolve=>server.close(resolve));}
});
