import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query, withTransaction } from "./db.js";
import {
  approveInitialScmReconciliationRun,
  assertScmReconciliationRunReadyToApply,
  assertScmReconciliationOrderEditable,
  cancelMissingScmPurchaseOrderLocally,
  createScmReconciliationRun,
  enrichScmScheduleWithReconciliation,
  finishScmReconciliationRun,
  getScmReconciliationPreference,
  getScmReconciliationRunDetails,
  getScmReconciliationRunDecisionSummary,
  getScmReconciliationSettings,
  initializeScmReconciliationRunTargets,
  listLocalScmReconciliationSources,
  listScmReconciliationRuns,
  loadLocalScmReconciliationOrder,
  markScmReconciliationRunRunning,
  recordScmReconciliationMissingLookup,
  reconcileScmOrderFamily,
  resolveScmReconciliationReview,
  scmScheduleEffectiveReconciliationStatus,
  scmReconciliationProposedOutcome,
  scmReconciliationReviewFingerprint,
  clearScmReconciliationMissingLookup,
  storeLinkedScmReconciliationTransactions,
  storeScmIfIrWebhook,
  updateScmReconciliationPreference,
  updateScmReconciliationRunTarget,
  updateScmReconciliationRunTargetDecision,
  updateScmReconciliationSettings
} from "./scm-reconciliation-repository.js";
import { applyScmReconciliationRun } from "./scm-reconciliation-service.js";
import { listScmSchedule } from "./dispatch-repository.js";

const olderReconciliationAt = "2026-08-01T17:21:00.000Z";
const newerScheduleAt = "2026-08-01T17:50:00.000Z";
const newerReconciliationAt = "2026-08-01T18:05:00.000Z";

assert.equal(scmScheduleEffectiveReconciliationStatus({
  scheduleStatus: "Hold",
  scheduleId: 101,
  scheduleUpdatedAt: newerScheduleAt,
  reconciliationStatus: "current",
  reconciliationReconciledAt: olderReconciliationAt,
  reconciliationApplicationStatus: "Queued"
}), "Hold", "A newer persisted Hold must win over an older Queued reconciliation snapshot.");

assert.equal(scmScheduleEffectiveReconciliationStatus({
  scheduleStatus: "Queued",
  scheduleId: 102,
  scheduleUpdatedAt: newerScheduleAt,
  reconciliationStatus: "current",
  reconciliationReconciledAt: olderReconciliationAt,
  reconciliationApplicationStatus: "Hold"
}), "Queued", "A newer persisted un-Hold must win over an older Hold reconciliation snapshot.");

assert.equal(scmScheduleEffectiveReconciliationStatus({
  scheduleStatus: "Hold",
  scheduleId: 103,
  scheduleUpdatedAt: newerScheduleAt,
  reconciliationStatus: "current",
  reconciliationReconciledAt: newerReconciliationAt,
  reconciliationApplicationStatus: "Queued"
}), "Queued", "A newer reconciliation snapshot must supersede an older persisted schedule status.");

assert.equal(scmScheduleEffectiveReconciliationStatus({
  scheduleStatus: "Hold",
  scheduleId: 104,
  scheduleUpdatedAt: newerScheduleAt,
  reconciliationStatus: "pending",
  reconciliationReconciledAt: newerReconciliationAt,
  reconciliationApplicationStatus: "Queued"
}), "Hold", "Pending reconciliation must retain the persisted schedule status.");

assert.equal(scmScheduleEffectiveReconciliationStatus({
  scheduleStatus: "Hold",
  scheduleId: 105,
  scheduleUpdatedAt: newerScheduleAt,
  reconciliationStatus: "pending",
  reconciliationReconciledAt: olderReconciliationAt,
  reconciliationApplicationStatus: "Queued",
  blockingReview: true
}), "Reconcile Review", "A blocking review must take precedence over pending and schedule statuses.");

const rollback = await beginRollbackContext();
const seed = Number(String(Date.now()).slice(-8));
const operatorId = `reconcile-harness-${seed}`;
const poId = 9800000000 + seed;
const poRef = `PO-RECON-${seed}`;
const poLineKey = 7100000000 + seed;
const irId = 7200000000 + seed;
const irLineKey = String(7300000000 + seed);
const toId = 9400000000 + seed;
const toRef = `TO-RECON-${seed}`;
const toLineKey = 7500000000 + seed;
const ifId = 7600000000 + seed;
const inheritedSplitToId = 8900000000 + seed;
const inheritedSplitToRef = `TO-INHERITED-SPLIT-${seed}`;
const inheritedSplitToLineKey = 7550000000 + seed;
const inheritedSplitChildIds = [-(8900000000 + seed), -(8910000000 + seed)];
const inheritedSplitChildRefs = [
  `${inheritedSplitToRef}-S3`,
  `${inheritedSplitToRef}-S4`
];
const incompleteSplitToId = 8800000000 + seed;
const incompleteSplitToRef = `TO-INCOMPLETE-SPLIT-${seed}`;
const incompleteSplitToLineKey = 7560000000 + seed;
const incompleteSplitChildId = -(8800000000 + seed);
const incompleteSplitChildRef = `${incompleteSplitToRef}-S1`;
const authoritativeToId = 9100000000 + seed;
const authoritativeToRef = `TO-AUTH-PROGRESS-${seed}`;
const authoritativeToLineKey = 8100000000 + seed;
const authoritativeIfId = 8200000000 + seed;
const authoritativeIrId = 8300000000 + seed;
const orphanPoId = 9300000000 + seed;
const orphanPoRef = `PO-ORPHAN-${seed}`;
const orphanPoLineKey = 7800000000 + seed;
const orphanSplitPoId = -orphanPoId;
const orphanSplitPoRef = `${orphanPoRef}-S1`;
const plannedPoId = 9200000000 + seed;
const plannedPoRef = `PO-PLANNED-${seed}`;
const plannedPoLineKey = 7400000000 + seed;
const plannedGroupRef = `PGOB-${seed}`;
const missingCancelPoId = 9700000000 + seed;
const missingCancelPoRef = `PO-MISSING-CANCEL-${seed}`;
const missingCancelPoLineKey = 7900000000 + seed;
const missingActivityPoId = 9600000000 + seed;
const missingActivityPoRef = `PO-MISSING-ACTIVITY-${seed}`;
const missingActivityPoLineKey = 7950000000 + seed;
const fixedModifiedAt = "2026-07-29T21:00:00.000Z";

function linkedTransaction({
  sourceOrderId,
  sourceOrderRef,
  transactionType,
  transactionId,
  transactionRef,
  transactionLineKey,
  sourceLineKey,
  itemId,
  itemName,
  quantity,
  locationId
}) {
  return {
    sourceOrderId,
    sourceOrderRef,
    transactionType,
    transactionId,
    transactionRef,
    status: "B",
    statusText: "Posted",
    transactionDate: "2026-07-29",
    lastModifiedAt: fixedModifiedAt,
    transactionLine: Number(transactionLineKey),
    transactionLineKey: String(transactionLineKey),
    sourceOrderLine: Number(sourceLineKey),
    sourceLineKey: String(sourceLineKey),
    itemId,
    itemName,
    quantity,
    unit: "EA",
    locationId,
    location: `Location ${locationId}`
  };
}

