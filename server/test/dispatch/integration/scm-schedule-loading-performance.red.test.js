// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { dispatchPlanAssignmentRows } from "../../../src/dispatch-planner-v2-repository.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";

after(closeDb);

const repositoryUrl = new URL("../../../src/dispatch-repository.js", import.meta.url);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function fixtureIdentity(label) {
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const id = `89${nonce.slice(-11)}${String(label.length).padStart(2, "0")}`;
  return { id, ref: `PO-SCHEDULE-PERF-${label}-${nonce}` };
}

async function insertPurchaseOrder({ id, ref, status = "Queued" }) {
  await query(
    `WITH inserted AS (
       INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         foreign_total, destination_location_id, destination_location,
         source_location_id, source_location, dispatch_vendor_yard,
         receipt_status, initial_scm_status, netsuite_active, synced_at
       ) VALUES (
         $1::bigint, $2, current_date, $1::bigint + 1, 'Schedule Performance Vendor',
         'pendingReceipt', 'Purchase Order : Pending Receipt', 100,
         1, '3445', 15, '12441', 'Schedule Performance Yard',
         'not_received', $3, true, now()
       )
       RETURNING netsuite_id
     )
     INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, received_pallet_qty,
       received_layer_qty, received_section_qty, received_piece_qty,
       netsuite_received_qty, netsuite_received_baseline_qty, item_weight,
       netsuite_active, synced_at, raw
     )
     SELECT netsuite_id, $1::bigint + 2, $1::bigint + 3,
            'Schedule Performance Item', 'SCHEDULE-PERF-SKU', 10, 'EA',
            1, '3445', 1, 0, 0, 0, 10, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 5, true, now(), '{}'::jsonb
       FROM inserted`,
    [id, ref, status]
  );
}

async function completePurchaseOrder(ref, evidenceId) {
  await query(
    `INSERT INTO dispatch_order_completion_events (
       order_kind, order_ref, dispatch_completion_status,
       dispatch_completed_at, completion_evidence_type,
       completion_evidence_id, actor_type, actor_id, reason, metadata
     ) VALUES (
       'PO', $1, 'completed', now(), 'manual_dispatch', $2,
       'operator', 'schedule-performance-test',
       'Completed filter performance fixture', '{}'::jsonb
     )`,
    [ref, evidenceId]
  );
}

test("SCM-PERF-1/2: Completed jobs are skipped by default and restored only by an explicit Completed status", async () => {
  await inRollback(async () => {
    const queued = fixtureIdentity("QUEUED");
    const completed = fixtureIdentity("COMPLETED");
    const searchPrefix = `PO-SCHEDULE-PERF-`;
    await insertPurchaseOrder(queued);
    await insertPurchaseOrder(completed);
    await completePurchaseOrder(completed.ref, `SCM-PERF-COMPLETE-${completed.id}`);

    const defaultRows = await listScmSchedule({ search: searchPrefix });
    assert.ok(defaultRows.some((row) => row.orderRef === queued.ref), "queued work must remain visible");
    assert.equal(
      defaultRows.some((row) => row.orderRef === completed.ref),
      false,
      "completed work must not consume the default schedule load"
    );

    const completedRows = await listScmSchedule({
      search: searchPrefix,
      status: ["Completed"]
    });
    assert.deepEqual(
      completedRows.filter((row) => [queued.ref, completed.ref].includes(row.orderRef)).map((row) => row.orderRef),
      [completed.ref],
      "an explicit Completed selection must retain completed history"
    );

    const mixedRows = await listScmSchedule({
      search: searchPrefix,
      status: ["Queued", "Completed"]
    });
    assert.deepEqual(
      new Set(mixedRows.filter((row) => [queued.ref, completed.ref].includes(row.orderRef)).map((row) => row.orderRef)),
      new Set([queued.ref, completed.ref]),
      "Completed must remain available in a mixed status selection"
    );
  });
});

