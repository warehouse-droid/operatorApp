import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb,pool} from '../../../src/db.js';
import {configureBinOrderWorkflow,getBinOrderWorkflow,getBinOrderWorkflowOptions} from '../../../src/mbt/bin-order-workflow-service.js';
import {cargoFixture,cargoCommand,gravelPlan} from '../support/bin-cargo-fixtures.js';
import {getBinCargoOptions} from '../../../src/mbt/bin-cargo-service.js';
after(closeDb);
test('Plan Delivery: configuration lookup propagates storage failure instead of enabling route-only editing',async t=>{
  const f=await cargoFixture({configured:false}),failure=new Error('workflow storage unavailable'),read=pool.query.bind(pool);
  const mock=t.mock.method(pool,'query',function(sql,...args){
    if(String(sql).includes('AS active_assignment')) throw failure;
    return read(sql,...args);
  });
  try {await assert.rejects(getBinOrderWorkflowOptions(f.frontVisitId),error=>error===failure);}
  finally {mock.mock.restore();}
  assert.equal((await getBinOrderWorkflowOptions(f.frontVisitId)).configurationIssue,null);
});
function command(f,cargo) {return {...cargoCommand(f),expectedRevision:f.workflow.revision,deliveryAssetId:f.assetId,...(cargo?{cargo}:{})};}
async function saved(f) {return (await query('SELECT plan FROM mbt_bin_cargo_plans WHERE order_id=$1',[f.frontVisitId])).rows;}
test('Plan Delivery: ordered materials require a pickup route before any workflow can be saved',async()=>{
  const f=await cargoFixture({ordered:true,configured:false});
  await assert.rejects(configureBinOrderWorkflow(command(f)),/material|pickup|cargo/i);
  assert.equal((await getBinOrderWorkflow(f.frontVisitId)).configured,false);
  assert.deepEqual(await saved(f),[]);
  const missing=gravelPlan();missing.materials[0].pickup=null;
  await assert.rejects(configureBinOrderWorkflow(command(f,missing)),/pickup/i);
  assert.equal((await getBinOrderWorkflow(f.frontVisitId)).parts.length,0);
  await assert.rejects(configureBinOrderWorkflow(command(f,{mode:'none'})),/material/i);
});
test('Plan Delivery: one transaction saves bin and purchased cargo, with exact replay and fixed order data',async()=>{
  const f=await cargoFixture({ordered:true,configured:false});
  const before=(await query('SELECT service_snapshot,scheduled_start_at,scheduled_end_at FROM mbt_service_visits WHERE service_visit_id=$1',[f.frontVisitId])).rows[0];
  const input=command(f,gravelPlan()),result=await configureBinOrderWorkflow(input);
  assert.equal(result.body.revision,f.workflow.revision+1);
  assert.deepEqual(result.body.parts[0].steps.map(s=>s.actionCode),['collect_empty_bin','cargo_pickup_1','deliver_bin']);
  assert.equal((await saved(f))[0].plan.materials[0].weightLbs,2600);
  assert.equal((await configureBinOrderWorkflow(input)).replayed,true);
  assert.deepEqual((await query('SELECT service_snapshot,scheduled_start_at,scheduled_end_at FROM mbt_service_visits WHERE service_visit_id=$1',[f.frontVisitId])).rows[0],before);
  const options=await getBinCargoOptions(f.frontVisitId);assert.equal(options.cargo.materials[0].pickup.yardCode,'150');
});
test('Plan Delivery: downstream workflow failure rolls back a new cargo plan before a safe retry',async()=>{
  const f=await cargoFixture({ordered:true,configured:false}),input=command(f,gravelPlan());
  await query(`CREATE FUNCTION reject_cargo_workflow_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cargo workflow rollback'; END $$;
    CREATE TRIGGER reject_cargo_workflow_test BEFORE INSERT ON mbt_visit_steps FOR EACH ROW EXECUTE FUNCTION reject_cargo_workflow_test();`);
  try {await assert.rejects(configureBinOrderWorkflow(input),/cargo workflow rollback/);}
  finally {await query('DROP TRIGGER reject_cargo_workflow_test ON mbt_visit_steps; DROP FUNCTION reject_cargo_workflow_test();');}
  assert.deepEqual(await saved(f),[]);assert.equal((await getBinOrderWorkflow(f.frontVisitId)).parts.length,0);
  const result=await configureBinOrderWorkflow(input);assert.equal(result.body.parts[0].steps[1].actionCode,'cargo_pickup_1');
});
test('Plan Delivery: concurrent combined saves have one winner and plain deliveries may omit cargo',async()=>{
  const plain=await cargoFixture({configured:false});assert.equal((await configureBinOrderWorkflow(command(plain))).body.parts[0].steps.length,2);
  const f=await cargoFixture({ordered:true,configured:false});
  const results=await Promise.allSettled([configureBinOrderWorkflow(command(f,gravelPlan())),configureBinOrderWorkflow(command(f,gravelPlan()))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal((await saved(f)).length,1);assert.equal((await getBinOrderWorkflow(f.frontVisitId)).parts.length,1);
  await assert.rejects(configureBinOrderWorkflow({...command(f,gravelPlan()),idempotencyKey:crypto.randomUUID()}),/revision/i);
});
