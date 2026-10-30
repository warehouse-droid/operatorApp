import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {query,closeDb} from '../../../src/db.js';
import {createMbtRouter} from '../../../src/mbt/router.js';
import {transportFixture,transportInput} from '../support/bin-transport-fixtures.js';
after(closeDb);

test('Transport errors: real HTTP validation retains specific messages and failed saves roll back',async t=>{
  const f=await transportFixture(),app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.operator={id:f.actor.operatorId,roles:['dispatcher']};next();});
  app.use('/api/mbt',createMbtRouter({authorizePhase3Capability:async()=>({})}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}/api/mbt/planning/transport/trips`;
  const send=input=>fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':input.idempotencyKey},body:JSON.stringify(input)});
  try {
    const cases=[
      {name:'missing bin capacity',capacity:null,weightLbs:undefined,code:'MBT_TRANSPORT_CAPACITY_REQUIRED',message:/maximum payload.*not configured/i},
      {name:'overweight',capacity:5000,weightLbs:20000,code:'MBT_TRANSPORT_CAPACITY',message:/20,000.*exceeds.*11,023/i},
      {name:'below known cargo',capacity:27215,weightLbs:2000,code:'MBT_TRANSPORT_CAPACITY',message:/at least 2,600 lb/i},
      {name:'missing item weight',capacity:27215,lineKey:'machine-2',weightLbs:undefined,code:'MBT_TRANSPORT_WEIGHT_REQUIRED',message:/enter.*cargo weight/i},
      {name:'too much quantity',capacity:27215,quantity:'3',weightLbs:10000,code:'MBT_TRANSPORT_ALLOCATION_INVALID',message:/exceed.*remaining/i},
      {name:'stale source',capacity:27215,weightLbs:6000,stale:true,code:'MBT_TRANSPORT_SOURCE_CHANGED',message:/order.*changed.*refresh/i}
    ];
    for(const row of cases) await t.test(row.name,async()=>{
      await query('UPDATE mbt_bin_types SET maximum_payload_kg=$2 WHERE bin_type_id=(SELECT bin_type_id FROM mbt_bin_assets WHERE asset_id=$1)',[f.assetId,row.capacity]);
      const input=await transportInput(f,[{lineKey:row.lineKey || 'loose-1',quantity:row.quantity || '1'}]);
      input.weightLbs=row.weightLbs;if(row.stale) input.sourceFingerprint='stale';
      const response=await send(input),body=await response.json();
      assert.equal(response.status,409,JSON.stringify(body));assert.equal(body.code,row.code);assert.match(body.error,row.message);
      assert.notEqual(body.error,'An unexpected error occurred.');assert.ok(body.correlationId);
      assert.equal((await query('SELECT count(*)::int AS n FROM mbt_transport_trips WHERE source_key=lower($1)',[f.sourceRef])).rows[0].n,0);
      assert.equal((await query('SELECT count(*)::int AS n FROM mbt_transport_sources WHERE source_key=lower($1)',[f.sourceRef])).rows[0].n,0);
    });
    await t.test('corrected request saves automatic weight and linked delivery',async()=>{
      const input=await transportInput(f,[{lineKey:'loose-1',quantity:'1'}]);
      delete input.weightLbs;input.returnDestination={kind:'delivery',visitId:f.part.visitId};
      const response=await send(input),body=await response.json();
      assert.equal(response.status,201,JSON.stringify(body));assert.equal(body.trip.weightLbs,2600);
      assert.equal(body.trip.route.returnDestination.visitId,f.part.visitId);
    });
  } finally {await new Promise(resolve=>server.close(resolve));}
});
