// @ts-check

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { createScmPurchaseOrderSplit, listScmSchedule } from "../../../src/dispatch-repository.js";
import { repairScmManualSplitFamilyAuthority } from "../../../src/scm-manual-split-authority-repository.js";
import {
  scmManualSplitHasOperationalStatusAuthority,
  scmManualSplitHasOperatorStatusAuthority
} from "../../../src/scm-manual-split-authority.js";
import { effectiveScmPurchaseOrderCatalogStatus } from "../../../src/scm-purchase-order-catalog-status.js";
import {
  enrichScmScheduleWithReconciliation,
  reconcileScmOrderFamily,
  resolveScmReconciliationReview,
  scmScheduleEffectiveReconciliationStatus,
  storeLinkedScmReconciliationTransactions
} from "../../../src/scm-reconciliation-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function fixtureIdentity(label) {
  const token = crypto.randomUUID().replaceAll("-", "");
  const seed = Number.parseInt(token.slice(0, 10), 16);
  const baseId = 8_600_000_000_000 + (seed * 20);
  return {
    sourcePoId: baseId + 1,
    lineId: baseId + 2,
    itemId: baseId + 3,
    sourcePoRef: `PO-MANUAL-AUTH-${label}-${token.slice(0, 10)}`,
    firstSplitRef: `SN-MANUAL-AUTH-${label}-${token.slice(0, 10)}-1`,
    secondSplitRef: `SN-MANUAL-AUTH-${label}-${token.slice(0, 10)}-2`
  };
}

async function seedSource(label) {
  const fixture = fixtureIdentity(label);
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, source_location_id,
       source_location, dispatch_vendor_yard, receipt_status,
       initial_scm_status, netsuite_active, synced_at
     ) VALUES (
       $1::bigint, $2, current_date, $1::bigint + 10, 'Manual authority vendor',
       'E', 'Purchase Order : Pending Billing/Partially Received',
       1, '3445', 1, '3445', 'Manual authority yard', 'partially_received',
       'Hold', true, now()
     )`,
    [fixture.sourcePoId, fixture.sourcePoRef]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       id, purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, received_pallet_qty,
       received_layer_qty, received_section_qty, received_piece_qty,
       netsuite_received_qty, netsuite_received_baseline_qty, item_weight,
       netsuite_active, synced_at, raw
     ) VALUES (
       $2::bigint, $1::bigint, 10, $3::bigint, 'Manual authority item', 'MANUAL-AUTH-SKU', 100, 'EA',
       1, '3445', 10, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 25,
       true, now(), '{}'::jsonb
     )`,
    [fixture.sourcePoId, fixture.lineId, fixture.itemId]
  );
  return fixture;
}

async function createSplit(fixture, {
  ref = fixture.firstSplitRef,
  destinationLocationId = 15,
  status
} = {}) {
  return createScmPurchaseOrderSplit({
    sourcePoRef: fixture.sourcePoRef,
    newPoRef: ref,
    destinationLocationId,
    ...(status ? { status } : {}),
    lines: [{ lineRowId: fixture.lineId, pallets: 1 }],
    createdBy: "manual-split-authority-test"
  });
}

test("user-confirmed split creation persists Hold and destination in every operational mirror", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("create");
    const created = await createSplit(fixture);
    const result = await query(
      `SELECT child.initial_scm_status,
              child.destination_location_id::text AS child_location_id,
              child.destination_location AS child_location,
              split.details->>'destinationLocationId' AS confirmed_location_id,
              split.details->>'destinationLocation' AS confirmed_location,
              schedule.status AS schedule_status,
              schedule.dropoff_point AS schedule_dropoff
         FROM dispatch_scm_po_splits split
         JOIN purchase_orders child ON child.netsuite_id = split.split_po_id
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(split.split_po_ref)
        WHERE split.id = $1`,
      [created.split.id]
    );

    assert.deepEqual(result.rows, [{
      initial_scm_status: "Hold",
      child_location_id: "15",
      child_location: "12441",
      confirmed_location_id: "15",
      confirmed_location: "12441",
      schedule_status: "Hold",
      schedule_dropoff: "12441"
    }]);

    const priority = await createSplit(fixture, {
      ref: fixture.secondSplitRef,
      destinationLocationId: 28,
      status: "Priority"
    });
    const priorityMirrors = await query(
      `SELECT child.initial_scm_status, schedule.status AS schedule_status
         FROM dispatch_scm_po_splits split
         JOIN purchase_orders child ON child.netsuite_id = split.split_po_id
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(split.split_po_ref)
        WHERE split.id = $1`,
      [priority.split.id]
    );
    assert.deepEqual(priorityMirrors.rows, [{
      initial_scm_status: "Hold",
      schedule_status: "Priority"
    }]);
  });
});

