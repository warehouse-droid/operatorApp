import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {createInventoryDamageRouter} from '../src/operator-inventory-router.js';
import {assertDamagePhotoAccess} from '../src/inventory-damage-repository.js';
import {app} from '../src/server.js';
import {createOperator,loginOperator} from '../src/auth-repository.js';
import {query,closeDb} from '../src/db.js';
let server,base,op,manager,other;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const [name,role,yards] of [['op','operator',[1]],['manager','yard_manager',[1]],['other','operator',[28]]]) {
    const username=`inventory-http-${name}-${crypto.randomUUID()}`,password=crypto.randomUUID();
    const actor=await createOperator({username,password,displayName:name,role,operatorYardLocationIds:yards,yardLocationIds:yards});
    const session={actor,...await loginOperator(username,password)};
    if(name==='op') op=session; else if(name==='manager') manager=session; else other=session;
  }
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,item_type,to_pcs) VALUES(980300,'HTTP Count SKU','PCS','InvtPart',1) ON CONFLICT DO NOTHING");
  await query('INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand) VALUES(980300,1,10) ON CONFLICT DO NOTHING');
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await closeDb();});
async function request(path,session,body,method=body?'POST':'GET') {
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(session?{authorization:`Bearer ${session.token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const text=await response.text(); let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,data};
}
test('A1: new endpoints require authentication, role and yard scope',async()=>{
  for(const path of ['/api/count-sheets','/api/control/count-sheets','/api/inventory/damage/config']) assert.equal((await request(path)).status,401);
  assert.equal((await request('/api/control/count-sheets',op)).status,403);
  assert.equal((await request('/api/control/count-sheets/catalog?locationId=28',manager)).status,403);
  assert.equal((await request('/api/inventory/damage/items?locationId=1',other)).status,403);
  assert.equal((await request('/api/inventory/damage/config',op)).data.reasons.length,5);
});
test('C1-C5: real HTTP creation, claim, zero count and review',async()=>{
  const created=await request('/api/control/count-sheets',manager,{requestId:crypto.randomUUID(),locationId:1,title:'HTTP sheet',itemIds:[980300]});
  assert.equal(created.status,201);const id=created.data.id;
  assert.equal((await request(`/api/count-sheets/${id}`,other)).status,403);
  let response=await request(`/api/count-sheets/${id}/take`,op,{});assert.equal(response.status,200);
  const sheet=response.data;
  response=await request(`/api/count-sheets/${id}/line`,op,{attempt:sheet.attempt,revision:sheet.revision,itemId:980300,values:{pieces:0}});
  assert.equal(response.status,200);assert.equal(response.data.counted,1);
  const complete=await request(`/api/count-sheets/${id}/submit`,op,{attempt:response.data.attempt,revision:response.data.revision});
  assert.equal(complete.data.status,'submitted');assert.equal('variance' in complete.data.items[0].count,false);
  const review=await request(`/api/control/count-sheets/${id}`,manager);assert.equal(Number(review.data.items[0].count.variance),-10);
});
test('A1/D2: invalid damage submission and cross-yard photo access fail before NetSuite',async()=>{
  const reportId=crypto.randomUUID();
  assert.equal((await request('/api/inventory/damage/reports',op,{requestId:reportId,locationId:1,itemId:980300,reasonId:7,values:{pieces:1},photos:[]})).status,400);
  const reference=`r2://operator/operator-damage-photo/2026/09/23/${op.actor.id}/yard-1/${reportId}/a.jpg`;
  assert.equal((await request(`/api/photo-upload/preview?ref=${encodeURIComponent(reference)}`,other)).status,403);
});
test('D2-D7: real damage routes save, post, review and authorize photographs across network boundaries',async()=>{
  await query('TRUNCATE inventory_damage_adjustments,inventory_damage_photos,inventory_damage_events,inventory_damage_reports,inventory_damage_months RESTART IDENTITY');
  let record;
  const remote={directory:async()=>[{id:1,name:'3445',subsidiary:1},{id:10,name:'3445 Damage',parent:1}],
    findMonthly:async()=>record?[record]:[],findExternal:async()=>record || null,get:async()=>record,units:async()=>({'191':'PCS'}),
    create:async payload=>{record={...payload,id:991111,tranId:'IT-TEST',inventory:{items:payload.inventory.items.map(line=>({...line,line:1}))}};return record;}};
  const local=express();local.use(express.json());local.use((req,_res,next)=>{req.operator=op.actor;next();});
  local.use(createInventoryDamageRouter({getItem:async()=>({item_id:980300,location_id:1,item_name:'HTTP Count SKU',item_type:'InvtPart',stock_unit:'PCS',sales_unit:'PCS',sales_unit_id:191,to_pcs:1}),verifyPhotos:async()=>{},remote}));
  local.use((error,_req,res,_next)=>res.status(error.status || 500).json({error:error.message}));
  const listener=local.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));
  const origin=`http://127.0.0.1:${listener.address().port}`;
  try {
    assert.equal((await fetch(origin+'/items/980300?locationId=1')).status,200);
    const id=crypto.randomUUID(),photo=`r2://operator/operator-damage-photo/2026/09/23/${op.actor.id}/yard-1/${id}/a.jpg`;
    assert.equal(await assertDamagePhotoAccess(op.actor,photo),true);
    const response=await fetch(origin+'/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:id,locationId:1,itemId:980300,values:{pieces:2},reasonId:7,photos:[photo]})});
    assert.equal(response.status,202);const accepted=await response.json();
    let saved;
    for(let attempt=0;attempt<30;attempt++) {saved=await (await fetch(origin+`/reports/${id}`)).json();if(saved.status==='posted')break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(saved.status,'posted');assert.equal(saved.transfer_ref,'IT-TEST');
    assert.equal(await assertDamagePhotoAccess(op.actor,photo),true);assert.equal(await assertDamagePhotoAccess(op.actor,'r2://operator/order/a.jpg'),false);
    assert.equal(await assertDamagePhotoAccess({...op.actor,role:'yard_manager',roles:['yard_manager','operator'],yardLocationIds:[28]},photo),true,'Operator yard grants still authorize a manager using Operator');
    assert.equal(await assertDamagePhotoAccess({...op.actor,role:'operator',roles:['operator','yard_manager'],operatorYardLocationIds:[],yardLocationIds:[1]},photo),true,'A manager may review photos for their management yard');
    await assert.rejects(assertDamagePhotoAccess(other.actor,photo),{status:403});
    const review=await (await fetch(origin+`/reports?locationId=1&month=${accepted.month}`)).json();assert.equal(review.reports.length,1);assert.equal(review.reports[0].photos[0],photo);
    const retry=await fetch(origin+`/reports/${id}/retry`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(retry.status,200);
    assert.equal(record.inventory.items.length,1);
  } finally {await new Promise(resolve=>listener.close(resolve));}
});
