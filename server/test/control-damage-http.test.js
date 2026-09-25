import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {query,closeDb} from '../src/db.js';
import {createOperator,loginOperator} from '../src/auth-repository.js';
import {app} from '../src/server.js';
import {createControlDamageRouter} from '../src/control-damage-router.js';
import {submitDamageReport} from '../src/inventory-damage-service.js';
let manager,operator,server,base;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const role of ['yard_manager','operator']) {
    const username=`control-damage-http-${crypto.randomUUID()}`,password=crypto.randomUUID();
    const actor=await createOperator({username,password,displayName:role,role,yardLocationIds:role==='yard_manager'?[1]:[],operatorYardLocationIds:role==='operator'?[1]:[]});
    const session={actor,...await loginOperator(username,password)};if(role==='yard_manager')manager=session;else operator=session;
  }
  await query('TRUNCATE inventory_damage_adjustments,inventory_damage_photos,inventory_damage_events,inventory_damage_reports,inventory_damage_months RESTART IDENTITY');
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await closeDb();});
const headers=session=>({'content-type':'application/json',...(session?{authorization:`Bearer ${session.token}`}:{})});
test('CH1: production Control routes enforce authentication, role, yard and no-store responses',async()=>{
  for(const path of ['/api/control/damage/config','/api/control/damage/review?locationId=1&month=2026-09']) {
    assert.equal((await fetch(base+path)).status,401);assert.equal((await fetch(base+path,{headers:headers(operator)})).status,403);
  }
  const config=await fetch(base+'/api/control/damage/config',{headers:headers(manager)});
  assert.equal(config.status,200);assert.equal(config.headers.get('cache-control'),'no-store');assert.deepEqual((await config.json()).yards.map(row=>row.id),[1]);
  assert.equal((await fetch(base+'/api/control/damage/review?locationId=28&month=2026-09',{headers:headers(manager)})).status,403);
  assert.equal((await fetch(base+'/control/damage-stock')).status,200);
});
test('CH2: real HTTP editor reviews, accepts and verifies keyed updates, additions, removals and retry',async()=>{
  let record={id:'998187',tranId:'IT00551',memo:'3445 2026 Sep Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[{line:1,item:{id:'1256',refName:'Original SKU'},adjustQtyBy:3,units:'191',custcol_atlas_rc_so:{id:'7'},description:'Original line'},{line:2,item:{id:'5020',refName:'Remove SKU'},adjustQtyBy:2,units:'191',custcol_atlas_rc_so:{id:'8'},description:'Remove line'}]}};
  let writes=0;
  const remote={directory:async()=>[{id:1,name:'3445',subsidiary:1},{id:10,name:'3445 Damage',parent:1}],get:async()=>structuredClone(record),findMonthly:async()=>[structuredClone(record)],units:async()=>({'191':'PCS'}),
    item:async id=>({item_id:Number(id),item_name:'New SKU',location_id:1,item_type:'InvtPart',sales_unit_id:191,sales_unit:'PCS'}),itemUnits:async()=>[{id:'191',label:'PCS',conversionRate:1}],
    apply:async(id,plan)=>{assert.equal(Number(id),998187);assert.equal(plan.replace,true);writes++;record.inventory.items=plan.payload.inventory.items.map((line,index)=>({...record.inventory.items.find(old=>old.line===line.line),...line,line:line.line || index+10}));}};
  const local=express();local.use(express.json());local.use((req,_res,next)=>{req.operator=manager.actor;next();});local.use(createControlDamageRouter({remote}));
  local.use((error,_req,res,_next)=>res.status(error.status || 500).json({error:error.message}));
  const listener=local.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));const origin=`http://127.0.0.1:${listener.address().port}`;
  try {
    const item=await (await fetch(origin+'/items/5020?locationId=1')).json();assert.equal(item.units[0].label,'PCS');
    const review=await (await fetch(origin+'/review?locationId=1&month=2026-09')).json();assert.equal(review.transfers[0].lines.length,2);
    const id=crypto.randomUUID(),payload={requestId:id,locationId:1,month:'2026-09',transferId:998187,revision:review.transfers[0].revision,note:'Correct inspection',changes:[
      {action:'update',line:1,itemId:1256,quantity:6,unitId:191,reasonId:7},{action:'remove',line:2},{action:'add',itemId:5020,quantity:4,unitId:191,reasonId:8}]};
    const response=await fetch(origin+'/adjustments',{method:'POST',headers:headers(),body:JSON.stringify(payload)});assert.equal(response.status,202);
    let saved;
    for(let attempt=0;attempt<40;attempt++) {saved=await (await fetch(origin+`/adjustments/${id}`)).json();if(saved.status==='posted')break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(saved.status,'posted',saved.last_error);assert.equal(writes,1);assert.equal(record.inventory.items.length,2);
    assert.equal(record.inventory.items[0].adjustQtyBy,6);assert.equal(record.inventory.items[1].adjustQtyBy,4);
    assert.equal((await fetch(origin+`/adjustments/${id}/retry`,{method:'POST',headers:headers(),body:'{}'})).status,200);assert.equal(writes,1);
    const after=await (await fetch(origin+'/review?locationId=1&month=2026-09')).json();assert.equal(after.history[0].plan.note,'Correct inspection');
    await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit) VALUES(980630,'HTTP Retry SKU','InvtPart','PCS') ON CONFLICT DO NOTHING");
    const reportId=crypto.randomUUID();
    await submitDamageReport(operator.actor,{requestId:reportId,locationId:1,itemId:980630,reasonId:7,values:{pieces:2},photos:[`r2://operator/operator-damage-photo/2026/09/23/${operator.actor.id}/yard-1/${reportId}/photo.jpg`]},
      {getItem:async()=>({item_id:980630,item_name:'HTTP Retry SKU',location_id:1,item_type:'InvtPart',sales_unit:'PCS',sales_unit_id:191,stock_unit:'PCS',to_pcs:1}),verifyPhotos:async()=>{},now:()=>new Date('2026-09-23T12:00:00Z')});
    await query("UPDATE inventory_damage_reports SET status='attention',safe_to_retry=false WHERE id=$1",[reportId]);
    record.inventory.items.push({line:99,item:{id:'980630'},adjustQtyBy:2,units:'191',custcol_atlas_rc_so:{id:'7'},description:`DMG:${reportId}`});
    const recheck=await fetch(origin+`/reports/${reportId}/retry`,{method:'POST',headers:headers(),body:'{}'});
    assert.equal(recheck.status,200);assert.equal((await recheck.json()).status,'posted');assert.equal(writes,1);
    assert.equal((await query("SELECT details->>'actorId' AS actor FROM inventory_damage_events WHERE report_id=$1 AND action='control_recheck'",[reportId])).rows[0].actor,manager.actor.id);
    assert.equal((await fetch(origin+`/reports/${crypto.randomUUID()}/retry`,{method:'POST',headers:headers(),body:'{}'})).status,404);
  } finally {await new Promise(resolve=>listener.close(resolve));}
});
