// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createDispatchPlan,
  saveDispatchPlanSnapshot
} from "../../../src/dispatch-plan-repository.js";
import {
  createScmPurchaseOrderSplit,
  listScmSchedule
} from "../../../src/dispatch-repository.js";
import { driverCompanyDate } from "../../../src/driver-plan-date-policy.js";
import {
  planJobsForDriver,
  recordDriverJobPhotos,
  startDriverJob
} from "../../../src/driver-repository.js";
import {
  reconcileScmOrderFamily,
  storeLinkedScmReconciliationTransactions
} from "../../../src/scm-reconciliation-repository.js";

after(closeDb);

const FIRST_RECEIPT = 629.46;
const SECOND_RECEIPT = 629.46;
const NEW_SPLIT_RECEIPT = 1678.56;
const LATER_SPLIT_RECEIPT = 5544.24;
const ORIGINAL_TOTAL = FIRST_RECEIPT + SECOND_RECEIPT;
const AMENDED_TOTAL = ORIGINAL_TOTAL + NEW_SPLIT_RECEIPT;
const FINAL_TOTAL = AMENDED_TOTAL + LATER_SPLIT_RECEIPT;
const STALE_DESTINATION_SOURCE_TOTAL = 4406.4;
const STALE_DESTINATION_SPLIT_QTY = 2121.6;
const STALE_DESTINATION_RECEIVED_QTY = 2692.8;

function fixtureIdentity() {
  const token = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const seed = Number.parseInt(token.slice(0, 8), 16);
  const baseId = 8_940_000_000_000 + (seed * 20);
  return {
    token,
    sourcePoId: baseId + 1,
    sourceLineId: baseId + 2,
    itemId: baseId + 3,
    sourcePoRef: `POB03658-TEST-${token.slice(0, 10)}`,
    childRefs: [
      `POB03658-SPLIT-A-${token.slice(0, 10)}`,
      `POB03658-SPLIT-B-${token.slice(0, 10)}`,
      `POB03658-NEW-SPLIT-${token.slice(0, 10)}`,
      `POB03658-LATER-SPLIT-${token.slice(0, 10)}`
    ],
    driverLogin: `pob03658-driver-${token.slice(0, 10).toLowerCase()}`,
    truckPlate: `P36-${token.slice(0, 6)}`
  };
}

