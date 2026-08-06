// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";

const RATE_SERVICE_PATH = "../../../src/mbt/" + "rate-card-configuration-service.js";
const rateService = /** @type {Record<string, Function>} */ (await import(RATE_SERVICE_PATH)
  .catch(() => ({})));
const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({
  operatorId: `p3-rate-admin-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
let commandSequence = 0;

after(async () => {
  await closeDb();
});

/** @param {string} name */
function requiredOperation(name) {
  const operation = rateService[name];
  assert.equal(typeof operation, "function", `P3.6 requires rate-card-configuration-service.${name}.`);
  return operation;
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
  const environmentBefore = {
    root: config.mbt.enabled,
    masterData: config.mbtPhase3.masterDataEnabled
  };
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  await query(
    `UPDATE mbt_feature_flags
        SET enabled = true, updated_by = $2, updated_at = now()
      WHERE flag_key = ANY($1::text[])`,
    [["mbt_enabled", "mbt_master_data"], ACTOR.operatorId]
  );
  try {
    return await operation();
  } finally {
    config.mbt.enabled = environmentBefore.root;
    config.mbtPhase3.masterDataEnabled = environmentBefore.masterData;
  }
}

async function seedDumpReferences() {
  const materialId = crypto.randomUUID();
  const dumpSiteId = crypto.randomUUID();
  const materialCode = `P3MAT${RUN_ID.slice(0, 10)}`;
  const dumpSiteCode = `P3DUMP${RUN_ID.slice(0, 10)}`;
  await query(
    `INSERT INTO mbt_materials (
       material_id, material_code, display_name, description,
       active, revision, created_by, updated_by
     ) VALUES ($1, $2, 'Synthetic clean fill', 'P3.6 fixture', true, 1, $3, $3)`,
    [materialId, materialCode, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_dump_sites (
       dump_site_id, dump_site_code, display_name, country_code,
       active, revision, created_by, updated_by
     ) VALUES ($1, $2, 'Synthetic P3 transfer station', 'CA', true, 1, $3, $3)`,
    [dumpSiteId, dumpSiteCode, ACTOR.operatorId]
  );
  return { materialCode, dumpSiteCode };
}

function validGraph({
  suffix = "A",
  materialCode = `P3MAT${RUN_ID.slice(0, 10)}`,
  dumpSiteCode = `P3DUMP${RUN_ID.slice(0, 10)}`
} = {}) {
  return {
    rateCard: {
      rateCardCode: `P3_RATE_${RUN_ID.slice(0, 12)}_${suffix}`,
      displayName: `Synthetic local rate ${suffix}`,
      description: "PII-free P3.6 rate graph",
      customerNetSuiteId: null,
      subsidiaryNetSuiteId: null,
      serviceTemplateCode: null,
      currency: "CAD",
      active: true
    },
    version: {
      versionNumber: 1,
      effectiveFrom: "2036-08-03T00:00:00.000Z",
      effectiveTo: null,
      defaultRentalCalendarDays: 14,
      calculationNotes: "Use exact raw metres and integer CAD cents"
    },
    distanceBands: [
      {
        serviceCode: "delivery",
        binTypeCode: "14YD",
        sequenceNumber: 0,
        minimumMetres: 0,
        maximumMetres: 10_000,
        amountMinor: 12_000,
        downtownSurchargeMinor: 1_500,
        currency: "CAD",
        description: "Local"
      },
      {
        serviceCode: "delivery",
        binTypeCode: "14YD",
        sequenceNumber: 1,
        minimumMetres: 10_000,
        maximumMetres: null,
        amountMinor: 18_000,
        downtownSurchargeMinor: 2_500,
        currency: "CAD",
        description: "Extended"
      }
    ],
    components: [
      {
        componentCode: "rental_daily",
        componentKind: "rental",
        serviceCode: "delivery",
        binTypeCode: "14YD",
        rateBasis: "per_day",
        amountMinor: 700,
        percentageBasisPoints: null,
        defaultQuantity: "1.0000",
        currency: "CAD",
        taxable: true,
        active: true,
        description: "Daily rental"
      }
    ],
    dumpTariffs: [
      {
        dumpSiteCode,
        materialCode,
        tariffCode: "clean_fill_tonne",
        pricingBasis: "per_quantity",
        unitOfMeasure: "TONNE",
        amountMinor: 2_500,
        minimumAmountMinor: 16_000,
        currency: "CAD",
        active: true,
        description: "Customer clean-fill tariff"
      }
    ],
    depositRules: [
      {
        ruleCode: "initial_14yd",
        ruleType: "bin_type",
        binTypeCode: "14YD",
        serviceCode: null,
        fixedAmountMinor: 25_000,
        percentageBasisPoints: null,
        currency: "CAD",
        liabilityAccountMappingKey: "",
        active: true,
        description: "Local-only deposit intent"
      }
    ]
  };
}

