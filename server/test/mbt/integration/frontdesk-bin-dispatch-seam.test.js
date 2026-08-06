import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, pool, query, withTransaction } from "../../../src/db.js";
import {
  acceptFrontdeskQuote,
  convertFrontdeskQuote,
  createFrontdeskQuote,
  issueFrontdeskQuote
} from "../../../src/mbt/frontdesk-service.js";
import {
  assignMbtBinFrontLeg,
  listMbtBinFrontLegs
} from "../../../src/mbt/bin-dispatch-service.js";
import { MbtError } from "../../../src/mbt/errors.js";
import { recordAssetMovement } from "../../../src/mbt/asset-service.js";
import {
  createFrontdeskPrerequisites,
  frontdeskCommand,
  frontdeskDistanceResolver,
  frontdeskTaxResolver,
  quoteCommand
} from "../support/frontdesk-fixtures.js";
import {
  BIN_DISPATCH_BIN_TYPE_ID,
  BIN_DISPATCH_YARD_CODE,
  BIN_DISPATCH_YARD_ID,
  enabledBinDispatchBoundary,
  ordinaryDispatchSideEffects
} from "../support/bin-dispatch-fixtures.js";

const ACTOR = Object.freeze({ operatorId: "p3-frontdesk-dispatch-seam", roles: ["mbt_frontdesk"] });
const DISPATCHER = Object.freeze({ operatorId: "p3-frontdesk-dispatcher", roles: ["dispatcher"] });
const WRONG_YARD_ID = "00000000-0000-4000-8000-000000003445";
const WRONG_BIN_TYPE_ID = "00000000-0000-4000-8000-000000000020";
const RUN_SEED = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 6), 16);

/** @param {number} offset */
function planDate(offset) {
  const date = new Date(Date.UTC(2075, 0, 1));
  date.setUTCDate(date.getUTCDate() + (RUN_SEED % 2_000) + offset);
  return date.toISOString().slice(0, 10);
}

/** @param {string} date @param {number} hour */
function atHour(date, hour) {
  return `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

/** @param {string} label @param {string} date @param {{quantity?: number}} [options] */
async function convertedFrontdeskContract(label, date, { quantity = 1 } = {}) {
  const fixture = await createFrontdeskPrerequisites({ label });
  const created = await createFrontdeskQuote({
    ...quoteCommand(fixture, { actor: ACTOR, identity: `${label}-${crypto.randomUUID()}` }),
    proposedDeliveryAt: atHour(date, 12),
    proposedReturnAt: atHour(date, 18),
    ...(quantity > 1 ? {
      serviceLines: Array.from({ length: quantity }, () => ({
        binTypeId: fixture.binTypeId,
        proposedDeliveryAt: atHour(date, 12),
        proposedReturnAt: atHour(date, 18)
      }))
    } : {})
  }, {
    resolveDistance: frontdeskDistanceResolver(fixture),
    resolveTaxPolicy: frontdeskTaxResolver
  });
  const quoteId = created.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand(`${label}-issue`, ACTOR, {
    quoteId,
    expectedRevision: 1,
    validUntil: atHour(date, 23)
  }));
  await acceptFrontdeskQuote(frontdeskCommand(`${label}-accept`, ACTOR, {
    quoteId,
    expectedRevision: 2,
    acceptedAt: atHour(date, 10)
  }));
  const converted = await convertFrontdeskQuote(frontdeskCommand(`${label}-convert`, ACTOR, {
    quoteId,
    expectedRevision: 3
  }));
  return { fixture, quoteId, converted };
}

/**
 * @param {object} input
 * @param {string} input.label
 * @param {string} [input.binTypeId]
 * @param {string} [input.yardId]
 * @param {string} [input.yardCode]
 * @param {boolean} [input.active]
 * @param {boolean} [input.underMaintenance]
 */
async function insertAsset({
  label,
  binTypeId = BIN_DISPATCH_BIN_TYPE_ID,
  yardId = BIN_DISPATCH_YARD_ID,
  yardCode = BIN_DISPATCH_YARD_CODE,
  active = true,
  underMaintenance = false
}) {
  const assetId = crypto.randomUUID();
  const movementId = crypto.randomUUID();
  const assetCode = `SEAM-${label}-${assetId.replaceAll("-", "").slice(0, 10)}`.toUpperCase();
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_bin_assets (
         asset_id, asset_code, qr_code, bin_type_id, home_yard_id,
         active, under_maintenance, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'p3-seam-test', 'p3-seam-test')`,
      [assetId, assetCode, `QR-${assetCode}`, binTypeId, yardId, active, underMaintenance]
    );
    await query(
      `INSERT INTO mbt_bin_movements (
         movement_id, asset_id, asset_sequence, movement_type,
         before_status, after_status, before_location_kind,
         after_location_kind, after_location_reference, to_yard_id,
         source, actor_type, actor_id, occurred_at
       ) VALUES (
         $1, $2, 1, 'asset_registered', NULL, 'available', NULL,
         'yard', $3, $4, 'p3_frontdesk_dispatch_seam', 'system',
         'p3-seam-test', now()
       )`,
      [movementId, assetId, yardCode, yardId]
    );
    await query(
      `INSERT INTO mbt_bin_asset_state (
         asset_id, lifecycle_status, location_kind, location_reference,
         yard_id, last_movement_id, revision, changed_at
       ) VALUES ($1, 'available', 'yard', $2, $3, $4, 1, now())`,
      [assetId, yardCode, yardId, movementId]
    );
  });
  return { assetId, assetCode, stateRevision: 1 };
}