async function seedPob03658Source(fixture, { ordered = ORIGINAL_TOTAL } = {}) {
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, source_location_id,
       source_location, dispatch_vendor_yard, receipt_status,
       initial_scm_status, netsuite_active, synced_at
     ) VALUES (
       $1::bigint, $2, current_date, $1::bigint + 10,
       'POB03658 lifecycle vendor', 'E',
       'Purchase Order : Pending Billing/Partially Received',
       1, '3445', 15, '12441', 'POB03658 Vendor Yard', 'partially_received',
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
       received_sales_qty, netsuite_received_qty,
       netsuite_received_baseline_qty, item_weight, netsuite_active, synced_at, raw
     ) VALUES (
       $2::bigint, $1::bigint, 10, $3::bigint,
       'POB03658 production-shaped item', 'POB03658-ITEM', $4, 'EA',
       1, '3445', 0, 0, 0, 0,
       0, 0, 0, 0, 0,
       0, 0, 0,
       0, 0, 0, 25, true, now(),
       '{"sourceLineAliases":["10"],"orderLine":"10","orderLineAliases":["10"]}'::jsonb
     )`,
    [fixture.sourcePoId, fixture.sourceLineId, fixture.itemId, ordered]
  );
  await query(
    `INSERT INTO dispatch_drivers (name, login, active)
     VALUES ('POB03658 Test Driver', $1, true)`,
    [fixture.driverLogin]
  );
  await query(
    `INSERT INTO dispatch_trucks (plate, active)
     VALUES ($1, true)`,
    [fixture.truckPlate]
  );
}

async function createSplit(fixture, { childRef, quantity, destinationLocationId }) {
  return createScmPurchaseOrderSplit({
    sourcePoRef: fixture.sourcePoRef,
    newPoRef: childRef,
    destinationLocationId,
    status: "Queued",
    lines: [{ lineRowId: fixture.sourceLineId, salesQty: quantity }],
    createdBy: "pob03658-split-driver-lifecycle-test"
  });
}

function splitPlanTruck(fixture, {
  childRef,
  destination,
  destinationLocationId = destination === "12441" ? 15 : 1,
  sequence
}) {
  const loadId = `POB03658-LOAD-${sequence}-${fixture.token.slice(0, 8)}`;
  return [{
    id: `POB03658-TRUCK-${fixture.token.slice(0, 8)}`,
    plate: fixture.truckPlate,
    base: "3445",
    driverLogin: fixture.driverLogin,
    driver: fixture.driverLogin,
    loads: [{
      id: loadId,
      name: `POB03658 Split ${sequence}`,
      driverLogin: fixture.driverLogin,
      driverName: fixture.driverLogin,
      truckId: `POB03658-TRUCK-${fixture.token.slice(0, 8)}`,
      truckPlate: fixture.truckPlate,
      switchYard: "3445",
      parkingSpot: `P${sequence}`,
      plannedStartMinute: 420 + (sequence * 60),
      plannedFinishMinute: 470 + (sequence * 60),
      driverSequence: 0,
      stops: [
        {
          id: `${loadId}-PICKUP`,
          type: "pick",
          orderId: childRef,
          location: "POB03658 Vendor Yard"
        },
        {
          id: `${loadId}-DROPOFF`,
          type: "drop",
          orderId: childRef,
          location: destination,
          destinationLocationId
        }
      ]
    }]
  }];
}

async function planSplit(fixture, {
  childRef,
  destination,
  destinationLocationId = destination === "12441" ? 15 : 1,
  sequence
}) {
  const planDate = driverCompanyDate();
  const plan = await createDispatchPlan({
    planDate,
    note: `POB03658 split ${sequence} Driver lifecycle`
  });
  const saved = await saveDispatchPlanSnapshot(plan.id, {
    planDate,
    baseRevision: plan.revision,
    orders: [{
      id: childRef,
      type: "PO",
      sourceYard: "POB03658 Vendor Yard",
      pickupLocations: ["POB03658 Vendor Yard"],
      destinationYard: destination,
      address: destination
    }],
    trucks: splitPlanTruck(fixture, {
      childRef,
      destination,
      destinationLocationId,
      sequence
    }),
    summary: {},
    sessionId: `pob03658-driver-${fixture.token}-${sequence}`
  });
  const assignment = await query(
    `SELECT order_ref, planned_order_ref, assignment
       FROM dispatch_plan_order_assignments
      WHERE plan_id = $1
        AND (
          lower(order_ref) = lower($2)
          OR lower(NULLIF(planned_order_ref, '')) = lower($2)
        )`,
    [plan.id, childRef]
  );
  assert.equal(assignment.rowCount, 1, `${childRef} must have one real plan assignment`);

  const jobs = planJobsForDriver(saved, fixture.driverLogin)
    .filter((job) => ["pickup", "dropoff"].includes(job.stopType));
  assert.deepEqual(
    jobs.map((job) => job.stopType),
    ["pickup", "dropoff"],
    `${childRef} must materialize the Driver pickup and dropoff jobs`
  );
  return { plan, jobs };
}

async function completePlannedSplit(fixture, { childRef, sequence, jobs }) {
  for (const job of jobs) {
    await startDriverJob(fixture.driverLogin, job.jobId, { job });
    await recordDriverJobPhotos(fixture.driverLogin, job.jobId, {
      job,
      photoDataUrls: [
        `r2://pob03658-test/${sequence}/${job.stopType}/1.jpg`,
        `r2://pob03658-test/${sequence}/${job.stopType}/2.jpg`
      ]
    });
  }

  const dropoff = jobs.find((job) => job.stopType === "dropoff");
  const completion = await query(
    `SELECT order_kind, order_ref, completion_evidence_type,
            completion_evidence_id
       FROM dispatch_order_completion_status
      WHERE order_kind = 'PO'
        AND lower(order_ref) = lower($1)`,
    [childRef]
  );
  assert.equal(completion.rowCount, 1, `${childRef} must have canonical completion evidence`);
  assert.equal(completion.rows[0].completion_evidence_type, "driver_job");
  assert.equal(completion.rows[0].completion_evidence_id, dropoff?.jobId);
}

