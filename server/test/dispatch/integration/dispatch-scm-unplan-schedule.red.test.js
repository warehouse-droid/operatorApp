// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { listScmSchedule, syncScmScheduleFromDispatchPlan } from "../../../src/dispatch-repository.js";

test("unplanning PO/TO stops restores their pre-Dispatch schedule state", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = Date.now();
      const poRef = `PO-UNPLAN-${suffix}`;
      const toRef = `TO-UNPLAN-${suffix}`;
      const legacyRef = `SN-UNPLAN-${suffix}`;
      const poId = Number(`95${String(suffix).slice(-10)}`);
      const legacyPoId = Number(`96${String(suffix).slice(-10)}`);
      const toId = Number(`97${String(suffix).slice(-10)}`);
      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note)
         VALUES ('2096-07-23', 'draft', 'SCM unplan regression')
         RETURNING id`
      );
      const planId = plan.rows[0].id;

      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, status, status_text, initial_scm_status, netsuite_active, synced_at
         ) VALUES
           ($1, $2, 'B', 'Purchase Order : Pending Receipt', 'Queued', true, now()),
           ($3, $4, 'B', 'Purchase Order : Pending Receipt', 'Queued', true, now())`,
        [poId, poRef, legacyPoId, legacyRef]
      );
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, status, status_text, from_location_id, from_location,
           to_location_id, to_location, netsuite_active, synced_at
         ) VALUES (
           $1, $2, 'B', 'Transfer Order : Pending Fulfillment', 1, '12441',
           2, '2967', true, now()
         )`,
        [toId, toRef]
      );
      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, order_ref, method, status, eta_date, eta_time, driver,
           dispatch_assignment_note, dispatch_plan_id, created_by, updated_by
         ) VALUES
           ('PO', $1, 'MBT', 'Priority', '2096-07-25', '08:15', 'SCM PO Driver',
            'SCM PO assignment', NULL, 'scm-user', 'scm-user'),
           ('TO', $2, 'MBT', 'Book Appt', '2096-07-26', '09:45', 'SCM TO Driver',
            'SCM TO assignment', NULL, 'scm-user', 'scm-user')`,
        [poRef, toRef]
      );

      const assignedPlan = {
        id: planId,
        planDate: "2096-07-23",
        orders: [
          { id: poRef, type: "PO" },
          { id: toRef, type: "TO" }
        ],
        trucks: [{
          plate: "PLAN-TRUCK",
          loads: [{
            id: "PLAN-LOAD",
            name: "Load 1",
            driverName: "Dispatch Driver",
            stops: [
              { id: "PO-DROP", type: "drop", orderId: poRef, timing: { arrival: 600 } },
              { id: "TO-DROP", type: "drop", orderId: toRef, timing: { arrival: 660 } }
            ]
          }]
        }]
      };

      const planned = await syncScmScheduleFromDispatchPlan(assignedPlan, { updatedBy: "dispatch-v2:test-plan" });
      assert.equal(planned.planned, 2);
      assert.equal(planned.unplanned, 0);
      let rows = (await query(
        `SELECT order_ref, status, eta_time, driver, dispatch_assignment_note,
                dispatch_plan_id, dispatch_previous_state
           FROM scm_transport_schedule
          WHERE order_ref = ANY($1::text[])
          ORDER BY order_ref`,
        [[poRef, toRef]]
      )).rows;
      assert.ok(rows.every((row) => row.status === "Planned"));
      assert.ok(rows.every((row) => String(row.dispatch_plan_id) === String(planId)));
      assert.equal(rows.find((row) => row.order_ref === poRef)?.dispatch_previous_state?.status, "Priority");
      assert.equal(rows.find((row) => row.order_ref === toRef)?.dispatch_previous_state?.status, "Book Appt");

      const reassignedPlan = structuredClone(assignedPlan);
      reassignedPlan.trucks[0].loads[0].driverName = "Second Dispatch Driver";
      await syncScmScheduleFromDispatchPlan(reassignedPlan, { updatedBy: "dispatch-v2:test-replan" });

      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, order_ref, method, status, eta_date, eta_time, driver,
           dispatch_assignment_note, dispatch_plan_id, created_by, updated_by
         ) VALUES (
           'PO', $1, 'MBT', 'Planned', '2096-07-23', '21:21', 'Stale Driver',
           'STALE-TRUCK Load 3', $2, 'dispatch-v2:legacy', 'dispatch-v2:legacy'
         )`,
        [legacyRef, planId]
      );

      const unplanned = await syncScmScheduleFromDispatchPlan({
        ...assignedPlan,
        orders: [],
        trucks: [{ plate: "PLAN-TRUCK", loads: [] }]
      }, { updatedBy: "dispatch-v2:test-unplan" });
      assert.equal(unplanned.planned, 0);
      assert.equal(unplanned.unplanned, 3);

      rows = (await query(
        `SELECT order_ref, status, eta_date::text AS eta_date, eta_time, driver,
                dispatch_assignment_note, dispatch_plan_id, dispatch_previous_state, updated_by
           FROM scm_transport_schedule
          WHERE order_ref = ANY($1::text[])
          ORDER BY order_ref`,
        [[poRef, toRef, legacyRef]]
      )).rows;
      const po = rows.find((row) => row.order_ref === poRef);
      const to = rows.find((row) => row.order_ref === toRef);
      const legacy = rows.find((row) => row.order_ref === legacyRef);
      assert.deepEqual(
        [po?.status, po?.eta_date, po?.eta_time, po?.driver, po?.dispatch_assignment_note],
        ["Priority", "2096-07-25", "08:15", "SCM PO Driver", "SCM PO assignment"]
      );
      assert.deepEqual(
        [to?.status, to?.eta_date, to?.eta_time, to?.driver, to?.dispatch_assignment_note],
        ["Book Appt", "2096-07-26", "09:45", "SCM TO Driver", "SCM TO assignment"]
      );
      assert.deepEqual(
        [legacy?.status, legacy?.eta_date, legacy?.eta_time, legacy?.driver, legacy?.dispatch_assignment_note],
        ["Queued", null, null, null, null]
      );
      assert.ok(rows.every((row) => row.dispatch_plan_id === null));
      assert.ok(rows.every((row) => row.dispatch_previous_state === null));
      assert.ok(rows.every((row) => row.updated_by === "dispatch-v2:test-unplan"));

      const [poSchedule] = await listScmSchedule({ exactRef: poRef });
      const [toSchedule] = await listScmSchedule({ exactRef: toRef });
      const [legacySchedule] = await listScmSchedule({ exactRef: legacyRef });
      assert.deepEqual(
        [poSchedule?.status, poSchedule?.etaDate, poSchedule?.etaTime, poSchedule?.driver, poSchedule?.notes],
        ["Priority", "2096-07-25", "08:15", "SCM PO Driver", "SCM PO assignment"],
        "The PO/TO Schedule projection must immediately expose the restored PO state."
      );
      assert.deepEqual(
        [toSchedule?.status, toSchedule?.etaDate, toSchedule?.etaTime, toSchedule?.driver, toSchedule?.notes],
        ["Book Appt", "2096-07-26", "09:45", "SCM TO Driver", "SCM TO assignment"],
        "The PO/TO Schedule projection must immediately expose the restored TO state."
      );
      assert.deepEqual(
        [legacySchedule?.status, legacySchedule?.etaDate, legacySchedule?.etaTime, legacySchedule?.driver, legacySchedule?.notes],
        ["Queued", "", "", "", ""],
        "A legacy stale Dispatch assignment like SN1398121 must return to the schedule queue."
      );

      const migrationRef = `SN-MIGRATION-${suffix}`;
      const manualRef = `PO-MANUAL-PLANNED-${suffix}`;
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, status, status_text, initial_scm_status, netsuite_active, synced_at
         ) VALUES
           ($1, $2, 'B', 'Purchase Order : Pending Receipt', 'Queued', true, now()),
           ($3, $4, 'B', 'Purchase Order : Pending Receipt', 'Queued', true, now())`,
        [poId + 10, migrationRef, poId + 20, manualRef]
      );
      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, order_ref, method, status, eta_date, eta_time, driver,
           dispatch_assignment_note, created_by, updated_by
         ) VALUES
           ('PO', $1, 'MBT', 'Planned', '2096-07-27', '21:21', 'Stale Migration Driver',
            'STALE-MIGRATION-TRUCK Load 3', 'dispatch-v2:legacy', 'dispatch-v2:legacy'),
           ('PO', $2, 'MBT', 'Planned', '2096-07-28', '12:30', 'SCM Manual Driver',
            NULL, 'scm-user', 'scm-user')`,
        [migrationRef, manualRef]
      );
      const migrationSql = await readFile(
        new URL("../../../migrations/163_dispatch_scm_unplan_state.sql", import.meta.url),
        "utf8"
      );
      await query(migrationSql);
      const migrationRows = (await query(
        `SELECT order_ref, status, eta_date::text AS eta_date, eta_time, driver,
                dispatch_assignment_note, dispatch_plan_id, dispatch_previous_state, updated_by
           FROM scm_transport_schedule
          WHERE order_ref = ANY($1::text[])
          ORDER BY order_ref`,
        [[migrationRef, manualRef]]
      )).rows;
      const migrated = migrationRows.find((row) => row.order_ref === migrationRef);
      const manual = migrationRows.find((row) => row.order_ref === manualRef);
      assert.deepEqual(
        [migrated?.status, migrated?.eta_date, migrated?.eta_time, migrated?.driver, migrated?.dispatch_assignment_note, migrated?.dispatch_plan_id, migrated?.dispatch_previous_state, migrated?.updated_by],
        ["Queued", null, null, null, null, null, null, "migration-163-dispatch-unplan"],
        "Deploying migration 163 must immediately repair an existing SN1398121-style stale row."
      );
      assert.deepEqual(
        [manual?.status, manual?.eta_date, manual?.eta_time, manual?.driver, manual?.updated_by],
        ["Planned", "2096-07-28", "12:30", "SCM Manual Driver", "scm-user"],
        "Migration 163 must leave manually planned SCM rows without Dispatch evidence unchanged."
      );
    });
  } finally {
    await rollback.rollback();
    await closeDb();
  }
});