test("operator status authority excludes the evidence-driven Planned lifecycle", () => {
  for (const status of [
    "Queued", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"
  ]) {
    assert.equal(scmManualSplitHasOperatorStatusAuthority(status), true, status);
  }
  assert.equal(scmManualSplitHasOperatorStatusAuthority("Planned"), false);
  assert.equal(scmManualSplitHasOperatorStatusAuthority(), false);
});

test("an exact active dispatch assignment grants continuing authority to Planned", () => {
  assert.equal(scmManualSplitHasOperationalStatusAuthority("Planned"), false);
  assert.equal(scmManualSplitHasOperationalStatusAuthority("Planned", {
    hasActivePlan: true
  }), true);
  assert.equal(scmManualSplitHasOperationalStatusAuthority("Partially Done", {
    hasActivePlan: true
  }), false);
  assert.equal(scmManualSplitHasOperationalStatusAuthority("Planned", {
    hasActivePlan: true,
    derivedStatus: "Completed"
  }), false);
  assert.equal(scmManualSplitHasOperationalStatusAuthority("Hold"), true);
});

test("scheduled reconciliation preserves a held manual child despite partial receipt evidence", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("scheduled-reconcile");
    await createSplit(fixture, { status: "Hold", destinationLocationId: 15 });
    await storeLinkedScmReconciliationTransactions({
      order: {
        kind: "PO",
        id: fixture.sourcePoId,
        tranid: fixture.sourcePoRef,
        destinationLocationId: 1,
        destinationLocation: "3445"
      },
      source: "manual",
      transactions: [
        {
          sourceOrderId: fixture.sourcePoId,
          sourceOrderRef: fixture.sourcePoRef,
          sourceOrderLine: "10",
          sourceLineKey: "10",
          transactionId: fixture.sourcePoId + 10,
          transactionType: "ItemRcpt",
          transactionRef: `IR-${fixture.sourcePoId + 10}`,
          status: "B",
          statusText: "Posted",
          transactionDate: "2026-08-31",
          lastModifiedAt: "2026-08-31T16:00:00.000Z",
          transactionLine: "1",
          transactionLineKey: "1",
          itemId: fixture.itemId,
          itemName: "Manual authority item",
          quantity: 5,
          unit: "EA",
          locationId: 15,
          location: "12441"
        },
        {
          sourceOrderId: fixture.sourcePoId,
          sourceOrderRef: fixture.sourcePoRef,
          sourceOrderLine: "10",
          sourceLineKey: "10",
          transactionId: fixture.sourcePoId + 11,
          transactionType: "ItemRcpt",
          transactionRef: `IR-${fixture.sourcePoId + 11}`,
          status: "B",
          statusText: "Posted",
          transactionDate: "2026-08-31",
          lastModifiedAt: "2026-08-31T16:01:00.000Z",
          transactionLine: "2",
          transactionLineKey: "2",
          itemId: fixture.itemId,
          itemName: "Manual authority item",
          quantity: 1,
          unit: "EA",
          locationId: 2,
          location: "Wrong yard"
        }
      ]
    });

    const reconciled = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: fixture.sourcePoId,
      source: "manual"
    });
    assert.equal(reconciled.reconciliationStatus, "review");
    assert.equal(reconciled.targets[fixture.firstSplitRef]?.received, 5);
    assert.equal(reconciled.targets[fixture.firstSplitRef]?.applicationStatus, "Hold");
    assert.equal(reconciled.targets[fixture.firstSplitRef]?.reconciliationStatus, "ok");
    const schedule = await query(
      `SELECT status, reconciliation_blocked
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [fixture.firstSplitRef]
    );
    assert.deepEqual(schedule.rows, [{ status: "Hold", reconciliation_blocked: false }]);
  });
});

test("accepting a parent reconciliation review preserves a manual split operational status", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("accept");
    await createSplit(fixture, { status: "Hold" });
    const targets = {
      [fixture.sourcePoRef]: {
        orderRef: fixture.sourcePoRef,
        targetKind: "source_residual",
        ordered: 90,
        fulfilled: 0,
        received: 30,
        hidden: false,
        applicationStatus: "Reconcile Review"
      },
      [fixture.firstSplitRef]: {
        orderRef: fixture.firstSplitRef,
        targetKind: "po_split",
        ordered: 10,
        fulfilled: 0,
        received: 5,
        hidden: false,
        applicationStatus: "Reconcile Review"
      }
    };
    const state = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         netsuite_status_code, netsuite_status_text, application_status,
         reconciliation_status, reconciliation_reason, ordered_qty,
         received_qty, remaining_qty, exact_allocation, quantity_summary,
         order_snapshot, proposed_state, reconciled_at
       ) VALUES (
         'PO', $1, $2, 'E',
         'Purchase Order : Pending Billing/Partially Received',
         'Partially Done', 'review', 'Fixture allocation review',
         100, 35, 65, false, $3::jsonb, $4::jsonb, $5::jsonb, now()
       ) RETURNING id`,
      [
        fixture.sourcePoId,
        fixture.sourcePoRef,
        JSON.stringify({ family: { ordered: 100, received: 35, remaining: 65 }, targets }),
        JSON.stringify({ scheduleRef: fixture.sourcePoRef }),
        JSON.stringify({ applicationStatus: "Reconcile Review", targets })
      ]
    );
    const stateId = state.rows[0].id;
    await query(
      `INSERT INTO scm_reconciliation_review_cases (
         case_key, order_state_id, review_code, severity, dismissible,
         status, reason, details
       ) VALUES ($1, $2, 'reconciliation_conflict', 'blocking', false,
         'open', 'Fixture allocation review', '{}'::jsonb)`,
      [`PO:${fixture.sourcePoId}:manual-split-authority`, stateId]
    );
    await query(
      `UPDATE scm_transport_schedule
          SET status = 'Hold',
              reconciliation_order_state_id = $2,
              reconciliation_blocked = true
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [fixture.firstSplitRef, stateId]
    );

    const [listedBeforeAcceptance] = await listScmSchedule({
      exactRef: fixture.firstSplitRef,
      kind: "PO",
      audience: "scm"
    });
    assert.equal(listedBeforeAcceptance?.isScmSplit, true);
    assert.equal(listedBeforeAcceptance?.status, "Hold");
    assert.equal(listedBeforeAcceptance?.calculatedStatus, "Hold",
      "the PO/TO Schedule query must not project a parent review over a manual split status");

    const [beforeAcceptance] = await enrichScmScheduleWithReconciliation([{
      orderKind: "PO",
      orderRef: fixture.firstSplitRef,
      sourceRef: fixture.sourcePoRef,
      isScmSplit: true,
      status: "Hold",
      calculatedStatus: "Partially Done",
      scheduleId: 42,
      updatedAt: "2026-08-31T16:00:00.000Z",
      reconciliationBlocked: true
    }]);
    assert.equal(beforeAcceptance?.calculatedStatus, "Hold");
    assert.equal(beforeAcceptance?.reconciliationStatus, "ok");

    await resolveScmReconciliationReview({
      kind: "PO",
      orderRef: fixture.sourcePoRef,
      resolution: "accept_current",
      note: "Regression: preserve confirmed manual child state.",
      actor: "manual-split-authority-test",
      actorRole: "admin"
    });

    const schedule = await query(
      `SELECT status, reconciliation_blocked
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [fixture.firstSplitRef]
    );
    const accepted = await query(
      `SELECT quantity_summary->'targets'->$2->>'applicationStatus' AS child_status
         FROM scm_reconciliation_order_state
        WHERE id = $1`,
      [stateId, fixture.firstSplitRef]
    );
    assert.deepEqual(schedule.rows, [{ status: "Hold", reconciliation_blocked: false }]);
    assert.equal(accepted.rows[0]?.child_status, "Hold");
    const [displayed] = await enrichScmScheduleWithReconciliation([{
      orderKind: "PO",
      orderRef: fixture.firstSplitRef,
      sourceRef: fixture.sourcePoRef,
      isScmSplit: true,
      status: "Hold",
      calculatedStatus: "Partially Done",
      scheduleId: 42,
      updatedAt: "2026-08-31T16:00:00.000Z",
      reconciliationBlocked: false
    }]);
    assert.equal(displayed?.status, "Hold");
    assert.equal(displayed?.calculatedStatus, "Hold");
    assert.equal(displayed?.reconciliationStatus, "ok");

    await query(
      `INSERT INTO dispatch_order_completion_events (
         order_kind, order_ref, dispatch_completed_at,
         completion_evidence_type, completion_evidence_id,
         actor_type, actor_id, metadata
       ) VALUES ('PO', $1, now(), 'driver_job', $2, 'driver', 'manual-authority-driver', '{}'::jsonb)`,
      [fixture.firstSplitRef, `manual-split-authority:${fixture.firstSplitRef}`]
    );
    const [completedListed] = await listScmSchedule({
      exactRef: fixture.firstSplitRef,
      kind: "PO",
      audience: "scm",
      view: "completed"
    });
    assert.equal(completedListed?.status, "Hold");
    assert.equal(completedListed?.calculatedStatus, "Completed",
      "canonical driver completion must still win over manual split authority");
    assert.equal(completedListed?.dispatchCompletionEvidenceType, "driver_job");
  });
});