try {
  await rollback.run(async () => {
    const schema = await query(
      `SELECT
         to_regclass('public.scm_reconciliation_settings') AS settings,
         to_regclass('public.scm_reconciliation_runs') AS runs,
         to_regclass('public.scm_reconciliation_audit_events') AS audit,
         to_regclass('public.scm_reconciliation_transaction_snapshots') AS snapshots,
         to_regclass('public.scm_reconciliation_order_state') AS order_state,
         to_regclass('public.dispatch_scm_to_splits') AS to_splits`
    );
    assert.ok(Object.values(schema.rows[0]).every(Boolean), "Migration 074 reconciliation tables must exist.");

    const migration = await query(
      `SELECT 1
         FROM schema_migrations
        WHERE filename = '074_po_to_reconciliation.sql'`
    );
    assert.equal(migration.rowCount, 1, "Migration 074 must be recorded as applied.");
    const decisionMigration = await query(
      `SELECT 1
         FROM schema_migrations
        WHERE filename = '075_scm_reconciliation_review_decisions.sql'`
    );
    assert.equal(decisionMigration.rowCount, 1, "Migration 075 review decisions must be applied.");
    const cancelMissingMigration = await query(
      `SELECT 1
         FROM schema_migrations
        WHERE filename = '076_scm_reconciliation_cancel_missing.sql'`
    );
    assert.equal(
      cancelMissingMigration.rowCount,
      1,
      "Migration 076 controlled source-missing cancellation must be applied."
    );

    const trigger = await query(
      `SELECT trigger.tgenabled
         FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid = trigger.tgrelid
        WHERE relation.relname = 'scm_reconciliation_audit_events'
          AND trigger.tgname = 'trg_scm_reconciliation_audit_events_immutable'
          AND NOT trigger.tgisinternal`
    );
    assert.equal(trigger.rows[0]?.tgenabled, "O", "The reconciliation audit mutation guard must be enabled.");

    const scheduleColumns = await query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'scm_transport_schedule'
          AND column_name IN (
            'reconciliation_order_state_id',
            'reconciliation_blocked',
            'last_reconciled_at'
          )`
    );
    assert.equal(scheduleColumns.rowCount, 3, "Schedule reconciliation columns must be installed.");

    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt,
         role, roles, active
       ) VALUES (
         $1, $1, 'Reconciliation Harness', 'hash', 'salt',
         'admin', ARRAY['admin']::text[], true
       )`,
      [operatorId]
    );
    assert.deepEqual(await getScmReconciliationPreference(operatorId), { showDetails: false });
    assert.deepEqual(await updateScmReconciliationPreference(operatorId, true), { showDetails: true });
    assert.deepEqual(await getScmReconciliationPreference(operatorId), { showDetails: true });

    const initialSettings = await getScmReconciliationSettings();
    assert.equal(initialSettings.nightlyTime, "21:30");
    assert.equal(initialSettings.timeZone, "America/Toronto");
    const updatedSettings = await updateScmReconciliationSettings({
      nightlyEnabled: true,
      nightlyTime: "22:15",
      timeZone: "America/Toronto",
      initialBackfillModifiedSince: "2026-01-01"
    }, operatorId);
    assert.equal(updatedSettings.nightlyEnabled, true);
    assert.equal(updatedSettings.nightlyTime, "22:15");

    const run = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "all",
      dryRun: true,
      requestedBy: operatorId
    });
    await initializeScmReconciliationRunTargets(run.id, [
      { kind: "PO", id: poId, tranid: poRef },
      { kind: "TO", id: toId, tranid: toRef }
    ]);
    await updateScmReconciliationRunTarget(run.id, {
      kind: "PO",
      id: poId
    }, {
      status: "running",
      checkpoint: { phase: "source" }
    });
    await updateScmReconciliationRunTarget(run.id, {
      kind: "PO",
      id: poId
    }, {
      status: "succeeded",
      result: { status: "partial" }
    });
    const runDetails = await getScmReconciliationRunDetails(run.id, {
      limit: 1,
      offset: 0
    });
    assert.equal(runDetails.run.id, run.id);
    assert.equal(runDetails.targetCount, 2);
    assert.equal(runDetails.targets.length, 1);
    assert.equal(runDetails.hasMore, true);
    const runDetailsSecondPage = await getScmReconciliationRunDetails(run.id, {
      limit: 1,
      offset: 1
    });
    assert.equal(runDetailsSecondPage.targets.length, 1);
    assert.notEqual(runDetailsSecondPage.targets[0].id, runDetails.targets[0].id);
    const runningRun = await markScmReconciliationRunRunning(run.id);
    const awaiting = await finishScmReconciliationRun(run.id, {
      status: "awaiting_approval",
      summary: { processed: 2 },
      checkpoint: { processed: 2 },
      apiRequestCount: 3,
      expectedWorkerLeaseToken: runningRun.checkpoint.workerLeaseToken
    });
    assert.equal(awaiting.status, "awaiting_approval");
    const initialLiveApply = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "all",
      dryRun: false,
      applyUnambiguous: true,
      requestedBy: operatorId
    });
    await query(
      `UPDATE scm_reconciliation_runs
          SET resume_of_run_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [initialLiveApply.id, run.id]
    );
    const initialLiveApplyWorker = await markScmReconciliationRunRunning(
      initialLiveApply.id
    );
    const completedInitialLiveApply = await finishScmReconciliationRun(
      initialLiveApply.id,
      {
        status: "succeeded",
        summary: { processed: 2 },
        checkpoint: { processed: 2 },
        expectedWorkerLeaseToken:
          initialLiveApplyWorker.checkpoint.workerLeaseToken
      }
    );
    assert.equal(completedInitialLiveApply.status, "succeeded");
    const approved = await approveInitialScmReconciliationRun(run.id, operatorId);
    assert.equal(approved.status, "succeeded");
    assert.equal(
      approved.approvedBy,
      operatorId,
      "Completing a linked initial live Apply must durably approve its proposal even when a scheduler owns the worker."
    );
    assert.equal((await getScmReconciliationSettings()).initialDryRunApproved, true);

    const interruptedRun = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "TO",
      dryRun: true,
      requestedBy: operatorId
    });
    const interruptedWorker = await markScmReconciliationRunRunning(interruptedRun.id);
    await query(
      `UPDATE scm_reconciliation_runs
          SET status = 'interrupted',
              summary = '{"recovered":true}'::jsonb,
              checkpoint = '{"processed":101}'::jsonb,
              error = 'Recovered by stale-run watchdog.',
              api_request_count = 17,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [interruptedRun.id]
    );
    const lateFinish = await finishScmReconciliationRun(interruptedRun.id, {
      status: "succeeded",
      summary: { recovered: false, processed: 564 },
      checkpoint: { processed: 564 },
      error: "",
      apiRequestCount: 99,
      expectedWorkerLeaseToken: interruptedWorker.checkpoint.workerLeaseToken
    });
    assert.equal(
      lateFinish.status,
      "interrupted",
      "A late worker must not overwrite an interrupted reconciliation run."
    );
    assert.deepEqual(lateFinish.summary, { recovered: true });
    assert.deepEqual(lateFinish.checkpoint, { processed: 101 });
    assert.equal(lateFinish.error, "Recovered by stale-run watchdog.");
    assert.equal(lateFinish.apiRequestCount, 17);

    const decisionRun = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "TO",
      dryRun: true,
      requestedBy: operatorId
    });
    await initializeScmReconciliationRunTargets(decisionRun.id, [{
      kind: "TO",
      id: authoritativeToId,
      tranid: authoritativeToRef
    }]);
    const decisionProposal = {
      orderKind: "TO",
      sourceOrderId: authoritativeToId,
      sourceOrderRef: authoritativeToRef,
      applicationStatus: "Reconcile Review",
      reconciliationStatus: "review",
      reason: "A planned source line changed.",
      quantities: {
        ordered: 10,
        fulfilled: 10,
        received: 10,
        abandoned: 0,
        remaining: 0,
        destinationRemaining: 0
      },
      lines: [{
        lineKey: String(authoritativeToLineKey),
        itemId: 820002,
        itemName: "Decision Harness Item",
        unit: "EA",
        ordered: 10,
        fulfilled: 10,
        received: 10,
        remaining: 0,
        identityStatus: "exact",
        allocationQuality: "exact"
      }]
    };
    await updateScmReconciliationRunTarget(decisionRun.id, {
      kind: "TO",
      id: authoritativeToId
    }, {
      status: "review",
      proposedChange: decisionProposal,
      result: decisionProposal
    });
    const decisionWorker = await markScmReconciliationRunRunning(decisionRun.id);
    await finishScmReconciliationRun(decisionRun.id, {
      status: "succeeded",
      summary: { reviewOrders: 1 },
      expectedWorkerLeaseToken: decisionWorker.checkpoint.workerLeaseToken
    });
    assert.equal(
      scmReconciliationProposedOutcome(decisionProposal),
      "Completed"
    );
    const decisionFingerprint = scmReconciliationReviewFingerprint(decisionProposal);
    assert.equal(decisionFingerprint.length, 64);
    assert.notEqual(
      scmReconciliationReviewFingerprint({
        ...decisionProposal,
        targets: {
          [authoritativeToRef]: {
            orderRef: authoritativeToRef,
            ordered: 10,
            fulfilled: 10,
            received: 10,
            hasActivePlan: true,
            allocationMethods: ["exact"]
          }
        }
      }),
      scmReconciliationReviewFingerprint({
        ...decisionProposal,
        targets: {
          [authoritativeToRef]: {
            orderRef: authoritativeToRef,
            ordered: 10,
            fulfilled: 10,
            received: 10,
            hasActivePlan: false,
            allocationMethods: ["exact"]
          }
        }
      }),
      "A changed operational target must invalidate a saved review decision."
    );
    const evidenceProposal = {
      ...decisionProposal,
      evidenceVersion: 2,
      evidence: {
        statusCode: "G",
        statusText: "Transfer Order : Received",
        lifecycle: "closed",
        sourceLocationId: 15,
        destinationLocationId: 1,
        dispatchPlanned: true
      }
    };
    assert.notEqual(
      scmReconciliationReviewFingerprint(evidenceProposal),
      scmReconciliationReviewFingerprint({
        ...evidenceProposal,
        evidence: {
          ...evidenceProposal.evidence,
          destinationLocationId: 2
        }
      }),
      "A changed NetSuite location must invalidate a version-2 review decision."
    );
    await assert.rejects(
      assertScmReconciliationRunReadyToApply(decisionRun.id),
      /choose an action for every reviewed order/i
    );
    const undecidedDetails = await getScmReconciliationRunDetails(decisionRun.id);
    const undecidedTarget = undecidedDetails.targets[0];
    const decided = await updateScmReconciliationRunTargetDecision({
      runId: decisionRun.id,
      targetId: undecidedTarget.id,
      decision: "accept_current",
      note: "Harness verified the complete NetSuite result.",
      actor: operatorId,
      expectedUpdatedAt: undecidedTarget.updatedAt
    });
    assert.equal(decided.target.reviewDecision, "accept_current");
    assert.equal(decided.target.reviewDecisionFingerprint.length, 64);
    assert.deepEqual(decided.decisionSummary, {
      reviewTargets: 1,
      decidedTargets: 1,
      pendingTargets: 0,
      skippedTargets: 0,
      acceptedTargets: 1,
      keptReviewTargets: 0
    });
    assert.equal(
      (await getScmReconciliationRunDecisionSummary(decisionRun.id)).pendingTargets,
      0
    );
    await assertScmReconciliationRunReadyToApply(decisionRun.id);
    await assert.rejects(
      updateScmReconciliationRunTargetDecision({
        runId: decisionRun.id,
        targetId: undecidedTarget.id,
        decision: "skip",
        note: "This stale edit must fail.",
        actor: operatorId,
        expectedUpdatedAt: undecidedTarget.updatedAt
      }),
      /changed after it was opened/i
    );
    const decisionAudit = await query(
      `SELECT action, payload
         FROM scm_reconciliation_audit_events
        WHERE run_id = $1
          AND event_type = 'dry_run.review_decision'`,
      [decisionRun.id]
    );
    assert.equal(decisionAudit.rowCount, 1);
    assert.equal(decisionAudit.rows[0].action, "accept_current");

    const scopedProposal = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "TO",
      dryRun: true,
      requestedBy: operatorId
    });
    const scopedProposalWorker = await markScmReconciliationRunRunning(scopedProposal.id);
    await finishScmReconciliationRun(scopedProposal.id, {
      status: "succeeded",
      summary: { reviewOrders: 2 },
      expectedWorkerLeaseToken: scopedProposalWorker.checkpoint.workerLeaseToken
    });
    const scopedLive = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "TO",
      dryRun: false,
      applyUnambiguous: true,
      requestedBy: operatorId
    });
    await query(
      `UPDATE scm_reconciliation_runs
          SET resume_of_run_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [scopedLive.id, scopedProposal.id]
    );
    const scopedLiveWorker = await markScmReconciliationRunRunning(scopedLive.id);
    await finishScmReconciliationRun(scopedLive.id, {
      status: "succeeded",
      summary: { reviewOrders: 2 },
      expectedWorkerLeaseToken: scopedLiveWorker.checkpoint.workerLeaseToken
    });
    const scopedApply = await applyScmReconciliationRun(
      scopedProposal.id,
      operatorId
    );
    assert.equal(scopedApply.applied, true);
    assert.equal(scopedApply.approved, false);
    assert.equal(scopedApply.applyRun.id, scopedLive.id);
    assert.equal(scopedApply.applyRun.scope, "TO");
    const mappedScopedLive = (await listScmReconciliationRuns({ limit: 20 }))
      .find((candidate) => candidate.id === scopedLive.id);
    assert.equal(mappedScopedLive.resumeOfRunId, scopedProposal.id);

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, status, status_text,
         vendor_id, vendor, destination_location_id, destination_location,
         receipt_status, initial_scm_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2026-07-29', 'B', 'Pending Receipt',
         5001, 'Harness Vendor', 1, 'Destination Yard',
         'not_received', 'Hold', true, now()
       )`,
      [poId, poRef]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, quantity,
         netsuite_received_qty, unit, location_id, location, netsuite_active,
         raw
       ) VALUES (
         $1, $2, 810001, 'Harness PO Item', 'HARNESS-PO', 10,
         0, 'EA', 1, 'Destination Yard', true,
         $3::jsonb
       )`,
      [
        poId,
        poLineKey,
        JSON.stringify({
          sourceLineAliases: [String(poLineKey)],
          orderLine: String(poLineKey),
          orderLineAliases: [String(poLineKey)],
          identityStatus: "exact"
        })
      ]
    );

    const poOrder = {
      kind: "PO",
      id: poId,
      tranid: poRef,
      destinationLocationId: 1,
      destinationLocation: "Destination Yard"
    };
    const initialPo = await loadLocalScmReconciliationOrder("PO", poId);
    assert.equal(initialPo.localStatus, "Hold",
      "A newly discovered NetSuite PO must expose its initial Hold status to reconciliation.");
    const initialPoReconciliation = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: poId,
      source: "manual",
      dryRun: true
    });
    assert.equal(initialPoReconciliation.applicationStatus, "Hold",
      "The first reconciliation pass must preserve a new PO's Hold status.");
    assert.equal(initialPoReconciliation.targets[poRef]?.applicationStatus, "Hold",
      "The source PO target must also preserve Hold before any receiving progress.");
    const firstReceipt = linkedTransaction({
      sourceOrderId: poId,
      sourceOrderRef: poRef,
      transactionType: "ItemRcpt",
      transactionId: irId,
      transactionRef: `IR-${seed}`,
      transactionLineKey: irLineKey,
      sourceLineKey: poLineKey,
      itemId: 810001,
      itemName: "Harness PO Item",
      quantity: 4,
      locationId: 1
    });
    await storeLinkedScmReconciliationTransactions({
      order: poOrder,
      transactions: [firstReceipt],
      source: "manual"
    });
    await storeLinkedScmReconciliationTransactions({
      order: poOrder,
      transactions: [firstReceipt],
      source: "manual"
    });
    let auditRows = await query(
      `SELECT id, event_key, payload_hash
         FROM scm_reconciliation_audit_events
        WHERE source = 'manual'
          AND record_type = 'IR'
          AND netsuite_transaction_id = $1
        ORDER BY id`,
      [irId]
    );
    assert.equal(auditRows.rowCount, 1, "An identical same-timestamp snapshot must remain idempotent.");

    const correctedReceipt = { ...firstReceipt, quantity: 6 };
    await storeLinkedScmReconciliationTransactions({
      order: poOrder,
      transactions: [correctedReceipt],
      source: "manual"
    });
    auditRows = await query(
      `SELECT id, event_key, payload_hash
         FROM scm_reconciliation_audit_events
        WHERE source = 'manual'
          AND record_type = 'IR'
          AND netsuite_transaction_id = $1
        ORDER BY id`,
      [irId]
    );
    assert.equal(auditRows.rowCount, 2, "A corrected same-timestamp payload must append immutable audit evidence.");
    assert.notEqual(auditRows.rows[0].payload_hash, auditRows.rows[1].payload_hash);
    assert.notEqual(auditRows.rows[0].event_key, auditRows.rows[1].event_key);

    const currentReceipt = await query(
      `SELECT snapshot.latest_event_id, line.quantity
         FROM scm_reconciliation_transaction_snapshots snapshot
         JOIN scm_reconciliation_transaction_snapshot_lines line
           ON line.transaction_snapshot_id = snapshot.id
        WHERE snapshot.transaction_type = 'IR'
          AND snapshot.netsuite_transaction_id = $1`,
      [irId]
    );
    assert.equal(Number(currentReceipt.rows[0].quantity), 6);
    assert.equal(
      Number(currentReceipt.rows[0].latest_event_id),
      Number(auditRows.rows[1].id),
      "Current snapshot must point to the corrected immutable event."
    );

    const poResult = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: poId,
      source: "manual"
    });
    assert.equal(poResult.applicationStatus, "Partially Done");
    assert.equal(poResult.quantities.ordered, 10);
    assert.equal(poResult.quantities.received, 6);

    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         fulfillment_status, receiving_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2026-07-29', 'B', 'Pending Fulfillment',
         15, 'Source Yard', 1, 'Destination Yard',
         'not_fulfilled', 'not_received', true, now()
       )`,
      [toId, toRef]
    );
    const toRaw = JSON.stringify({
      sourceLineAliases: [String(toLineKey)],
      orderLine: String(toLineKey),
      orderLineAliases: [String(toLineKey)],
      identityStatus: "exact"
    });
    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location, loaded_qty,
         netsuite_received_qty, netsuite_active, raw
       ) VALUES
         ('outbound', $1, $2, 820001, 'Harness TO Item', 'HARNESS-TO',
          10, 'EA', 15, 'Source Yard', 0, 0, true, $3::jsonb),
         ('receiving', $1, $2, 820001, 'Harness TO Item', 'HARNESS-TO',
          10, 'EA', 1, 'Destination Yard', 0, 0, true, $3::jsonb)`,
      [toId, toLineKey, toRaw]
    );
    const fulfillment = linkedTransaction({
      sourceOrderId: toId,
      sourceOrderRef: toRef,
      transactionType: "ItemShip",
      transactionId: ifId,
      transactionRef: `IF-${seed}`,
      transactionLineKey: 7700000000 + seed,
      sourceLineKey: toLineKey,
      itemId: 820001,
      itemName: "Harness TO Item",
      quantity: 10,
      locationId: 15
    });
    await storeLinkedScmReconciliationTransactions({
      order: {
        kind: "TO",
        id: toId,
        tranid: toRef,
        sourceLocationId: 15,
        sourceLocation: "Source Yard",
        destinationLocationId: 1,
        destinationLocation: "Destination Yard"
      },
      transactions: [fulfillment],
      source: "manual"
    });
    const toResult = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: toId,
      source: "manual"
    });
    assert.equal(toResult.applicationStatus, "In Transit");
    assert.equal(toResult.quantities.ordered, 10);
    assert.equal(toResult.quantities.fulfilled, 10);
    assert.equal(toResult.quantities.received, 0);

    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         fulfillment_status, receiving_status, netsuite_active, synced_at
       ) VALUES
         ($1, $2, DATE '2026-07-29', 'G', 'Transfer Order : Received',
          15, 'Source Yard', 1, 'Destination Yard',
          'not_fulfilled', 'not_received', true, now()),
         ($3, $4, DATE '2026-07-29', 'G', 'Transfer Order : Received',
          15, 'Source Yard', 1, 'Destination Yard',
          'not_fulfilled', 'not_received', true, now()),
         ($5, $6, DATE '2026-07-29', 'G', 'Transfer Order : Received',
          15, 'Source Yard', 1, 'Destination Yard',
          'not_fulfilled', 'not_received', true, now()),
         ($7, $8, DATE '2026-07-29', 'D', 'Transfer Order : Pending Receipt',
          15, 'Source Yard', 1, 'Destination Yard',
          'not_fulfilled', 'not_received', true, now()),
         ($9, $10, DATE '2026-07-29', 'D', 'Transfer Order : Pending Receipt',
          15, 'Source Yard', 1, 'Destination Yard',
          'not_fulfilled', 'not_received', true, now())`,
      [
        inheritedSplitToId,
        inheritedSplitToRef,
        inheritedSplitChildIds[0],
        inheritedSplitChildRefs[0],
        inheritedSplitChildIds[1],
        inheritedSplitChildRefs[1],
        incompleteSplitToId,
        incompleteSplitToRef,
        incompleteSplitChildId,
        incompleteSplitChildRef
      ]
    );
    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location, loaded_qty,
         netsuite_received_qty, netsuite_active
       ) VALUES
         ('outbound', $1, $2, 822001, 'Inherited split item', 'INHERITED-SPLIT',
          10, 'EA', 15, 'Source Yard', 10, 0, true),
         ('receiving', $1, $2, 822001, 'Inherited split item', 'INHERITED-SPLIT',
          10, 'EA', 1, 'Destination Yard', 0, 10, true),
         ('outbound', $3, $4, 822002, 'Incomplete split item', 'INCOMPLETE-SPLIT',
          10, 'EA', 15, 'Source Yard', 10, 0, true),
         ('receiving', $3, $4, 822002, 'Incomplete split item', 'INCOMPLETE-SPLIT',
          10, 'EA', 1, 'Destination Yard', 0, 0, true)`,
      [
        inheritedSplitToId,
        inheritedSplitToLineKey,
        incompleteSplitToId,
        incompleteSplitToLineKey
      ]
    );
    await query(
      `INSERT INTO dispatch_scm_to_splits (
         source_to_id, source_to_ref, split_to_id, split_to_ref,
         status, created_by
       ) VALUES
         ($1, $2, $3, $4, 'active', $9),
         ($1, $2, $5, $6, 'active', $9),
         ($7, $8, $10, $11, 'active', $9)`,
      [
        inheritedSplitToId,
        inheritedSplitToRef,
        inheritedSplitChildIds[0],
        inheritedSplitChildRefs[0],
        inheritedSplitChildIds[1],
        inheritedSplitChildRefs[1],
        incompleteSplitToId,
        incompleteSplitToRef,
        operatorId,
        incompleteSplitChildId,
        incompleteSplitChildRef
      ]
    );

    const inheritedSplitResult = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: inheritedSplitToId,
      source: "manual"
    });
    assert.equal(inheritedSplitResult.applicationStatus, "Completed");
    assert.equal(inheritedSplitResult.reconciliationStatus, "ok");
    assert.equal(inheritedSplitResult.reason, "");
    assert.equal(inheritedSplitResult.targets[inheritedSplitToRef].applicationStatus, "Completed");
    for (const splitRef of inheritedSplitChildRefs) {
      const target = inheritedSplitResult.targets[splitRef];
      assert(target, `${splitRef} must remain a visible reconciliation target.`);
      assert.equal(target.applicationStatus, "Completed");
      assert.equal(target.reconciliationStatus, "ok");
      assert.equal(target.inheritedFamilyCompletion, true);
      assert.equal(target.missingSplitLineLedger, true);
      assert.equal(target.hidden, false);
      assert.deepEqual(target.splitIntegrity, {
        ledgerLineCount: 0,
        activeMappedLineCount: 0,
        activeChildLineCount: 0
      });
    }
    let inheritedSchedules = await query(
      `SELECT order_ref, status
         FROM scm_transport_schedule
        WHERE order_kind = 'TO'
          AND order_ref = ANY($1::text[])
        ORDER BY order_ref`,
      [[inheritedSplitToRef, ...inheritedSplitChildRefs]]
    );
    assert.equal(inheritedSchedules.rowCount, 3);
    assert.ok(
      inheritedSchedules.rows.every((row) => row.status === "Completed"),
      "A fully received source TO must complete every active header-only split."
    );
    await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: inheritedSplitToId,
      source: "manual"
    });
    inheritedSchedules = await query(
      `SELECT order_ref, status
         FROM scm_transport_schedule
        WHERE order_kind = 'TO'
          AND order_ref = ANY($1::text[])`,
      [[inheritedSplitToRef, ...inheritedSplitChildRefs]]
    );
    assert.equal(inheritedSchedules.rowCount, 3, "Inherited split completion must be idempotent.");

    const incompleteSplitResult = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: incompleteSplitToId,
      source: "manual"
    });
    assert.equal(incompleteSplitResult.calculatedApplicationStatus, "In Transit");
    assert.equal(incompleteSplitResult.applicationStatus, "Reconcile Review");
    assert.equal(incompleteSplitResult.reconciliationStatus, "review");
    assert.match(incompleteSplitResult.reason, /active TO split.*incomplete line ledger/i);
    assert.equal(
      incompleteSplitResult.targets[incompleteSplitChildRef].applicationStatus,
      "Reconcile Review",
      "A header-only split must not inherit completion before destination receipt is complete."
    );
    assert.equal(incompleteSplitResult.targets[incompleteSplitChildRef].hidden, false);
    const incompleteSchedules = await query(
      `SELECT order_ref, status
         FROM scm_transport_schedule
        WHERE order_kind = 'TO'
          AND order_ref = ANY($1::text[])
        ORDER BY order_ref`,
      [[incompleteSplitToRef, incompleteSplitChildRef]]
    );
    assert.equal(incompleteSchedules.rowCount, 2);
    assert.ok(incompleteSchedules.rows.every((row) => row.status === "Reconcile Review"));

    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         fulfillment_status, receiving_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2026-07-29', 'G', 'Transfer Order : Received',
         15, 'Source Yard', 1, 'Destination Yard',
         'not_fulfilled', 'not_received', true, now()
       )`,
      [authoritativeToId, authoritativeToRef]
    );
    const authoritativeOrder = {
      kind: "TO",
      id: authoritativeToId,
      tranid: authoritativeToRef,
      status: "G",
      statusText: "Transfer Order : Received",
      sourceLocationId: 15,
      sourceLocation: "Source Yard",
      destinationLocationId: 1,
      destinationLocation: "Destination Yard",
      lines: [
        {
          stage: "outbound",
          sourceLineKey: String(authoritativeToLineKey),
          sourceLineAliases: [
            String(authoritativeToLineKey),
            String(authoritativeToLineKey + 1)
          ],
          orderLine: 1,
          orderLineAliases: ["1", "2"],
          logicalLineIdentity: `transfer-anchor:${authoritativeToLineKey}`,
          identityStatus: "exact",
          itemId: 821001,
          itemName: "Authoritative Item A",
          sku: "AUTH-A",
          quantity: 63,
          cumulativeProgressQuantity: 63,
          unit: "PC",
          locationId: 15,
          location: "Source Yard"
        },
        {
          stage: "receiving",
          sourceLineKey: String(authoritativeToLineKey + 2),
          sourceLineAliases: [String(authoritativeToLineKey + 2)],
          orderLine: 3,
          orderLineAliases: ["3"],
          logicalLineIdentity: `transfer-anchor:${authoritativeToLineKey}`,
          identityStatus: "exact",
          itemId: 821001,
          itemName: "Authoritative Item A",
          sku: "AUTH-A",
          quantity: 63,
          cumulativeProgressQuantity: 63,
          unit: "PC",
          locationId: 1,
          location: "Destination Yard"
        },
        {
          stage: "outbound",
          sourceLineKey: String(authoritativeToLineKey + 3),
          sourceLineAliases: [
            String(authoritativeToLineKey + 3),
            String(authoritativeToLineKey + 4)
          ],
          orderLine: 4,
          orderLineAliases: ["4", "5"],
          logicalLineIdentity: `transfer-anchor:${authoritativeToLineKey + 3}`,
          identityStatus: "exact",
          itemId: 821002,
          itemName: "PALLET",
          sku: "PALLET",
          quantity: 16,
          cumulativeProgressQuantity: 16,
          unit: "EACH",
          locationId: 15,
          location: "Source Yard"
        },
        {
          stage: "receiving",
          sourceLineKey: String(authoritativeToLineKey + 5),
          sourceLineAliases: [String(authoritativeToLineKey + 5)],
          orderLine: 6,
          orderLineAliases: ["6"],
          logicalLineIdentity: `transfer-anchor:${authoritativeToLineKey + 3}`,
          identityStatus: "exact",
          itemId: 821002,
          itemName: "PALLET",
          sku: "PALLET",
          quantity: 16,
          cumulativeProgressQuantity: 16,
          unit: "EACH",
          locationId: 1,
          location: "Destination Yard"
        },
        {
          stage: "outbound",
          sourceLineKey: String(authoritativeToLineKey + 6),
          sourceLineAliases: [
            String(authoritativeToLineKey + 6),
            String(authoritativeToLineKey + 7)
          ],
          orderLine: 7,
          orderLineAliases: ["7", "8"],
          logicalLineIdentity: `transfer-anchor:${authoritativeToLineKey + 6}`,
          identityStatus: "exact",
          itemId: 821003,
          itemName: "Authoritative Item C",
          sku: "AUTH-C",
          quantity: 643.16,
          cumulativeProgressQuantity: 643.16,
          unit: "SQFT",
          locationId: 15,
          location: "Source Yard"
        },
        {
          stage: "receiving",
          sourceLineKey: String(authoritativeToLineKey + 8),
          sourceLineAliases: [String(authoritativeToLineKey + 8)],
          orderLine: 9,
          orderLineAliases: ["9"],
          logicalLineIdentity: `transfer-anchor:${authoritativeToLineKey + 6}`,
          identityStatus: "exact",
          itemId: 821003,
          itemName: "Authoritative Item C",
          sku: "AUTH-C",
          quantity: 643.16,
          cumulativeProgressQuantity: 643.16,
          unit: "SQFT",
          locationId: 1,
          location: "Destination Yard"
        }
      ]
    };
    await storeLinkedScmReconciliationTransactions({
      order: authoritativeOrder,
      transactions: [
        linkedTransaction({
          sourceOrderId: authoritativeToId,
          sourceOrderRef: authoritativeToRef,
          transactionType: "ItemShip",
          transactionId: authoritativeIfId,
          transactionRef: `IF-AUTH-${seed}`,
          transactionLineKey: authoritativeToLineKey + 100,
          sourceLineKey: authoritativeToLineKey + 4,
          itemId: 821002,
          itemName: "PALLET",
          quantity: 16,
          locationId: 15
        }),
        linkedTransaction({
          sourceOrderId: authoritativeToId,
          sourceOrderRef: authoritativeToRef,
          transactionType: "ItemShip",
          transactionId: authoritativeIfId + 1,
          transactionRef: `IF-AUTH-2-${seed}`,
          transactionLineKey: authoritativeToLineKey + 101,
          sourceLineKey: authoritativeToLineKey + 7,
          itemId: 821003,
          itemName: "Authoritative Item C",
          quantity: 643.16,
          locationId: 15
        }),
        linkedTransaction({
          sourceOrderId: authoritativeToId,
          sourceOrderRef: authoritativeToRef,
          transactionType: "ItemRcpt",
          transactionId: authoritativeIrId,
          transactionRef: `IR-AUTH-${seed}`,
          transactionLineKey: authoritativeToLineKey + 102,
          sourceLineKey: authoritativeToLineKey + 2,
          itemId: 821001,
          itemName: "Authoritative Item A",
          quantity: 63,
          locationId: 1
        }),
        linkedTransaction({
          sourceOrderId: authoritativeToId,
          sourceOrderRef: authoritativeToRef,
          transactionType: "ItemRcpt",
          transactionId: authoritativeIrId,
          transactionRef: `IR-AUTH-${seed}`,
          transactionLineKey: authoritativeToLineKey + 103,
          sourceLineKey: authoritativeToLineKey + 5,
          itemId: 821002,
          itemName: "PALLET",
          quantity: 16,
          locationId: 1
        }),
        linkedTransaction({
          sourceOrderId: authoritativeToId,
          sourceOrderRef: authoritativeToRef,
          transactionType: "ItemRcpt",
          transactionId: authoritativeIrId + 1,
          transactionRef: `IR-AUTH-2-${seed}`,
          transactionLineKey: authoritativeToLineKey + 104,
          sourceLineKey: authoritativeToLineKey + 8,
          itemId: 821003,
          itemName: "Authoritative Item C",
          quantity: 643.16,
          locationId: 1
        })
      ],
      source: "manual"
    });
    const authoritativeResult = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: authoritativeToId,
      source: "manual",
      dryRun: true,
      authoritativeOrder
    });
    assert.equal(
      authoritativeResult.applicationStatus,
      "Completed",
      "A complete current TO must not be made partial by a missing linked IF item."
    );
    assert.equal(authoritativeResult.reconciliationStatus, "ok");
    assert.deepEqual(authoritativeResult.quantities, {
      ordered: 722.16,
      fulfilled: 722.16,
      received: 722.16,
      abandoned: 0,
      remaining: 0,
      destinationRemaining: 0
    });
    assert.doesNotMatch(
      authoritativeResult.reason,
      /mirror|physical\/accounting|could not be linked/i
    );

    const pinReview = await query(
      `INSERT INTO scm_reconciliation_review_cases (
         case_key, order_state_id, review_code, severity, dismissible,
         status, reason
       )
       SELECT $2, state.id, 'allocation_review', 'blocking', false,
              'open', 'Harness alias pin'
         FROM scm_reconciliation_order_state state
        WHERE state.order_kind = 'TO'
          AND state.source_order_netsuite_id = $1
       RETURNING id`,
      [toId, `harness-alias-pin:${seed}`]
    );
    const pinResolution = await query(
      `INSERT INTO scm_reconciliation_review_resolutions (
         review_case_id, action, actor, actor_role, note
       ) VALUES ($1, 'allocate', $2, 'admin', 'Alias survival harness')
       RETURNING id`,
      [Number(pinReview.rows[0].id), operatorId]
    );
    const pinned = await query(
      `UPDATE scm_reconciliation_allocations allocation
          SET allocation_method = 'pinned',
              pin_resolution_id = $4,
              pinned_by = $3,
              pinned_at = now(),
              pin_note = 'Alias survival harness',
              updated_at = now()
         FROM scm_reconciliation_order_line_state line,
              scm_reconciliation_order_state state
        WHERE allocation.order_line_state_id = line.id
          AND line.order_state_id = state.id
          AND state.order_kind = 'TO'
          AND state.source_order_netsuite_id = $1
          AND line.netsuite_line_key = $2
          AND allocation.progress_kind = 'fulfilled'
          AND allocation.target_kind = 'source_residual'
          AND allocation.active = true
        RETURNING allocation.id`,
      [toId, String(toLineKey), operatorId, Number(pinResolution.rows[0].id)]
    );
    assert.equal(pinned.rowCount, 1, "The alias test needs one pinned source allocation.");
    await query(
      `UPDATE scm_reconciliation_review_cases
          SET status = 'resolved',
              resolved_at = now(),
              resolved_by = $2,
              resolution_action = 'allocate',
              resolution_note = 'Alias survival harness',
              updated_at = now()
        WHERE id = $1`,
      [Number(pinReview.rows[0].id), operatorId]
    );
    const canonicalToLineKey = String(toLineKey + 100000000);
    const aliasResult = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: toId,
      source: "manual",
      authoritativeOrder: {
        kind: "TO",
        id: toId,
        tranid: toRef,
        status: "B",
        statusText: "Pending Receipt",
        sourceLocationId: 15,
        sourceLocation: "Source Yard",
        destinationLocationId: 1,
        destinationLocation: "Destination Yard",
        lines: [
          {
            stage: "outbound",
            sourceLineKey: canonicalToLineKey,
            sourceLineAliases: [canonicalToLineKey, String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 10,
            unit: "EA",
            locationId: 15,
            location: "Source Yard"
          },
          {
            stage: "receiving",
            sourceLineKey: canonicalToLineKey,
            sourceLineAliases: [canonicalToLineKey, String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 0,
            unit: "EA",
            locationId: 1,
            location: "Destination Yard"
          }
        ]
      }
    });
    assert.equal(aliasResult.reconciliationStatus, "ok");
    assert.ok(
      aliasResult.targets[toRef].allocationMethods.includes("pinned"),
      "A stable physical alias must preserve the manual pin when the canonical TO key changes."
    );

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, status, status_text,
         vendor_id, vendor, destination_location_id, destination_location,
         receipt_status, netsuite_active, synced_at
       ) VALUES
         ($1, $2, DATE '2026-07-29', 'B', 'Pending Receipt',
          5001, 'Harness Vendor', 1, 'Destination Yard',
          'not_received', true, now()),
         ($3, $4, DATE '2026-07-29', 'B', 'Pending Receipt',
          5001, 'Harness Vendor', 1, 'Destination Yard',
          'not_received', true, now())`,
      [orphanPoId, orphanPoRef, orphanSplitPoId, orphanSplitPoRef]
    );
    const orphanLines = await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, quantity,
         netsuite_received_qty, unit, location_id, location, netsuite_active,
         raw
       ) VALUES
         ($1, $2, 830001, 'Orphaned PO Item', 'ORPHAN-PO', 10,
          0, 'EA', 1, 'Destination Yard', true, $5::jsonb),
         ($3, $4, 830001, 'Orphaned PO Item', 'ORPHAN-PO', 4,
          0, 'EA', 1, 'Destination Yard', true, $6::jsonb)
       RETURNING id, purchase_order_id`,
      [
        orphanPoId,
        orphanPoLineKey,
        orphanSplitPoId,
        -orphanPoLineKey,
        JSON.stringify({
          sourceLineAliases: [String(orphanPoLineKey)],
          orderLine: String(orphanPoLineKey),
          orderLineAliases: [String(orphanPoLineKey)],
          identityStatus: "exact"
        }),
        JSON.stringify({
          sourceLineAliases: [String(-orphanPoLineKey)],
          orderLine: String(-orphanPoLineKey),
          orderLineAliases: [String(-orphanPoLineKey)],
          identityStatus: "exact"
        })
      ]
    );
    const orphanSourceLineId = Number(
      orphanLines.rows.find((row) => Number(row.purchase_order_id) === orphanPoId).id
    );
    const orphanChildLineId = Number(
      orphanLines.rows.find((row) => Number(row.purchase_order_id) === orphanSplitPoId).id
    );
    const orphanSplit = await query(
      `INSERT INTO dispatch_scm_po_splits (
         source_po_id, source_po_ref, split_po_id, split_po_ref,
         status, created_by
       ) VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING id`,
      [orphanPoId, orphanPoRef, orphanSplitPoId, orphanSplitPoRef, operatorId]
    );
    await query(
      `INSERT INTO dispatch_scm_po_split_lines (
         split_id, source_line_id, split_line_id, item_id, sku, item_name,
         sales_qty, requested_sales_qty, unit
       ) VALUES ($1, $2, $3, 830001, 'ORPHAN-PO', 'Orphaned PO Item', 4, 4, 'EA')`,
      [Number(orphanSplit.rows[0].id), orphanSourceLineId, orphanChildLineId]
    );
    const replacedPoLineKey = String(orphanPoLineKey + 100000000);
    const orphanResult = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: orphanPoId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: {
        kind: "PO",
        id: orphanPoId,
        tranid: orphanPoRef,
        status: "B",
        statusText: "Pending Receipt",
        destinationLocationId: 1,
        destinationLocation: "Destination Yard",
        lines: [{
          stage: "receiving",
          sourceLineKey: replacedPoLineKey,
          sourceLineAliases: [replacedPoLineKey],
          orderLine: replacedPoLineKey,
          orderLineAliases: [replacedPoLineKey],
          identityStatus: "exact",
          itemId: 830001,
          itemName: "Orphaned PO Item",
          sku: "ORPHAN-PO",
          quantity: 10,
          cumulativeProgressQuantity: 0,
          unit: "EA",
          locationId: 1,
          location: "Destination Yard"
        }]
      }
    });
    assert.equal(orphanResult.reconciliationStatus, "review");
    assert.match(orphanResult.reason, /removed or replaced while active split/i);

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, status, status_text,
         vendor_id, vendor, destination_location_id, destination_location,
         receipt_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2026-07-29', 'B', 'Pending Receipt',
         5001, 'Harness Vendor', 1, 'Destination Yard',
         'not_received', true, now()
       )`,
      [plannedPoId, plannedPoRef]
    );
    for (const [lineKey, quantity] of [
      [plannedPoLineKey, 10],
      [plannedPoLineKey + 1, 5]
    ]) {
      await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, quantity,
           netsuite_received_qty, unit, location_id, location, netsuite_active,
           raw
         ) VALUES (
           $1, $2, 840001, 'Same SKU Planned Item', 'SAME-SKU', $3,
           0, 'EA', 1, 'Destination Yard', true, $4::jsonb
         )`,
        [
          plannedPoId,
          lineKey,
          quantity,
          JSON.stringify({
            sourceLineAliases: [String(lineKey)],
            orderLine: String(lineKey),
            orderLineAliases: [String(lineKey)],
            identityStatus: "exact"
          })
        ]
      );
    }
    await query(
      `INSERT INTO scm_schedule_groups (group_ref, status, created_by)
       VALUES ($1, 'active', $2)`,
      [plannedGroupRef, operatorId]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, group_ref, status, created_by, updated_by
       ) VALUES ('PO', $1, $2, 'Queued', $3, $3)`,
      [plannedPoRef, plannedGroupRef, operatorId]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, group_ref, status, eta_date, driver,
         created_by, updated_by
       ) VALUES (
         'PO', $1, $1, 'Planned', DATE '2026-08-01', 'Harness Driver',
         $2, $2
       )`,
      [plannedGroupRef, operatorId]
    );
    const plannedLocal = await loadLocalScmReconciliationOrder("PO", plannedPoId);
    assert.equal(plannedLocal.dispatchPlanned, true, "An active grouped PO plan must protect its source members.");
    assert.equal(new Date(plannedLocal.dispatchPlanDate).toISOString().slice(0, 10), "2026-08-01");
    const plannedResult = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: plannedPoId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: {
        kind: "PO",
        id: plannedPoId,
        tranid: plannedPoRef,
        status: "B",
        statusText: "Pending Receipt",
        destinationLocationId: 2,
        destinationLocation: "Changed Destination",
        lines: [
          {
            stage: "receiving",
            sourceLineKey: String(plannedPoLineKey),
            sourceLineAliases: [String(plannedPoLineKey)],
            orderLine: String(plannedPoLineKey),
            orderLineAliases: [String(plannedPoLineKey)],
            identityStatus: "exact",
            itemId: 840001,
            itemName: "Same SKU Planned Item",
            sku: "SAME-SKU",
            quantity: 8,
            cumulativeProgressQuantity: 0,
            unit: "EA",
            locationId: 2,
            location: "Changed Destination"
          },
          {
            stage: "receiving",
            sourceLineKey: String(plannedPoLineKey + 1),
            sourceLineAliases: [String(plannedPoLineKey + 1)],
            orderLine: String(plannedPoLineKey + 1),
            orderLineAliases: [String(plannedPoLineKey + 1)],
            identityStatus: "exact",
            itemId: 840001,
            itemName: "Same SKU Planned Item",
            sku: "SAME-SKU",
            quantity: 5,
            cumulativeProgressQuantity: 0,
            unit: "EA",
            locationId: 2,
            location: "Changed Destination"
          }
        ]
      }
    });
    assert.equal(plannedResult.reconciliationStatus, "review");
    assert.match(plannedResult.reason, /destination changed after the parent order was planned/i);
    assert.match(plannedResult.reason, /changed planned source line/i);
    const unchangedPlan = await query(
      `SELECT po.destination_location_id, line.quantity,
              group_schedule.status, group_schedule.eta_date,
              group_schedule.driver
         FROM purchase_orders po
         JOIN purchase_order_lines line
           ON line.purchase_order_id = po.netsuite_id
          AND line.line_id = $2
         JOIN scm_transport_schedule group_schedule
           ON group_schedule.order_kind = 'PO'
          AND group_schedule.order_ref = $3
        WHERE po.netsuite_id = $1`,
      [plannedPoId, plannedPoLineKey, plannedGroupRef]
    );
    assert.equal(Number(unchangedPlan.rows[0].destination_location_id), 1);
    assert.equal(Number(unchangedPlan.rows[0].quantity), 10);
    assert.equal(unchangedPlan.rows[0].status, "Planned");
    assert.equal(unchangedPlan.rows[0].driver, "Harness Driver");

    const enriched = await enrichScmScheduleWithReconciliation([
      { orderKind: "PO", sourceId: poId, orderRef: poRef, status: "Queued" },
      { orderKind: "TO", sourceId: toId, orderRef: toRef, status: "Queued" }
    ], { includeDetails: true });
    assert.equal(enriched.length, 2);
    assert.equal(enriched[0].reconciliation.quantities.received, 6);
    assert.equal(enriched[1].status, "In Transit");
    assert.ok(enriched.every((row) => row.reconciliationApplicationStatus === row.status),
      "Schedule and reconciliation application statuses must expose the same effective status.");
    assert.ok(enriched.every((row) => Array.isArray(row.reconciliation.lines)));
    assert.ok(enriched.every((row) => Array.isArray(row.reconciliation.allocationTargets)));

    assert.equal(await assertScmReconciliationOrderEditable({
      kind: "TO",
      orderRef: toRef
    }), true);
    await query(
      `UPDATE scm_transport_schedule
          SET reconciliation_blocked = true,
              status = 'Reconcile Review'
        WHERE order_kind = 'TO'
          AND order_ref = $1`,
      [toRef]
    );
    await assert.rejects(
      assertScmReconciliationOrderEditable({ kind: "TO", orderRef: toRef }),
      /requires NetSuite reconciliation review/i
    );
    await query(
      `UPDATE scm_transport_schedule
          SET reconciliation_blocked = false,
              status = 'In Transit'
        WHERE order_kind = 'TO'
          AND order_ref = $1`,
      [toRef]
    );

    const firstMissing = await recordScmReconciliationMissingLookup({
      kind: "PO",
      id: poId
    }, { sourceName: "manual" });
    assert.equal(firstMissing.missing_success_count, 1);
    const secondMissing = await recordScmReconciliationMissingLookup({
      kind: "PO",
      id: poId
    }, { sourceName: "manual" });
    assert.equal(secondMissing.missing_success_count, 2);
    assert.equal(secondMissing.reconciliation_status, "missing");
    await assert.rejects(
      assertScmReconciliationOrderEditable({ kind: "PO", orderRef: poRef }),
      /requires NetSuite reconciliation review/i
    );
    await assert.rejects(
      resolveScmReconciliationReview({
        kind: "PO",
        orderRef: poRef,
        resolution: "accept_current",
        note: "A missing source cannot bypass fresh NetSuite verification.",
        actor: operatorId,
        actorRole: "admin"
      }),
      (error) =>
        error?.code
          === "SCM_RECONCILIATION_SOURCE_MISSING_CONTROLLED_ACTION_REQUIRED"
    );
    await clearScmReconciliationMissingLookup({ kind: "PO", id: poId });
    await query(
      `UPDATE scm_transport_schedule
          SET reconciliation_blocked = false,
              status = CASE
                WHEN status = 'Reconcile Review' THEN 'Queued'
                ELSE status
              END
        WHERE order_kind = 'PO'
          AND order_ref = $1`,
      [poRef]
    );
    assert.equal(await assertScmReconciliationOrderEditable({
      kind: "PO",
      orderRef: poRef
    }), true);
    const resolvedSchedule = await enrichScmScheduleWithReconciliation([{
      orderKind: "PO",
      sourceId: poId,
      orderRef: poRef,
      status: "Queued"
    }], { includeDetails: true });
    assert.notEqual(
      resolvedSchedule[0].status,
      "Reconcile Review",
      "Accepting the current result must clear stale target-level review status."
    );
    assert.equal(
      resolvedSchedule[0].reconciliationReason,
      "",
      "Accepting the current result must clear stale target-level review reason."
    );

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, status, status_text,
         destination_location_id, destination_location, receipt_status,
         netsuite_active, synced_at, status_updated_at
       ) VALUES (
         $1, $2, CURRENT_DATE, 'B', 'Purchase Order : Pending Receipt',
         1, 'Harness Destination', 'not_received',
         true, now(), now()
       )`,
      [missingCancelPoId, missingCancelPoRef]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location, netsuite_received_qty,
         netsuite_active, synced_at
       ) VALUES (
         $1, $2, 820099, 'Missing Cancellation Item', 'MISSING-CANCEL',
         12, 'EA', 1, 'Harness Destination', 0,
         true, now()
       )`,
      [missingCancelPoId, missingCancelPoLineKey]
    );
    const missingScheduleBeforeCancellation = await query(
      `SELECT id
         FROM scm_transport_schedule
        WHERE order_kind = 'PO'
          AND order_ref = $1`,
      [missingCancelPoRef]
    );
    assert.equal(
      missingScheduleBeforeCancellation.rows.length,
      0,
      "The controlled cancellation fixture must cover a PO that never had a schedule row."
    );
    const missingHistoryRun = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "order_family",
      targetOrderKind: "PO",
      targetOrderId: missingCancelPoId,
      targetOrderRef: missingCancelPoRef,
      dryRun: false,
      applyUnambiguous: true,
      requestedBy: operatorId
    });
    await initializeScmReconciliationRunTargets(missingHistoryRun.id, [{
      kind: "PO",
      id: missingCancelPoId,
      tranid: missingCancelPoRef
    }]);
    await updateScmReconciliationRunTarget(missingHistoryRun.id, {
      kind: "PO",
      id: missingCancelPoId
    }, {
      status: "review",
      proposedChange: {
        reconciliationStatus: "missing",
        reason: "The order was absent from two successful direct NetSuite lookups."
      },
      result: { missingLookupCount: 2 }
    });
    const missingHistoryWorker = await markScmReconciliationRunRunning(missingHistoryRun.id);
    await finishScmReconciliationRun(missingHistoryRun.id, {
      status: "succeeded",
      summary: { missingConfirmed: 1 },
      expectedWorkerLeaseToken: missingHistoryWorker.checkpoint.workerLeaseToken
    });
    await recordScmReconciliationMissingLookup({
      kind: "PO",
      id: missingCancelPoId,
      tranid: missingCancelPoRef
    }, {
      sourceName: "manual",
      runId: missingHistoryRun.id
    });
    const confirmedMissingCancellation = await recordScmReconciliationMissingLookup({
      kind: "PO",
      id: missingCancelPoId,
      tranid: missingCancelPoRef
    }, {
      sourceName: "manual",
      runId: missingHistoryRun.id
    });
    assert.equal(confirmedMissingCancellation.missing_success_count, 2);
    const missingCancellationCase = await query(
      `SELECT review.id, review.last_detected_at
         FROM scm_reconciliation_review_cases review
         JOIN scm_reconciliation_order_state state
           ON state.id = review.order_state_id
        WHERE state.order_kind = 'PO'
          AND state.source_order_netsuite_id = $1
          AND review.review_code = 'source_missing'
          AND review.status = 'open'`,
      [missingCancelPoId]
    );
    const verifiedAt = new Date().toISOString();
    const missingCancellation = await cancelMissingScmPurchaseOrderLocally({
      sourceOrderId: missingCancelPoId,
      sourceOrderRef: missingCancelPoRef,
      reviewCaseId: missingCancellationCase.rows[0].id,
      expectedLastDetectedAt: missingCancellationCase.rows[0].last_detected_at,
      verification: {
        verifiedAt,
        orderKind: "PO",
        sourceOrderId: missingCancelPoId,
        sourceOrderRef: missingCancelPoRef,
        lineQueryFound: false,
        headerQueryFound: false,
        referenceQueryFound: false
      },
      note: "Harness verified the Purchase Order is absent by ID, header, and transaction number.",
      actor: operatorId,
      actorRole: "admin"
    });
    assert.equal(missingCancellation.action, "cancel_missing");
    assert.equal(missingCancellation.applicationStatus, "Cancelled");
    assert.equal(missingCancellation.netsuiteTerminalState, "deleted");
    const missingCancellationState = await query(
      `SELECT po.netsuite_active,
              po.netsuite_missing_at,
              state.netsuite_terminal_state,
              state.application_status,
              state.reconciliation_status,
              state.reconciliation_reason,
              state.ordered_qty,
              state.remaining_qty,
              state.destination_remaining_qty,
              schedule.status AS schedule_status,
              schedule.reconciliation_blocked,
              line.netsuite_active AS line_active,
              review.status AS review_status,
              review.resolution_action,
              resolution.action AS recorded_action,
              audit.action AS audit_action,
              audit.payload
         FROM purchase_orders po
         JOIN purchase_order_lines line
           ON line.purchase_order_id = po.netsuite_id
         JOIN scm_reconciliation_order_state state
           ON state.order_kind = 'PO'
          AND state.source_order_netsuite_id = po.netsuite_id
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND schedule.order_ref = po.tranid
         JOIN scm_reconciliation_review_cases review
           ON review.order_state_id = state.id
          AND review.review_code = 'source_missing'
         JOIN scm_reconciliation_review_resolutions resolution
           ON resolution.review_case_id = review.id
          AND resolution.action = 'cancel_missing'
         JOIN scm_reconciliation_audit_events audit
           ON audit.id = resolution.audit_event_id
        WHERE po.netsuite_id = $1`,
      [missingCancelPoId]
    );
    const cancelledMissing = missingCancellationState.rows[0];
    assert.equal(cancelledMissing.netsuite_active, false);
    assert.ok(cancelledMissing.netsuite_missing_at);
    assert.equal(cancelledMissing.netsuite_terminal_state, "deleted");
    assert.equal(cancelledMissing.application_status, "Cancelled");
    assert.equal(cancelledMissing.reconciliation_status, "current");
    assert.equal(cancelledMissing.reconciliation_reason, null);
    assert.equal(Number(cancelledMissing.ordered_qty), 12);
    assert.equal(Number(cancelledMissing.remaining_qty), 0);
    assert.equal(Number(cancelledMissing.destination_remaining_qty), 0);
    assert.equal(cancelledMissing.schedule_status, "Cancelled");
    assert.equal(cancelledMissing.reconciliation_blocked, false);
    assert.equal(cancelledMissing.line_active, true, "Historical PO line detail must be preserved.");
    assert.equal(cancelledMissing.review_status, "resolved");
    assert.equal(cancelledMissing.resolution_action, "cancel_missing");
    assert.equal(cancelledMissing.recorded_action, "cancel_missing");
    assert.equal(cancelledMissing.audit_action, "cancel_missing");
    assert.equal(cancelledMissing.payload.verification.referenceQueryFound, false);
    const completedScheduleRows = await listScmSchedule({
      search: missingCancelPoRef,
      view: "completed"
    });
    const cancelledHistoryRow = completedScheduleRows.find(
      (row) => row.orderKind === "PO"
        && String(row.sourceId) === String(missingCancelPoId)
    );
    assert.ok(
      cancelledHistoryRow,
      "A locally cancelled PO with no prior schedule must remain visible in completed history."
    );
    assert.equal(cancelledHistoryRow.status, "Cancelled");
    assert.ok(
      cancelledHistoryRow.scheduleId > 0,
      "Controlled cancellation must create a durable schedule history row."
    );
    const broadSourcesAfterCancellation = await listLocalScmReconciliationSources({
      kind: "PO"
    });
    assert.equal(
      broadSourcesAfterCancellation.some((source) => source.id === missingCancelPoId),
      false,
      "A controlled deleted/current PO must not reopen in broad nightly reconciliation."
    );
    const historicalMissingTarget = await getScmReconciliationRunDetails(
      missingHistoryRun.id
    );
    assert.equal(
      historicalMissingTarget.targets.find((target) =>
        Number(target.orderId) === missingCancelPoId)?.status,
      "review",
      "Local cancellation must not rewrite the historical reconciliation run target."
    );
    await assert.rejects(
      cancelMissingScmPurchaseOrderLocally({
        sourceOrderId: missingCancelPoId,
        sourceOrderRef: missingCancelPoRef,
        reviewCaseId: missingCancellationCase.rows[0].id,
        expectedLastDetectedAt: missingCancellationCase.rows[0].last_detected_at,
        verification: {
          verifiedAt: new Date().toISOString(),
          orderKind: "PO",
          sourceOrderId: missingCancelPoId,
          sourceOrderRef: missingCancelPoRef,
          lineQueryFound: false,
          headerQueryFound: false,
          referenceQueryFound: false
        },
        note: "A stale duplicate cancellation must fail.",
        actor: operatorId
      }),
      /no longer available|changed after it was opened/i
    );
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, status, status_text,
         destination_location_id, destination_location, receipt_status,
         netsuite_active, synced_at, status_updated_at
       ) VALUES (
         $1, $2, CURRENT_DATE, 'B', 'Purchase Order : Pending Receipt',
         1, 'Harness Destination', 'not_received',
         true, now(), now()
       )`,
      [missingActivityPoId, missingActivityPoRef]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location, netsuite_received_qty,
         netsuite_active, synced_at
       ) VALUES (
         $1, $2, 820098, 'Missing Activity Item', 'MISSING-ACTIVITY',
         5, 'EA', 1, 'Harness Destination', 0,
         true, now()
       )`,
      [missingActivityPoId, missingActivityPoLineKey]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, source_table, source_id, order_ref, status, eta_date,
         created_by, updated_by
       ) VALUES (
         'PO', 'purchase_orders', $1, $2, 'Planned', CURRENT_DATE,
         $3, $3
       )`,
      [missingActivityPoId, missingActivityPoRef, operatorId]
    );
    await recordScmReconciliationMissingLookup({
      kind: "PO",
      id: missingActivityPoId,
      tranid: missingActivityPoRef
    }, { sourceName: "manual" });
    await recordScmReconciliationMissingLookup({
      kind: "PO",
      id: missingActivityPoId,
      tranid: missingActivityPoRef
    }, { sourceName: "manual" });
    const missingActivityCase = await query(
      `SELECT review.id, review.last_detected_at
         FROM scm_reconciliation_review_cases review
         JOIN scm_reconciliation_order_state state
           ON state.id = review.order_state_id
        WHERE state.order_kind = 'PO'
          AND state.source_order_netsuite_id = $1
          AND review.review_code = 'source_missing'
          AND review.status = 'open'`,
      [missingActivityPoId]
    );
    await assert.rejects(
      cancelMissingScmPurchaseOrderLocally({
        sourceOrderId: missingActivityPoId,
        sourceOrderRef: missingActivityPoRef,
        reviewCaseId: missingActivityCase.rows[0].id,
        expectedLastDetectedAt: missingActivityCase.rows[0].last_detected_at,
        verification: {
          verifiedAt: new Date().toISOString(),
          orderKind: "PO",
          sourceOrderId: missingActivityPoId,
          sourceOrderRef: missingActivityPoRef,
          lineQueryFound: false,
          headerQueryFound: false,
          referenceQueryFound: false
        },
        note: "This cancellation must be rejected because an operational plan exists.",
        actor: operatorId
      }),
      (error) =>
        error?.code === "SCM_RECONCILIATION_MISSING_PO_HAS_ACTIVITY"
        && Number(error?.activity?.operationalSchedules || 0) === 1
    );
    const guardedMissingPo = await query(
      `SELECT po.netsuite_active, review.status
         FROM purchase_orders po
         JOIN scm_reconciliation_order_state state
           ON state.order_kind = 'PO'
          AND state.source_order_netsuite_id = po.netsuite_id
         JOIN scm_reconciliation_review_cases review
           ON review.order_state_id = state.id
          AND review.review_code = 'source_missing'
        WHERE po.netsuite_id = $1`,
      [missingActivityPoId]
    );
    assert.equal(guardedMissingPo.rows[0].netsuite_active, true);
    assert.equal(guardedMissingPo.rows[0].status, "open");

    const webhookPayload = {
      schemaVersion: "mbbs.ifir.reconciliation.v1",
      eventId: `harness-webhook-${seed}`,
      eventTime: fixedModifiedAt,
      action: "create",
      record: {
        recordType: "itemReceipt",
        id: 7900000000 + seed,
        tranid: `IR-WEBHOOK-${seed}`,
        status: { value: "B", text: "Posted" },
        lastModifiedAt: fixedModifiedAt,
        createdFrom: {
          id: poId,
          ref: poRef,
          recordType: "purchaseOrder"
        },
        actualLocation: { id: 1, text: "Destination Yard" },
        lines: [{
          lineUniqueKey: String(7910000000 + seed),
          sourceLineKey: String(poLineKey),
          item: { id: 810001, text: "Harness PO Item" },
          quantity: 1,
          units: "EA",
          actualLocation: { id: 1, text: "Destination Yard" }
        }]
      }
    };
    const webhookStored = await storeScmIfIrWebhook(webhookPayload, {
      eventId: webhookPayload.eventId,
      timestamp: String(Math.floor(new Date(fixedModifiedAt).getTime() / 1000)),
      rawBody: JSON.stringify(webhookPayload)
    });
    assert.equal(webhookStored.ok, true);
    assert.equal(webhookStored.duplicate, false);
    const webhookDuplicate = await storeScmIfIrWebhook(webhookPayload, {
      eventId: webhookPayload.eventId,
      timestamp: String(Math.floor(new Date(fixedModifiedAt).getTime() / 1000)),
      rawBody: JSON.stringify(webhookPayload)
    });
    assert.equal(webhookDuplicate.duplicate, true);

    await query(
      `UPDATE transfer_orders
          SET dispatch_planned = true,
              dispatch_plan_date = DATE '2026-08-02',
              dispatch_planned_at = now()
        WHERE netsuite_id = $1`,
      [toId]
    );
    const plannedToSourceChange = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: toId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: {
        kind: "TO",
        id: toId,
        tranid: toRef,
        status: "B",
        statusText: "Pending Receipt",
        sourceLocationId: 16,
        sourceLocation: "Changed Source Yard",
        destinationLocationId: 1,
        destinationLocation: "Destination Yard",
        lines: [
          {
            stage: "outbound",
            sourceLineKey: String(toLineKey),
            sourceLineAliases: [String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 10,
            unit: "EA",
            locationId: 16,
            location: "Changed Source Yard"
          },
          {
            stage: "receiving",
            sourceLineKey: String(toLineKey),
            sourceLineAliases: [String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 0,
            unit: "EA",
            locationId: 1,
            location: "Destination Yard"
          }
        ]
      }
    });
    assert.equal(plannedToSourceChange.reconciliationStatus, "review");
    assert.match(plannedToSourceChange.reason, /source location changed after the parent order was planned/i);
    const unchangedToSource = await query(
      `SELECT from_location_id
         FROM transfer_orders
        WHERE netsuite_id = $1`,
      [toId]
    );
    assert.equal(Number(unchangedToSource.rows[0].from_location_id), 15);

    await query(
      `UPDATE transfer_order_lines
          SET netsuite_active = false
        WHERE transfer_order_id = $1`,
      [toId]
    );
    const inactiveExactBaseline = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: toId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: {
        kind: "TO",
        id: toId,
        tranid: toRef,
        status: "G",
        statusText: "Transfer Order : Received",
        sourceLocationId: 15,
        sourceLocation: "Source Yard",
        destinationLocationId: 1,
        destinationLocation: "Destination Yard",
        lines: [
          {
            stage: "outbound",
            sourceLineKey: String(toLineKey),
            sourceLineAliases: [String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 10,
            unit: "EA",
            locationId: 15,
            location: "Source Yard"
          },
          {
            stage: "receiving",
            sourceLineKey: String(toLineKey),
            sourceLineAliases: [String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 10,
            unit: "EA",
            locationId: 1,
            location: "Destination Yard"
          }
        ]
      }
    });
    assert.equal(
      inactiveExactBaseline.reconciliationStatus,
      "ok",
      "Inactive exact local lines must remain a valid historical comparison baseline."
    );
    assert.equal(inactiveExactBaseline.applicationStatus, "Completed");
    assert.doesNotMatch(inactiveExactBaseline.reason, /added source line/i);

    await query(
      `UPDATE transfer_order_lines
          SET item_id = 99999999
        WHERE transfer_order_id = $1`,
      [toId]
    );
    const reusedHistoricalAlias = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: toId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: {
        kind: "TO",
        id: toId,
        tranid: toRef,
        status: "G",
        statusText: "Transfer Order : Received",
        sourceLocationId: 15,
        sourceLocation: "Source Yard",
        destinationLocationId: 1,
        destinationLocation: "Destination Yard",
        lines: [
          {
            stage: "outbound",
            sourceLineKey: String(toLineKey),
            sourceLineAliases: [String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 10,
            unit: "EA",
            locationId: 15,
            location: "Source Yard"
          },
          {
            stage: "receiving",
            sourceLineKey: String(toLineKey),
            sourceLineAliases: [String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 10,
            unit: "EA",
            locationId: 1,
            location: "Destination Yard"
          }
        ]
      }
    });
    assert.equal(reusedHistoricalAlias.reconciliationStatus, "review");
    assert.match(
      reusedHistoricalAlias.reason,
      /added source line/i,
      "A reused historical alias for another item must not be accepted as the same planned line."
    );
    await query(
      `UPDATE transfer_order_lines
          SET item_id = 820001
        WHERE transfer_order_id = $1`,
      [toId]
    );

    const activeAliasLineKey = toLineKey + 200000000;
    const activeAliasRaw = JSON.stringify({
      sourceLineAliases: [String(toLineKey)],
      orderLine: String(toLineKey),
      orderLineAliases: [String(toLineKey)],
      identityStatus: "exact"
    });
    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location, loaded_qty,
         netsuite_received_qty, netsuite_active, raw
       ) VALUES
         ('outbound', $1, $2, 820001, 'Harness TO Item', 'HARNESS-TO',
          10, 'EA', 15, 'Source Yard', 10, 0, true, $3::jsonb),
         ('receiving', $1, $2, 820001, 'Harness TO Item', 'HARNESS-TO',
          10, 'EA', 1, 'Destination Yard', 0, 10, true, $3::jsonb)`,
      [toId, activeAliasLineKey, activeAliasRaw]
    );
    const activePreferredOverHistorical = await reconcileScmOrderFamily({
      kind: "TO",
      sourceOrderId: toId,
      source: "manual",
      dryRun: true,
      authoritativeOrder: {
        kind: "TO",
        id: toId,
        tranid: toRef,
        status: "G",
        statusText: "Transfer Order : Received",
        sourceLocationId: 15,
        sourceLocation: "Source Yard",
        destinationLocationId: 1,
        destinationLocation: "Destination Yard",
        lines: [
          {
            stage: "outbound",
            sourceLineKey: String(toLineKey),
            sourceLineAliases: [String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 10,
            unit: "EA",
            locationId: 15,
            location: "Source Yard"
          },
          {
            stage: "receiving",
            sourceLineKey: String(toLineKey),
            sourceLineAliases: [String(toLineKey)],
            orderLine: String(toLineKey),
            orderLineAliases: [String(toLineKey)],
            identityStatus: "exact",
            itemId: 820001,
            itemName: "Harness TO Item",
            sku: "HARNESS-TO",
            quantity: 10,
            cumulativeProgressQuantity: 10,
            unit: "EA",
            locationId: 1,
            location: "Destination Yard"
          }
        ]
      }
    });
    assert.equal(
      activePreferredOverHistorical.reconciliationStatus,
      "ok",
      "An active exact alias must take precedence over an inactive historical alias."
    );
    assert.doesNotMatch(activePreferredOverHistorical.reason, /added source line/i);

    await assert.rejects(
      withTransaction(async () => {
        await query(
          `UPDATE scm_reconciliation_audit_events
              SET actor = 'tampered'
            WHERE id = $1`,
          [auditRows.rows[0].id]
        );
      }),
      /append-only/i,
      "Audit history must reject updates."
    );
  });
  console.log("SCM reconciliation repository/database harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