async function assignAndCompleteSplit(fixture, options) {
  const planned = await planSplit(fixture, options);
  await completePlannedSplit(fixture, { ...options, jobs: planned.jobs });
}

async function recordExactChildReceipt(childRef, quantity) {
  const updated = await query(
    `UPDATE purchase_order_lines line
        SET received_sales_qty = $2,
            confirmed_at = now(),
            confirmed_by = 'pob03658-driver-lifecycle-test',
            synced_at = now()
       FROM purchase_orders child
      WHERE child.netsuite_id = line.purchase_order_id
        AND lower(COALESCE(NULLIF(child.dispatch_ref, ''), child.tranid)) = lower($1)
      RETURNING line.id`,
    [childRef, quantity]
  );
  assert.equal(updated.rowCount, 1, `${childRef} must have one exact received split line`);
}

async function updateParentRecord(fixture, { ordered, received }) {
  await query(
    `UPDATE purchase_order_lines
        SET quantity = $2,
            netsuite_received_qty = $3,
            synced_at = now()
      WHERE id = $1`,
    [fixture.sourceLineId, ordered, received]
  );
  await query(
    `UPDATE purchase_orders
        SET status = 'E',
            status_text = 'Purchase Order : Pending Billing/Partially Received',
            status_updated_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1`,
    [fixture.sourcePoId]
  );
}

function authoritativeParent(fixture, { ordered, received }) {
  return {
    kind: "PO",
    id: fixture.sourcePoId,
    tranid: fixture.sourcePoRef,
    status: "E",
    statusText: "Purchase Order : Pending Billing/Partially Received",
    sourceLocationId: 15,
    sourceLocation: "12441",
    destinationLocationId: 1,
    destinationLocation: "3445",
    lastModifiedAt: new Date().toISOString(),
    lines: [{
      sourceLineKey: "10",
      sourceLineAliases: ["10"],
      orderLine: "10",
      orderLineAliases: ["10"],
      identityStatus: "exact",
      stage: "receiving",
      itemId: fixture.itemId,
      itemName: "POB03658 production-shaped item",
      sku: "POB03658-ITEM",
      quantity: ordered,
      cumulativeProgressQuantity: received,
      cumulativeProgressObserved: true,
      unit: "EA",
      locationId: 1,
      location: "3445"
    }]
  };
}

function receiptEvidence(fixture, receipts) {
  return receipts.map(({ quantity, locationId, transactionOffset }) => ({
    sourceOrderId: fixture.sourcePoId,
    sourceOrderRef: fixture.sourcePoRef,
    sourceOrderLine: "10",
    sourceLineKey: "10",
    transactionId: fixture.sourcePoId + transactionOffset,
    transactionType: "ItemRcpt",
    transactionRef: `IR-POB03658-${fixture.token.slice(0, 8)}-${transactionOffset}`,
    status: "B",
    statusText: "Posted",
    transactionDate: driverCompanyDate(),
    lastModifiedAt: new Date().toISOString(),
    transactionLine: String(transactionOffset),
    transactionLineKey: String(transactionOffset),
    itemId: fixture.itemId,
    itemName: "POB03658 production-shaped item",
    quantity,
    unit: "EA",
    locationId,
    location: locationId === 15 ? "12441" : "3445"
  }));
}

async function storeReceiptEvidence(fixture, receipts) {
  await storeLinkedScmReconciliationTransactions({
    order: {
      kind: "PO",
      id: fixture.sourcePoId,
      tranid: fixture.sourcePoRef,
      destinationLocationId: 1,
      destinationLocation: "3445"
    },
    source: "manual",
    transactions: receiptEvidence(fixture, receipts)
  });
}

async function reconcile(fixture, quantities) {
  return reconcileScmOrderFamily({
    kind: "PO",
    sourceOrderId: fixture.sourcePoId,
    source: "system",
    authoritativeOrder: authoritativeParent(fixture, quantities)
  });
}