test("accepted unchanged reconciliation conflict remains resolved until evidence changes", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("accepted-conflict");
    await createSplit(fixture, { status: "Hold", destinationLocationId: 15 });
    const reason = "Production-shaped allocation conflict for accepted evidence.";

    const first = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: fixture.sourcePoId,
      source: "manual",
      explicitReviewReason: reason
    });
    assert.equal(first.reconciliationStatus, "review");
    await query(
      `UPDATE scm_reconciliation_review_cases
          SET details = details - 'conflictFingerprint'
        WHERE case_key = $1`,
      [`PO:${fixture.sourcePoId}:reconciliation_conflict`]
    );
    await resolveScmReconciliationReview({
      kind: "PO",
      orderRef: fixture.sourcePoRef,
      resolution: "accept_current",
      note: "Accept this exact NetSuite evidence.",
      actor: "manual-split-authority-test",
      actorRole: "admin"
    });

    const unchanged = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: fixture.sourcePoId,
      source: "system",
      explicitReviewReason: reason
    });
    assert.notEqual(unchanged.reconciliationStatus, "review");
    assert.notEqual(unchanged.applicationStatus, "Reconcile Review");
    const accepted = await query(
      `SELECT review.status, review.resolution_action,
              review.details->>'conflictFingerprint' AS conflict_fingerprint,
              state.reconciliation_status,
              schedule.status AS schedule_status,
              schedule.reconciliation_blocked
         FROM scm_reconciliation_review_cases review
         JOIN scm_reconciliation_order_state state ON state.id = review.order_state_id
         JOIN scm_transport_schedule schedule
           ON schedule.reconciliation_order_state_id = state.id
          AND lower(schedule.order_ref) = lower($2)
        WHERE review.case_key = $1`,
      [`PO:${fixture.sourcePoId}:reconciliation_conflict`, fixture.firstSplitRef]
    );
    assert.equal(accepted.rows[0]?.status, "resolved");
    assert.equal(accepted.rows[0]?.resolution_action, "accept");
    assert.match(accepted.rows[0]?.conflict_fingerprint || "", /^[a-f0-9]{64}$/);
    assert.notEqual(accepted.rows[0]?.reconciliation_status, "review");
    assert.equal(accepted.rows[0]?.schedule_status, "Hold");
    assert.equal(accepted.rows[0]?.reconciliation_blocked, false);

    const changed = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: fixture.sourcePoId,
      source: "system",
      explicitReviewReason: `${reason} New receipt evidence arrived.`
    });
    assert.equal(changed.reconciliationStatus, "review");
    const reopened = await query(
      `SELECT status, resolution_action
         FROM scm_reconciliation_review_cases
        WHERE case_key = $1`,
      [`PO:${fixture.sourcePoId}:reconciliation_conflict`]
    );
    assert.deepEqual(reopened.rows, [{ status: "open", resolution_action: null }]);
  });
});

