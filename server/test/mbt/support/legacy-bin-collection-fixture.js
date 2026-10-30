import crypto from 'node:crypto';
import {query} from '../../../src/db.js';
import {getFrontdeskContractTimeline} from '../../../src/mbt/frontdesk-service.js';

// Explicit fixture for contracts created before collection became on-request.
// Keep legacy assignment/revision protection tests without expecting new rentals to auto-create C.
export async function addLegacyCollection(converted, actor) {
  const contractId=converted.body.contract.contractId;
  const delivery=(await query("SELECT * FROM mbt_service_visits WHERE contract_id=$1 AND service_action='delivery' ORDER BY visit_number LIMIT 1",[contractId])).rows[0];
  const line=(await query('SELECT * FROM mbt_contract_service_lines WHERE service_line_id=$1',[delivery.service_line_id])).rows[0];
  const id=crypto.randomUUID(),ref=delivery.visit_reference.replace(/V1$/,'V2'),yard=delivery.service_snapshot.mandatoryStops[0];
  const service={...delivery.service_snapshot,displayName:'Return bin',serviceAction:'return_bin',
    predecessorVisitId:delivery.service_visit_id,dependencyKind:'predecessor_completed',mandatoryStops:[
      {stopId:`${ref}-S1`,sequence:1,actionCode:'pickup_bin',stopKind:'pickup',locationRole:'customer_site',yardId:null,yardCode:null,siteProfileId:line.customer_site_profile_id,assetId:null},
      {stopId:`${ref}-S2`,sequence:2,actionCode:'return_bin',stopKind:'drop',locationRole:'return_yard',yardId:yard.yardId,yardCode:yard.yardCode,siteProfileId:null,assetId:null}
    ]};
  delete service.collectionOnRequest;
  const values={...delivery,service_visit_id:id,visit_reference:ref,visit_number:delivery.visit_number+1,
    service_action:'return_bin',status:'tentative',predecessor_visit_id:delivery.service_visit_id,
    material_id:line.material_id,scheduled_start_at:line.planned_return_at,
    scheduled_end_at:new Date(new Date(line.planned_return_at).getTime()+14400000),service_snapshot:service};
  await query('INSERT INTO mbt_service_visits SELECT (jsonb_populate_record(NULL::mbt_service_visits,$1::jsonb)).*',[JSON.stringify(values)]);
  await query(`UPDATE mbt_service_visits SET service_snapshot=(service_snapshot-'collectionOnRequest')||$2::jsonb WHERE service_visit_id=$1`,
    [delivery.service_visit_id,JSON.stringify({dependentReturnVisitId:id,dependentReturnVisitRevision:1})]);
  for(const [sequence,action,role] of [[0,'pickup_bin','customer_site'],[1,'return_bin','return_yard']]) await query(
    `INSERT INTO mbt_visit_steps(visit_step_id,service_visit_id,sequence_number,action_code,display_name,location_role,required,completion_blocking)
     VALUES($1,$2,$3,$4,$4,$5,true,true)`,[crypto.randomUUID(),id,sequence,action,role]);
  converted.body.visits=(await getFrontdeskContractTimeline({actor,contractId})).visits;
  return id;
}
