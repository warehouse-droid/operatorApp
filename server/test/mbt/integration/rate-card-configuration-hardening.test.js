// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  activateLocalRateCardVersion,
  applyLocalRateCardDraft,
  cloneLocalRateCardVersion,
  listLocalRateCards,
  normalizeLocalRateCardGraph,
  validateLocalRateCardVersion
} from "../../../src/mbt/rate-card-configuration-service.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({ operatorId: `p36-hard-${RUN_ID}`, roles: Object.freeze(["admin"]) });
let sequence = 0;

after(async () => {
  await closeDb();
});

function graph(overrides = {}) {
  return {
    rateCard: {
      rateCardCode: `P36_HARD_${RUN_ID.slice(0, 12)}`,
      displayName: "P3.6 hardening rate",
      description: "Local-only exact-cent evidence",
      customerNetSuiteId: 7143,
      subsidiaryNetSuiteId: 33,
      serviceTemplateCode: "LOCAL_TEMPLATE",
      currency: "CAD",
      active: true
    },
    version: {
      versionNumber: 1,
      effectiveFrom: "2036-08-03T00:00:00.000Z",
      effectiveTo: "2037-08-03T00:00:00.000Z",
      defaultRentalCalendarDays: 14,
      calculationNotes: "Exact raw metres"
    },
    distanceBands: [{
      serviceCode: "delivery",
      binTypeCode: "14YD",
      sequenceNumber: 0,
      minimumMetres: 0,
      maximumMetres: null,
      amountMinor: 12_000,
      downtownSurchargeMinor: 0,
      currency: "CAD",
      description: "All distances"
    }],
    components: [{
      componentCode: "fuel_percent",
      componentKind: "other",
      serviceCode: null,
      binTypeCode: null,
      rateBasis: "percentage",
      amountMinor: null,
      percentageBasisPoints: 500,
      defaultQuantity: "1.0000",
      currency: "CAD",
      taxable: true,
      active: true,
      description: "Fuel percentage"
    }],
    dumpTariffs: [{
      dumpSiteCode: "DUMP_LOCAL",
      materialCode: null,
      tariffCode: "fixed_dump",
      pricingBasis: "fixed",
      unitOfMeasure: null,
      amountMinor: 5_000,
      minimumAmountMinor: 0,
      currency: "CAD",
      active: true,
      description: "Fixed dump"
    }],
    depositRules: [{
      ruleCode: "deposit_percent",
      ruleType: "percentage",
      binTypeCode: null,
      serviceCode: "delivery",
      fixedAmountMinor: null,
      percentageBasisPoints: 1_000,
      currency: "CAD",
      liabilityAccountMappingKey: "deposit_liability",
      active: true,
      description: "Ten percent"
    }],
    ...overrides
  };
}

/** @param {Record<string, unknown>} extra */
function command(extra) {
  sequence += 1;
  return {
    actor: ACTOR,
    reason: `P3.6 hardening ${sequence}`,
    idempotencyKey: `p36-hard-idem-${RUN_ID}-${sequence}`,
    correlationId: `p36-hard-corr-${RUN_ID}-${sequence}`,
    requestId: `p36-hard-req-${RUN_ID}-${sequence}`,
    ...extra
  };
}

/** @param {() => unknown} operation @param {string} code */
function rejectsCode(operation, code) {
  assert.throws(operation, (error) => error?.status === 400 && error?.code === code, code);
}

/** @param {() => Promise<unknown>} operation */
async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

/** @param {() => Promise<unknown>} operation */
async function withMasterDataEnabled(operation) {
  const before = { root: config.mbt.enabled, masterData: config.mbtPhase3.masterDataEnabled };
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  try {
    return await operation();
  } finally {
    config.mbt.enabled = before.root;
    config.mbtPhase3.masterDataEnabled = before.masterData;
  }
}

/** @param {string} suffix @param {string} [status] @param {Record<string, unknown>} [validation] */
async function seedVersion(suffix, status = "draft", validation = {}) {
  const rateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, currency, active, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, 'CAD', true, 1, $4, $4)`,
    [rateCardId, `P36HARD${RUN_ID.slice(0, 10)}${suffix}`, `Hardening ${suffix}`, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status, effective_from,
       validation_snapshot, revision, created_by, updated_by
     ) VALUES ($1, $2, 1, $3, '2036-08-03T00:00:00Z', $4::jsonb, 1, $5, $5)`,
    [rateCardVersionId, rateCardId, status, JSON.stringify(validation), ACTOR.operatorId]
  );
  return { rateCardId, rateCardVersionId };
}