test("accepting a review preserves a split planning status saved after the review snapshot", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("post-review-plan");
    await createSplit(fixture, { status: "Hold", destinationLocationId: 15 });
    await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: fixture.sourcePoId,
      source: "manual",
      explicitReviewReason: "Review snapshot predates dispatch planning."
    });
    await query(
      `UPDATE scm_reconciliation_order_state
          SET application_status = 'Queued',
              netsuite_status_code = 'B',
              netsuite_status_text = 'Purchase Order : Pending Receipt',
              quantity_summary = jsonb_set(
                quantity_summary,
                ARRAY['targets', $2, 'hasActivePlan'],
                'false'::jsonb,
                false
              )
        WHERE order_kind = 'PO'
          AND source_order_netsuite_id = $1`,
      [fixture.sourcePoId, fixture.firstSplitRef]
    );
    await query(
      `UPDATE scm_transport_schedule schedule
          SET status = 'Planned',
              updated_by = 'dispatch-v2:post-review-plan-test',
              updated_at = state.reconciled_at + interval '1 minute'
         FROM scm_reconciliation_order_state state
        WHERE state.id = schedule.reconciliation_order_state_id
          AND lower(schedule.order_ref) = lower($1)`,
      [fixture.firstSplitRef]
    );
    const beforeAcceptance = await query(
      `SELECT state.application_status,
              state.quantity_summary->'targets'->$2->>'hasActivePlan' AS has_active_plan,
              schedule.status,
              schedule.updated_at > state.reconciled_at AS schedule_is_newer
         FROM scm_reconciliation_order_state state
         JOIN scm_transport_schedule schedule
           ON schedule.reconciliation_order_state_id = state.id
        WHERE state.order_kind = 'PO'
          AND state.source_order_netsuite_id = $1
          AND lower(schedule.order_ref) = lower($2)`,
      [fixture.sourcePoId, fixture.firstSplitRef]
    );
    assert.deepEqual(beforeAcceptance.rows, [{
      application_status: "Queued",
      has_active_plan: "false",
      status: "Planned",
      schedule_is_newer: true
    }]);

    await resolveScmReconciliationReview({
      kind: "PO",
      orderRef: fixture.sourcePoRef,
      resolution: "accept_current",
      note: "Accept without overwriting newer dispatch planning.",
      actor: "manual-split-authority-test",
      actorRole: "admin"
    });

    const persisted = await query(
      `SELECT schedule.status,
              schedule.updated_by,
              state.quantity_summary->'targets'->$2->>'applicationStatus'
                AS target_application_status
         FROM scm_transport_schedule schedule
         JOIN scm_reconciliation_order_state state
           ON state.id = schedule.reconciliation_order_state_id
        WHERE lower(schedule.order_ref) = lower($1)`,
      [fixture.firstSplitRef, fixture.firstSplitRef]
    );
    assert.deepEqual(persisted.rows, [{
      status: "Planned",
      updated_by: "dispatch-v2:post-review-plan-test",
      target_application_status: "Planned"
    }]);
  });
});