/** @param {string} date @param {string} label */
async function insertPlan(date, label) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const driver = await query(
    "INSERT INTO dispatch_drivers (name, login, active) VALUES ($1, $2, true) RETURNING id::text",
    [`Seam Driver ${suffix}`, `seam_driver_${suffix}`]
  );
  const fleet = await withTransaction(async () => {
    const truck = await query(
      `INSERT INTO dispatch_trucks (
         plate, capacity_lbs, active, truck_type, base_yard_id,
         bin_service_enabled, bin_slot_capacity
       ) VALUES ($1, 48000, true, 'bin', $2, true, 1)
       RETURNING id::text`,
      [`SEAM${suffix}`, BIN_DISPATCH_YARD_ID]
    );
    await query(
      `INSERT INTO dispatch_truck_bin_types (truck_id, bin_type_id, active, created_by)
       VALUES ($1, $2, true, 'p3-seam-test')`,
      [truck.rows[0].id, BIN_DISPATCH_BIN_TYPE_ID]
    );
    return String(truck.rows[0].id);
  });
  const driverId = String(driver.rows[0].id);
  const loadId = `SEAM-LOAD-${suffix}`;
  const trucks = [{
    id: fleet,
    plate: `SEAM${suffix}`,
    truckType: "bin",
    binSlotCapacity: 1,
    supportedBinTypeCodes: ["14YD"],
    driverId,
    driverLogin: `seam_driver_${suffix}`,
    loads: [{ id: loadId, name: `Seam ${label}`, truckId: fleet, driverId, stops: [] }]
  }];
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ($1::date, 'draft', $2, 1) RETURNING id::text`,
    [date, `Synthetic Front Desk to BIN Dispatch seam ${label}`]
  );
  const planId = String(plan.rows[0].id);
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, $2::jsonb, $3::jsonb)`,
    [planId, JSON.stringify(trucks), JSON.stringify({ dispatchPlanFormat: { version: 2, source: "p3-seam-test" } })]
  );
  return { planId, planRevision: 1, loadId };
}

/** @param {Awaited<ReturnType<typeof convertedFrontdeskContract>>} created */
function visitIds(created) {
  return {
    deliveryVisitId: created.converted.body.visits[0].visitId,
    returnVisitId: created.converted.body.visits[1].visitId,
    contractId: created.converted.body.contract.contractId
  };
}

after(async () => {
  await closeDb();
});

test("multi-bin Front Desk contract exposes one independent ready Dispatch card per physical bin", async () => {
  const date = planDate(9);
  const created = await convertedFrontdeskContract("multi-bin-feed", date, { quantity: 2 });
  await Promise.all([
    insertAsset({ label: "multi-bin-feed-a" }),
    insertAsset({ label: "multi-bin-feed-b" })
  ]);

  const feed = await listMbtBinFrontLegs({ planDate: date, search: "", limit: 100 }, {
    capability: enabledBinDispatchBoundary
  });
  const contractId = created.converted.body.contract.contractId;
  const cards = feed.items.filter((item) => item.mbt.contractId === contractId);
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards.map((item) => item.mbt.serviceLineId)).size, 2);
  assert.equal(cards.every((item) => item.mbt.timeline[0]?.relation === "current"), true);
  assert.equal(cards.every((item) => item.mbt.timeline[1]?.relation === "future"), true);
});

