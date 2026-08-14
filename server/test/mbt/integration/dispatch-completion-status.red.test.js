// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { manuallyCompleteDispatchOrder } from "../../../src/dispatch-completion-repository.js";
import {
  createMbbsBillingCasesFromCandidates,
  listMbbsBillingCandidates,
  previewMbbsBillingCandidatesBatch
} from "../../../src/mbt/mbbs-billing-candidate-service.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function driverDetails(orderKind, orderRef, address) {
  return {
    address,
    dropAddress: address,
    orderTypes: [orderKind],
    orders: [{ orderType: orderKind, orderRef, source: "dispatch" }]
  };
}

async function installCompletionRateGraph() {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const rateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_local_item_settings (
       item_code, display_name, description, item_type, category,
       pricing_mode, netsuite_mapping_local_key, system_owned,
       applicable_service_types, applicable_legacy_source_types,
       charge_basis, active, revision, created_by, updated_by
     ) VALUES (
       'DELIVERY_CHARGE_MBBS', 'Delivery Charge MBBS', 'Local MBBS delivery charge.',
       'delivery_fee', 'cross_charge', 'rate_card', 'delivery_charge_mbbs', false,
       ARRAY['delivery']::text[], ARRAY['SO','TO','PO','VRMA']::text[],
       'distance', true, 1, 'dispatch-completion-test', 'dispatch-completion-test'
     ) ON CONFLICT (item_code) DO NOTHING`
  );
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, currency, created_by, updated_by
     ) VALUES ($1, $2, $3, 'CAD', 'dispatch-completion-test', 'dispatch-completion-test')`,
    [rateCardId, `DISPATCH_COMPLETION_${suffix}`, `Dispatch completion ${suffix}`]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       effective_from, activated_at, validation_snapshot, created_by, updated_by
     ) VALUES (
       $1, $2, 1, 'draft', NULL, NULL, '{}'::jsonb,
       'dispatch-completion-test', 'dispatch-completion-test'
     )`,
    [rateCardVersionId, rateCardId]
  );
  await query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, item_code, service_code,
       sequence_number, minimum_metres, maximum_metres, amount_minor, currency,
       description, pricing_basis, boundary_rule, origin_yard_codes
     ) VALUES (
       $1, $2, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge',
       0, 0, NULL, 20000, 'CAD', 'Completion fallback test rate',
       'flat', 'upper_inclusive', ARRAY['2967']::text[]
     )`,
    [crypto.randomUUID(), rateCardVersionId]
  );
  await query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_at = now()
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId]
  );
  return rateCardVersionId;
}

