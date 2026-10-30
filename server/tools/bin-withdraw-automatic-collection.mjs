import { query } from '../src/db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../src/dispatch-fleet-status.js';
import { executeMbtCommand } from '../src/mbt/command-repository.js';

export async function withdrawAutomaticCollection(input) {
  const {actor,idempotencyKey,correlationId,requestId,...payload}=input;
  return executeMbtCommand({actor,idempotencyKey,correlationId,requestId,payload,
    commandName:'mbt.bin_order.withdraw_automatic_collection',mutation:async()=>{
      await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
      const root=(await query(`SELECT v.*,o.configuration,o.display_reference,o.revision AS order_revision
        FROM mbt_bin_orders o JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
        WHERE o.order_id=$1 AND o.order_kind='collection' AND o.display_reference=$2 FOR UPDATE OF v,o`,[input.orderId,input.reference])).rows[0];
      if(!root || root.status!=='tentative' || root.configuration || root.actual_started_at || root.actual_completed_at
        || root.dispatch_plan_id || root.service_snapshot.collectionRequestedBy || root.service_snapshot.collectionRequestedAt) throw new Error('Collection is no longer an untouched automatic draft.');
      const unsafe=await query(`SELECT 1 FROM mbt_bin_order_parts WHERE order_id=$1
        UNION ALL SELECT 1 FROM mbt_bin_planning_assignments WHERE service_visit_id=$1
        UNION ALL SELECT 1 FROM mbt_bin_dispatch_assignment_history WHERE service_visit_id=$1
        UNION ALL SELECT 1 FROM mbt_contract_service_line_events WHERE service_visit_id=$1 OR (service_line_id=$2 AND event_type='collection')
        UNION ALL SELECT 1 FROM mbt_bin_workflow_events WHERE order_id=$1
        UNION ALL SELECT 1 FROM mbt_visit_steps WHERE service_visit_id=$1 AND (status<>'pending' OR started_at IS NOT NULL OR completed_at IS NOT NULL)
        UNION ALL SELECT 1 FROM mbt_evidence WHERE service_visit_id=$1`,[input.orderId,root.service_line_id]);
      if(unsafe.rowCount) throw new Error('Collection has configuration, planning, request or execution history; automatic withdrawal is forbidden.');
      const beforeOrder=(await query('SELECT * FROM mbt_bin_orders WHERE order_id=$1',[input.orderId])).rows[0];
      const delivery=(await query(`SELECT * FROM mbt_service_visits WHERE service_line_id=$1 AND service_action='delivery'
        AND service_snapshot->>'dependentReturnVisitId'=$2 FOR UPDATE`,[root.service_line_id,input.orderId])).rows[0];
      if(delivery) {
        const issued=await query(`SELECT 1 FROM mbt_bin_planning_assignments a WHERE a.released_at IS NOT NULL
          AND (a.service_visit_id=$1 OR a.service_visit_id IN (SELECT visit_id FROM mbt_bin_order_parts WHERE order_id=$1))`,[delivery.service_visit_id]);
        if(delivery.actual_started_at || delivery.dispatch_plan_id || issued.rowCount) throw new Error('Delivery already has issued instructions; leave its legacy collection unchanged.');
        await query(`UPDATE mbt_service_visits SET service_snapshot=(service_snapshot-'dependentReturnVisitId'-'dependentReturnVisitRevision')
          ||'{"collectionOnRequest":true}'::jsonb,revision=revision+1,updated_by=$2,updated_at=now() WHERE service_visit_id=$1`,[delivery.service_visit_id,actor.operatorId]);
      }
      await query(`UPDATE mbt_service_visits SET status='cancelled',cancelled_at=now(),predecessor_visit_id=NULL,cancellation_reason='Withdraw unrequested automatic collection',revision=revision+1,
        service_snapshot=service_snapshot||'{"withdrawnAutomaticCollection":true}'::jsonb,updated_by=$2,updated_at=now() WHERE service_visit_id=$1`,[input.orderId,actor.operatorId]);
      await query('DELETE FROM mbt_bin_orders WHERE order_id=$1',[input.orderId]);
      return {status:200,body:{withdrawnOrderId:input.orderId,reference:input.reference},audit:{
        action:'mbt.bin_order.automatic_collection_withdrawn',entityType:'mbt_service_visit',entityId:input.orderId,
        beforeState:{visit:root,order:beforeOrder,delivery:delivery||null},afterState:{withdrawnAutomaticCollection:true},
        revisionBefore:Number(root.revision),revisionAfter:Number(root.revision)+1,
        reason:'User requested collection only when Front Desk explicitly clicks Collect bin; preserve expected return as reminder.',source:'local'}};
    }});
}