test("SCM-PERF-3: assignment projection alone supplies Planned status and route timing", async () => {
  await inRollback(async () => {
    const planned = fixtureIdentity("PLANNED");
    await insertPurchaseOrder(planned);
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       VALUES ('2399-12-30', 'draft', 'Schedule projection fixture', 1)
       RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_plan_order_assignments (
         plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
         load_id, stop_id, assignment
       ) VALUES (
         $1, '2399-12-30', $2, $2, 'direct', 'SCM-PERF-LOAD',
         'SCM-PERF-DROP', $3::jsonb
       )`,
      [
        plan.rows[0].id,
        planned.ref,
        JSON.stringify({
          dispatchPlanned: true,
          dispatchOrderKind: "PO",
          dispatchEtaTime: "13:45",
          dispatchDriverName: "Projection Driver",
          dispatchTruckPlate: "PROJ-101",
          dispatchLoadName: "Projection Load"
        })
      ]
    );

    const [row] = await listScmSchedule({ exactRef: planned.ref });
    assert.ok(row, "the assigned PO must remain searchable without snapshot JSON");
    assert.equal(row.calculatedStatus, "Planned");
    assert.equal(row.etaDate, "2399-12-30");
    assert.equal(row.etaTime, "13:45");
    assert.equal(row.driver, "Projection Driver");
    assert.match(row.notes, /PROJ-101/u);
    assert.match(row.notes, /Projection Load/u);
  });
});

test("SCM-PERF-3B: projection generation persists kind, ETA, driver, truck and load", () => {
  const [row] = dispatchPlanAssignmentRows({
    id: "SCM-PERF-PROJECTION",
    planDate: "2399-12-29",
    orders: [{ id: "PO-SCHEDULE-PROJECTION", type: "PO", sourceTable: "purchase_orders" }],
    trucks: [{
      id: "SCM-PERF-TRUCK",
      plate: "PROJ-202",
      driverName: "Projected Driver",
      loads: [{
        id: "SCM-PERF-LOAD",
        name: "Projected Load",
        parkingSpot: "P-7",
        stops: [{
          id: "SCM-PERF-DROP",
          type: "dropoff",
          orderId: "PO-SCHEDULE-PROJECTION",
          timing: { arrival: 825 }
        }]
      }]
    }]
  });

  assert.equal(row.orderRef, "PO-SCHEDULE-PROJECTION");
  assert.equal(row.assignment.dispatchOrderKind, "PO");
  assert.equal(row.assignment.dispatchEtaTime, "13:45");
  assert.equal(row.assignment.dispatchDriverName, "Projected Driver");
  assert.equal(row.assignment.dispatchTruckPlate, "PROJ-202");
  assert.equal(row.assignment.dispatchLoadName, "Projected Load");
  assert.equal(row.assignment.dispatchParkingSpot, "P-7");
});

test("SCM-PERF-3C: a cancelled plan projection cannot mark an order Planned", async () => {
  await inRollback(async () => {
    const cancelled = fixtureIdentity("CANCELLED-PLAN");
    await insertPurchaseOrder(cancelled);
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       VALUES ('2399-12-28', 'cancelled', 'Cancelled projection fixture', 1)
       RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_plan_order_assignments (
         plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
         load_id, stop_id, assignment
       ) VALUES ($1, '2399-12-28', $2, $2, 'direct', 'CANCELLED-LOAD',
         'CANCELLED-DROP', $3::jsonb)`,
      [plan.rows[0].id, cancelled.ref, JSON.stringify({
        dispatchOrderKind: "PO",
        dispatchEtaTime: "09:15"
      })]
    );

    const [row] = await listScmSchedule({ exactRef: cancelled.ref });
    assert.ok(row);
    assert.equal(row.calculatedStatus, "Queued");
    assert.notEqual(row.etaDate, "2399-12-28");
  });
});

test("SCM-PERF-4A: one closed split excludes its complete PO family", async () => {
  await inRollback(async () => {
    const source = fixtureIdentity("OPEN-SOURCE");
    const child = fixtureIdentity("CLOSED-SPLIT");
    await insertPurchaseOrder(source);
    await insertPurchaseOrder(child);
    await query(
      `UPDATE purchase_orders
          SET status = 'H', status_text = 'Purchase Order : Closed'
        WHERE netsuite_id = $1::bigint`,
      [child.id]
    );
    await query(
      `INSERT INTO dispatch_scm_po_splits (
         source_po_id, source_po_ref, split_po_id, split_po_ref,
         status, created_by, details
       ) VALUES ($1::bigint, $2, $3::bigint, $4, 'active',
         'schedule-performance-test', '{}'::jsonb)`,
      [source.id, source.ref, child.id, child.ref]
    );

    assert.equal((await listScmSchedule({ exactRef: source.ref })).length, 0);
    assert.equal((await listScmSchedule({ exactRef: child.ref })).length, 0);
  });
});

