// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { assertBinWorkflowDependency, binLocalDate } from "./bin-order-workflow-domain.js";
import { binWorkflowError } from "./bin-order-workflow-repository.js";
import { releaseMbtBinSuccessorToPool } from "./bin-planning-repository.js";

/** A dependency is satisfied by committed evidence, including another driver's work.
 * @param {any} visit @param {any} step @param {Date} occurredAt */
export async function assertBinWorkflowPrerequisites(visit, step, occurredAt) {
  if (!visit.service_snapshot?.binWorkflow) {return [];}
  const {rows} = await query(`SELECT d.*,s.status,s.completed_at,p.display_reference,
      pickup.completed_at AS picked_up_at
    FROM mbt_bin_workflow_dependencies d
    JOIN mbt_visit_steps s ON s.service_visit_id=d.prerequisite_visit_id AND s.action_code=d.prerequisite_action_code
    JOIN mbt_bin_order_parts p ON p.visit_id=d.prerequisite_visit_id
    LEFT JOIN mbt_visit_steps pickup ON pickup.service_visit_id=d.prerequisite_visit_id AND pickup.action_code='pickup_bin'
    WHERE d.dependent_visit_id=$1 AND d.dependent_action_code=$2`,
  [visit.service_visit_id,step.action_code]);
  const late = [];
  for (const row of rows) {
    try {
      assertBinWorkflowDependency({completedAt:row.status === "completed" ? row.completed_at : null,occurredAt});
    } catch (error) {
      throw binWorkflowError(409,`${row.display_reference}: ${error instanceof Error ? error.message : String(error)}`, "MBT_BIN_WORKFLOW_PREREQUISITE");
    }
    if (row.same_day && binLocalDate(row.picked_up_at || row.completed_at) !== binLocalDate(occurredAt)) {
      late.push({reference:row.display_reference,pickedUpAt:row.picked_up_at || row.completed_at});
    }
  }
  return late;
}

/** Recompute the parents, including the source of a shared onward delivery.
 * Final collection closes a rental only when all its older collections finish.
 * @param {string} serviceLineId @param {Date} occurredAt @param {string} actorId */
async function refreshRental(serviceLineId, occurredAt, actorId) {
  const {rows:orders} = await query(`SELECT o.*,v.status FROM mbt_bin_orders o
    JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
    WHERE o.service_line_id=$1 AND o.configuration IS NOT NULL
    ORDER BY (o.order_kind='collection'),o.exchange_number FOR UPDATE OF o,v`,[serviceLineId]);
  for (const order of orders) {
    const {rows:[state]} = await query(`SELECT
      bool_and(v.status='completed' AND (p.linked_delivery_visit_id IS NULL OR target.status='completed')) AS done,
      min(v.actual_started_at) AS started_at,max(GREATEST(v.actual_completed_at,target.actual_completed_at)) AS finished_at
      FROM mbt_bin_order_parts p JOIN mbt_service_visits v ON v.service_visit_id=p.visit_id
      LEFT JOIN mbt_service_visits target ON target.service_visit_id=p.linked_delivery_visit_id WHERE p.order_id=$1`,
    [order.order_id]);
    if (!state.started_at || order.status === "cancelled") {continue;}
    let done = state.done === true;
    if (order.order_kind === "collection") {
      const pending = await query(`SELECT 1 FROM mbt_bin_orders o JOIN mbt_service_visits v ON v.service_visit_id=o.order_id
        WHERE o.service_line_id=$1 AND o.order_kind='exchange' AND v.status NOT IN ('completed','cancelled') LIMIT 1`,[serviceLineId]);
      done = done && !pending.rowCount;
      await query("UPDATE mbt_bin_rental_numbers SET recovery_pending=$2 WHERE service_line_id=$1",[serviceLineId,!done]);
    }
    const status = done ? "completed" : "in_progress";
    if (order.status === status) {continue;}
    await query(`UPDATE mbt_service_visits SET status=$2,actual_started_at=COALESCE(actual_started_at,$3),
      actual_completed_at=CASE WHEN $2='completed' THEN COALESCE(actual_completed_at,$4) ELSE actual_completed_at END,
      updated_by=$5,updated_at=now(),revision=revision+1 WHERE service_visit_id=$1`,
    [order.order_id,status,state.started_at,state.finished_at || occurredAt,actorId]);
    if (done) {
      await query(`UPDATE mbt_bin_workflow_claims c SET released_at=$2
        FROM mbt_bin_order_parts p WHERE p.visit_id=c.visit_id AND p.order_id=$1 AND c.released_at IS NULL`,
      [order.order_id,occurredAt]);
      await releaseMbtBinSuccessorToPool(String(order.order_id),actorId);
    }
  }
}