function command(label, extra = {}) {
  commandSequence += 1;
  const identity = `${RUN_ID}-${commandSequence}`;
  return {
    actor: ACTOR,
    reason: `P3.6 ${label}`,
    idempotencyKey: `p3-rate-idem-${identity}`,
    correlationId: `p3-rate-corr-${identity}`,
    requestId: `p3-rate-req-${identity}`,
    ...extra
  };
}

test("P3-F12: manual and multi-CSV rate graphs share one canonical validator", async () => {
  const normalizeLocalRateCardGraph = requiredOperation("normalizeLocalRateCardGraph");
  const graph = validGraph();
  const manual = normalizeLocalRateCardGraph(graph, { sourceKind: "manual" });
  const csv = normalizeLocalRateCardGraph(structuredClone(graph), { sourceKind: "csv" });
  assert.deepEqual(csv, manual);
  assert.deepEqual(manual, graph);
  assert.equal(Object.hasOwn(manual.rateCard, "netSuiteId"), false);
  assert.equal(Object.hasOwn(manual.rateCard, "price"), false);
  assert.ok(manual.distanceBands.every(({ minimumMetres, maximumMetres, amountMinor }) => (
    Number.isSafeInteger(minimumMetres)
      && (maximumMetres === null || Number.isSafeInteger(maximumMetres))
      && Number.isSafeInteger(amountMinor)
  )));
});