test("P3-F13/F15 seam: conversion freezes the shared-yard route, configured steps/evidence, visit distance, and delivery billing owner", async () => {
  const date = planDate(10);
  const ordinaryBefore = await ordinaryDispatchSideEffects();
  const created = await convertedFrontdeskContract("materialized-route", date);
  const { deliveryVisitId, returnVisitId } = visitIds(created);
  const visits = await query(
    `SELECT service_visit_id::text, visit_number::int, service_snapshot,
            expected_asset_id::text, outgoing_asset_id::text
       FROM mbt_service_visits
      WHERE service_visit_id = ANY($1::uuid[])
      ORDER BY visit_number`,
    [[deliveryVisitId, returnVisitId]]
  );
  assert.equal(visits.rowCount, 2);
  const delivery = visits.rows[0];
  const successor = visits.rows[1];
  assert.equal(delivery.expected_asset_id, null);
  assert.equal(delivery.outgoing_asset_id, null);
  assert.ok(
    Array.isArray(delivery.service_snapshot.mandatoryStops),
    "conversion must freeze the complete delivery route before Dispatch reads it"
  );
  assert.deepEqual(delivery.service_snapshot.mandatoryStops.map((stop) => ({
    sequence: stop.sequence,
    actionCode: stop.actionCode,
    stopKind: stop.stopKind,
    locationRole: stop.locationRole,
    yardId: stop.yardId ?? null,
    yardCode: stop.yardCode ?? null,
    siteProfileId: stop.siteProfileId ?? null
  })), [
    {
      sequence: 1,
      actionCode: "collect_empty_bin",
      stopKind: "pickup",
      locationRole: "origin_yard",
      yardId: BIN_DISPATCH_YARD_ID,
      yardCode: BIN_DISPATCH_YARD_CODE,
      siteProfileId: null
    },
    {
      sequence: 2,
      actionCode: "deliver_bin",
      stopKind: "drop",
      locationRole: "customer_site",
      yardId: null,
      yardCode: null,
      siteProfileId: created.fixture.siteProfileId
    }
  ]);
  assert.equal(delivery.service_snapshot.schemaVersion, "mbt-bin-service-snapshot-v1");
  assert.equal(delivery.service_snapshot.templateVersionId, created.fixture.templateVersionId);
  assert.equal(delivery.service_snapshot.templateRevision, 2);
  assert.equal(delivery.service_snapshot.dependentReturnVisitId, returnVisitId);
  assert.equal(delivery.service_snapshot.dependentReturnVisitRevision, 1);
  assert.deepEqual(successor.service_snapshot.mandatoryStops.map(({ actionCode, locationRole }) => ({
    actionCode,
    locationRole
  })), [
    { actionCode: "pickup_bin", locationRole: "customer_site" },
    { actionCode: "return_bin", locationRole: "return_yard" }
  ]);

  const visitSteps = await query(
    `SELECT step.service_visit_id::text, step.sequence_number::int,
            step.action_code, step.location_role,
            step.template_step_id::text, step.required,
            step.completion_blocking,
            requirement.template_evidence_requirement_id::text,
            requirement.evidence_code, requirement.evidence_type,
            requirement.minimum_count::int, requirement.required AS evidence_required
       FROM mbt_visit_steps step
       LEFT JOIN mbt_visit_evidence_requirements requirement
         ON requirement.visit_step_id = step.visit_step_id
      WHERE step.service_visit_id = ANY($1::uuid[])
      ORDER BY step.service_visit_id, step.sequence_number, requirement.evidence_code`,
    [[deliveryVisitId, returnVisitId]]
  );
  const deliverySteps = visitSteps.rows.filter(({ service_visit_id }) => service_visit_id === deliveryVisitId);
  assert.deepEqual(deliverySteps.map((row) => ({
    sequence: row.sequence_number,
    action: row.action_code,
    templateStepId: row.template_step_id,
    evidenceTemplateId: row.template_evidence_requirement_id,
    evidenceCode: row.evidence_code,
    evidenceType: row.evidence_type,
    evidenceMinimum: row.minimum_count
  })), [
    {
      sequence: 0,
      action: "collect_empty_bin",
      templateStepId: null,
      evidenceTemplateId: null,
      evidenceCode: null,
      evidenceType: null,
      evidenceMinimum: null
    },
    {
      sequence: 1,
      action: "deliver_bin",
      templateStepId: created.fixture.templateStepId,
      evidenceTemplateId: created.fixture.templateEvidenceRequirementId,
      evidenceCode: "delivery_photo",
      evidenceType: "photo",
      evidenceMinimum: 1
    }
  ]);

  const financialEvidence = await query(
    `SELECT b.service_visit_id::text AS billing_visit_id,
            quote_distance.distance_snapshot_id::text AS quote_distance_id,
            visit_distance.distance_snapshot_id::text AS visit_distance_id,
            quote_distance.provider AS quote_provider,
            visit_distance.provider AS visit_provider,
            quote_distance.provider_metres::int AS quote_metres,
            visit_distance.provider_metres::int AS visit_metres,
            quote_distance.route_hash AS quote_hash,
            visit_distance.route_hash AS visit_hash,
            visit_distance.route_snapshot ->> 'sourceQuoteDistanceSnapshotId' AS lineage_id,
            (SELECT count(*)::int FROM mbt_distance_snapshots d
              WHERE d.subject_type = 'quote' AND d.subject_id = $1) AS quote_snapshot_count,
            (SELECT count(*)::int FROM mbt_distance_snapshots d
              WHERE d.subject_type = 'visit' AND d.subject_id = $2) AS visit_snapshot_count
       FROM mbt_billing_cases b
       JOIN mbt_quotes q ON q.quote_id = $1
       JOIN mbt_distance_snapshots quote_distance
         ON quote_distance.distance_snapshot_id = q.distance_snapshot_id
       JOIN mbt_distance_snapshots visit_distance
         ON visit_distance.subject_type = 'visit'
        AND visit_distance.subject_id = $2
      WHERE b.contract_id = $3 AND b.case_type = 'mbt_contract'`,
    [created.quoteId, deliveryVisitId, created.converted.body.contract.contractId]
  );
  assert.equal(financialEvidence.rowCount, 1);
  assert.deepEqual(financialEvidence.rows[0], {
    billing_visit_id: deliveryVisitId,
    quote_distance_id: financialEvidence.rows[0].quote_distance_id,
    visit_distance_id: financialEvidence.rows[0].visit_distance_id,
    quote_provider: "synthetic_route_engine",
    visit_provider: "synthetic_route_engine",
    quote_metres: 12_500,
    visit_metres: 12_500,
    quote_hash: financialEvidence.rows[0].quote_hash,
    visit_hash: financialEvidence.rows[0].quote_hash,
    lineage_id: financialEvidence.rows[0].quote_distance_id,
    quote_snapshot_count: 1,
    visit_snapshot_count: 1
  });
  assert.notEqual(financialEvidence.rows[0].visit_distance_id, financialEvidence.rows[0].quote_distance_id);
  assert.deepEqual(await ordinaryDispatchSideEffects(), ordinaryBefore);
});