/** Called inside the physical completion transaction; rollback/replay is shared with driver evidence.
 * @param {any} context @param {boolean} visitCompleted */
export async function finishBinWorkflowStep(context, visitCompleted) {
  const visit = context.rows.visit;
  const workflow = visit.service_snapshot?.binWorkflow;
  if (!workflow) {await refreshLegacyRentalBin(visit);return;}
  const action = String(context.step.action_code);
  const assetId = String(visit.expected_asset_id);
  const at = context.normalized.occurredAt;
  const actorId = `driver:${context.normalized.driverLogin}`;
  if (action === "deliver_bin") {
    await query("UPDATE mbt_bin_rental_numbers SET current_asset_id=$2 WHERE service_line_id=$1",[visit.service_line_id,assetId]);
  } else if (action === "pickup_bin") {
    await query(`UPDATE mbt_bin_rental_numbers SET current_asset_id=NULL
      WHERE service_line_id=$1 AND current_asset_id=$2`,[visit.service_line_id,assetId]);
  }
  if (visitCompleted) {
    await query(`UPDATE mbt_bin_workflow_claims c SET released_at=$2
      WHERE c.visit_id=$1 AND c.released_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM mbt_bin_order_parts p JOIN mbt_service_visits target ON target.service_visit_id=p.linked_delivery_visit_id
        WHERE p.visit_id=c.visit_id AND target.status<>'completed')`,[visit.service_visit_id,at]);
  }
  const late = await assertBinWorkflowPrerequisites(visit,context.step,at);
  await query(`INSERT INTO mbt_bin_workflow_events(event_id,order_id,visit_id,source_event_id,action,details)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[crypto.randomUUID(),workflow.orderId,visit.service_visit_id,context.normalized.eventId,
    late.length ? "late_same_day_completion" : "step_completed",JSON.stringify({actionCode:action,assetId,occurredAt:at,late})]);
  const {rows:sources} = await query(`SELECT DISTINCT o.service_line_id FROM mbt_bin_order_parts p
    JOIN mbt_bin_orders o ON o.order_id=p.order_id WHERE p.linked_delivery_visit_id=$1`,[visit.service_visit_id]);
  for (const id of new Set([visit.service_line_id,...sources.map((/** @type {any} */ s)=>s.service_line_id)])) {
    await refreshRental(id,at,actorId);
  }
}

/** Issued legacy jobs keep their snapshots while updating the rental's physical-bin projection.
 * @param {any} visit */
async function refreshLegacyRentalBin(visit) {
  if (!visit.service_line_id) {return;}
  const ids=[visit.expected_asset_id,visit.outgoing_asset_id,visit.incoming_asset_id].filter(Boolean);
  if (!ids.length) {return;}
  await query(`UPDATE mbt_bin_rental_numbers r SET current_asset_id=COALESCE((
    SELECT s.asset_id FROM mbt_bin_asset_state s WHERE s.asset_id=ANY($2::uuid[])
      AND s.location_kind='customer_site' AND s.lifecycle_status='at_customer' AND s.customer_site_profile_id=$4
    ORDER BY (s.asset_id=$3::uuid) DESC NULLS LAST,s.asset_id LIMIT 1),
    CASE WHEN r.current_asset_id=ANY($2::uuid[]) THEN NULL ELSE r.current_asset_id END)
    WHERE r.service_line_id=$1`,[visit.service_line_id,ids,visit.outgoing_asset_id,visit.customer_site_profile_id]);
}
