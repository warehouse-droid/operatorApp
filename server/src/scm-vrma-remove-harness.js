import { beginRollbackContext, closeDb, query } from "./db.js";
import { getScmVrmaOrder, removeScmVrmaOrder } from "./dispatch-repository.js";

const suffix = String(Date.now());
const actor = "scm-vrma-remove-harness";

function assert(condition, message, details = {}) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function captureRejection(action, pattern, message) {
  try {
    await action();
  } catch (error) {
    assert(pattern.test(String(error?.message || error)), message, {
      error: error?.message,
      code: error?.code,
      conflicts: error?.conflicts
    });
    return error;
  }
  throw new Error(message);
}

async function createVrma(label, {
  status = "Queued",
  operatorStatus = "open",
  localYardOrderStatus = "Open",
  preparingOperatorId = null,
  preparingStartedAt = null,
  loadedAt = null,
  packedPalletQty = 0,
  loadedQty = 0,
  confirmed = false,
  confirmedAt = null
} = {}) {
  const ref = `VRMA-REMOVE-${label}-${suffix}`;
  const header = await query(
    `INSERT INTO scm_vrma_orders (
       vrma_ref, vendor, local_vendor, pickup_location, dropoff_location,
       status, method, notes, operator_status, local_yard_order_status,
       preparing_operator_id, preparing_started_at, loaded_at, created_by, updated_by
     ) VALUES (
       $1, 'Harness Vendor', 'Harness Vendor', '3445', 'Harness Yard',
       $2, 'MBT', 'Removal harness fixture', $3, $4,
       $5, $6, $7, $8, $8
     )
     RETURNING *`,
    [
      ref,
      status,
      operatorStatus,
      localYardOrderStatus,
      preparingOperatorId,
      preparingStartedAt,
      loadedAt,
      actor
    ]
  );
  await query(
    `INSERT INTO scm_vrma_order_lines (
       vrma_order_id, item_name, quantity, unit, weight_lbs,
       packed_pallet_qty, loaded_qty, confirmed, confirmed_at
     ) VALUES ($1, 'Harness Item', 10, 'PC', 25, $2, $3, $4, $5)`,
    [header.rows[0].id, packedPalletQty, loadedQty, confirmed, confirmedAt]
  );
  await query(
    `INSERT INTO scm_transport_schedule (
       order_kind, source_table, source_id, order_ref, method,
       pickup_point, dropoff_point, brand, content, weight_lbs,
       status, notes, created_by, updated_by
     ) VALUES (
       'VRMA', 'scm_vrma_orders', $1, $2, 'MBT',
       '3445', 'Harness Yard', 'Harness Vendor', 'Harness Item 10 PC', 25,
       $3, 'Removal harness fixture', $4, $4
     )`,
    [header.rows[0].id, ref, status, actor]
  );
  return { ref, id: header.rows[0].id };
}

async function revision(ref) {
  const detail = await getScmVrmaOrder(ref);
  assert(detail?.concurrencyUpdatedAt, "VRMA detail must expose its cancellation concurrency revision.", { detail });
  return detail.concurrencyUpdatedAt;
}

