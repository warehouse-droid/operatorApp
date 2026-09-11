import crypto from "node:crypto";
import { beginRollbackContext, query } from "../../src/db.js";
import { createDispatchPlan, saveDispatchPlanSnapshot } from "../../src/dispatch-plan-repository.js";

export async function rollbackTest(run) {
  const context = await beginRollbackContext();
  try { await context.run(run); } finally { await context.rollback(); }
}

export async function seedTransferDependency({ priorDate = "2098-09-01", date = "2098-09-08" } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const base = 8_900_000_000 + Number.parseInt(suffix, 16) * 10;
  const salesRef = `SO-UNLINK-${suffix}`;
  const transferRef = `TO-UNLINK-${suffix}`;
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,customer,status,status_text,
    outbound_location_id,outbound_location,sales_order_type,fulfillment_status,operator_status,
    local_yard_order_status,dispatch_address,netsuite_active)
    VALUES ($1,$2,'Unlink regression','B','Sales Order : Pending Fulfillment',1,'3445',
    'Delivery','not_fulfilled','open','Open','100 Test Street',true)`, [base, salesRef]);
  const line = (await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,
    item_type,item_type_text,quantity,unit,piece_qty,to_pcs,netsuite_active)
    VALUES ($1,1,599,'Test material','TEST','InvtPart','Inventory Item',10,'EACH',10,1,true) RETURNING id`, [base])).rows[0];
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,from_location_id,from_location,
    to_location_id,to_location,outbound_operator_status,local_yard_order_status,fulfillment_status,
    receiving_status,netsuite_active) VALUES ($1,$2,'B','Transfer Order : Pending Fulfillment',28,'2967',
    1,'3445','open','Open','not_fulfilled','not_received',true)`, [base + 1, transferRef]);
  const truck = (await query("INSERT INTO dispatch_trucks (plate,active) VALUES ($1,true) RETURNING id::text,plate", [`UNLINK-${suffix}`])).rows[0];
  const prior = await createDispatchPlan({ planDate: priorDate });
  await query(`INSERT INTO dispatch_plan_order_assignments (plan_id,plan_date,order_ref,planned_order_ref,load_id,stop_id)
    VALUES ($1,$2,$3,$3,'prior-load','prior-drop')`, [prior.id, priorDate, transferRef]);
  const created = await createDispatchPlan({ planDate: date });
  const order = { id: salesRef, type: "SO", sourceYard: "3445", pickupLocations: ["3445"],
    address: "100 Test Street", items: [{ lineRowId: line.id, itemId: 599, sku: "TEST", itemType: "InvtPart", quantity: 10, pieces: 10 }] };
  const plan = await saveDispatchPlanSnapshot(created.id, { planDate: date, orders: [order],
    trucks: [{ id: truck.id, plate: truck.plate, loads: [{ id: "target-load", name: "Load 1", stops: [
      { id: "target-pick", type: "pick", orderId: salesRef, location: "3445", timing: { arrival: 420, depart: 450 } },
      { id: "target-drop", type: "drop", orderId: salesRef, location: "3445", timing: { arrival: 480, depart: 510 } }
    ] }] }] });
  const dependency = (await query(`INSERT INTO order_dependencies (sales_order_id,sales_order_ref,dispatch_target_ref,
    dispatch_target_kind,transfer_order_id,transfer_order_ref,dependency_mode,same_load_required,status,
    source_location_id,source_location,accounting_destination_location_id,accounting_destination_location,
    planned_plan_id,planned_date,reconciliation_status)
    VALUES ($1,$2,$2,'normal',$3,$4,'yard_replenishment',false,'active',28,'2967',1,'3445',$5,$6,'pending') RETURNING id`,
  [base, salesRef, base + 1, transferRef, plan.id, date])).rows[0];
  await query(`INSERT INTO order_dependency_lines (dependency_id,sales_line_id,item_id,item_name,unit,allocated_quantity,
    piece_qty,line_role) VALUES ($1,$2,599,'Test material','EACH',10,10,'sales_allocation')`, [dependency.id, line.id]);
  return { salesRef, transferRef, salesId: base, transferId: base + 1, salesLineId: line.id, dependencyId: Number(dependency.id), plan, prior };
}

export async function seedTransferJob(fixture, { stopType = "dropoff", status = "complete", target = false } = {}) {
  const jobId = crypto.randomUUID();
  await query(`INSERT INTO driver_job_records (job_id,plan_id,plan_date,driver_login,load_id,stop_id,stop_type,
    order_refs,status,started_at,completed_at) VALUES ($1,$2,$3,'unlink-test',$4,$5,$6,$7::jsonb,$8,
    now() - interval '1 minute', CASE WHEN $8 = 'complete' THEN now() ELSE NULL END)`,
  [jobId, target ? fixture.plan.id : fixture.prior.id, target ? fixture.plan.planDate : fixture.prior.planDate,
    target ? "target-load" : "prior-load", target ? "target-drop" : "prior-drop", stopType,
    JSON.stringify([target ? fixture.salesRef : fixture.transferRef]), status]);
  return jobId;
}

export function unlinkCommand(fixture) {
  return { requestId: crypto.randomUUID(), action: "unlink_to", targetRef: fixture.salesRef,
    planId: fixture.plan.id, planDate: fixture.plan.planDate, expectedPlanRevision: fixture.plan.revision,
    payload: { dependencyId: fixture.dependencyId } };
}

export async function executionEvidence(fixture) {
  const result = {};
  for (const [name, sql, values] of [
    ["lines", "SELECT * FROM order_dependency_lines WHERE dependency_id=$1 ORDER BY id", [fixture.dependencyId]],
    ["jobs", "SELECT * FROM driver_job_records WHERE order_refs ? $1 ORDER BY id", [fixture.transferRef]],
    ["transfer", "SELECT * FROM transfer_orders WHERE netsuite_id=$1", [fixture.transferId]],
    ["priorPlan", "SELECT * FROM dispatch_plan_snapshots WHERE plan_id=$1", [fixture.prior.id]]
  ]) { result[name] = (await query(sql, values)).rows; }
  return result;
}
