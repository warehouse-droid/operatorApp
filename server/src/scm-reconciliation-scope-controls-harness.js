import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  cancelScmReconciliationRun,
  createScmReconciliationRun,
  finishScmReconciliationRun,
  getScmReconciliationRunDetails,
  initializeScmReconciliationRunTargets,
  listLocalScmReconciliationSources,
  listScmReconciliationBroadExcludedSources,
  listScmReconciliationRuns,
  markScmReconciliationRunRunning,
  queueScmReconciliationRunResume,
  updateScmReconciliationRunTarget
} from "./scm-reconciliation-repository.js";
import { normalizeScmReconciliationTargetRefs } from "./scm-reconciliation-service.js";

const normalizedRefs = normalizeScmReconciliationTargetRefs(
  ' pob03581, "POB03582"\nPOB03581\r\n',
  ["pob03583", " POB03582 "]
);
assert.deepEqual(
  normalizedRefs,
  ["POB03581", "POB03582", "POB03583"],
  "Targeted source references must accept CSV/newlines, normalize case, and deduplicate in input order."
);
assert.equal(
  normalizeScmReconciliationTargetRefs(
    Array.from({ length: 100 }, (_, index) => `POB-${index + 1}`)
  ).length,
  100,
  "The documented 100-reference boundary must remain accepted."
);
assert.throws(
  () => normalizeScmReconciliationTargetRefs(
    Array.from({ length: 101 }, (_, index) => `POB-${index + 1}`)
  ),
  (error) => error?.status === 400 && /no more than 100/i.test(error.message),
  "Targeted runs must reject more than 100 unique source references."
);
assert.throws(
  () => normalizeScmReconciliationTargetRefs("P".repeat(65)),
  (error) => error?.status === 400 && /64 characters or fewer/i.test(error.message),
  "Oversized source references must be rejected before persistence."
);

const rollback = await beginRollbackContext();
const suffix = `${Date.now()}-${process.pid}`.replace(/\D/g, "").slice(-12);
const actor = `reconciliation-scope-harness-${suffix}`;
const baseId = 9_600_000_000 + Number(suffix.slice(-7));
const fixtures = {
  active: { id: baseId + 1, ref: `PO-SCOPE-ACTIVE-${suffix}` },
  completed: { id: baseId + 2, ref: `PO-SCOPE-COMPLETED-${suffix}` },
  hold: { id: baseId + 3, ref: `PO-SCOPE-HOLD-${suffix}` },
  skipped: { id: baseId + 4, ref: `PO-SCOPE-SKIP-${suffix}` },
  closed: { id: baseId + 5, ref: `PO-SCOPE-CLOSED-${suffix}` },
  staleCompleted: { id: baseId + 6, ref: `PO-SCOPE-STALE-COMPLETED-${suffix}` }
};
const orphanSkipped = {
  id: baseId + 7,
  ref: `PO-SCOPE-ORPHAN-SKIP-${suffix}`
};

