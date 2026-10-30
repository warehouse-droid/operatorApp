import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {planningFixture,run,storedPlan,boundary} from '../support/bin-planning-fixtures.js';
import {configureBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {getBinOrderWindow,changeBinOrderWindow,assertBinDeliveryUnplanned,binRequestedWindow} from '../../../src/mbt/bin-order-window-service.js';
after(closeDb);
let offset=4900;
test('time window: malformed dates return a client error without a database exception',async()=>{
  for(const startLocal of ['2037-13-01T12:00','2037-02-30T12:00','2037-08-03T25:00','not-a-date']) {
    await assert.rejects(binRequestedWindow({startLocal,endLocal:'2037-08-04T16:00'}),error=>error.status===400);
  }
  await assert.rejects(binRequestedWindow({startAt:'2037-08-03T12:00Z',endAt:'2037-08-03T11:00Z'}),error=>error.status===400);
});
async function fixture(assigned=false,released=false) {
  const f=await planningFixture(offset++),lineId=crypto.randomUUID();
  await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,customer_site_profile_id,site_snapshot,pricing_snapshot)
    SELECT $1,contract_id,1,bin_type_id,customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[lineId,f.contractId]);
  await query('UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2',[lineId,f.contractId]);
  const configured=await configureBinOrderWorkflow({visitId:f.frontVisitId,expectedRevision:1,actor:f.actor,
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    deliveryAssetId:f.assetId,deliveryWindow:{startAt:`${f.planDate}T11:00:00Z`,endAt:`${f.planDate}T12:00:00Z`}});
  const part=configured.body.parts[0];
  if(assigned) await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});
  if(released) await run(f,'confirm');
  return {...f,part};
}
async function input(f) {
  const options=await getBinOrderWindow(f.part.visitId);
  return {...options,visitId:f.part.visitId,actor:f.actor,idempotencyKey:crypto.randomUUID(),
    correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    window:{startLocal:`${f.planDate}T07:30`,endLocal:`${f.planDate}T08:30`},
    plans:options.plans.map(p=>({...p,sessionId:f.editLease.sessionId,editLeaseToken:f.editLease.token}))};
}
async function visit(id){return (await query('SELECT * FROM mbt_service_visits WHERE service_visit_id=$1',[id])).rows[0];}
for(const state of ['unplanned','draft','released']) test(`time window: Dispatch cannot change a ${state} delivery`,async()=>{
  const f=await fixture(state!=='unplanned',state==='released'),request=await input(f),before=await visit(f.part.visitId);
  await assert.rejects(changeBinOrderWindow(request,boundary),error=>error.status===403 && /Front Desk/i.test(error.message));
  assert.deepEqual(await visit(f.part.visitId),before);
  assert.equal((await getBinOrderWindow(f.part.visitId)).eligible,false);
  if(state!=='unplanned') await assert.rejects(assertBinDeliveryUnplanned(f.frontVisitId),{code:'MBT_FRONTDESK_DELIVERY_PLANNED'});
});

test('time window: concurrent unauthorized requests leave the released plan and assignment unchanged',async()=>{
  const f=await fixture(true,true),request=await input(f),before=await visit(f.part.visitId),plan=await storedPlan(f.planId);
  const outcomes=await Promise.allSettled(Array.from({length:8},()=>changeBinOrderWindow({...request,idempotencyKey:crypto.randomUUID()},boundary)));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,0);
  assert.ok(outcomes.every(r=>r.status==='rejected' && r.reason.status===403));
  assert.deepEqual(await visit(f.part.visitId),before);assert.equal((await storedPlan(f.planId)).digest,plan.digest);
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND withdrawn_at IS NULL',[f.part.visitId])).rows[0].n,1);
});