test("U1: terminal Driver drops project one universal completed status for every dispatch order kind", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const completedAt = "2039-09-14T18:25:30.000Z";
  const references = [
    ["SO", `SO-U1-${suffix}`],
    ["TO", `TO-U1-${suffix}`],
    ["PO", `PO-U1-${suffix}`],
    ["VRMA", `VRMA-U1-${suffix}`],
    ["CUSTOM", `LOCAL-U1-${suffix}`]
  ];

  await inRollback(async () => {
    for (const [index, [orderKind, orderRef]] of references.entries()) {
      const jobId = `U1-DROP-${suffix}-${index}`;
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_date, driver_login, load_id, load_name,
           stop_id, stop_type, order_refs, status, completed_at, job_details
         ) VALUES (
           $1, '2039-09-14', 'dispatch-completion-test', $2, $3,
           $4, 'dropoff', $5::jsonb, 'complete', $6::timestamptz, $7::jsonb
         )`,
        [
          jobId,
          `U1-LOAD-${index}`,
          `Load ${index + 1}`,
          `U1-STOP-${index}`,
          JSON.stringify([orderRef]),
          completedAt,
          JSON.stringify(driverDetails(orderKind, orderRef, `${index + 1} Completion Road, Toronto, ON`))
        ]
      );
    }

    const projected = await query(
      `SELECT order_kind, order_ref, dispatch_completion_status,
              dispatch_completed_at, completion_evidence_type,
              completion_evidence_id
         FROM dispatch_order_completion_status
        WHERE order_ref = ANY($1::text[])
        ORDER BY order_kind, order_ref`,
      [references.map(([, orderRef]) => orderRef)]
    );

    assert.equal(projected.rowCount, references.length);
    assert.deepEqual(
      projected.rows.map((row) => row.order_kind).sort(),
      references.map(([orderKind]) => orderKind).sort()
    );
    for (const row of projected.rows) {
      assert.equal(row.dispatch_completion_status, "completed");
      assert.equal(new Date(row.dispatch_completed_at).toISOString(), completedAt);
      assert.equal(row.completion_evidence_type, "driver_job");
      assert.match(row.completion_evidence_id, new RegExp(`^U1-DROP-${suffix}-`, "u"));
    }
  });

  const afterRollback = await query(
    `SELECT count(*)::int AS count
       FROM dispatch_order_completion_status
      WHERE order_ref = ANY($1::text[])`,
    [references.map(([, orderRef]) => orderRef)]
  );
  assert.equal(afterRollback.rows[0].count, 0, "Driver completion and universal status must share one transaction");
});

test("U2: starts, travel, completed pickups, and incomplete drops never project completion", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const rows = [
      ["PICKUP", "pickup", "complete", "SO", `SO-U2-PICKUP-${suffix}`],
      ["TRAVEL", "travel", "complete", "TO", `TO-U2-TRAVEL-${suffix}`],
      ["STARTED", "dropoff", "in_progress", "PO", `PO-U2-STARTED-${suffix}`]
    ];
    for (const [label, stopType, status, orderKind, orderRef] of rows) {
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_date, driver_login, load_id, stop_id, stop_type,
           order_refs, status, started_at, completed_at, job_details
         ) VALUES (
           $1, '2039-09-15', 'dispatch-completion-test', $2, $3, $4,
           $5::jsonb, $6, '2039-09-15T10:00:00.000Z',
           CASE WHEN $6 = 'complete' THEN '2039-09-15T10:05:00.000Z'::timestamptz ELSE NULL END,
           $7::jsonb
         )`,
        [
          `U2-${label}-${suffix}`,
          `U2-LOAD-${label}`,
          `U2-STOP-${label}`,
          stopType,
          JSON.stringify([orderRef]),
          status,
          JSON.stringify(driverDetails(orderKind, orderRef, "Not a terminal completion"))
        ]
      );
    }

    const projected = await query(
      `SELECT order_kind, order_ref
         FROM dispatch_order_completion_status
        WHERE order_ref = ANY($1::text[])`,
      [rows.map((row) => row[4])]
    );
    assert.equal(projected.rowCount, 0);
  });
});