test("active split planning survives a later reconciliation snapshot and acceptance", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("active-plan-authority");
    await createSplit(fixture, { status: "Hold", destinationLocationId: 15 });
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       VALUES ('2399-12-30', 'draft', 'Active split authority fixture', 1)
       RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_plan_order_assignments (
         plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
         load_id, stop_id, assignment
       ) VALUES (
         $1, '2399-12-30', $2, $2, 'direct',
         'ACTIVE-SPLIT-AUTHORITY-LOAD', 'ACTIVE-SPLIT-AUTHORITY-STOP', $3::jsonb
       )`,
      [
        plan.rows[0].id,
        fixture.firstSplitRef,
        JSON.stringify({ dispatchPlanned: true, dispatchOrderKind: "PO" })
      ]
    );
    await query(
      `UPDATE scm_transport_schedule
          SET status = 'Planned',
              updated_by = 'dispatch-v2:active-plan-authority',
              updated_at = now() - interval '1 minute'
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [fixture.firstSplitRef]
    );
    await storeLinkedScmReconciliationTransactions({
      order: {
        kind: "PO",
        id: fixture.sourcePoId,
        tranid: fixture.sourcePoRef,
        destinationLocationId: 1,
        destinationLocation: "3445"
      },
      source: "manual",
      transactions: [{
        sourceOrderId: fixture.sourcePoId,
        sourceOrderRef: fixture.sourcePoRef,
        sourceOrderLine: "10",
        sourceLineKey: "10",
        transactionId: fixture.sourcePoId + 20,
        transactionType: "ItemRcpt",
        transactionRef: `IR-${fixture.sourcePoId + 20}`,
        status: "B",
        statusText: "Posted",
        transactionDate: "2026-08-31",
        lastModifiedAt: "2026-08-31T21:00:00.000Z",
        transactionLine: "1",
        transactionLineKey: "1",
        itemId: fixture.itemId,
        itemName: "Manual authority item",
        quantity: 5,
        unit: "EA",
        locationId: 15,
        location: "12441"
      }]
    });

    const reconciled = await reconcileScmOrderFamily({
      kind: "PO",
      sourceOrderId: fixture.sourcePoId,
      source: "manual",
      explicitReviewReason: "Active planned child must survive this review."
    });
    assert.equal(reconciled.reconciliationStatus, "review");
    assert.equal(reconciled.targets[fixture.firstSplitRef]?.hasActivePlan, true);
    assert.equal(
      reconciled.targets[fixture.firstSplitRef]?.hasActiveDispatchAssignment,
      true
    );
    assert.equal(reconciled.targets[fixture.firstSplitRef]?.applicationStatus, "Planned");
    assert.equal(reconciled.targets[fixture.firstSplitRef]?.reconciliationStatus, "ok");

    await resolveScmReconciliationReview({
      kind: "PO",
      orderRef: fixture.sourcePoRef,
      resolution: "accept_current",
      note: "Accept without replacing active dispatch planning.",
      actor: "manual-split-authority-test",
      actorRole: "admin"
    });
    const persisted = await query(
      `SELECT schedule.status, schedule.reconciliation_blocked,
              state.quantity_summary->'targets'->$2->>'applicationStatus'
                AS target_application_status
         FROM scm_transport_schedule schedule
         JOIN scm_reconciliation_order_state state
           ON state.id = schedule.reconciliation_order_state_id
        WHERE lower(schedule.order_ref) = lower($1)`,
      [fixture.firstSplitRef, fixture.firstSplitRef]
    );
    assert.deepEqual(persisted.rows, [{
      status: "Planned",
      reconciliation_blocked: false,
      target_application_status: "Planned"
    }]);
  });
});

