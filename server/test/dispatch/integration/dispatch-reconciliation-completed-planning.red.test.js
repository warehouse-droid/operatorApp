// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import {
  listReconciliationCompletedOperationallyPendingDispatchRefs
} from "../../../src/dispatch-history-mode.js";
import { recordDriverJobPhotos } from "../../../src/driver-repository.js";
import { assertNoRestrictedScmDispatchOrders } from "../../../src/server.js";
import {
  appendDriverCompletedVisitPhotos,
  getDriverCompletedVisit
} from "../../../src/driver-completed-photo-repository.js";

after(async () => {
  await closeDb();
});

function fixtureRef(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`.toUpperCase();
}

async function seedReconciliationTarget({
  scheduleStatus = "Queued",
  reconciliationStatus = "ok",
  hidden = false,
  operationallyCompleted = false,
  preserveOperationalStatus = false,
  method = "MBT"
} = {}) {
  const sourceRef = fixtureRef("POB-RECON-DISPATCH");
  const targetRef = fixtureRef("SN-RECON-DISPATCH");
  const sourceId = Date.now() + Math.floor(Math.random() * 100000);
  const inserted = await query(
    `INSERT INTO scm_reconciliation_order_state (
       order_kind, source_order_netsuite_id, source_order_ref,
       application_status, reconciliation_status, reconciliation_source,
       ordered_qty, received_qty, remaining_qty, quantity_summary, reconciled_at
     ) VALUES (
       'PO', $1, $2,
       'Completed', $3, 'manual',
       10, 10, 0, $4::jsonb, now()
     ) RETURNING id`,
    [
      sourceId,
      sourceRef,
      reconciliationStatus,
      JSON.stringify({
        family: { ordered: 10, received: 10, remaining: 0, applicationStatus: "Completed" },
        targets: {
          [targetRef]: {
            orderRef: targetRef,
            targetKind: "source_residual",
            ordered: 10,
            received: 10,
            remaining: 0,
            applicationStatus: "Completed",
            hidden,
            operationallyCompleted,
            preserveOperationalStatus
          }
        }
      })
    ]
  );
  await query(
    `INSERT INTO scm_transport_schedule (
       order_kind, source_table, order_ref, method,
       pickup_point, dropoff_point, brand, content, weight_lbs,
       status, reconciliation_blocked, reconciliation_order_state_id,
       created_by, updated_by
     ) VALUES (
       'PO', 'purchase_orders', $1, $2,
       'Vendor yard', '3445', 'Fixture vendor', $1, 100,
       $3, $4, $5,
       'reconciliation-dispatch-test', 'reconciliation-dispatch-test'
     )`,
    [
      targetRef,
      method,
      scheduleStatus,
      ["review", "missing"].includes(reconciliationStatus),
      inserted.rows[0].id
    ]
  );
  return { sourceRef, targetRef };
}

function driverPhoto(label) {
  return `r2://driver/driver-dropoff-photo/2026/09/08/${crypto.randomUUID()}/${label}.jpg`;
}

test("reconciliation-only Completed target remains planable, then Driver completion and photo append make it terminal", async () => {
  await withTransaction(async () => {
    const fixture = await seedReconciliationTarget();
    const before = await listReconciliationCompletedOperationallyPendingDispatchRefs({
      candidateRefs: [fixture.targetRef]
    });
    assert.equal(before.has(fixture.targetRef.toLowerCase()), true,
      "receipt reconciliation without operational evidence must remain Dispatch-planable");
    await assert.doesNotReject(() => assertNoRestrictedScmDispatchOrders(
      [fixture.targetRef],
      "add this reconciliation-only target to Dispatch"
    ));

    const planDate = "1901-09-08";
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, revision, confirmed_at, note)
       VALUES ($1::date, 'confirmed', 1, now(), 'Reconciliation-completed Driver lifecycle fixture')
       RETURNING id`,
      [planDate]
    );
    const jobId = fixtureRef("RECON-DISPATCH-JOB");
    const initialPhotos = [driverPhoto("arrival"), driverPhoto("delivery")];
    const completed = await recordDriverJobPhotos("reconciliation-dispatch-driver", jobId, {
      photoDataUrls: initialPhotos,
      occurredAt: "1901-09-08T14:05:00.000Z",
      job: {
        jobId,
        planId: Number(plan.rows[0].id),
        planDate,
        driverName: "Reconciliation Dispatch Driver",
        truckId: "reconciliation-truck",
        truckPlate: "RECON-1",
        loadId: "reconciliation-load",
        loadName: "Reconciliation pending load",
        stopId: fixtureRef("RECON-DROP"),
        stopType: "dropoff",
        orderRefs: [fixture.targetRef],
        physicalVisitJobIds: [jobId],
        physicalVisitStopIds: [],
        location: "3445",
        address: "3445 Kennedy Road",
        destinationLocationId: 1,
        requiredPhotos: 2,
        startedAt: "1901-09-08T14:00:00.000Z",
        mbt: { schemaVersion: 1 }
      }
    });
    assert.equal(completed.status, "complete");
    assert.deepEqual(completed.photo_data_urls, initialPhotos);

    const after = await listReconciliationCompletedOperationallyPendingDispatchRefs({
      candidateRefs: [fixture.targetRef]
    });
    assert.equal(after.has(fixture.targetRef.toLowerCase()), false,
      "a genuine Driver completion must permanently remove the reconciliation-only allowance");
    await assert.rejects(
      () => assertNoRestrictedScmDispatchOrders(
        [fixture.targetRef],
        "add this Driver-completed target to Dispatch"
      ),
      (error) => error?.code === "DISPATCH_RESTRICTED_SCM_ORDER" && error?.status === 409
    );

    const visit = await getDriverCompletedVisit({ recordId: Number(completed.id) });
    assert.equal(visit.appendable, true);
    assert.deepEqual(visit.photoReferences, initialPhotos);
    const requestId = crypto.randomUUID();
    const photoId = crypto.randomUUID();
    const appendedReference =
      `r2://dispatch-stop-evidence/driver-dropoff-photo/2026/09/08/${requestId}-${photoId}/supplemental.jpg`;
    const appended = await appendDriverCompletedVisitPhotos({
      recordId: Number(completed.id),
      expectedStateHash: visit.stateHash,
      requestId,
      additionEventId: crypto.randomUUID(),
      actorId: "reconciliation-dispatcher",
      actorName: "Reconciliation Dispatcher",
      reason: "Append the final delivery-condition evidence.",
      photos: [{
        photoId,
        ordinal: 1,
        byteSize: 512,
        sha256: "a".repeat(64),
        mimeType: "image/jpeg",
        objectReference: appendedReference
      }]
    });
    assert.deepEqual(appended.photos, [...initialPhotos, appendedReference]);
  }, { rollback: true });
});

test("operational, held, hidden, reviewed, and non-MBT Completed targets remain restricted", async () => {
  await withTransaction(async () => {
    const fixtures = [
      await seedReconciliationTarget({ operationallyCompleted: true }),
      await seedReconciliationTarget({ preserveOperationalStatus: true }),
      await seedReconciliationTarget({ scheduleStatus: "Hold" }),
      await seedReconciliationTarget({ hidden: true }),
      await seedReconciliationTarget({ reconciliationStatus: "review" }),
      await seedReconciliationTarget({ method: "Vendor" })
    ];
    const eligible = await listReconciliationCompletedOperationallyPendingDispatchRefs({
      candidateRefs: fixtures.map((fixture) => fixture.targetRef)
    });
    assert.deepEqual([...eligible], []);
  }, { rollback: true });
});