try {
  await rollback.run(async () => {
    const schema = await query(
      `SELECT
         EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'scm_reconciliation_runs'
              AND column_name = 'include_terminal_orders'
         ) AS run_scope_override,
         EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'scm_reconciliation_order_state'
              AND column_name = 'broad_reconciliation_skipped'
         ) AS saved_skip,
         EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'scm_reconciliation_runs'
              AND column_name = 'cancel_requested_at'
         ) AS safe_stop`
    );
    assert.equal(schema.rows[0]?.run_scope_override, true, "Migration 080 run override column is missing.");
    assert.equal(schema.rows[0]?.saved_skip, true, "Migration 080 saved-Skip column is missing.");
    assert.equal(schema.rows[0]?.safe_stop, true, "Migration 081 safe-Stop column is missing.");

    // The partial unique index allows one company-wide running row. Park any
    // pre-existing row only inside this never-committed test transaction so
    // the running-cancellation fixture is deterministic.
    await query(
      `UPDATE scm_reconciliation_runs
          SET status = 'interrupted'
        WHERE status = 'running'`
    );

    for (const fixture of Object.values(fixtures)) {
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, status, status_text,
           vendor_id, vendor, destination_location_id, destination_location,
           receipt_status, netsuite_active, synced_at
         ) VALUES (
           $1, $2, CURRENT_DATE, 'B', 'Purchase Order : Pending Receipt',
           5001, 'Scope Harness Vendor', 1, 'Scope Harness Yard',
           'not_received', true, now()
         )`,
        [fixture.id, fixture.ref]
      );
    }

    for (const [fixture, applicationStatus, savedSkip] of [
      [fixtures.active, "Queued", false],
      [fixtures.completed, "Completed", false],
      [fixtures.staleCompleted, "Completed", false],
      [fixtures.skipped, "Queued", true]
    ]) {
      await query(
        `INSERT INTO scm_reconciliation_order_state (
           order_kind, source_order_netsuite_id, source_order_ref,
           application_status, reconciliation_status,
           broad_reconciliation_skipped,
           broad_reconciliation_skipped_at,
           broad_reconciliation_skipped_by,
           broad_reconciliation_skip_note,
           reconciled_at
         ) VALUES (
           'PO', $1, $2, $3, 'current', $4,
           CASE WHEN $4 THEN now() ELSE NULL END,
           CASE WHEN $4 THEN $5 ELSE NULL END,
           CASE WHEN $4 THEN 'Harness saved Skip decision' ELSE NULL END,
           now()
         )`,
        [fixture.id, fixture.ref, applicationStatus, savedSkip, actor]
      );
    }
    await query(
      `UPDATE purchase_orders
          SET synced_at = now() - interval '2 hours'
        WHERE netsuite_id = $1`,
      [fixtures.staleCompleted.id]
    );
    await query(
      `UPDATE scm_reconciliation_order_state
          SET reconciled_at = now() - interval '1 hour'
        WHERE order_kind = 'PO'
          AND source_order_netsuite_id = $1`,
      [fixtures.staleCompleted.id]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, quantity,
         netsuite_received_qty, unit, location_id, location, netsuite_active,
         raw, synced_at
       ) VALUES (
         $1, $2, 5002, 'Stale completed source line', 'STALE-COMPLETED', 3,
         0, 'EA', 1, 'Scope Harness Yard', true, '{}'::jsonb, now()
       )`,
      [fixtures.staleCompleted.id, fixtures.staleCompleted.id + 1000]
    );
    await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status,
         broad_reconciliation_skipped, broad_reconciliation_skipped_at,
         broad_reconciliation_skipped_by, broad_reconciliation_skip_note
       ) VALUES (
         'PO', $1, $2, 'Queued', 'current',
         true, now(), $3, 'Orphaned saved Skip decision'
       )`,
      [orphanSkipped.id, orphanSkipped.ref, actor]
    );

    for (const [fixture, status] of [
      [fixtures.hold, "Hold"],
      [fixtures.closed, "Cancelled"]
    ]) {
      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, source_table, source_id, order_ref, status,
           created_by, updated_by
         ) VALUES (
           'PO', 'purchase_orders', $1, $2, $3, $4, $4
         )`,
        [fixture.id, fixture.ref, status, actor]
      );
    }

    const allPoSources = await listLocalScmReconciliationSources({ kind: "PO" });
    const fixtureSources = allPoSources.filter((source) =>
      Object.values(fixtures).some((fixture) => fixture.id === source.id)
    );
    assert.equal(
      fixtureSources.length,
      Object.keys(fixtures).length,
      "Broad-source discovery must retain local headers before applying the explicit exclusion set."
    );

    const excluded = await listScmReconciliationBroadExcludedSources({ kind: "PO" });
    const fixtureExclusions = new Map(
      excluded
        .filter((source) => Object.values(fixtures).some((fixture) => fixture.id === source.id))
        .map((source) => [source.id, source.reason])
    );
    assert.equal(fixtureExclusions.get(fixtures.completed.id), "completed");
    assert.equal(
      fixtureExclusions.has(fixtures.staleCompleted.id),
      false,
      "A completed calculation must re-enter broad reconciliation when a source line was synced later."
    );
    assert.equal(fixtureExclusions.get(fixtures.hold.id), "hold");
    assert.equal(fixtureExclusions.get(fixtures.skipped.id), "saved_skip");
    assert.equal(fixtureExclusions.get(fixtures.closed.id), "closed");
    assert.equal(
      excluded.find((source) => source.id === orphanSkipped.id)?.reason,
      "saved_skip",
      "A durable Skip must remain excluded even when its local PO/TO header is absent."
    );
    assert.equal(
      fixtureExclusions.has(fixtures.active.id),
      false,
      "An active order must remain in a default broad reconciliation."
    );
    const effectiveFixtureSources = fixtureSources.filter((source) =>
      !fixtureExclusions.has(source.id)
    );
    assert.deepEqual(
      effectiveFixtureSources.map((source) => source.id),
      [fixtures.active.id, fixtures.staleCompleted.id],
      "Default broad reconciliation must retain active and stale-completed orders while excluding unchanged terminal, Hold, and saved-Skip orders."
    );

    const queued = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "PO",
      includeTerminalOrders: true,
      dryRun: true,
      requestedBy: actor
    });
    assert.equal(queued.includeTerminalOrders, true);
    await initializeScmReconciliationRunTargets(queued.id, [
      { kind: "PO", id: fixtures.active.id, tranid: fixtures.active.ref },
      { kind: "PO", id: fixtures.completed.id, tranid: fixtures.completed.ref }
    ]);
    const storedOverride = await query(
      `SELECT include_terminal_orders
         FROM scm_reconciliation_runs
        WHERE id = $1`,
      [queued.id]
    );
    assert.equal(storedOverride.rows[0]?.include_terminal_orders, true);
    assert.equal(
      (await listScmReconciliationRuns({ limit: 200 }))
        .find((run) => run.id === queued.id)?.includeTerminalOrders,
      true,
      "The terminal-order override must round-trip through run-history mapping."
    );
    assert.equal(
      (await getScmReconciliationRunDetails(queued.id)).run.includeTerminalOrders,
      true,
      "The terminal-order override must round-trip through run-detail mapping."
    );

    const queuedStop = await cancelScmReconciliationRun(
      queued.id,
      actor,
      "Harness stopped queued reconciliation."
    );
    assert.equal(queuedStop.stopped, true);
    assert.equal(queuedStop.run.status, "cancelled");
    assert.equal(queuedStop.run.checkpoint.stopRequestedBy, actor);
    assert.equal(queuedStop.run.error, "Harness stopped queued reconciliation.");
    const cancelledQueuedDetails = await getScmReconciliationRunDetails(queued.id);
    assert.deepEqual(
      cancelledQueuedDetails.targets.map((target) => target.status).sort(),
      ["skipped", "skipped"],
      "Stopping a queued run must safely skip every unstarted target."
    );

    await updateScmReconciliationRunTarget(queued.id, {
      kind: "PO",
      id: fixtures.active.id
    }, {
      status: "succeeded",
      result: { unexpected: true }
    });
    const postCancelUpdate = await getScmReconciliationRunDetails(queued.id);
    assert.equal(
      postCancelUpdate.targets.find((target) => Number(target.orderId) === fixtures.active.id)?.status,
      "skipped",
      "A worker update arriving after cancellation must not revive a stopped target."
    );
    const postCancelFinish = await finishScmReconciliationRun(queued.id, {
      status: "succeeded",
      summary: { unexpected: true }
    });
    assert.equal(
      postCancelFinish.status,
      "cancelled",
      "A worker completion arriving after cancellation must not overwrite the final run state."
    );
    assert.equal(
      (await cancelScmReconciliationRun(queued.id, actor)).stopped,
      false,
      "Stopping an already-final run must be idempotent."
    );

    const running = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "PO",
      includeTerminalOrders: false,
      dryRun: true,
      requestedBy: actor
    });
    await initializeScmReconciliationRunTargets(running.id, [
      { kind: "PO", id: fixtures.hold.id, tranid: fixtures.hold.ref },
      { kind: "PO", id: fixtures.skipped.id, tranid: fixtures.skipped.ref }
    ]);
    const initialWorker = await markScmReconciliationRunRunning(running.id);
    const initialWorkerLease = initialWorker.checkpoint.workerLeaseToken;
    assert.ok(initialWorkerLease, "A running reconciliation must own a worker lease.");
    await updateScmReconciliationRunTarget(running.id, {
      kind: "PO",
      id: fixtures.hold.id
    }, {
      status: "running",
      checkpoint: { phase: "source" },
      workerLeaseToken: initialWorkerLease
    });
    await updateScmReconciliationRunTarget(running.id, {
      kind: "PO",
      id: fixtures.skipped.id
    }, {
      status: "succeeded",
      result: { alreadyComplete: true },
      workerLeaseToken: initialWorkerLease
    });

    const runningStop = await cancelScmReconciliationRun(
      running.id,
      actor,
      "Harness stopped running reconciliation."
    );
    assert.equal(runningStop.stopped, false);
    assert.equal(runningStop.stopRequested, true);
    assert.equal(
      runningStop.run.status,
      "running",
      "A running reconciliation must retain the global running lock until its worker acknowledges Stop."
    );
    const requestedRunningDetails = await getScmReconciliationRunDetails(running.id);
    const requestedRunningTargets = new Map(
      requestedRunningDetails.targets.map((target) => [Number(target.orderId), target])
    );
    assert.equal(
      requestedRunningTargets.get(fixtures.hold.id)?.status,
      "running",
      "A Stop request must not falsely skip the in-flight target before the worker stops."
    );
    const acknowledgedStop = await finishScmReconciliationRun(running.id, {
      status: "cancelled",
      summary: { stopped: true },
      checkpoint: { phase: "reconcile", processed: 0 },
      expectedWorkerLeaseToken: initialWorkerLease
    });
    assert.equal(
      acknowledgedStop.status,
      "interrupted",
      "A running Stop must preserve durable progress in a resumable run."
    );
    assert.equal(acknowledgedStop.resumeAllowed, true);
    const interruptedRunningDetails = await getScmReconciliationRunDetails(running.id);
    const interruptedRunningTargets = new Map(
      interruptedRunningDetails.targets.map((target) => [Number(target.orderId), target])
    );
    assert.equal(
      interruptedRunningTargets.get(fixtures.hold.id)?.status,
      "running",
      "Stopping a running run must preserve its unfinished target for resume."
    );
    assert.equal(
      interruptedRunningTargets.get(fixtures.skipped.id)?.status,
      "succeeded",
      "Stopping a running run must preserve targets that were already final."
    );

    const resumed = await queueScmReconciliationRunResume(running.id, actor);
    assert.equal(resumed.id, running.id, "Resume must reuse the interrupted run ID.");
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.cancelRequestedAt, null, "Resume must clear the prior Stop request.");
    assert.equal(resumed.cancelRequestedBy, "");
    assert.equal(resumed.cancelRequestNote, "");
    assert.equal(resumed.resumeCount, 1);
    const queuedResumeDetails = await getScmReconciliationRunDetails(running.id);
    const queuedResumeTargets = new Map(
      queuedResumeDetails.targets.map((target) => [Number(target.orderId), target])
    );
    assert.equal(
      queuedResumeTargets.get(fixtures.hold.id)?.status,
      "pending",
      "Resume must return the unfinished target to the pending queue."
    );
    assert.equal(
      queuedResumeTargets.get(fixtures.skipped.id)?.status,
      "succeeded",
      "Resume must not repeat an already-terminal target."
    );

    const resumedWorker = await markScmReconciliationRunRunning(running.id);
    const resumedWorkerLease = resumedWorker.checkpoint.workerLeaseToken;
    assert.ok(resumedWorkerLease);
    assert.notEqual(
      resumedWorkerLease,
      initialWorkerLease,
      "A resumed worker must receive a fresh lease."
    );

    await updateScmReconciliationRunTarget(running.id, {
      kind: "PO",
      id: fixtures.hold.id
    }, {
      status: "failed",
      error: "A stale worker must not write this result.",
      workerLeaseToken: initialWorkerLease
    });
    assert.equal(
      (await getScmReconciliationRunDetails(running.id)).targets
        .find((target) => Number(target.orderId) === fixtures.hold.id)?.status,
      "pending",
      "The prior worker lease must not mutate a resumed target."
    );
    const staleFinish = await finishScmReconciliationRun(running.id, {
      status: "failed",
      summary: { staleWorker: true },
      error: "A stale worker must not finish the resumed run.",
      expectedWorkerLeaseToken: initialWorkerLease
    });
    assert.equal(
      staleFinish.status,
      "running",
      "The prior worker lease must not finish the resumed run."
    );
    assert.notEqual(staleFinish.summary?.staleWorker, true);

    await updateScmReconciliationRunTarget(running.id, {
      kind: "PO",
      id: fixtures.hold.id
    }, {
      status: "running",
      checkpoint: { phase: "resumed-source" },
      workerLeaseToken: resumedWorkerLease
    });
    await updateScmReconciliationRunTarget(running.id, {
      kind: "PO",
      id: fixtures.hold.id
    }, {
      status: "succeeded",
      result: { resumed: true },
      workerLeaseToken: resumedWorkerLease
    });
    assert.equal(
      (await getScmReconciliationRunDetails(running.id)).targets
        .find((target) => Number(target.orderId) === fixtures.hold.id)?.status,
      "succeeded",
      "The fresh worker lease must be able to finish the remaining target."
    );
    const resumedFinish = await finishScmReconciliationRun(running.id, {
      status: "succeeded",
      summary: { resumed: true },
      checkpoint: { phase: "complete", processed: 2 },
      expectedWorkerLeaseToken: resumedWorkerLease
    });
    assert.equal(
      resumedFinish.status,
      "succeeded",
      "The fresh worker lease must be able to finish the resumed run."
    );

    const stopAudit = await query(
      `SELECT run_id, event_type, action, actor
         FROM scm_reconciliation_audit_events
        WHERE run_id IN ($1, $2)
          AND event_type IN (
            'run.stopped',
            'run.stop_requested',
            'run.interrupted',
            'run.resume_requested'
          )
        ORDER BY run_id, event_type`,
      [queued.id, running.id]
    );
    const auditTypesByRun = new Map([
      [queued.id, []],
      [running.id, []]
    ]);
    for (const row of stopAudit.rows) {
      auditTypesByRun.get(Number(row.run_id))?.push(row.event_type);
    }
    assert.deepEqual(auditTypesByRun.get(queued.id), ["run.stopped"]);
    assert.deepEqual(
      auditTypesByRun.get(running.id),
      ["run.interrupted", "run.resume_requested", "run.stop_requested"],
      "A running Stop and resume must retain each lifecycle audit event."
    );
    assert.ok(stopAudit.rows.every((row) => row.actor === actor));
    assert.equal(
      stopAudit.rows.find((row) => row.event_type === "run.stopped")?.action,
      "stop"
    );
    assert.equal(
      stopAudit.rows.find((row) => row.event_type === "run.stop_requested")?.action,
      "stop_request"
    );
    assert.equal(
      stopAudit.rows.find((row) => row.event_type === "run.interrupted")?.action,
      "stop"
    );
    assert.equal(
      stopAudit.rows.find((row) => row.event_type === "run.resume_requested")?.action,
      "resume"
    );
  });

  console.log("SCM reconciliation scope controls harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
