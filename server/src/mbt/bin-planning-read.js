// @ts-check
import { query } from "../db.js";
import { getDispatchPlanEditLease } from "../dispatch-plan-lease-repository.js";
import { assertPlanningAccess, planningDate, planningError, readPlanningPlan } from "./bin-planning-repository.js";
import { projectMbtBinPlanningCard } from "./bin-dispatch-service.js";

/** @param {any} input @param {any} boundary */
export async function getMbtBinPlanning(input, boundary) {
  assertPlanningAccess(input, boundary);
  const date = planningDate(input.planDate);
  const offset = Math.min(1_000_000, Math.max(0, Number.parseInt(input.offset, 10) || 0));
  const limit = Math.min(100, Math.max(1, Number.parseInt(input.limit, 10) || 40));
  const search = String(input.search || "").trim().slice(0, 200);
  const params = [search];
  const predicate = `v.bin_type_id IS NOT NULL AND v.dispatch_plan_id IS NULL AND v.status IN ('ready','in_progress','evidence_pending')
    AND (v.predecessor_visit_id IS NULL OR predecessor.status IN ('completed','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM mbt_service_visits earlier WHERE earlier.contract_id=v.contract_id
      AND earlier.service_line_id IS NOT DISTINCT FROM v.service_line_id
      AND earlier.visit_number<v.visit_number AND earlier.status NOT IN ('completed','cancelled'))
    AND ($1='' OR concat_ws(' ',v.visit_reference,v.service_action,c.contract_number,v.customer_snapshot::text,
      v.site_snapshot::text,(SELECT string_agg(a.asset_code,' ') FROM mbt_bin_assets a
        WHERE a.asset_id IN (v.expected_asset_id,v.outgoing_asset_id,v.incoming_asset_id))) ILIKE '%' || $1 || '%')`;
  const from = `FROM mbt_service_visits v JOIN mbt_contracts c ON c.contract_id=v.contract_id
    LEFT JOIN mbt_service_visits predecessor ON predecessor.service_visit_id=v.predecessor_visit_id`;
  const candidates = await query(`SELECT v.*,c.contract_number ${from} WHERE ${predicate}
    ORDER BY v.scheduled_start_at NULLS LAST,v.service_visit_id LIMIT $2 OFFSET $3`, [...params, limit, offset]);
  const count = await query(`SELECT count(*)::int AS total ${from} WHERE ${predicate}`, params);
  const planRow = await query("SELECT id::text FROM dispatch_plans WHERE plan_date=$1::date", [date]);
  const plan = planRow.rows[0] ? await readPlanningPlan(planRow.rows[0].id) : null;
  const assigned = plan ? await query(`SELECT v.*,c.contract_number FROM mbt_service_visits v
    JOIN mbt_contracts c ON c.contract_id=v.contract_id WHERE v.dispatch_plan_id=$1 ORDER BY v.visit_number,v.service_visit_id`, [plan.id]) : { rows: [] };
  const items = [];
  for (const visit of candidates.rows) {items.push(await projectMbtBinPlanningCard(visit));}
  const assignedItems = [];
  for (const visit of assigned.rows) {
    assignedItems.push({ ...(await projectMbtBinPlanningCard(visit)), assignment: visit.dispatch_assignment_snapshot,
      loadId: visit.dispatch_load_id, planningGeneration: Number(visit.planning_generation) });
  }
  const drivers = await query("SELECT id::text,name,login,active FROM dispatch_drivers WHERE active ORDER BY lower(name),id");
  const trucks = await query(`SELECT t.id::text,t.plate,t.capacity_lbs AS "capacityLbs",t.truck_type AS "truckType",
      t.bin_slot_capacity AS "binSlotCapacity",t.base_yard AS base,t.base_yard_id::text AS "baseYardId",
      COALESCE(array_agg(b.type_code ORDER BY b.type_code) FILTER (WHERE b.type_code IS NOT NULL),ARRAY[]::text[]) AS "supportedBinTypeCodes"
    FROM dispatch_trucks t LEFT JOIN dispatch_truck_bin_types c ON c.truck_id=t.id AND c.active
    LEFT JOIN mbt_bin_types b ON b.bin_type_id=c.bin_type_id AND b.active
    WHERE t.active AND t.truck_type='bin' AND t.bin_service_enabled GROUP BY t.id ORDER BY lower(t.plate)`);
  return { planDate: date, plan, lease: await getDispatchPlanEditLease(date),
    pool: { items, total: count.rows[0].total, offset, limit,
      nextOffset: offset + limit < count.rows[0].total ? offset + limit : null },
    assigned: assignedItems, drivers: drivers.rows, trucks: trucks.rows };
}

/** @param {any} input @param {any} boundary */
export async function getMbtBinPlanningVisit(input, boundary) {
  assertPlanningAccess(input, boundary);
  const { rows } = await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1", [input.visitId]);
  if (!rows[0]) {throw planningError(404, "MBT_BIN_VISIT_NOT_FOUND", "The BIN visit was not found.");}
  const steps = await query("SELECT visit_step_id,sequence_number,action_code,display_name,status,started_at,completed_at FROM mbt_visit_steps WHERE service_visit_id=$1 ORDER BY sequence_number", [input.visitId]);
  const history = await query("SELECT action,created_at,actor_operator_id,reason,prior_assignment,assignment FROM mbt_bin_dispatch_assignment_history WHERE service_visit_id=$1 ORDER BY created_at DESC,assignment_history_id", [input.visitId]);
  const assignments = await query("SELECT generation,plan_date,load_id,driver_id,truck_id,created_at,released_at,withdrawn_at,withdrawal_reason FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 ORDER BY generation DESC", [input.visitId]);
  const events = await query("SELECT action,actor_id,details,created_at FROM mbt_bin_planning_events WHERE service_visit_id=$1 ORDER BY created_at DESC", [input.visitId]);
  const evidence = await query("SELECT evidence_id,evidence_type,captured_at,recorded_at FROM mbt_evidence WHERE service_visit_id=$1 ORDER BY captured_at", [input.visitId]);
  return { visit: await projectMbtBinPlanningCard(rows[0]), steps: steps.rows, history: history.rows,
    assignments: assignments.rows, events: events.rows, evidence: evidence.rows };
}
