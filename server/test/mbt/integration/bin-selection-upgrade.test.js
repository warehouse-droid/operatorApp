import test,{after} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {readFile} from "node:fs/promises";
import {query,closeDb,withTransaction} from "../../../src/db.js";
import {planningFixture,storedPlan,run,boundary} from "../support/bin-planning-fixtures.js";
import {assignMbtBinFrontLeg} from "../../../src/mbt/bin-dispatch-service.js";
import {binStopLabels} from "../../../src/mbt/bin-stop-labels.js";
after(closeDb);

async function legacyState() {
  return (await query(`SELECT jsonb_build_object(
    'visits',(SELECT jsonb_agg(to_jsonb(v) ORDER BY service_visit_id) FROM mbt_service_visits v),
    'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY visit_step_id) FROM mbt_visit_steps s),
    'plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM dispatch_plans p),
    'snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY plan_id) FROM dispatch_plan_snapshots s),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY service_line_id) FROM mbt_contract_service_lines l)) AS state`)).rows[0].state;
}

test("BIN upgrade backfills five-digit references and confirms old frozen stops without changing legacy records",async()=>{
  const f=await planningFixture(5400),line=crypto.randomUUID();
  const input={actor:f.actor,visitId:f.frontVisitId,planId:f.planId,planDate:f.planDate,loadId:f.binLoadIds[0],
    expectedPlanRevision:(await storedPlan(f.planId)).revision,expectedVisitRevision:1,
    assetAssignments:[{assetId:f.assetId,reservationSlot:"outgoing",expectedStateRevision:1}],reason:"Legacy upgrade fixture",
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()};
  await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[line,f.contractId]);
  await query("UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2",[line,f.contractId]);
  await query(`INSERT INTO mbt_driver_pilot_scope(pilot_scope_id,plan_date,driver_login,truck_id,contract_id,
    service_visit_id,active,authorized_by,authorized_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,true,'test',now(),now()+interval '1 day')`,
    [crypto.randomUUID(),f.planDate,f.driverLogin,f.binTruckId,f.contractId,f.frontVisitId]);
  await assignMbtBinFrontLeg(input,boundary);
  const plan=await storedPlan(f.planId);
  for(const truck of plan.trucks) for(const load of truck.loads) for(const stop of load.stops) {
    delete stop.reference;delete stop.assetCode;delete stop.assetId;
  }
  const snapshot=(await query("SELECT dispatch_assignment_snapshot FROM mbt_service_visits WHERE service_visit_id=$1",[f.frontVisitId])).rows[0].dispatch_assignment_snapshot;
  snapshot.stops=plan.trucks.flatMap(t=>t.loads.flatMap(l=>l.stops)).filter(s=>s.mbt?.visitId===f.frontVisitId);
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1",[f.planId,JSON.stringify(plan.trucks)]);
  await query("UPDATE mbt_service_visits SET dispatch_assignment_snapshot=$2::jsonb WHERE service_visit_id=$1",[f.frontVisitId,JSON.stringify(snapshot)]);
  // Rehearse the old workflow upgrade with its newer dependent cargo schema removed.
  await query(`DROP TRIGGER IF EXISTS mbt_release_cancelled_bin_cargo ON mbt_service_visits;
    DROP FUNCTION IF EXISTS mbt_release_cancelled_bin_cargo();
    DROP TABLE IF EXISTS mbt_bin_cargo_plans;
    DROP TRIGGER trg_mbt_register_bin_rental ON mbt_contract_service_lines;
    DROP TRIGGER trg_mbt_register_bin_order ON mbt_service_visits;
    DROP TRIGGER trg_mbt_sync_bin_collection_window ON mbt_service_visits;
    DROP TABLE mbt_bin_workflow_dependencies,mbt_bin_workflow_claims,mbt_bin_workflow_events,
      mbt_bin_order_parts,mbt_bin_orders,mbt_bin_rental_numbers;
    DROP FUNCTION mbt_register_bin_order(uuid),mbt_register_bin_rental_trigger(),mbt_register_bin_order_trigger(),
      mbt_preserve_bin_reference_identity(),mbt_sync_bin_collection_window();
    DELETE FROM schema_migrations WHERE filename='297_bin_order_workflows.sql'`);
  const before=await legacyState();
  const sql=await readFile(new URL("../../../migrations/297_bin_order_workflows.sql",import.meta.url),"utf8");
  await withTransaction(async()=>{await query(sql);await query("INSERT INTO schema_migrations(filename) VALUES ('297_bin_order_workflows.sql')");});
  await query(await readFile(new URL('../../../migrations/308_bin_cargo_plans.sql',import.meta.url),'utf8'));
  assert.deepEqual(await legacyState(),before);
  const references=(await query("SELECT display_reference FROM mbt_bin_orders ORDER BY display_reference")).rows.map(r=>r.display_reference);
  assert.equal(references.length,2);assert.match(references[0],/^BIN\d{5}C$/);assert.match(references[1],/^BIN\d{5}D$/);
  await run(f,"confirm");
  const labels=await binStopLabels(await storedPlan(f.planId));
  assert.equal(Object.keys(labels).length,2);
  for(const label of Object.values(labels)) {assert.match(label.reference,/^BIN\d{5}D$/);assert.equal(label.assetCode,f.assetCode);}
  assert.deepEqual((await query("SELECT dispatch_assignment_snapshot FROM mbt_service_visits WHERE service_visit_id=$1",[f.frontVisitId])).rows[0].dispatch_assignment_snapshot,snapshot);
});
