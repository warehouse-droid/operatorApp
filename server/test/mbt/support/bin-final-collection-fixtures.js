import crypto from 'node:crypto';
import {query,withTransaction} from '../../../src/db.js';
import {recordAssetMovement} from '../../../src/mbt/asset-service.js';
import {configureBinOrderWorkflow,getBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {editFixture} from './bin-workflow-edit-fixtures.js';
export async function finalCollectionFixture({configured=true}={}) {
  const f=await editFixture({linked:false});
  let final=await getBinOrderWorkflow(f.successorVisitId);
  if(configured) final=(await configureBinOrderWorkflow({visitId:f.successorVisitId,expectedRevision:final.revision,
    actor:f.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    dumpSiteId:f.dumpIds[0],destination:{kind:'yard',yardId:'00000000-0000-4000-8000-000000012441'}})).body;
  return {...f,final,finalId:final.parts[0]?.visitId || f.successorVisitId};
}
export async function completeRentalPart(f,part) {
  const at=`${f.planDate}T10:00:00Z`;
  await query("UPDATE mbt_visit_steps SET status='completed',completed_at=$2 WHERE service_visit_id=$1",[part.visitId,at]);
  if(part.role==='delivery') {
    await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:part.assetId,movementType:'deliver_bin_expected',afterStatus:'at_customer',
      afterLocation:{kind:'customer_site',customerSiteProfileId:f.siteProfileId,reference:'100 Test Route'},source:'final-collection-test',actorType:'system',actorId:'test',occurredAt:at}));
    await query('UPDATE mbt_bin_rental_numbers SET current_asset_id=$2 WHERE service_line_id=$1',[f.lineId,part.assetId]);
  }
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=$2 WHERE service_visit_id=$1",[part.visitId,at]);
}
export async function addUnconfiguredExchange(f) {
  const id=crypto.randomUUID();
  await query(`INSERT INTO mbt_service_visits(service_visit_id,contract_id,service_line_id,visit_number,visit_reference,
    service_template_version_id,service_action,status,customer_site_profile_id,bin_type_id,expected_asset_id,
    scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,created_by,updated_by)
    SELECT $1,contract_id,service_line_id,(SELECT max(visit_number)+1 FROM mbt_service_visits WHERE contract_id=$2),$3,
      service_template_version_id,'exchange_bin','ready',customer_site_profile_id,bin_type_id,expected_asset_id,
      scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,'test','test'
    FROM mbt_service_visits WHERE service_visit_id=$4`,[id,f.contractId,`pending-exchange-${id}`,f.rootId]);
  return getBinOrderWorkflow(id);
}