test("U3: a TOB00870-shaped direct dependency is completed and billed even without a TO Driver row", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const salesOrderId = 9_970_000_000 + Math.floor(Math.random() * 100_000);
    const transferOrderId = salesOrderId + 1;
    const salesOrderRef = `SO-U3-${suffix}`;
    const transferOrderRef = `TO-U3-${suffix}`;
    const driverJobId = `U3-SO-DROP-${suffix}`;
    const completedAt = "2039-09-16T18:25:30.000Z";

    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, customer, fulfillment_status,
         outbound_location_id, outbound_location, sales_order_type,
         dispatch_address, netsuite_active, synced_at
       ) VALUES (
         $1, $2, 'Direct dependency customer', 'not_fulfilled',
         28, '2967', 'Delivery',
         '100 Direct Customer Road, Toronto, ON', true, $3::timestamptz
       )`,
      [salesOrderId, salesOrderRef, completedAt]
    );
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, from_location_id, from_location,
         to_location_id, to_location, fulfillment_status,
         netsuite_active, synced_at
       ) VALUES (
         $1, $2, 28, '2967', 15, '12441', 'not_fulfilled', true, $3::timestamptz
       )`,
      [transferOrderId, transferOrderRef, completedAt]
    );
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, '2039-09-16', 'dispatch-completion-test', 'BC-U3', 'U3-LOAD', 'Load 3',
         'U3-CUSTOMER-DROP', 'dropoff', $2::jsonb, 'complete', $3::timestamptz, $4::jsonb
       )`,
      [
        driverJobId,
        JSON.stringify([salesOrderRef]),
        completedAt,
        JSON.stringify(driverDetails("SO", salesOrderRef, "100 Direct Customer Road, Toronto, ON"))
      ]
    );
    const dependency = await query(
      `INSERT INTO order_dependencies (
         sales_order_id, sales_order_ref, transfer_order_id, transfer_order_ref,
         dependency_mode, same_load_required, status,
         source_location_id, source_location,
         accounting_destination_location_id, accounting_destination_location,
         planned_date, planned_truck_plate, planned_load_id, planned_load_name,
         local_completed_at, direct_received_at, direct_receipt_job_id,
         reconciliation_status, dispatch_target_ref, dispatch_target_kind
       ) VALUES (
         $1, $2, $3, $4,
         'direct_to_customer', true, 'received_local',
         28, '2967', 15, '12441',
         '2039-09-16', 'BC-U3', 'U3-LOAD', 'Load 3',
         $5::timestamptz, $5::timestamptz, $6,
         'required', $2, 'normal'
       ) RETURNING id::text`,
      [salesOrderId, salesOrderRef, transferOrderId, transferOrderRef, completedAt, driverJobId]
    );

    const projected = await query(
      `SELECT order_kind, order_ref, dispatch_completion_status,
              dispatch_completed_at, completion_evidence_type,
              completion_evidence_id
         FROM dispatch_order_completion_status
        WHERE order_ref = ANY($1::text[])
        ORDER BY order_kind`,
      [[salesOrderRef, transferOrderRef]]
    );
    assert.deepEqual(projected.rows.map((row) => ({
      orderKind: row.order_kind,
      orderRef: row.order_ref,
      status: row.dispatch_completion_status,
      evidenceType: row.completion_evidence_type,
      evidenceId: row.completion_evidence_id
    })), [
      {
        orderKind: "SO",
        orderRef: salesOrderRef,
        status: "completed",
        evidenceType: "driver_job",
        evidenceId: driverJobId
      },
      {
        orderKind: "TO",
        orderRef: transferOrderRef,
        status: "completed",
        evidenceType: "direct_dependency",
        evidenceId: driverJobId
      }
    ]);
    assert.equal(
      (await query(
        `SELECT count(*)::int AS count
           FROM driver_job_records
          WHERE order_refs @> $1::jsonb`,
        [JSON.stringify([transferOrderRef])]
      )).rows[0].count,
      0,
      "the direct TO must not require a fabricated Driver job"
    );

    const listed = await listMbbsBillingCandidates({
      actor: { operatorId: "dispatch-completion-test", roles: ["admin"] },
      completedDate: "2039-09-16",
      search: suffix,
      limit: 100
    });
    const directCandidate = listed.items.find((candidate) =>
      candidate.references.some((reference) => reference.rootReference === transferOrderRef)
    );
    assert.ok(directCandidate, "the completed direct TO must be admitted to billing");
    assert.equal(directCandidate.sourceSystem, "direct_dependency");
    assert.equal(directCandidate.sourceRecordId, dependency.rows[0].id);
    assert.equal(directCandidate.dispatchCompletionStatus, "completed");
    assert.equal(directCandidate.dispatchCompletedAt, completedAt);
    assert.equal(directCandidate.completionEvidenceType, "direct_dependency");
    assert.equal(directCandidate.completionEvidenceId, driverJobId);
    assert.equal(directCandidate.billingRule, "to_direct_additional_drop");
    assert.equal(directCandidate.dropCount, 1);
    assert.equal(directCandidate.chargeable, true);
    assert.match(directCandidate.relationship.summary, /additional drop/iu);
  });
});

test("U4: audited manual recovery is guarded, idempotent, and never fabricates Driver evidence", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const salesOrderId = 9_980_000_000 + Math.floor(Math.random() * 100_000);
    const salesOrderRef = `SO-U4-${suffix}`;
    const completedAt = "2039-09-17T15:45:00.000Z";
    const actor = { operatorId: `dispatcher-${suffix}`, roles: ["dispatcher"] };
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, customer, fulfillment_status,
         outbound_location_id, outbound_location, sales_order_type,
         dispatch_address, netsuite_active, synced_at
       ) VALUES (
         $1, $2, 'Manual completion customer', 'not_fulfilled',
         28, '2967', 'Delivery',
         '4 Manual Recovery Road, Toronto, ON', true, now()
       )`,
      [salesOrderId, salesOrderRef]
    );
    const driverRowsBefore = Number((await query(
      "SELECT count(*)::int AS count FROM driver_job_records"
    )).rows[0].count);

    await assert.rejects(
      manuallyCompleteDispatchOrder({
        actor,
        orderKind: "SO",
        orderRef: salesOrderRef,
        completedAt,
        reason: "Driver forgot to submit the completed customer stop.",
        confirm: false
      }),
      (error) => error?.code === "DISPATCH_COMPLETION_CONFIRMATION_REQUIRED"
    );
    await assert.rejects(
      manuallyCompleteDispatchOrder({
        actor,
        orderKind: "SO",
        orderRef: salesOrderRef,
        completedAt,
        reason: " ",
        confirm: true
      }),
      (error) => error?.code === "DISPATCH_COMPLETION_REASON_REQUIRED"
    );
    await assert.rejects(
      manuallyCompleteDispatchOrder({
        actor: { operatorId: `sales-${suffix}`, roles: ["sales"] },
        orderKind: "SO",
        orderRef: salesOrderRef,
        completedAt,
        reason: "Not authorized to recover Driver completion.",
        confirm: true
      }),
      (error) => error?.code === "DISPATCH_COMPLETION_FORBIDDEN"
    );
    await assert.rejects(
      manuallyCompleteDispatchOrder({
        actor,
        orderKind: "TO",
        orderRef: `TO-UNKNOWN-${suffix}`,
        completedAt,
        reason: "Unknown orders cannot be marked complete.",
        confirm: true
      }),
      (error) => error?.code === "DISPATCH_COMPLETION_ORDER_NOT_FOUND"
    );

    const command = {
      actor,
      orderKind: "SO",
      orderRef: salesOrderRef,
      completedAt,
      reason: "Driver forgot to submit the completed customer stop.",
      confirm: true
    };
    const first = await manuallyCompleteDispatchOrder(command);
    const repeated = await manuallyCompleteDispatchOrder(command);
    assert.equal(first.dispatchCompletionStatus, "completed");
    assert.equal(first.dispatchCompletedAt, completedAt);
    assert.equal(first.completionEvidenceType, "manual_dispatch");
    assert.equal(first.orderKind, "SO");
    assert.equal(first.orderRef, salesOrderRef);
    assert.equal(first.actorId, actor.operatorId);
    assert.equal(first.reason, command.reason);
    assert.equal(repeated.completionEventId, first.completionEventId);

    const events = await query(
      `SELECT count(*)::int AS count
         FROM dispatch_order_completion_events
        WHERE order_kind = 'SO'
          AND lower(order_ref) = lower($1)
          AND completion_evidence_type = 'manual_dispatch'`,
      [salesOrderRef]
    );
    assert.equal(events.rows[0].count, 1);
    assert.equal(
      Number((await query("SELECT count(*)::int AS count FROM driver_job_records")).rows[0].count),
      driverRowsBefore
    );

    const listed = await listMbbsBillingCandidates({
      actor: { operatorId: "dispatch-completion-test", roles: ["admin"] },
      completedDate: "2039-09-17",
      search: suffix,
      limit: 100
    });
    const manualCandidate = listed.items.find((candidate) =>
      candidate.references.some((reference) => reference.rootReference === salesOrderRef)
    );
    assert.ok(manualCandidate, "manual canonical completion must admit an unfulfilled SO to billing");
    assert.equal(manualCandidate.sourceSystem, "dispatch_completion");
    assert.equal(manualCandidate.dispatchCompletionStatus, "completed");
    assert.equal(manualCandidate.dispatchCompletedAt, completedAt);
    assert.equal(manualCandidate.completionEvidenceType, "manual_dispatch");
    assert.equal(manualCandidate.chargeable, true);
  });
});