test("P3-F12: one draft command creates the complete graph atomically and exact retry replays", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const applyLocalRateCardDraft = requiredOperation("applyLocalRateCardDraft");
    const references = await seedDumpReferences();
    const graph = validGraph(references);
    const input = command("atomic manual draft", { sourceKind: "manual", graph });
    const first = await applyLocalRateCardDraft(input);
    const replay = await applyLocalRateCardDraft(structuredClone(input));
    assert.equal(first.status, 201);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    assert.equal(first.body.version.status, "draft");
    assert.equal(first.body.version.versionNumber, 1);

    const stored = await query(
      `SELECT card.rate_card_code,
              card.currency,
              version.status,
              version.revision::int AS revision,
              (SELECT count(*)::int FROM mbt_rate_distance_bands band
                WHERE band.rate_card_version_id = version.rate_card_version_id) AS bands,
              (SELECT count(*)::int FROM mbt_rate_components component
                WHERE component.rate_card_version_id = version.rate_card_version_id) AS components,
              (SELECT count(*)::int FROM mbt_dump_tariffs tariff
                WHERE tariff.rate_card_version_id = version.rate_card_version_id) AS tariffs,
              (SELECT count(*)::int FROM mbt_deposit_rules rule
                WHERE rule.rate_card_version_id = version.rate_card_version_id) AS deposits
         FROM mbt_rate_cards card
         JOIN mbt_rate_card_versions version USING (rate_card_id)
        WHERE card.rate_card_code = $1`,
      [graph.rateCard.rateCardCode]
    );
    assert.deepEqual(stored.rows, [{
      rate_card_code: graph.rateCard.rateCardCode,
      currency: "CAD",
      status: "draft",
      revision: 1,
      bands: 2,
      components: 1,
      tariffs: 1,
      deposits: 1
    }]);
    const evidence = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_audit_events
           WHERE actor_operator_id = $1 AND action = 'mbt.rate_card.draft.applied') AS audits,
         (SELECT count(*)::int FROM mbt_command_receipts
           WHERE actor_operator_id = $1 AND command_name = 'mbt.rate_card.draft.apply') AS receipts`,
      [ACTOR.operatorId]
    );
    assert.deepEqual(evidence.rows[0], { audits: 1, receipts: 1 });
  }));
});

test("P3-F12: gaps, overlap, unsafe cents/metres, invalid dates/currency/units, and extra pricing fields fail before mutation", async () => {
  const normalizeLocalRateCardGraph = requiredOperation("normalizeLocalRateCardGraph");
  const mutations = [
    {
      label: "gap",
      mutate: (graph) => { graph.distanceBands[1].minimumMetres = 10_001; },
      code: "MBT_RATE_CARD_INVALID"
    },
    {
      label: "overlap",
      mutate: (graph) => { graph.distanceBands[1].minimumMetres = 9_999; },
      code: "MBT_RATE_CARD_INVALID"
    },
    {
      label: "fractional cents",
      mutate: (graph) => { graph.components[0].amountMinor = 0.5; },
      code: "MBT_RATE_CARD_INPUT_INVALID"
    },
    {
      label: "unsafe metres",
      mutate: (graph) => { graph.distanceBands[0].maximumMetres = Number.MAX_SAFE_INTEGER + 1; },
      code: "MBT_RATE_CARD_INPUT_INVALID"
    },
    {
      label: "date order",
      mutate: (graph) => { graph.version.effectiveTo = "2036-08-02T00:00:00.000Z"; },
      code: "MBT_RATE_CARD_INPUT_INVALID"
    },
    {
      label: "non-CAD local currency",
      mutate: (graph) => { graph.rateCard.currency = "USD"; },
      code: "MBT_RATE_CARD_CURRENCY_INVALID"
    },
    {
      label: "fixed tariff with unit",
      mutate: (graph) => { graph.dumpTariffs[0].pricingBasis = "fixed"; },
      code: "MBT_RATE_CARD_INPUT_INVALID"
    },
    {
      label: "duplicate dollar price",
      mutate: (graph) => { graph.components[0].amount = "7.00"; },
      code: "MBT_RATE_CARD_INPUT_INVALID"
    }
  ];
  for (const scenario of mutations) {
    const graph = structuredClone(validGraph());
    scenario.mutate(graph);
    assert.throws(
      () => normalizeLocalRateCardGraph(graph, { sourceKind: "manual" }),
      (error) => error?.status === 400 && error?.code === scenario.code,
      scenario.label
    );
  }
});

test("P3-F12: unknown local references roll back every draft row", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const applyLocalRateCardDraft = requiredOperation("applyLocalRateCardDraft");
    const graph = validGraph({
      suffix: "UNKNOWN",
      materialCode: "DOES_NOT_EXIST",
      dumpSiteCode: "DOES_NOT_EXIST"
    });
    await assert.rejects(
      () => applyLocalRateCardDraft(command("unknown reference", {
        sourceKind: "csv",
        graph
      })),
      (error) => error?.status === 400 && error?.code === "MBT_MASTER_REFERENCE_INVALID"
    );
    const counts = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_rate_cards WHERE rate_card_code = $1) AS cards,
         (SELECT count(*)::int FROM mbt_rate_card_versions version
           JOIN mbt_rate_cards card USING (rate_card_id)
          WHERE card.rate_card_code = $1) AS versions`,
      [graph.rateCard.rateCardCode]
    );
    assert.deepEqual(counts.rows[0], { cards: 0, versions: 0 });
  }));
});

test("P3-F12: validation and activation are audited, revision-bound, idempotent, and locally quiet", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const applyLocalRateCardDraft = requiredOperation("applyLocalRateCardDraft");
    const validateLocalRateCardVersion = requiredOperation("validateLocalRateCardVersion");
    const activateLocalRateCardVersion = requiredOperation("activateLocalRateCardVersion");
    const externalBefore = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
         (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain) AS chains`
    );
    const references = await seedDumpReferences();
    const created = await applyLocalRateCardDraft(command("activation draft", {
      sourceKind: "manual",
      graph: validGraph({ ...references, suffix: "ACTIVE" })
    }));
    const validated = await validateLocalRateCardVersion(command("validate", {
      rateCardVersionId: created.body.version.rateCardVersionId,
      expectedRevision: created.body.version.revision
    }));
    assert.equal(validated.body.version.validation.valid, true);
    const activationInput = command("activate", {
      rateCardVersionId: created.body.version.rateCardVersionId,
      expectedRevision: validated.body.version.revision
    });
    const activated = await activateLocalRateCardVersion(activationInput);
    const replay = await activateLocalRateCardVersion(structuredClone(activationInput));
    assert.equal(activated.body.version.status, "active");
    assert.equal(activated.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, activated.body);
    const external = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
         (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain) AS chains`
    );
    assert.deepEqual(external.rows[0], externalBefore.rows[0]);
  }));
});

