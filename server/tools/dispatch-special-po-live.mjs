import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./src/db.js";
import { listScmSchedule, listDispatchOrders, enrichDispatchOrdersWithPoTargetAllocations } from "./src/dispatch-repository.js";
import { getDispatchOrderCatalogOrder } from "./src/dispatch-order-catalog-repository.js";
import { assertNoDriverPwaCompletedDispatchRefs } from "./src/dispatch-history-mode.js";

const context = await beginRollbackContext();
try {
  await context.run(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='20s'");
    const poRef = "LOINC-035925";
    const [schedule] = (await listScmSchedule({ exactRef: poRef, audience: "scm", status: ["Completed"] }))
      .filter((row) => row.orderRef === poRef);
    assert.equal(schedule?.calculatedStatus, "Completed");
    const card = await getDispatchOrderCatalogOrder(poRef);
    assert.equal(card?.dispatchCompletionStatus, "completed");
    assert.equal(card?.dispatchPlanningRestricted, true);
    for (const ref of [poRef, "POB03921"]) {
      await assert.rejects(assertNoDriverPwaCompletedDispatchRefs([ref]), { code: "DISPATCH_ORDER_DRIVER_COMPLETED" });
    }
    const source = (await listDispatchOrders({ type: "PO", search: poRef, includeHiddenScm: true }))
      .find((order) => order.id === poRef);
    assert.ok(source, "PO source remains available for history");
    const [projected] = await enrichDispatchOrdersWithPoTargetAllocations([source]);
    assert.equal(projected.poRouteProjection?.hasResidual, false);
    const [completion] = (await query(`SELECT dispatch_completed_at, completion_evidence_id
      FROM dispatch_order_completion_status WHERE order_kind='PO' AND order_ref=$1`, [poRef])).rows;
    const [driver] = (await query("SELECT completed_at, status, stop_type FROM driver_job_records WHERE job_id=$1",
      [completion.completion_evidence_id])).rows;
    assert.equal(driver.status, "complete");
    assert.equal(driver.stop_type, "dropoff");
    assert.equal(new Date(completion.dispatch_completed_at).toISOString(), new Date(driver.completed_at).toISOString());
    console.log(JSON.stringify({ poRef, scheduleStatus: schedule.calculatedStatus,
      planningRestricted: card.dispatchPlanningRestricted, bothPoAliasesBlocked: true,
      hasResidual: projected.poRouteProjection.hasResidual,
      completedAt: new Date(completion.dispatch_completed_at).toISOString(),
      driverEvidenceVerified: true, readOnly: true }));
  });
} finally { await context.rollback(); await closeDb(); }