test("U5: multiple completion evidence sources select one canonical status and one billing candidate", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const salesOrderId = 9_985_000_000 + Math.floor(Math.random() * 100_000);
    const salesOrderRef = `SO-U5-${suffix}`;
    const completedAt = "2039-09-18T16:15:00.000Z";
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, customer, fulfillment_status, fulfilled_at,
         outbound_location_id, outbound_location, sales_order_type,
         dispatch_address, netsuite_active, synced_at
       ) VALUES (
         $1, $2, 'Dedupe customer', 'fulfilled', $3::timestamptz,
         28, '2967', 'Delivery', '5 Dedupe Road, Toronto, ON', true, $3::timestamptz
       )`,
      [salesOrderId, salesOrderRef, completedAt]
    );
    for (const [index, stopType, address] of [
      [0, "pickup", "2967 Kennedy Road, Toronto, ON"],
      [1, "dropoff", "5 Dedupe Road, Toronto, ON"]
    ]) {
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_date, driver_login, load_id, load_name,
           stop_id, stop_type, order_refs, status, completed_at, job_details
         ) VALUES (
           $1, '2039-09-18', 'dispatch-completion-test', $2, 'Load U5',
           $3, $4, $5::jsonb, 'complete', $6::timestamptz, $7::jsonb
         )`,
        [
          `U5-${stopType.toUpperCase()}-${suffix}`,
          `U5-LOAD-${suffix}`,
          `U5-STOP-${index}`,
          stopType,
          JSON.stringify([salesOrderRef]),
          completedAt,
          JSON.stringify(driverDetails("SO", salesOrderRef, address))
        ]
      );
    }

    const events = await query(
      `SELECT completion_evidence_type
         FROM dispatch_order_completion_events
        WHERE order_kind = 'SO' AND lower(order_ref) = lower($1)
        ORDER BY completion_evidence_type`,
      [salesOrderRef]
    );
    assert.deepEqual(
      events.rows.map((row) => row.completion_evidence_type),
      ["driver_job", "netsuite_fulfillment"]
    );
    const canonical = await query(
      `SELECT completion_evidence_type
         FROM dispatch_order_completion_status
        WHERE order_kind = 'SO' AND lower(order_ref) = lower($1)`,
      [salesOrderRef]
    );
    assert.equal(canonical.rowCount, 1);
    assert.equal(canonical.rows[0].completion_evidence_type, "driver_job");

    const listed = await listMbbsBillingCandidates({
      actor: { operatorId: "dispatch-completion-test", roles: ["admin"] },
      completedDate: "2039-09-18",
      search: suffix,
      limit: 100
    });
    const matching = listed.items.filter((candidate) =>
      [...(candidate.references || []), ...(candidate.memberReferences || [])]
        .some((reference) => reference.rootReference === salesOrderRef)
    );
    assert.equal(matching.length, 1);
    assert.equal(matching[0].sourceSystem, "driver_pwa");
    assert.equal(matching[0].completionEvidenceType, "driver_job");
  });
});