test("manual split display status ignores family reconciliation derivation but preserves canonical completion", () => {
  const reconciliationEvidence = {
    scheduleStatus: "Hold",
    scheduleId: 42,
    scheduleUpdatedAt: "2026-08-31T16:00:00.000Z",
    reconciliationStatus: "review",
    reconciliationReconciledAt: "2026-08-31T16:10:00.000Z",
    reconciliationApplicationStatus: "Partially Done",
    blockingReview: true,
    preserveOperationalStatus: true
  };
  assert.equal(
    scmScheduleEffectiveReconciliationStatus(reconciliationEvidence),
    "Hold"
  );
  assert.equal(
    scmScheduleEffectiveReconciliationStatus({
      ...reconciliationEvidence,
      scheduleStatus: "Completed"
    }),
    "Completed"
  );
  const catalogOrder = { isScmSplit: true, scm: { status: "Hold" } };
  const catalogEvidence = {
    schedule_id: 42,
    schedule_status: "Hold",
    schedule_updated_at: "2026-08-31T16:00:00.000Z",
    reconciliation_status: "review",
    reconciled_at: "2026-08-31T16:10:00.000Z",
    reconciliation_application_status: "Partially Done",
    reconciliation_blocked: true
  };
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(catalogOrder, catalogEvidence),
    "Hold"
  );
  assert.equal(
    effectiveScmPurchaseOrderCatalogStatus(catalogOrder, {
      ...catalogEvidence,
      completion_event_id: 99
    }),
    "Completed"
  );
});

