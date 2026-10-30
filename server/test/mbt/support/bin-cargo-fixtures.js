import crypto from 'node:crypto';
import {query} from '../../../src/db.js';
import {planningFixture,boundary} from './bin-planning-fixtures.js';
import {configureBinOrderWorkflow,getBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {getBinCargoOptions,saveBinCargo} from '../../../src/mbt/bin-cargo-service.js';
export const orderedGravel={materials:[{itemCode:'GRAVEL',displayName:'Gravel',quantityMilliYards:1000,derivedWeightLbs:2600}],totalWeightLbs:2600};
export const yard150='00000000-0000-4000-8000-000000000150';
export const cargoBoundary={...boundary,routeEstimator:async request=>({source:'google_routes_v2',legMinutes:request.stops.slice(1).map(()=>1)})};
let offset=6200;
export async function cargoFixture({ordered=false,configured=true,planDate}={}) {
  const f=await planningFixture(offset++,planDate ? {planDate} : {}),lineId=crypto.randomUUID();
  await query('UPDATE mbt_bin_types SET maximum_payload_kg=5000 WHERE bin_type_id=(SELECT bin_type_id FROM mbt_bin_assets WHERE asset_id=$1)',[f.assetId]);
  await query('UPDATE dispatch_drivers SET own_yard_fixed_minutes=10,delivery_fixed_minutes=10 WHERE login=$1',[f.driverLogin]);
  await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[lineId,f.contractId]);
  await query('UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2',[lineId,f.contractId]);
  if(ordered && !configured) await attachOrderedMaterial(f);
  const workflow=configured ? (await configureBinOrderWorkflow({...cargoCommand(f),expectedRevision:1,deliveryAssetId:f.assetId})).body : await getBinOrderWorkflow(f.frontVisitId);
  // Preserve the legacy configured-but-unrouted state exercised by cargo regressions.
  if(ordered && configured) await attachOrderedMaterial(f);
  return {...f,lineId,part:workflow.parts[0],workflow};
}
export function cargoCommand(f) {return {visitId:f.part?.visitId || f.frontVisitId,actor:f.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()};}
export function gravelPlan(ordered=true) {return {mode:'materials',materials:[{...(ordered?{itemCode:'GRAVEL'}:{description:'Gravel',weightLbs:100}),pickup:{kind:'yard',id:yard150},dropoff:{kind:'destination'}}]};}
export async function cargoInput(f,cargo=gravelPlan()) {
  const options=await getBinCargoOptions(f.part?.visitId || f.frontVisitId);
  return {...cargoCommand(f),expectedRevision:options.revision,expectedVisits:options.expectedVisits,cargo,
    plans:options.plans.map(p=>({...p,sessionId:f.editLease.sessionId,editLeaseToken:f.editLease.token}))};
}
export async function saveCargo(f,cargo=gravelPlan(),extra={}) {return saveBinCargo({...await cargoInput(f,cargo),...extra},cargoBoundary);}

async function attachOrderedMaterial(f) {await query(`UPDATE mbt_service_visits SET service_snapshot=service_snapshot || $2::jsonb WHERE service_visit_id=$1`,[f.frontVisitId,JSON.stringify({attachedAggregate:orderedGravel})]);}
