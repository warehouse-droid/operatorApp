import crypto from 'node:crypto';
import {query,withTransaction} from '../../../src/db.js';
import {recordAssetMovement} from '../../../src/mbt/asset-service.js';
import {configureBinOrderWorkflow,getBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {cargoFixture,saveCargo,gravelPlan} from './bin-cargo-fixtures.js';

export async function editFixture({linked=true,sequence='delivery_first'}={}) {
  const f=await cargoFixture(),spare=await cargoFixture(),target=await cargoFixture({ordered:true});
  await saveCargo(target,gravelPlan());
  const materialId=crypto.randomUUID(),rootId=crypto.randomUUID(),dumpIds=[crypto.randomUUID(),crypto.randomUUID()];
  await query("INSERT INTO mbt_materials(material_id,material_code,display_name,created_by,updated_by) VALUES($1::uuid,$1::uuid::text,'Soil','test','test')",[materialId]);
  for(const [i,id] of dumpIds.entries()) {
    await query("INSERT INTO mbt_dump_sites(dump_site_id,dump_site_code,display_name,address_line_1,created_by,updated_by) VALUES($1::uuid,$1::uuid::text,$2,$3,'test','test')",[id,i?'2967':'3445',i?'2967 Kennedy Road':'3445 Kennedy Road']);
    await query("INSERT INTO mbt_dump_site_materials(dump_site_material_id,dump_site_id,material_id,accepted,created_by,updated_by) VALUES($1,$2,$3,true,'test','test')",[crypto.randomUUID(),id,materialId]);
  }
  await query('UPDATE mbt_contract_service_lines SET pricing_snapshot=pricing_snapshot || $2::jsonb WHERE service_line_id=$1',[f.lineId,JSON.stringify({materialId})]);
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:'deliver_bin_expected',afterStatus:'at_customer',
    afterLocation:{kind:'customer_site',customerSiteProfileId:f.siteProfileId,reference:'100 Test Route'},source:'edit-lock-test',actorType:'system',actorId:'test',occurredAt:`${f.planDate}T10:00:00Z`}));
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=$2 WHERE service_visit_id=ANY($1::uuid[])",[[f.frontVisitId,f.part.visitId],`${f.planDate}T10:00:00Z`]);
  await query('UPDATE mbt_bin_rental_numbers SET current_asset_id=$2 WHERE service_line_id=$1',[f.lineId,f.assetId]);
  await query(`INSERT INTO mbt_service_visits(service_visit_id,contract_id,service_line_id,visit_number,visit_reference,
    service_template_version_id,service_action,status,customer_site_profile_id,bin_type_id,expected_asset_id,
    scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,created_by,updated_by)
    SELECT $1,contract_id,service_line_id,(SELECT max(visit_number)+1 FROM mbt_service_visits WHERE contract_id=$2),$3,
      service_template_version_id,'exchange_bin','ready',customer_site_profile_id,bin_type_id,$4,
      scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,'test','test'
    FROM mbt_service_visits WHERE service_visit_id=$5`,[rootId,f.contractId,`exchange-edit-${rootId}`,f.assetId,f.frontVisitId]);
  const request={sequence,reuse:'different_bin',deliveryAssetId:spare.assetId,collectionAssetId:f.assetId,dumpSiteId:dumpIds[0],
    destination:linked?{kind:'delivery',orderId:target.frontVisitId}:{kind:'yard',yardId:'00000000-0000-4000-8000-000000012441'}};
  const result=await configureBinOrderWorkflow({visitId:rootId,expectedRevision:1,actor:f.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),...request});
  return {...f,rootId,spare,target,dumpIds,request,collection:result.body.parts.find(p=>p.role==='collection'),delivery:result.body.parts.find(p=>p.role==='delivery')};
}
export async function editCommand(f,changes={}) {
  const flow=await getBinOrderWorkflow(f.rootId);
  return {visitId:f.rootId,expectedRevision:flow.revision,actor:f.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),...f.request,...changes};
}
export async function visitState(id) {
  const visit=(await query('SELECT * FROM mbt_service_visits WHERE service_visit_id=$1',[id])).rows[0];
  const steps=(await query('SELECT * FROM mbt_visit_steps WHERE service_visit_id=$1 ORDER BY sequence_number',[id])).rows;
  const evidence=(await query('SELECT * FROM mbt_visit_evidence_requirements WHERE service_visit_id=$1 ORDER BY visit_evidence_requirement_id',[id])).rows;
  const claims=(await query('SELECT * FROM mbt_bin_workflow_claims WHERE visit_id=$1 ORDER BY claim_id',[id])).rows;
  return {visit,steps,evidence,claims};
}
