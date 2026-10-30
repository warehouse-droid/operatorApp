// Operational verification only; execute inside the live app with read-only SQL.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {getBinOrderWorkflowOptions} from '/app/src/mbt/bin-order-workflow-service.js';
import {projectBinWorkflowCard} from '/app/src/mbt/bin-order-workflow-read.js';
try {
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const options=await getBinOrderWorkflowOptions('5694fbd7-7da8-40a0-b3da-5b61b2c89784');
    const id=options.workflow.parts.find(p=>p.role==='collection')?.visitId || options.workflow.orderId;
    const visit=(await query('SELECT * FROM mbt_service_visits WHERE service_visit_id=$1',[id])).rows[0];
    const card=await projectBinWorkflowCard(visit);
    const pending=await query(`SELECT COALESCE(p.display_reference,o.display_reference) AS reference
      FROM mbt_bin_orders o JOIN mbt_service_visits root ON root.service_visit_id=o.order_id
      LEFT JOIN mbt_bin_order_parts p ON p.order_id=o.order_id
      LEFT JOIN mbt_service_visits child ON child.service_visit_id=p.visit_id
      WHERE o.service_line_id=$1 AND o.order_kind IN ('delivery','exchange') AND root.status<>'cancelled'
        AND COALESCE(child.status,root.status) NOT IN ('completed','cancelled')`,[visit.service_line_id]);
    if(pending.rows.length && !visit.dispatch_plan_id && !visit.actual_started_at) {
      assert.deepEqual(card.workflow.collectionHold.references.slice().sort(),pending.rows.map(r=>r.reference).sort());
      assert.equal(card.mbt.frontLeg.dispatchable,false);
      assert.match(card.blockedReason,/Waiting for.*complete/);
    }
    return {reference:card.displayReference,status:visit.status,revision:visit.revision,planId:visit.dispatch_plan_id,
      waitingFor:card.workflow.collectionHold?.references || [],blockedReason:card.blockedReason,
      dispatchable:card.mbt.frontLeg.dispatchable,routeEditable:options.editability.collection};
  });
  console.log(JSON.stringify(result,null,2));
} finally {await closeDb();}