async function assertNoReconcileReview(fixture, result, phase) {
  assert.notEqual(result.applicationStatus, "Reconcile Review", phase);
  assert.notEqual(result.reconciliationStatus, "review", phase);
  assert.equal(result.reason, "", phase);
  const review = await query(
    `SELECT count(*)::int AS count
       FROM scm_reconciliation_review_cases review
       JOIN scm_reconciliation_order_state state
         ON state.id = review.order_state_id
      WHERE state.order_kind = 'PO'
        AND state.source_order_netsuite_id = $1
        AND review.status = 'open'`,
    [fixture.sourcePoId]
  );
  assert.equal(review.rows[0]?.count, 0, `${phase}: no review case may be open`);
  const blocked = await query(
    `SELECT count(*)::int AS count
       FROM scm_transport_schedule
      WHERE reconciliation_order_state_id = (
        SELECT id
          FROM scm_reconciliation_order_state
         WHERE order_kind = 'PO'
           AND source_order_netsuite_id = $1
      )
        AND reconciliation_blocked = true`,
    [fixture.sourcePoId]
  );
  assert.equal(blocked.rows[0]?.count, 0, `${phase}: no family schedule may be blocked`);
}

test("POB03658: a matched parent update plus a new Driver-completed split stays out of Reconcile Review", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = fixtureIdentity();
      await seedPob03658Source(fixture);

      await createSplit(fixture, {
        childRef: fixture.childRefs[0],
        quantity: FIRST_RECEIPT,
        destinationLocationId: 15
      });
      await createSplit(fixture, {
        childRef: fixture.childRefs[1],
        quantity: SECOND_RECEIPT,
        destinationLocationId: 1
      });

      const initial = await reconcile(fixture, { ordered: ORIGINAL_TOTAL, received: 0 });
      await assertNoReconcileReview(fixture, initial, "initial split family");

      await assignAndCompleteSplit(fixture, {
        childRef: fixture.childRefs[0],
        destination: "12441",
        sequence: 1
      });
      await recordExactChildReceipt(fixture.childRefs[0], FIRST_RECEIPT);
      await updateParentRecord(fixture, { ordered: ORIGINAL_TOTAL, received: FIRST_RECEIPT });
      await storeReceiptEvidence(fixture, [{
        quantity: FIRST_RECEIPT,
        locationId: 15,
        transactionOffset: 101
      }]);
      const first = await reconcile(fixture, {
        ordered: ORIGINAL_TOTAL,
        received: FIRST_RECEIPT
      });
      await assertNoReconcileReview(fixture, first, "first completed split");
      assert.equal(first.applicationStatus, "Partially Done");
      assert.equal(first.targets[fixture.childRefs[0]]?.received, FIRST_RECEIPT);
      assert.equal(first.targets[fixture.childRefs[0]]?.remaining, 0);
      assert.equal(first.targets[fixture.childRefs[0]]?.reconciliationStatus, "ok");

      await assignAndCompleteSplit(fixture, {
        childRef: fixture.childRefs[1],
        destination: "3445",
        sequence: 2
      });
      await recordExactChildReceipt(fixture.childRefs[1], SECOND_RECEIPT);
      await updateParentRecord(fixture, { ordered: ORIGINAL_TOTAL, received: ORIGINAL_TOTAL });
      const priorReceipts = [
        { quantity: FIRST_RECEIPT, locationId: 15, transactionOffset: 101 },
        { quantity: SECOND_RECEIPT, locationId: 1, transactionOffset: 102 }
      ];
      await storeReceiptEvidence(fixture, priorReceipts);
      const previouslyComplete = await reconcile(fixture, {
        ordered: ORIGINAL_TOTAL,
        received: ORIGINAL_TOTAL
      });
      await assertNoReconcileReview(fixture, previouslyComplete, "previously matched complete record");
      assert.equal(previouslyComplete.applicationStatus, "Completed");

      // This is the POB03658 regression boundary: NetSuite legitimately increases
      // the parent line after all prior receipt records matched. The new local row is
      // already synchronized before reconciliation, so it must become usable capacity.
      await updateParentRecord(fixture, { ordered: AMENDED_TOTAL, received: ORIGINAL_TOTAL });
      await createSplit(fixture, {
        childRef: fixture.childRefs[2],
        quantity: NEW_SPLIT_RECEIPT,
        destinationLocationId: 1
      });
      const firstAmendmentPlan = await planSplit(fixture, {
        childRef: fixture.childRefs[2],
        destination: "3445",
        sequence: 3
      });
      const afterParentUpdate = await reconcile(fixture, {
        ordered: AMENDED_TOTAL,
        received: ORIGINAL_TOTAL
      });
      await assertNoReconcileReview(fixture, afterParentUpdate, "matched parent quantity update");
      assert.equal(afterParentUpdate.applicationStatus, "Partially Done");
      assert.equal(afterParentUpdate.quantities.remaining, NEW_SPLIT_RECEIPT);

      await completePlannedSplit(fixture, {
        childRef: fixture.childRefs[2],
        sequence: 3,
        jobs: firstAmendmentPlan.jobs
      });
      await recordExactChildReceipt(fixture.childRefs[2], NEW_SPLIT_RECEIPT);
      await updateParentRecord(fixture, { ordered: AMENDED_TOTAL, received: AMENDED_TOTAL });

      // Keep the two earlier location-specific IR rows unchanged. The authoritative
      // cumulative quantity supplies the exact balance for the newly completed child.
      await storeReceiptEvidence(fixture, priorReceipts);
      const completed = await reconcile(fixture, {
        ordered: AMENDED_TOTAL,
        received: AMENDED_TOTAL
      });
      await assertNoReconcileReview(fixture, completed, "new split Driver completion");
      assert.equal(completed.applicationStatus, "Completed");

      // Parent quantity amendments are recurring, not one-off. Repeat the same
      // complete -> increase -> split -> Driver complete transition with the
      // actual 5,544.24 increase observed on POB03658.
      await updateParentRecord(fixture, { ordered: FINAL_TOTAL, received: AMENDED_TOTAL });
      await createSplit(fixture, {
        childRef: fixture.childRefs[3],
        quantity: LATER_SPLIT_RECEIPT,
        destinationLocationId: 1
      });
      const laterAmendmentPlan = await planSplit(fixture, {
        childRef: fixture.childRefs[3],
        destination: "3445",
        sequence: 4
      });
      const afterLaterParentUpdate = await reconcile(fixture, {
        ordered: FINAL_TOTAL,
        received: AMENDED_TOTAL
      });
      await assertNoReconcileReview(
        fixture,
        afterLaterParentUpdate,
        "later matched parent quantity update"
      );
      assert.equal(afterLaterParentUpdate.applicationStatus, "Partially Done");
      assert.equal(afterLaterParentUpdate.quantities.remaining, LATER_SPLIT_RECEIPT);

      await completePlannedSplit(fixture, {
        childRef: fixture.childRefs[3],
        sequence: 4,
        jobs: laterAmendmentPlan.jobs
      });
      await recordExactChildReceipt(fixture.childRefs[3], LATER_SPLIT_RECEIPT);
      await updateParentRecord(fixture, { ordered: FINAL_TOTAL, received: FINAL_TOTAL });
      await storeReceiptEvidence(fixture, priorReceipts);
      const finallyCompleted = await reconcile(fixture, {
        ordered: FINAL_TOTAL,
        received: FINAL_TOTAL
      });
      await assertNoReconcileReview(
        fixture,
        finallyCompleted,
        "later split Driver completion"
      );
      assert.equal(finallyCompleted.applicationStatus, "Completed");
      assert.deepEqual(finallyCompleted.quantities, {
        ordered: FINAL_TOTAL,
        fulfilled: 0,
        received: FINAL_TOTAL,
        abandoned: 0,
        remaining: 0,
        destinationRemaining: 0
      });
      for (const childRef of fixture.childRefs) {
        assert.equal(
          finallyCompleted.targets[childRef]?.received,
          finallyCompleted.targets[childRef]?.ordered,
          childRef
        );
        assert.equal(finallyCompleted.targets[childRef]?.remaining, 0, childRef);
        assert.equal(finallyCompleted.targets[childRef]?.reconciliationStatus, "ok", childRef);
        const [scheduled] = await listScmSchedule({
          kind: "PO",
          exactRef: childRef,
          view: "completed",
          audience: "scm"
        });
        assert.equal(scheduled?.calculatedStatus, "Completed", childRef);
        assert.equal(scheduled?.dispatchCompletionEvidenceType, "driver_job", childRef);
      }

      const replay = await reconcile(fixture, {
        ordered: FINAL_TOTAL,
        received: FINAL_TOTAL
      });
      await assertNoReconcileReview(fixture, replay, "final identical replay");
      assert.equal(replay.applicationStatus, "Completed");
      assert.equal(replay.quantities.remaining, 0);
    });
  } finally {
    await rollback.rollback();
  }
});

