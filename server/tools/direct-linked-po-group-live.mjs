import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "./src/db.js";
import { listScmSchedule } from "./src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "./src/scm-reconciliation-repository.js";

const refs = ["SN1401884", "LOINC-033146", "LOINC-035332", "PO#B03964"];
try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout = '10s'");
    const started = performance.now();
    const rows = await listScmSchedule({ exactRefs: refs });
    const enriched = await enrichScmScheduleWithReconciliation(rows);
    const orders = rows.map(row => ({ ref: row.orderRef, status: row.calculatedStatus,
      displayedStatus: enriched.find(entry => entry.orderRef === row.orderRef)?.calculatedStatus,
      completedAt: row.dispatchCompletedAt || null }));
    const proof = (await query(`SELECT completion.order_ref,completion.dispatch_completed_at,
      completion.completion_evidence_type,completion.completion_evidence_id,
      completion.dispatch_completed_at=driver.completed_at AS exact_driver_timestamp,
      completion.metadata->>'directShipCoverageVerified' AS receipt_verified,
      completion.metadata->>'directTransportCoverageVerified' AS transport_verified
      FROM dispatch_order_completion_status completion JOIN driver_job_records driver
        ON driver.id=5492 AND completion.completion_evidence_id=driver.job_id
      WHERE completion.order_kind='PO' AND completion.order_ref='SN1401884'`)).rows;
    const receipts = (await query("SELECT count(*)::int AS count FROM dispatch_direct_po_ir_jobs WHERE local_po_id=-237519275993888")).rows[0].count;
    let fullScheduleProjectionMs = null;
    let activeScheduleMs = null;
    if (process.env.COMBINED_RELEASE_VERIFY === "1") {
      const row = orders.find(entry => entry.ref === "SN1401884");
      assert.equal(row?.status, "Completed");
      assert.equal(row?.displayedStatus, "Completed");
      assert.equal(row?.completedAt, "2026-10-02T16:32:30.332Z");
      assert.equal(proof.length, 1);
      assert.equal(proof[0].exact_driver_timestamp, true);
      assert.equal(proof[0].receipt_verified, "false");
      assert.equal(proof[0].transport_verified, "true");
      assert.equal(receipts, 0);
      for (const [ref,date] of [["LOINC-033146","2026-09-14T16:11:31.619Z"],["LOINC-035332","2026-10-01T17:37:53.866Z"]]) {
        const retained = orders.find(entry => entry.ref === ref);
        assert.equal(retained?.status, "Completed");
        assert.equal(retained?.completedAt, date);
      }
      const projected = await listScmSchedule({ exactRefs: ["SN1401884"], statusProjectionOnly: true });
      assert.equal(projected[0].calculatedStatus, "Completed");
      const fullStarted = performance.now();
      const full = await listScmSchedule({ view: "completed" });
      assert.ok(full.length > 0);
      assert.ok(full.every(entry => ["Completed", "Cancelled"].includes(entry.calculatedStatus)));
      fullScheduleProjectionMs = Math.round(performance.now()-fullStarted);
      const activeStarted = performance.now();
      const active = await listScmSchedule();
      assert.ok(active.length > 0);
      activeScheduleMs = Math.round(performance.now()-activeStarted);
    }
    return { orders, proof, receiptJobs: receipts, readOnly: true, elapsedMs: Math.round(performance.now()-started),
      fullScheduleProjectionMs, activeScheduleMs, statementTimeoutSeconds:10 };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