test("family repair is dry-run safe, exact, audited, and idempotent", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("repair");
    await createSplit(fixture, { status: "Queued", destinationLocationId: 15 });
    const cancelled = await createSplit(fixture, {
      ref: fixture.secondSplitRef,
      status: "Queued",
      destinationLocationId: 1
    });
    await query(
      `UPDATE dispatch_scm_po_splits
          SET status = 'cancelled', cancelled_at = now()
        WHERE id = $1`,
      [cancelled.split.id]
    );
    await query(
      `UPDATE scm_transport_schedule
          SET dropoff_point = NULL,
              reconciliation_blocked = true
        WHERE order_kind = 'PO'
          AND lower(order_ref) = ANY($1::text[])`,
      [[fixture.firstSplitRef.toLowerCase(), fixture.secondSplitRef.toLowerCase()]]
    );

    const options = {
      sourcePoRef: fixture.sourcePoRef,
      expectedActiveChildren: 1,
      actor: "manual-split-authority-test"
    };
    const dryRun = await repairScmManualSplitFamilyAuthority({ ...options, dryRun: true });
    assert.equal(dryRun.changedCount, 1);
    const afterDryRun = await query(
      `SELECT status, dropoff_point
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [fixture.firstSplitRef]
    );
    assert.deepEqual(afterDryRun.rows, [{ status: "Queued", dropoff_point: null }]);

    const applied = await repairScmManualSplitFamilyAuthority({ ...options, dryRun: false });
    assert.equal(applied.activeChildCount, 1);
    assert.equal(applied.changedCount, 1);
    assert.deepEqual(applied.changes.map((change) => ({
      orderRef: change.orderRef,
      status: change.after.status,
      dropoffPoint: change.after.dropoffPoint
    })), [{
      orderRef: fixture.firstSplitRef,
      status: "Hold",
      dropoffPoint: "12441"
    }]);

    const active = await query(
      `SELECT child.initial_scm_status, schedule.status,
              schedule.dropoff_point, schedule.reconciliation_blocked
         FROM dispatch_scm_po_splits split
         JOIN purchase_orders child ON child.netsuite_id = split.split_po_id
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(split.split_po_ref)
        WHERE lower(split.split_po_ref) = lower($1)`,
      [fixture.firstSplitRef]
    );
    assert.deepEqual(active.rows, [{
      initial_scm_status: "Hold",
      status: "Hold",
      dropoff_point: "12441",
      reconciliation_blocked: false
    }]);
    const cancelledState = await query(
      `SELECT child.initial_scm_status, schedule.status, schedule.dropoff_point
         FROM dispatch_scm_po_splits split
         JOIN purchase_orders child ON child.netsuite_id = split.split_po_id
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(split.split_po_ref)
        WHERE split.id = $1`,
      [cancelled.split.id]
    );
    assert.deepEqual(cancelledState.rows, [{
      initial_scm_status: "Queued",
      status: "Queued",
      dropoff_point: null
    }]);
    const audits = await query(
      `SELECT COUNT(*)::int AS count
         FROM dispatch_audit_log
        WHERE action = 'scm.manual_split_authority_repaired'
          AND lower(order_id) = lower($1)`,
      [fixture.firstSplitRef]
    );
    assert.equal(audits.rows[0]?.count, 1);

    const second = await repairScmManualSplitFamilyAuthority({ ...options, dryRun: false });
    assert.equal(second.changedCount, 0);
    const auditsAfterSecond = await query(
      `SELECT COUNT(*)::int AS count
         FROM dispatch_audit_log
        WHERE action = 'scm.manual_split_authority_repaired'
          AND lower(order_id) = lower($1)`,
      [fixture.firstSplitRef]
    );
    assert.equal(auditsAfterSecond.rows[0]?.count, 1);

    await assert.rejects(
      repairScmManualSplitFamilyAuthority({
        ...options,
        expectedActiveChildren: 2,
        dryRun: false
      }),
      /expected 2 active split children but found 1/i
    );
  });
});

test("targeted repair changes only named active children after status and destination guards", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("targeted-repair");
    await createSplit(fixture, { status: "Queued", destinationLocationId: 15 });
    await createSplit(fixture, {
      ref: fixture.secondSplitRef,
      status: "Queued",
      destinationLocationId: 1
    });
    const options = {
      sourcePoRef: fixture.sourcePoRef,
      expectedActiveChildren: 2,
      childRefs: [fixture.firstSplitRef],
      expectedCurrentStatus: "Queued",
      actor: "manual-split-authority-targeted-test",
      dryRun: false
    };

    const applied = await repairScmManualSplitFamilyAuthority(options);
    assert.equal(applied.activeChildCount, 2);
    assert.equal(applied.targetChildCount, 1);
    assert.equal(applied.changedCount, 1);
    assert.deepEqual(applied.changes.map((change) => change.orderRef), [fixture.firstSplitRef]);

    const children = await query(
      `SELECT split.split_po_ref, child.initial_scm_status, schedule.status
         FROM dispatch_scm_po_splits split
         JOIN purchase_orders child ON child.netsuite_id = split.split_po_id
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(split.split_po_ref)
        WHERE split.source_po_id = $1
        ORDER BY split.split_po_ref`,
      [fixture.sourcePoId]
    );
    assert.deepEqual(children.rows, [
      {
        split_po_ref: fixture.firstSplitRef,
        initial_scm_status: "Hold",
        status: "Hold"
      },
      {
        split_po_ref: fixture.secondSplitRef,
        initial_scm_status: "Queued",
        status: "Queued"
      }
    ]);

    await assert.rejects(
      repairScmManualSplitFamilyAuthority({
        ...options,
        childRefs: [`${fixture.firstSplitRef}-missing`]
      }),
      /requested active split children .* were not found/i
    );
    await assert.rejects(
      repairScmManualSplitFamilyAuthority({
        ...options,
        childRefs: [fixture.secondSplitRef],
        expectedCurrentStatus: "Hold"
      }),
      /expected current status Hold but found Queued/i
    );

    const idempotent = await repairScmManualSplitFamilyAuthority({
      ...options,
      expectedCurrentStatus: "Hold"
    });
    assert.equal(idempotent.changedCount, 0);
    const audits = await query(
      `SELECT order_id
         FROM dispatch_audit_log
        WHERE action = 'scm.manual_split_authority_repaired'
          AND operator_name = $1
        ORDER BY order_id`,
      [options.actor]
    );
    assert.deepEqual(audits.rows, [{ order_id: fixture.firstSplitRef }]);
  });
});

test("targeted repair can restore Planned only with exact active plan evidence", async () => {
  await inRollback(async () => {
    const fixture = await seedSource("targeted-planned-repair");
    await createSplit(fixture, { status: "Hold", destinationLocationId: 15 });
    await query(
      `UPDATE scm_transport_schedule
          SET status = 'Partially Done'
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [fixture.firstSplitRef]
    );
    const options = {
      sourcePoRef: fixture.sourcePoRef,
      expectedActiveChildren: 1,
      childRefs: [fixture.firstSplitRef],
      expectedCurrentStatus: "Partially Done",
      replacementStatus: "Planned",
      actor: "manual-split-authority-planned-repair-test",
      dryRun: false
    };
    await assert.rejects(
      repairScmManualSplitFamilyAuthority(options),
      /active dispatch assignment/i
    );

    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       VALUES ('2399-12-30', 'draft', 'Targeted planned repair fixture', 1)
       RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_plan_order_assignments (
         plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
         load_id, stop_id, assignment
       ) VALUES (
         $1, '2399-12-30', $2, $2, 'direct',
         'TARGETED-PLANNED-REPAIR-LOAD', 'TARGETED-PLANNED-REPAIR-STOP', $3::jsonb
       )`,
      [
        plan.rows[0].id,
        fixture.firstSplitRef,
        JSON.stringify({ dispatchPlanned: true, dispatchOrderKind: "PO" })
      ]
    );
    const applied = await repairScmManualSplitFamilyAuthority(options);
    assert.equal(applied.changedCount, 1);
    assert.equal(applied.changes[0]?.after.status, "Planned");
    const persisted = await query(
      `SELECT child.initial_scm_status, schedule.status,
              schedule.reconciliation_blocked
         FROM dispatch_scm_po_splits split
         JOIN purchase_orders child ON child.netsuite_id = split.split_po_id
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(split.split_po_ref)
        WHERE lower(split.split_po_ref) = lower($1)`,
      [fixture.firstSplitRef]
    );
    assert.deepEqual(persisted.rows, [{
      initial_scm_status: "Hold",
      status: "Planned",
      reconciliation_blocked: false
    }]);
  });
});

test("family repair rejects invalid scope and destination authority before writing", async () => {
  await assert.rejects(
    repairScmManualSplitFamilyAuthority(),
    /source PO ref, repair actor, and a positive expected active-child count are required/i
  );
  await inRollback(async () => {
    const fixture = await seedSource("repair-guards");
    const created = await createSplit(fixture, { status: "Queued", destinationLocationId: 15 });
    const options = {
      sourcePoRef: fixture.sourcePoRef,
      expectedActiveChildren: 1,
      actor: "manual-split-authority-test",
      dryRun: false
    };

    await assert.rejects(
      repairScmManualSplitFamilyAuthority({ ...options, sourcePoRef: `${fixture.sourcePoRef}-missing` }),
      /expected one exact source PO .* but found 0/i
    );

    await query(
      `UPDATE dispatch_scm_po_splits
          SET split_po_ref = ''
        WHERE id = $1`,
      [created.split.id]
    );
    await assert.rejects(
      repairScmManualSplitFamilyAuthority(options),
      /active split references .* missing or duplicated/i
    );
    await query(
      `UPDATE dispatch_scm_po_splits
          SET split_po_ref = $2,
              details = jsonb_set(details, '{destinationLocation}', '"2967"'::jsonb)
        WHERE id = $1`,
      [created.split.id, fixture.firstSplitRef]
    );
    await assert.rejects(
      repairScmManualSplitFamilyAuthority(options),
      /confirmed destination .* does not match its child PO mirror/i
    );

    const untouched = await query(
      `SELECT initial_scm_status
         FROM purchase_orders
        WHERE netsuite_id = $1`,
      [created.split.splitPoId]
    );
    assert.equal(untouched.rows[0]?.initial_scm_status, "Queued");
  });
});