async function seedValidBand(rateCardVersionId) {
  await query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, service_code, sequence_number,
       minimum_metres, maximum_metres, amount_minor, currency,
       downtown_surcharge_minor, description
     ) VALUES ($1, $2, 'delivery', 0, 0, NULL, 12000, 'CAD', 0, 'hardening')`,
    [crypto.randomUUID(), rateCardVersionId]
  );
}

test("P3-F12 hardening: every rate graph shape uses the same strict allowlist", () => {
  const valid = graph();
  assert.deepEqual(normalizeLocalRateCardGraph(valid, { sourceKind: "manual" }), valid);
  assert.deepEqual(normalizeLocalRateCardGraph(valid, { sourceKind: "csv" }), valid);

  const scenarios = [
    { mutate: () => undefined, sourceKind: "other", code: "MBT_RATE_CARD_INPUT_INVALID" },
    { value: null, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { value: [], code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.unknown = true; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.rateCard = null; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.version = []; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.components = null; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.distanceBands[0].maximumMetres = 1000; }, code: "MBT_RATE_CARD_INVALID" },
    { mutate: (value) => { value.rateCard.rateCardCode = ""; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.rateCard.displayName = "x".repeat(161); }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.rateCard.description = null; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.rateCard.active = "yes"; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.rateCard.customerNetSuiteId = 0; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.rateCard.subsidiaryNetSuiteId = 0; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.rateCard.serviceTemplateCode = "bad code"; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.version.effectiveFrom = "bad"; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.version.defaultRentalCalendarDays = 0; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.distanceBands[0] = null; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.distanceBands[0].binTypeCode = "bad code"; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.components[0].componentKind = "invalid"; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.components[0].amountMinor = 1; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.components[0].percentageBasisPoints = -1; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.components[0].defaultQuantity = 0; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => {
      value.components[0].rateBasis = "flat";
      value.components[0].amountMinor = 100;
    }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.dumpTariffs[0].pricingBasis = "invalid"; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => {
      value.dumpTariffs[0].pricingBasis = "per_weight";
      value.dumpTariffs[0].unitOfMeasure = "";
    }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.depositRules[0].ruleType = "invalid"; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.depositRules[0].fixedAmountMinor = 1; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => { value.depositRules[0].percentageBasisPoints = -1; }, code: "MBT_RATE_CARD_INPUT_INVALID" },
    { mutate: (value) => {
      value.depositRules[0].ruleType = "fixed";
      value.depositRules[0].fixedAmountMinor = 1;
    }, code: "MBT_RATE_CARD_INPUT_INVALID" }
  ];
  for (const scenario of scenarios) {
    const candidate = scenario.value === undefined ? structuredClone(valid) : scenario.value;
    scenario.mutate?.(candidate);
    rejectsCode(
      () => normalizeLocalRateCardGraph(candidate, { sourceKind: scenario.sourceKind ?? "manual" }),
      scenario.code
    );
  }
});

test("P3-F12 hardening: a fixed component and fixed deposit are accepted without percentage fields", () => {
  const candidate = graph();
  candidate.components[0] = {
    ...candidate.components[0],
    rateBasis: "flat",
    amountMinor: 500,
    percentageBasisPoints: null
  };
  candidate.depositRules[0] = {
    ...candidate.depositRules[0],
    ruleType: "fixed",
    fixedAmountMinor: 2_500,
    percentageBasisPoints: null,
    serviceCode: null
  };
  assert.deepEqual(normalizeLocalRateCardGraph(candidate, { sourceKind: "manual" }), candidate);
});

test("P3-F12 hardening: command authorization and optimistic inputs fail before mutation", async () => {
  await inRollback(async () => {
    await assert.rejects(
      () => applyLocalRateCardDraft(command({
        actor: { operatorId: "not-admin", roles: ["dispatcher"] },
        sourceKind: "manual",
        graph: graph()
      })),
      (error) => error?.status === 403 && error?.code === "MBT_ADMIN_REQUIRED"
    );
    await assert.rejects(
      () => validateLocalRateCardVersion(command({ rateCardVersionId: crypto.randomUUID(), expectedRevision: 0 })),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INPUT_INVALID"
    );
    await assert.rejects(
      () => cloneLocalRateCardVersion(command({
        sourceRateCardVersionId: crypto.randomUUID(), expectedRevision: 1, reason: ""
      })),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INPUT_INVALID"
    );

    const before = { root: config.mbt.enabled, masterData: config.mbtPhase3.masterDataEnabled };
    config.mbt.enabled = false;
    config.mbtPhase3.masterDataEnabled = true;
    try {
      await assert.rejects(
        () => applyLocalRateCardDraft(command({ sourceKind: "manual", graph: graph() })),
        (error) => error?.status === 409 && error?.code === "MBT_CAPABILITY_DISABLED"
      );
    } finally {
      config.mbt.enabled = before.root;
      config.mbtPhase3.masterDataEnabled = before.masterData;
    }
  });
});

test("P3-F12 hardening: lifecycle state, missing version, and stale revisions are explicit", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    await assert.rejects(
      () => validateLocalRateCardVersion(command({
        rateCardVersionId: crypto.randomUUID(), expectedRevision: 1
      })),
      (error) => error?.status === 404 && error?.code === "MBT_RATE_CARD_NOT_FOUND"
    );

    const noBands = await seedVersion("NOBANDS");
    await assert.rejects(
      () => validateLocalRateCardVersion(command({
        rateCardVersionId: noBands.rateCardVersionId, expectedRevision: 1
      })),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INVALID"
    );
    await assert.rejects(
      () => activateLocalRateCardVersion(command({
        rateCardVersionId: noBands.rateCardVersionId, expectedRevision: 1
      })),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INVALID"
    );

    const stale = await seedVersion("STALE");
    await seedValidBand(stale.rateCardVersionId);
    await assert.rejects(
      () => cloneLocalRateCardVersion(command({
        sourceRateCardVersionId: stale.rateCardVersionId, expectedRevision: 2
      })),
      (error) => error?.status === 409 && error?.code === "MBT_STALE_REVISION"
    );

    const active = await seedVersion("ACTIVE");
    await seedValidBand(active.rateCardVersionId);
    await query(
      "UPDATE mbt_rate_card_versions SET status = 'active', activated_at = now(), validation_snapshot = '{\"valid\":true}'::jsonb WHERE rate_card_version_id = $1",
      [active.rateCardVersionId]
    );
    await assert.rejects(
      () => validateLocalRateCardVersion(command({
        rateCardVersionId: active.rateCardVersionId, expectedRevision: 1
      })),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INPUT_INVALID"
    );

    const used = await seedVersion("USED");
    await seedValidBand(used.rateCardVersionId);
    await query(
      `UPDATE mbt_rate_card_versions SET first_used_at = now(),
         first_used_entity_type = 'quote', first_used_entity_id = $2
       WHERE rate_card_version_id = $1`,
      [used.rateCardVersionId, crypto.randomUUID()]
    );
    await assert.rejects(
      () => validateLocalRateCardVersion(command({
        rateCardVersionId: used.rateCardVersionId, expectedRevision: 1
      })),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INPUT_INVALID"
    );
  }));
});

test("P3-F12 hardening: service-template references resolve and the list API paginates locally", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const templateId = crypto.randomUUID();
    const dumpSiteId = crypto.randomUUID();
    await query(
      `INSERT INTO mbt_service_templates (
         template_id, template_code, display_name, created_by, updated_by
       ) VALUES ($1, 'LOCAL_TEMPLATE', 'Local template', $2, $2)`,
      [templateId, ACTOR.operatorId]
    );
    await query(
      `INSERT INTO mbt_dump_sites (
         dump_site_id, dump_site_code, display_name, country_code,
         active, revision, created_by, updated_by
       ) VALUES ($1, 'DUMP_LOCAL', 'Local dump', 'CA', true, 1, $2, $2)`,
      [dumpSiteId, ACTOR.operatorId]
    );
    const appliedGraph = graph();
    appliedGraph.rateCard.customerNetSuiteId = null;
    appliedGraph.rateCard.subsidiaryNetSuiteId = null;
    const created = await applyLocalRateCardDraft(command({
      sourceKind: "manual",
      graph: appliedGraph
    }));
    assert.equal(created.status, 201);

    const defaultPage = await listLocalRateCards();
    assert.equal(defaultPage.schemaVersion, "mbt-rate-cards-v1");
    assert.ok(defaultPage.items.length >= 1);

    const prefix = `P36_HARD_${RUN_ID.slice(0, 12)}`;
    const firstPage = await listLocalRateCards({ query: prefix, status: "DRAFT", limit: 1, cursor: null });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0].rateCardCode, prefix);
    assert.equal(firstPage.nextCursor, null);

    await assert.rejects(
      () => listLocalRateCards({ status: "invalid" }),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INPUT_INVALID"
    );
    await assert.rejects(
      () => listLocalRateCards({ limit: 0 }),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INPUT_INVALID"
    );
    await assert.rejects(
      () => listLocalRateCards({ limit: 101 }),
      (error) => error?.status === 400 && error?.code === "MBT_RATE_CARD_INPUT_INVALID"
    );
  }));
});
