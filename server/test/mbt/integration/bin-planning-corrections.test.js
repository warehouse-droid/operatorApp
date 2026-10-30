import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {planningFixture,run,boundary,storedPlan} from '../support/bin-planning-fixtures.js';
import {configureBinOrderWorkflow,getBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {getMbtBinPlanning} from '../../../src/mbt/bin-planning-read.js';
import {getBinOrderWindow,changeBinOrderWindow} from '../../../src/mbt/bin-order-window-service.js';
import {rescheduleFrontdeskDelivery,getFrontdeskContractTimeline} from '../../../src/mbt/frontdesk-service.js';
import {rental,actor} from '../support/bin-collection-request-fixtures.js';
import {frontdeskCommand} from '../support/frontdesk-fixtures.js';
after(closeDb);
let offset=5600;
const identity=()=>({idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()});
async function fixture() {
  const f=await planningFixture(offset++),line=crypto.randomUUID();
  await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[line,f.contractId]);
  await query('UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2',[line,f.contractId]);
  const root=(await query('SELECT * FROM mbt_service_visits WHERE service_visit_id=$1',[f.frontVisitId])).rows[0];
  f.window={startAt:root.scheduled_start_at.toISOString(),endAt:root.scheduled_end_at.toISOString()};
  return f;
}
const setup=(f,extra={})=>configureBinOrderWorkflow({visitId:f.frontVisitId,actor:f.actor,expectedRevision:1,
  ...identity(),deliveryAssetId:f.assetId,deliveryWindow:f.window,...extra});

for (const reason of [undefined,'','Customer requested']) test(`Front Desk delivery reason is optional: ${String(reason)}`,async()=>{
  const f=await rental(),input=frontdeskCommand('optional-delivery-reason',actor,{contractId:f.contractId,
    serviceLineId:f.line.serviceLineId,expectedRevision:f.line.revision,reason,
    deliveryWindow:{startAt:'2037-08-05T13:00Z',endAt:'2037-08-05T15:00Z'}});
  await rescheduleFrontdeskDelivery(input);
  const timeline=await getFrontdeskContractTimeline({actor,contractId:f.contractId});
  assert.equal(timeline.visits[0].scheduledStartAt,'2037-08-05T13:00:00.000Z');
  assert.equal((await rescheduleFrontdeskDelivery(input)).replayed,true);
  assert.equal(timeline.visits.length,1);
});

test('Dispatch time-window API denies mutation even with valid revisions and leases',async()=>{
  const f=await fixture(),{body:{parts:[part]}}=await setup(f);
  await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});await run(f,'confirm');
  const options=await getBinOrderWindow(part.visitId),plan=await storedPlan(f.planId);
  const before=(await query('SELECT * FROM mbt_service_visits WHERE contract_id=$1 ORDER BY visit_number',[f.contractId])).rows;
  await assert.rejects(changeBinOrderWindow({...identity(),...options,actor:f.actor,visitId:part.visitId,
    window:{startAt:`${f.planDate}T16:00Z`,endAt:`${f.planDate}T17:00Z`},
    plans:options.plans.map(p=>({...p,sessionId:f.editLease.sessionId,editLeaseToken:f.editLease.token}))},boundary),
    error=>error.status===403 && /Front Desk/i.test(error.message));
  assert.deepEqual((await query('SELECT * FROM mbt_service_visits WHERE contract_id=$1 ORDER BY visit_number',[f.contractId])).rows,before);
  assert.equal((await storedPlan(f.planId)).digest,plan.digest);
  assert.equal((await getBinOrderWindow(part.visitId)).eligible,false);
});

test('Dispatch route setup uses order windows and ignores client window overrides',async()=>{
  const f=await fixture();
  const result=await setup(f,{deliveryWindow:{startAt:'2040-01-01T00:00Z',endAt:'2040-01-02T00:00Z'}});
  assert.deepEqual(result.body.parts[0].window,f.window);
  const order=await getBinOrderWorkflow(f.frontVisitId);
  const changed=await setup(f,{expectedRevision:order.revision,deliveryWindow:{startLocal:'2040-01-01T08:00',endLocal:'2040-01-01T12:00'}});
  assert.deepEqual(changed.body.parts[0].window,f.window);
});

for(const status of ['planned','completed']) test(`BIN search finds ${status} work on another plan with one readable result`,async()=>{
  const f=await fixture(),{body:{parts:[part]}}=await setup(f);
  await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});
  if(status==='completed') await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_visit_id=$1",[part.visitId]);
  const input={planDate:'2030-01-02',actor:f.actor,search:part.reference.toLowerCase()};
  const result=await getMbtBinPlanning(input,boundary);
  assert.equal(result.pool.total,1);assert.equal(result.pool.items.length,1);
  const card=result.pool.items[0];assert.equal(card.displayReference,part.reference);assert.equal(card.mbt.status,status);
  assert.equal(card.dispatchPlanned,true);assert.equal(card.dispatchPlanDate,f.planDate);
  assert.equal(card.dispatchLoadId,f.binLoadIds[0]);assert.equal(card.dispatchPlanId,f.planId);
  const empty=await getMbtBinPlanning({...input,search:''},boundary);
  assert.ok(empty.pool.items.every(c=>c.mbt.visitId!==part.visitId));
  const exhausted=await getMbtBinPlanning({...input,offset:1,limit:1},boundary);
  assert.equal(exhausted.pool.total,1);assert.equal(exhausted.pool.items.length,0);
});

test('BIN search never uses a withdrawn assignment as a current plan',async()=>{
  const f=await fixture(),{body:{parts:[part]}}=await setup(f);
  await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});
  const revision=(await query('SELECT revision FROM mbt_service_visits WHERE service_visit_id=$1',[part.visitId])).rows[0].revision;
  await run(f,'cancel',{visitId:part.visitId,expectedVisitRevision:Number(revision)});
  const result=await getMbtBinPlanning({planDate:'2030-01-02',actor:f.actor,search:part.reference},boundary);
  assert.equal(result.pool.total,1);assert.equal(result.pool.items[0].dispatchPlanned,false);
  assert.equal(result.pool.items[0].dispatchPlanDate,null);
});

test('BIN search does not offer navigation to a load missing from the current plan',async()=>{
  const f=await fixture(),{body:{parts:[part]}}=await setup(f);
  await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});
  const plan=await storedPlan(f.planId);
  for(const truck of plan.trucks) truck.loads=truck.loads.filter(load=>load.id!==f.binLoadIds[0]);
  await query('UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1',[f.planId,JSON.stringify(plan.trucks)]);
  const result=await getMbtBinPlanning({planDate:'2030-01-02',actor:f.actor,search:part.reference},boundary);
  assert.equal(result.pool.total,1);
  assert.equal(result.pool.items[0].dispatchPlanned,false);
  assert.equal(result.pool.items[0].dispatchPlanDate,null);
  assert.equal(result.pool.items[0].dispatchLoadId,null);
});