test("P3-F15/F16 seam: feed offers only eligible origin-yard assets and selected assignment binds both visits atomically", async () => {
  const date = planDate(20);
  const created = await convertedFrontdeskContract("asset-choice", date);
  const { deliveryVisitId, returnVisitId } = visitIds(created);
  const first = await insertAsset({ label: "eligible-a" });
  const selected = await insertAsset({ label: "eligible-b" });
  const wrongYard = await insertAsset({ label: "wrong-yard", yardId: WRONG_YARD_ID, yardCode: "3445" });
  const wrongType = await insertAsset({ label: "wrong-type", binTypeId: WRONG_BIN_TYPE_ID });
  const maintenance = await insertAsset({ label: "maintenance", underMaintenance: true });
  const plan = await insertPlan(date, "asset choice");
  const ordinaryBefore = await ordinaryDispatchSideEffects();

  const feed = await listMbtBinFrontLegs({ planDate: date, search: "", limit: 100 }, {
    capability: enabledBinDispatchBoundary
  });
  const card = feed.items.find(({ mbt }) => mbt.visitId === deliveryVisitId);
  assert.ok(card);
  assert.deepEqual(card.mbt.assetRequirements, []);
  assert.equal(card.mbt.assetChoices.length, 1);
  assert.equal(card.mbt.assetChoices[0].reservationSlot, "outgoing");
  assert.deepEqual(
    card.mbt.assetChoices[0].eligibleAssets.map(({ assetCode }) => assetCode),
    card.mbt.assetChoices[0].eligibleAssets.map(({ assetCode }) => assetCode).toSorted((left, right) => left.localeCompare(right))
  );
  const offeredIds = new Set(card.mbt.assetChoices[0].eligibleAssets.map(({ assetId }) => assetId));
  assert.equal(offeredIds.has(first.assetId), true);
  assert.equal(offeredIds.has(selected.assetId), true);
  assert.equal(offeredIds.has(wrongYard.assetId), false);
  assert.equal(offeredIds.has(wrongType.assetId), false);
  assert.equal(offeredIds.has(maintenance.assetId), false);

  const assigned = await assignMbtBinFrontLeg({
    actor: DISPATCHER,
    planId: plan.planId,
    planDate: date,
    loadId: plan.loadId,
    visitId: deliveryVisitId,
    expectedVisitRevision: 1,
    expectedPlanRevision: plan.planRevision,
    assetAssignments: [{
      reservationSlot: "outgoing",
      assetId: selected.assetId,
      expectedStateRevision: selected.stateRevision
    }],
    reason: "Select an exact available origin-yard asset",
    idempotencyKey: `p3-seam-assign-${crypto.randomUUID()}`,
    correlationId: `p3-seam-corr-${crypto.randomUUID()}`,
    requestId: `p3-seam-req-${crypto.randomUUID()}`
  }, { capability: enabledBinDispatchBoundary });
  assert.equal(assigned.status, 201);
  assert.deepEqual(assigned.body.assetReservations.map(({ assetId }) => assetId), [selected.assetId]);

  const state = await query(
    `SELECT visit.service_visit_id::text, visit.status, visit.revision::int,
            visit.expected_asset_id::text, visit.outgoing_asset_id::text,
            visit.service_snapshot,
            (SELECT array_agg(step.expected_asset_id::text ORDER BY step.sequence_number)
               FROM mbt_visit_steps step
              WHERE step.service_visit_id = visit.service_visit_id) AS step_asset_ids
       FROM mbt_service_visits visit
      WHERE visit.service_visit_id = ANY($1::uuid[])
      ORDER BY visit.visit_number`,
    [[deliveryVisitId, returnVisitId]]
  );
  assert.deepEqual(state.rows.map((row) => ({
    visitId: row.service_visit_id,
    status: row.status,
    revision: row.revision,
    expectedAssetId: row.expected_asset_id,
    outgoingAssetId: row.outgoing_asset_id,
    stopAssetIds: row.service_snapshot.mandatoryStops.map(({ assetId }) => assetId),
    stepAssetIds: row.step_asset_ids
  })), [
    {
      visitId: deliveryVisitId,
      status: "planned",
      revision: 2,
      expectedAssetId: selected.assetId,
      outgoingAssetId: selected.assetId,
      stopAssetIds: [selected.assetId, selected.assetId],
      stepAssetIds: [selected.assetId, selected.assetId]
    },
    {
      visitId: returnVisitId,
      status: "tentative",
      revision: 2,
      expectedAssetId: selected.assetId,
      outgoingAssetId: null,
      stopAssetIds: [selected.assetId, selected.assetId],
      stepAssetIds: [selected.assetId, selected.assetId]
    }
  ]);
  const assets = await query(
    `SELECT state.asset_id::text, state.lifecycle_status, state.revision::int,
            (SELECT count(*)::int FROM mbt_bin_asset_reservations reservation
              WHERE reservation.asset_id = state.asset_id AND reservation.released_at IS NULL) AS reservations
       FROM mbt_bin_asset_state state
      WHERE state.asset_id = ANY($1::uuid[])
      ORDER BY state.asset_id`,
    [[first.assetId, selected.assetId]]
  );
  const selectedState = assets.rows.find(({ asset_id }) => asset_id === selected.assetId);
  const untouchedState = assets.rows.find(({ asset_id }) => asset_id === first.assetId);
  assert.deepEqual(selectedState, {
    asset_id: selected.assetId,
    lifecycle_status: "reserved",
    revision: 2,
    reservations: 1
  });
  assert.deepEqual(untouchedState, {
    asset_id: first.assetId,
    lifecycle_status: "available",
    revision: 1,
    reservations: 0
  });
  assert.deepEqual(await ordinaryDispatchSideEffects(), ordinaryBefore);
});

