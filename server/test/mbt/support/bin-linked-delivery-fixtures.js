import crypto from 'node:crypto';
import {query,withTransaction} from '../../../src/db.js';
import {recordAssetMovement} from '../../../src/mbt/asset-service.js';
import {configureBinOrderWorkflow,getBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {cargoFixture,saveCargo,gravelPlan} from './bin-cargo-fixtures.js';
export async function linkedFixture({cargo=true}={}) {
  const f=await cargoFixture(),target=await cargoFixture({ordered:cargo}),materialId=crypto.randomUUID(),dumpSiteId=crypto.randomUUID();
  await query("INSERT INTO mbt_materials(material_id,material_code,display_name,created_by,updated_by) VALUES($1::uuid,$1::uuid::text,'Soil','test','test')",[materialId]);
  await query("INSERT INTO mbt_dump_sites(dump_site_id,dump_site_code,display_name,address_line_1,created_by,updated_by) VALUES($1::uuid,$1::uuid::text,'3445','3445 Kennedy Road','test','test')",[dumpSiteId]);
  await query("INSERT INTO mbt_dump_site_materials(dump_site_material_id,dump_site_id,material_id,accepted,created_by,updated_by) VALUES($1,$2,$3,true,'test','test')",[crypto.randomUUID(),dumpSiteId,materialId]);
  await query('UPDATE mbt_service_visits SET material_id=$2 WHERE service_visit_id=$1',[f.successorVisitId,materialId]);
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:'deliver_bin_expected',afterStatus:'at_customer',
    afterLocation:{kind:'customer_site',customerSiteProfileId:f.siteProfileId,reference:'100 Test Route'},source:'linked-route-test',actorType:'system',actorId:'test',occurredAt:`${f.planDate}T10:00:00Z`}));
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=$2 WHERE service_visit_id=ANY($1::uuid[])",[[f.frontVisitId,f.part.visitId],`${f.planDate}T10:00:00Z`]);
  await query('UPDATE mbt_bin_rental_numbers SET current_asset_id=$2 WHERE service_line_id=$1',[f.lineId,f.assetId]);
  if(cargo) await saveCargo(target,gravelPlan(true));
  const configured=await configureBinOrderWorkflow({visitId:f.successorVisitId,expectedRevision:1,actor:f.actor,
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),dumpSiteId,
    destination:{kind:'delivery',orderId:target.frontVisitId}});
  return {...f,target,collection:configured.body.parts[0],delivery:(await getBinOrderWorkflow(target.frontVisitId)).parts[0]};
}
export async function linkedIntent(part) {
  return {visitId:part.visitId,expectedVisitRevision:Number((await query('SELECT revision FROM mbt_service_visits WHERE service_visit_id=$1',[part.visitId])).rows[0].revision),
    assetAssignments:[],stopOverrides:[],stopTimings:[]};
}
export function linkedLoad(f,visits,index=0) {
  return {id:f.binLoadIds[index],truckId:f.binTruckId,driverId:f.driverId,name:'Linked BIN route',startMode:'fixed',start:index?'09:00':'07:00',
    driverSequence:index,plannedStartMinute:420+index*120,plannedFinishMinute:530+index*120,visits};
}