async function remove(ref, expectedUpdatedAt = null) {
  return removeScmVrmaOrder({
    vrmaRef: ref,
    note: "Confirmed duplicate fixture; retain the audit trail.",
    actor,
    expectedUpdatedAt: expectedUpdatedAt || await revision(ref),
    confirm: true
  });
}

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const pristine = await createVrma("PRISTINE");
    await captureRejection(
      () => removeScmVrmaOrder({
        vrmaRef: pristine.ref,
        note: "Confirmed duplicate fixture.",
        actor,
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        confirm: true
      }),
      /changed after it was opened/i,
      "Removal must reject a stale VRMA revision."
    );
    const originalRevision = await revision(pristine.ref);
    const removed = await remove(pristine.ref, originalRevision);
    const retained = await query(
      `SELECT v.status, v.cancelled_at, v.cancelled_by, v.cancellation_note, v.cancellation_source,
              schedule.status AS schedule_status,
              (SELECT COUNT(*)::int FROM scm_vrma_order_lines line WHERE line.vrma_order_id = v.id) AS line_count
         FROM scm_vrma_orders v
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'VRMA'
          AND LOWER(schedule.order_ref) = LOWER(v.vrma_ref)
        WHERE v.id = $1`,
      [pristine.id]
    );
    assert(removed.removed === true
        && removed.idempotent === false
        && retained.rows[0]?.status === "Cancelled"
        && retained.rows[0]?.schedule_status === "Cancelled"
        && retained.rows[0]?.cancelled_at
        && retained.rows[0]?.cancelled_by === actor
        && retained.rows[0]?.cancellation_note.includes("duplicate fixture")
        && retained.rows[0]?.cancellation_source === "scm_remove"
        && Number(retained.rows[0]?.line_count) === 1,
      "Removal must soft-cancel both status layers and retain all VRMA lines and cancellation metadata.",
      { removed, retained: retained.rows[0] });
    const idempotent = await remove(pristine.ref, originalRevision);
    assert(idempotent.removed === true && idempotent.idempotent === true,
      "A retried removal must return idempotent success even with the pre-removal revision.",
      { idempotent });

    const completed = await createVrma("COMPLETED", { status: "Completed" });
    const completedError = await captureRejection(
      () => remove(completed.ref),
      /Completed VRMA cannot be removed/i,
      "A Completed VRMA must never be removed."
    );
    assert(completedError.code === "SCM_VRMA_REMOVE_BLOCKED",
      "Completed removal must expose the stable blocked code.",
      { code: completedError.code });

    const assigned = await createVrma("ASSIGNED");
    const assignmentPlan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES ('2098-01-01', 'draft', $1)
       RETURNING id`,
      [`VRMA removal assignment ${suffix}`]
    );
    await query(
      `INSERT INTO dispatch_vrma_plan_assignments (
         plan_id, order_ref, plan_date, truck_plate, load_name
       ) VALUES ($1, $2, '2098-01-01', 'REMOVE-101', 'Load 1')`,
      [assignmentPlan.rows[0].id, assigned.ref]
    );
    const assignmentError = await captureRejection(
      () => remove(assigned.ref),
      /active Dispatch plan/i,
      "A normalized active dispatch assignment must block VRMA removal."
    );
    assert(assignmentError.conflicts?.some((conflict) => conflict.type === "dispatch_plan"),
      "The normalized assignment blocker must be machine-readable.",
      { conflicts: assignmentError.conflicts });
    await query("UPDATE dispatch_plans SET status = 'cancelled' WHERE id = $1", [assignmentPlan.rows[0].id]);
    assert((await remove(assigned.ref)).removed === true,
      "Assignments that belong only to a cancelled plan must not block removal.");

    const snapshotOnly = await createVrma("SNAPSHOT");
    const snapshotPlan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES ('2098-01-02', 'draft', $1)
       RETURNING id`,
      [`VRMA removal snapshot ${suffix}`]
    );
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
       VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
      [
        snapshotPlan.rows[0].id,
        JSON.stringify([{ id: snapshotOnly.ref, type: "PO", sourceTable: "scm_vrma_orders" }]),
        JSON.stringify([{
          plate: "REMOVE-102",
          loads: [{ name: "Load 2", stops: [{ type: "drop", orderId: snapshotOnly.ref }] }]
        }])
      ]
    );
    await captureRejection(
      () => remove(snapshotOnly.ref),
      /active Dispatch plan/i,
      "An active legacy dispatch snapshot must block VRMA removal even without a normalized assignment."
    );

    const preparing = await createVrma("PREPARING", {
      operatorStatus: "preparing",
      preparingOperatorId: actor,
      preparingStartedAt: new Date()
    });
    await captureRejection(
      () => remove(preparing.ref),
      /packing or loading has already started/i,
      "Header-level Operator preparation must block removal."
    );

    const lineProgress = await createVrma("LINE", {
      packedPalletQty: 1,
      confirmed: true,
      confirmedAt: new Date()
    });
    await captureRejection(
      () => remove(lineProgress.ref),
      /packing or loading has already started/i,
      "Packed or confirmed line activity must block removal."
    );

    const loadHistory = await createVrma("LOAD-HISTORY");
    await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref, source_table, source_record_id,
         photo_data_url, line_snapshot, response
       ) VALUES (
         'vrma_local_load', 'vrma_order', $1, $2, 'scm_vrma_orders', $1,
         '', '[]'::jsonb, '{}'::jsonb
       )`,
      [loadHistory.id, loadHistory.ref]
    );
    const historyError = await captureRejection(
      () => remove(loadHistory.ref),
      /retained Operator load history/i,
      "Retained Operator load evidence must block removal."
    );
    assert(historyError.conflicts?.some((conflict) => conflict.type === "operator_load_history"),
      "Operator history must be reported as a distinct removal blocker.",
      { conflicts: historyError.conflicts });

    const grouped = await createVrma("GROUPED");
    const group = await query(
      `INSERT INTO scm_schedule_groups (group_ref, status, created_by)
       VALUES ($1, 'active', $2)
       RETURNING id`,
      [`VRMA-REMOVE-GROUP-${suffix}`, actor]
    );
    await query(
      `INSERT INTO scm_schedule_group_members (group_id, order_kind, order_ref)
       VALUES ($1, 'VRMA', $2)`,
      [group.rows[0].id, grouped.ref]
    );
    const groupError = await captureRejection(
      () => remove(grouped.ref),
      /Ungroup this VRMA/i,
      "Active SCM group membership must block VRMA removal."
    );
    assert(groupError.conflicts?.some((conflict) => conflict.type === "active_group"),
      "The active group blocker must be machine-readable.",
      { conflicts: groupError.conflicts });
  });
  console.log("SCM VRMA removal rollback harness passed.");
} finally {
  await rollback.rollback().catch(() => null);
  await closeDb();
}