test("P3-F16 seam: stale, wrong-yard, and changed dependent-return revisions fail before any binding or plan write", async () => {
  const cases = [
    { label: "wrong-yard", mutate: async () => {}, asset: { yardId: WRONG_YARD_ID, yardCode: "3445" }, code: "MBT_BIN_ASSET_MISMATCH" },
    {
      label: "stale-asset",
      mutate: async ({ asset }) => recordAssetMovement(pool, {
        assetId: asset.assetId,
        movementType: "inventory_reverified",
        afterStatus: "available",
        afterLocation: {
          kind: "yard",
          reference: BIN_DISPATCH_YARD_CODE,
          yardId: BIN_DISPATCH_YARD_ID
        },
        source: "p3_frontdesk_dispatch_seam",
        actorType: "system",
        actorId: "p3-seam-test",
        occurredAt: new Date(Date.now() + 1_000).toISOString()
      }),
      asset: {},
      code: "MBT_BIN_ASSET_MISMATCH"
    },
    { label: "stale-return", mutate: async ({ returnVisitId }) => query("UPDATE mbt_service_visits SET revision = revision + 1 WHERE service_visit_id = $1", [returnVisitId]), asset: {}, code: "MBT_BIN_DEPENDENT_VISIT_CHANGED" }
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const candidate = cases[index];
    const date = planDate(30 + index);
    const created = await convertedFrontdeskContract(candidate.label, date);
    const { deliveryVisitId, returnVisitId } = visitIds(created);
    const asset = await insertAsset({ label: candidate.label, ...candidate.asset });
    const plan = await insertPlan(date, candidate.label);
    await candidate.mutate({ asset, returnVisitId });
    const before = await query(
      `SELECT visit.status, visit.revision::int, visit.expected_asset_id::text,
              plan.revision::int AS plan_revision, snapshot.trucks,
              (SELECT count(*)::int FROM mbt_bin_asset_reservations reservation
                WHERE reservation.visit_id = visit.service_visit_id) AS reservations
         FROM mbt_service_visits visit
         JOIN dispatch_plans plan ON plan.id = $2
         JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
        WHERE visit.service_visit_id = $1`,
      [deliveryVisitId, plan.planId]
    );
    await assert.rejects(
      () => assignMbtBinFrontLeg({
        actor: DISPATCHER,
        planId: plan.planId,
        planDate: date,
        loadId: plan.loadId,
        visitId: deliveryVisitId,
        expectedVisitRevision: 1,
        expectedPlanRevision: 1,
        assetAssignments: [{
          reservationSlot: "outgoing",
          assetId: asset.assetId,
          expectedStateRevision: 1
        }],
        reason: `Reject ${candidate.label}`,
        idempotencyKey: `p3-seam-reject-${candidate.label}-${crypto.randomUUID()}`,
        correlationId: `p3-seam-reject-corr-${candidate.label}-${crypto.randomUUID()}`,
        requestId: `p3-seam-reject-req-${candidate.label}-${crypto.randomUUID()}`
      }, { capability: enabledBinDispatchBoundary }),
      (error) => error instanceof MbtError && error.status === 409 && error.code === candidate.code
    );
    const afterState = await query(
      `SELECT visit.status, visit.revision::int, visit.expected_asset_id::text,
              plan.revision::int AS plan_revision, snapshot.trucks,
              (SELECT count(*)::int FROM mbt_bin_asset_reservations reservation
                WHERE reservation.visit_id = visit.service_visit_id) AS reservations
         FROM mbt_service_visits visit
         JOIN dispatch_plans plan ON plan.id = $2
         JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = plan.id
        WHERE visit.service_visit_id = $1`,
      [deliveryVisitId, plan.planId]
    );
    assert.deepEqual(afterState.rows, before.rows);
  }
});
