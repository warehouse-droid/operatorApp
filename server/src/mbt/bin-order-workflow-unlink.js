// @ts-check
import {query} from '../db.js';
import {binWorkflowError,binWorkflowOrder} from './bin-order-workflow-repository.js';
import {binWorkLocked,workflowEditGuards} from './bin-order-workflow-editing.js';

/** Keep external dependency tuples across replacement of unstarted steps.
 * The caller holds the fleet fence and restores them in the same transaction.
 * @param {string[]} ids */
export async function suspendWorkflowStepLinks(ids) {
  return (await query(`DELETE FROM mbt_bin_workflow_dependencies
    WHERE dependent_visit_id=ANY($1::uuid[]) OR prerequisite_visit_id=ANY($1::uuid[]) RETURNING *`,[ids])).rows;
}
/** @param {any[]} links */
export async function restoreWorkflowStepLinks(links) {
  for (const edge of links) {
    await query(`INSERT INTO mbt_bin_workflow_dependencies
      (dependent_visit_id,dependent_action_code,prerequisite_visit_id,prerequisite_action_code,same_day)
      VALUES($1,$2,$3,$4,$5)`,[edge.dependent_visit_id,edge.dependent_action_code,
      edge.prerequisite_visit_id,edge.prerequisite_action_code,edge.same_day]);
  }
}

/** Detach only a changed external receiving link. Preserve its order/cargo and
 * require a fresh physical bin selection before it can be dispatched again.
 * @param {any[]} existing @param {any} flow */
export async function detachChangedWorkflowLinks(existing,flow) {
  for (const prior of existing.filter(p=>p.linked_delivery_visit_id)) {
    const next=flow.parts.find((/** @type {any} */ p)=>p.role===prior.part_role)?.destination;
    const nextId=next?.part ? existing.find(p=>p.part_role===next.part)?.visit_id : next?.visitId;
    const targetId=prior.linked_delivery_visit_id;
    if (targetId===nextId || existing.some(p=>p.visit_id===targetId)) {continue;}
    const [target]=await workflowEditGuards([targetId]);
    if (binWorkLocked(target)) {throw binWorkflowError(409,'Unplan the linked receiving delivery before changing its collection link.');}
    await detachDelivery(prior,target);
  }
}
/** @param {any} prior @param {any} target */
async function detachDelivery(prior,target) {
  const root=await binWorkflowOrder(target.service_visit_id,true);
  const snapshot={...target.service_snapshot,binWorkflow:{...target.service_snapshot.binWorkflow,source:null,needsBinSelection:true}};
  await query('DELETE FROM mbt_bin_workflow_dependencies WHERE dependent_visit_id=$1 AND prerequisite_visit_id=$2',[target.service_visit_id,prior.visit_id]);
  await query('UPDATE mbt_bin_order_parts SET linked_delivery_visit_id=NULL WHERE visit_id=$1',[prior.visit_id]);
  await query('UPDATE mbt_service_visits SET service_snapshot=$2::jsonb,revision=revision+1,updated_at=now() WHERE service_visit_id=$1',[target.service_visit_id,JSON.stringify(snapshot)]);
  const configuration={...root.configuration,parts:root.configuration.parts.map((/** @type {any} */ p)=>
    p.visitId===target.service_visit_id ? {...p,source:null,needsBinSelection:true} : p)};
  await query('UPDATE mbt_bin_orders SET configuration=$2::jsonb,revision=revision+1 WHERE order_id=$1',[root.service_visit_id,JSON.stringify(configuration)]);
}
