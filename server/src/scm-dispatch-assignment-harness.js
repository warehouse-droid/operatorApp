import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { syncScmScheduleFromDispatchPlan, updateScmScheduleEntry } from "./dispatch-repository.js";

const rollback = await beginRollbackContext();

function planFor(ref, { plate, driver, parking }) {
  return {
    planDate: "2096-07-22",
    orders: [{ id: ref, type: "PO" }],
    trucks: [{
      id: "PARENT-TRUCK",
      plate: "PARENT-PLATE",
      driver: "Parent Driver",
      loads: [{
        id: "SCM-LOAD-V2",
        name: "Load V2",
        truckId: `ID-${plate}`,
        truckPlate: plate,
        driverLogin: driver.toLowerCase().replaceAll(" ", "-"),
        driverName: driver,
        parkingSpot: parking,
        stops: [{ id: "SCM-DROP-V2", type: "drop", orderId: ref, timing: { arrival: 570, depart: 585 } }]
      }]
    }]
  };
}

try {
  await rollback.run(async () => {
    const ref = `PO-SCM-V2-${Date.now()}`;
    await syncScmScheduleFromDispatchPlan(planFor(ref, {
      plate: "LOAD-B",
      driver: "Load Driver B",
      parking: "B7"
    }), { updatedBy: "dispatch-harness" });

    let row = (await query(
      "SELECT eta_time, driver, notes, dispatch_assignment_note, created_by FROM scm_transport_schedule WHERE order_kind = 'PO' AND order_ref = $1",
      [ref]
    )).rows[0];
    assert.equal(row.eta_time, "09:30");
    assert.equal(row.driver, "Load Driver B");
    assert.equal(row.notes, null);
    assert.equal(row.dispatch_assignment_note, "LOAD-B Load V2 Parking B7");
    assert.equal(row.created_by, "dispatch-harness");

    await syncScmScheduleFromDispatchPlan(planFor(ref, {
      plate: "LOAD-C",
      driver: "Load Driver C",
      parking: "C8"
    }), { updatedBy: "dispatch-harness" });
    row = (await query(
      "SELECT driver, notes, dispatch_assignment_note FROM scm_transport_schedule WHERE order_kind = 'PO' AND order_ref = $1",
      [ref]
    )).rows[0];
    assert.equal(row.driver, "Load Driver C");
    assert.equal(row.dispatch_assignment_note, "LOAD-C Load V2 Parking C8");

    await updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: ref,
      patch: { notes: "SCM manual instruction" },
      updatedBy: "991"
    });
    await syncScmScheduleFromDispatchPlan(planFor(ref, {
      plate: "LOAD-D",
      driver: "Load Driver D",
      parking: "D9"
    }), { updatedBy: "dispatch-harness" });
    row = (await query(
      "SELECT driver, notes, dispatch_assignment_note FROM scm_transport_schedule WHERE order_kind = 'PO' AND order_ref = $1",
      [ref]
    )).rows[0];
    assert.equal(row.driver, "Load Driver D");
    assert.equal(row.notes, "SCM manual instruction");
    assert.equal(row.dispatch_assignment_note, "LOAD-D Load V2 Parking D9");
  });
  console.log(JSON.stringify({ ok: true, tests: 10 }));
} finally {
  await rollback.rollback();
  await closeDb();
}