test("P3-F12: editing a used version clones a complete new draft and preserves the original checksum", async () => {
  await inRollback(() => withMasterDataEnabled(async () => {
    const applyLocalRateCardDraft = requiredOperation("applyLocalRateCardDraft");
    const validateLocalRateCardVersion = requiredOperation("validateLocalRateCardVersion");
    const activateLocalRateCardVersion = requiredOperation("activateLocalRateCardVersion");
    const cloneLocalRateCardVersion = requiredOperation("cloneLocalRateCardVersion");
    const references = await seedDumpReferences();
    const created = await applyLocalRateCardDraft(command("clone source", {
      sourceKind: "manual",
      graph: validGraph({ ...references, suffix: "CLONE" })
    }));
    const validated = await validateLocalRateCardVersion(command("clone validate", {
      rateCardVersionId: created.body.version.rateCardVersionId,
      expectedRevision: created.body.version.revision
    }));
    const activated = await activateLocalRateCardVersion(command("clone activate", {
      rateCardVersionId: created.body.version.rateCardVersionId,
      expectedRevision: validated.body.version.revision
    }));
    await query(
      `UPDATE mbt_rate_card_versions
          SET first_used_at = now(),
              first_used_entity_type = 'quote',
              first_used_entity_id = $2
        WHERE rate_card_version_id = $1`,
      [activated.body.version.rateCardVersionId, crypto.randomUUID()]
    );
    const before = await query(
      `SELECT md5(jsonb_build_array(
         to_jsonb(version),
         (SELECT jsonb_agg(to_jsonb(band) ORDER BY sequence_number)
            FROM mbt_rate_distance_bands band
           WHERE band.rate_card_version_id = version.rate_card_version_id),
         (SELECT jsonb_agg(to_jsonb(component) ORDER BY component_code)
            FROM mbt_rate_components component
           WHERE component.rate_card_version_id = version.rate_card_version_id),
         (SELECT jsonb_agg(to_jsonb(tariff) ORDER BY tariff_code)
            FROM mbt_dump_tariffs tariff
           WHERE tariff.rate_card_version_id = version.rate_card_version_id),
         (SELECT jsonb_agg(to_jsonb(rule) ORDER BY rule_code)
            FROM mbt_deposit_rules rule
           WHERE rule.rate_card_version_id = version.rate_card_version_id)
       )::text) AS checksum
         FROM mbt_rate_card_versions version
        WHERE rate_card_version_id = $1`,
      [activated.body.version.rateCardVersionId]
    );
    const cloned = await cloneLocalRateCardVersion(command("clone used version", {
      sourceRateCardVersionId: activated.body.version.rateCardVersionId,
      expectedRevision: activated.body.version.revision
    }));
    assert.equal(cloned.body.version.status, "draft");
    assert.equal(cloned.body.version.versionNumber, 2);
    assert.notEqual(cloned.body.version.rateCardVersionId, activated.body.version.rateCardVersionId);
    const sourceAfterClone = await query(
      `SELECT md5(jsonb_build_array(
         to_jsonb(version),
         (SELECT jsonb_agg(to_jsonb(band) ORDER BY sequence_number)
            FROM mbt_rate_distance_bands band
           WHERE band.rate_card_version_id = version.rate_card_version_id),
         (SELECT jsonb_agg(to_jsonb(component) ORDER BY component_code)
            FROM mbt_rate_components component
           WHERE component.rate_card_version_id = version.rate_card_version_id),
         (SELECT jsonb_agg(to_jsonb(tariff) ORDER BY tariff_code)
            FROM mbt_dump_tariffs tariff
           WHERE tariff.rate_card_version_id = version.rate_card_version_id),
         (SELECT jsonb_agg(to_jsonb(rule) ORDER BY rule_code)
            FROM mbt_deposit_rules rule
           WHERE rule.rate_card_version_id = version.rate_card_version_id)
       )::text) AS checksum
         FROM mbt_rate_card_versions version
        WHERE rate_card_version_id = $1`,
      [activated.body.version.rateCardVersionId]
    );
    assert.equal(sourceAfterClone.rows[0].checksum, before.rows[0].checksum);
    const childCounts = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_rate_distance_bands WHERE rate_card_version_id = $1) AS bands,
         (SELECT count(*)::int FROM mbt_rate_components WHERE rate_card_version_id = $1) AS components,
         (SELECT count(*)::int FROM mbt_dump_tariffs WHERE rate_card_version_id = $1) AS tariffs,
         (SELECT count(*)::int FROM mbt_deposit_rules WHERE rate_card_version_id = $1) AS deposits`,
      [cloned.body.version.rateCardVersionId]
    );
    assert.deepEqual(childCounts.rows[0], { bands: 2, components: 1, tariffs: 1, deposits: 1 });
  }));
});