test("U6: a completed order without a route stays chargeable through guarded manual pricing", async () => {
  await inRollback(async () => {
    const rateCardVersionId = await installCompletionRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const salesOrderId = 9_990_000_000 + Math.floor(Math.random() * 100_000);
    const salesOrderRef = `SO-U6-${suffix}`;
    const completedAt = "2039-09-19T15:45:00.000Z";
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, customer, fulfillment_status,
         outbound_location_id, outbound_location, sales_order_type,
         dispatch_address, netsuite_active, synced_at
       ) VALUES (
         $1, $2, 'Missing route customer', 'not_fulfilled',
         28, '2967', 'Delivery', '', true, now()
       )`,
      [salesOrderId, salesOrderRef]
    );
    await manuallyCompleteDispatchOrder({
      actor: { operatorId: `dispatcher-${suffix}`, roles: ["dispatcher"] },
      orderKind: "SO",
      orderRef: salesOrderRef,
      completedAt,
      reason: "Driver completed the stop but the destination address is missing from the retained order.",
      confirm: true
    });

    const listed = await listMbbsBillingCandidates({
      actor: { operatorId: "dispatch-completion-test", roles: ["admin"] },
      completedDate: "2039-09-19",
      search: suffix,
      limit: 100
    });
    const selected = listed.items.find((candidate) =>
      candidate.references.some((reference) => reference.rootReference === salesOrderRef)
    );
    assert.ok(selected, "a canonical completion must remain visible despite missing route data");
    assert.equal(selected.dispatchCompletionStatus, "completed");
    assert.equal(selected.chargeable, true);

    let distanceCalls = 0;
    const preview = await previewMbbsBillingCandidatesBatch({
      actor: { operatorId: "dispatch-completion-test", roles: ["admin"] },
      candidateIds: [selected.candidateId],
      completedMonth: "2039-09",
      completedDate: "2039-09-19",
      rateCardVersionId
    }, {
      async resolveDistance() {
        distanceCalls += 1;
        return { provider: "must-not-run", providerMetres: 0 };
      }
    });
    assert.equal(distanceCalls, 0);
    assert.equal(preview.results[0].status, "manual_required");
    assert.equal(preview.results[0].automaticRate.available, false);
    assert.equal(preview.results[0].automaticRate.code, "MBT_MBBS_DISTANCE_UNAVAILABLE");
    assert.equal(preview.results[0].charge.calculatedAmountMinor, 0);
    assert.equal(preview.results[0].charge.finalAmountMinor, 0);
  });
});

test("U7: conversion re-resolves canonical completion and rejects source status alone", async () => {
  await inRollback(async () => {
    const rateCardVersionId = await installCompletionRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_996_000_000 + Math.floor(Math.random() * 100_000);
    const salesOrderRef = `SO-U7-${suffix}`;
    await query(
      `INSERT INTO netsuite_customers (
         netsuite_id, entity_number, legal_name, display_name, currency,
         source_modified_at, source_version, payload_hash
       ) VALUES ($1, $2, $3, $3, 'CAD', now(), $4, $5)`,
      [base + 9, `U7-${suffix}`, `U7 customer ${suffix}`, `u7-${suffix}`, "7".repeat(64)]
    );
    await query("ALTER TABLE sales_orders DISABLE TRIGGER trg_sales_fulfillment_dispatch_completion");
    try {
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, customer, fulfillment_status, fulfilled_at,
           outbound_location_id, outbound_location, sales_order_type,
           dispatch_address, netsuite_active, synced_at
         ) VALUES (
           $1, $2, 'Source-only customer', 'fulfilled', '2039-09-20T15:45:00.000Z',
           28, '2967', 'Delivery', '7 Source Only Road, Toronto, ON', true,
           '2039-09-20T15:45:00.000Z'
         )`,
        [base + 1, salesOrderRef]
      );
    } finally {
      await query("ALTER TABLE sales_orders ENABLE TRIGGER trg_sales_fulfillment_dispatch_completion");
    }
    const forgedSourceCandidateId = Buffer.from(JSON.stringify({
      v: 1,
      kind: "sales_order",
      netsuiteId: String(base + 1)
    }), "utf8").toString("base64url");
    let distanceCalls = 0;
    await assert.rejects(
      createMbbsBillingCasesFromCandidates({
        actor: { operatorId: "dispatch-completion-test", roles: ["admin"] },
        candidateIds: [forgedSourceCandidateId],
        completedMonth: "2039-09",
        completedDate: "2039-09-20",
        rateCardVersionId,
        customerNetsuiteId: String(base + 9),
        reason: "Reject a stale browser selection without canonical Dispatch completion",
        idempotencyKey: `u7-${suffix}`,
        correlationId: `u7-correlation-${suffix}`,
        requestId: `u7-request-${suffix}`
      }, {
        async resolveDistance() {
          distanceCalls += 1;
          return { provider: "must-not-run", providerMetres: 1000 };
        }
      }),
      (error) => error?.code === "MBT_BILLING_CANDIDATE_NOT_FOUND"
    );
    assert.equal(distanceCalls, 0);
    assert.equal((await query(
      `SELECT count(*)::int AS count
         FROM dispatch_order_completion_status
        WHERE order_kind = 'SO' AND order_ref = $1`,
      [salesOrderRef]
    )).rows[0].count, 0);
    assert.equal((await query(
      `SELECT count(*)::int AS count
         FROM mbt_cross_charge_cases
        WHERE root_reference = $1`,
      [salesOrderRef]
    )).rows[0].count, 0);
  });
});