test("POB03658: canonical Driver drop-off destination supersedes stale split-yard metadata", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = fixtureIdentity();
      await seedPob03658Source(fixture, {
        ordered: STALE_DESTINATION_SOURCE_TOTAL
      });
      await createSplit(fixture, {
        childRef: fixture.childRefs[0],
        quantity: STALE_DESTINATION_SPLIT_QTY,
        destinationLocationId: 15
      });

      const planned = await planSplit(fixture, {
        childRef: fixture.childRefs[0],
        destination: "3445",
        destinationLocationId: 1,
        sequence: 1
      });
      await completePlannedSplit(fixture, {
        childRef: fixture.childRefs[0],
        sequence: 1,
        jobs: planned.jobs
      });

      const persistedEvidence = await query(
        `SELECT child_line.location_id AS stale_split_location_id,
                child_line.received_sales_qty,
                job.job_details->>'destinationLocationId'
                  AS completed_destination_location_id
           FROM dispatch_scm_po_split_lines ledger
           JOIN dispatch_scm_po_splits split ON split.id = ledger.split_id
           JOIN purchase_order_lines child_line ON child_line.id = ledger.split_line_id
           JOIN driver_job_records job
             ON job.job_id = $2
            AND job.status = 'complete'
            AND job.stop_type = 'dropoff'
          WHERE split.split_po_ref = $1`,
        [
          fixture.childRefs[0],
          planned.jobs.find((job) => job.stopType === "dropoff")?.jobId
        ]
      );
      assert.equal(Number(persistedEvidence.rows[0]?.stale_split_location_id), 15);
      assert.equal(Number(persistedEvidence.rows[0]?.completed_destination_location_id), 1);
      assert.equal(Number(persistedEvidence.rows[0]?.received_sales_qty), 0,
        "the regression must not depend on manually copying receipt quantity to the child line");

      await updateParentRecord(fixture, {
        ordered: STALE_DESTINATION_SOURCE_TOTAL,
        received: STALE_DESTINATION_RECEIVED_QTY
      });
      await storeReceiptEvidence(fixture, [{
        quantity: STALE_DESTINATION_RECEIVED_QTY,
        locationId: 1,
        transactionOffset: 301
      }]);
      const reconciled = await reconcile(fixture, {
        ordered: STALE_DESTINATION_SOURCE_TOTAL,
        received: STALE_DESTINATION_RECEIVED_QTY
      });

      await assertNoReconcileReview(
        fixture,
        reconciled,
        "completed Driver destination agrees with the NetSuite receipt yard"
      );
      assert.equal(reconciled.applicationStatus, "Partially Done");
      assert.equal(
        reconciled.targets[fixture.childRefs[0]]?.received,
        STALE_DESTINATION_SPLIT_QTY
      );
      assert.equal(reconciled.targets[fixture.childRefs[0]]?.remaining, 0);
      assert.equal(
        reconciled.targets[fixture.sourcePoRef]?.received,
        Number((STALE_DESTINATION_RECEIVED_QTY - STALE_DESTINATION_SPLIT_QTY).toFixed(6))
      );
    });
  } finally {
    await rollback.rollback();
  }
});