test("SCM-PERF-4/5: schedule request path is independent of snapshot JSON history", async () => {
  const repository = await readFile(repositoryUrl, "utf8");
  const scheduleStart = repository.indexOf("export async function listScmSchedule(");
  const scheduleEnd = repository.indexOf("\nasync function updateScmScheduleEntryTransaction", scheduleStart);
  const scheduleBody = repository.slice(scheduleStart, scheduleEnd);
  const routeStart = repository.indexOf("async function attachScmScheduleRouteOptions(");
  const routeEnd = repository.indexOf("\nasync function resolveScmPurchaseOrderPickupYard", routeStart);
  const routeBody = repository.slice(routeStart, routeEnd);

  assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart, "schedule repository body must be inspectable");
  assert.doesNotMatch(
    scheduleBody,
    /dispatch_plan_snapshots/u,
    "schedule loading must use the assignment projection instead of accumulated snapshot JSON"
  );
  assert.match(scheduleBody, /dispatch_plan_order_assignments/u);
  assert.match(scheduleBody, /closed_po_family_ids/u);
  assert.match(scheduleBody, /closed_to_family_ids/u);
  assert.doesNotMatch(
    scheduleBody,
    /netSuiteClosedOrderFamilySql/u,
    "closed PO/TO families must be projected once instead of correlated per order"
  );
  assert.doesNotMatch(
    routeBody,
    /snapshot\.trucks::text\s+LIKE/u,
    "split route locks must not search serialized historical trucks"
  );
});

test("SCM-PERF-6: 1,000 plan dates remain below the two-second server budget", { timeout: 60_000 }, async () => {
  await inRollback(async () => {
    const active = fixtureIdentity("HISTORY-BOUND");
    await insertPurchaseOrder(active);
    const legacyOrders = Array.from({ length: 200 }, (_, index) => ({
      id: `SCM-PERF-LEGACY-${index}`,
      type: "PO",
      sourceTable: "purchase_orders"
    }));
    const legacyStops = Array.from({ length: 10 }, (_, index) => ({
      id: `SCM-PERF-STOP-${index}`,
      type: "drop",
      orderId: `SCM-PERF-LEGACY-${index}`,
      arriveTime: "08:00"
    }));
    const legacyTrucks = [{
      id: "SCM-PERF-TRUCK",
      plate: "PERF-1000",
      loads: [{ id: "SCM-PERF-LOAD", name: "Legacy Load", stops: legacyStops }]
    }];
    await query(
      `WITH inserted AS (
         INSERT INTO dispatch_plans (plan_date, status, note, revision)
         SELECT date '2400-01-01' + offset_value, 'draft', 'Legacy schedule history fixture', 1
           FROM generate_series(0, 999) offset_value
         ON CONFLICT (plan_date) DO NOTHING
         RETURNING id
       )
       INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
       SELECT id, $1::jsonb, $2::jsonb, '{}'::jsonb
         FROM inserted
       ON CONFLICT (plan_id) DO UPDATE
         SET orders = EXCLUDED.orders, trucks = EXCLUDED.trucks`,
      [JSON.stringify(legacyOrders), JSON.stringify(legacyTrucks)]
    );

    await listScmSchedule({ exactRef: active.ref });
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      const startedAt = performance.now();
      const rows = await listScmSchedule({ exactRef: active.ref });
      samples.push(performance.now() - startedAt);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].orderRef, active.ref);
    }
    const worstMs = Math.max(...samples);
    assert.ok(
      worstMs < 2_000,
      `PO/TO Schedule exceeded 2,000ms with 1,000 plan dates: ${samples.map((sample) => sample.toFixed(1)).join(", ")}ms`
    );
  });
});
