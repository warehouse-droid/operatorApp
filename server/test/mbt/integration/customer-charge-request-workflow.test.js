// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  acceptFrontdeskQuote,
  convertFrontdeskQuote,
  createFrontdeskQuote,
  issueFrontdeskQuote
} from "../../../src/mbt/frontdesk-service.js";
import {
  createFrontdeskPrerequisites,
  frontdeskCommand,
  frontdeskDistanceResolver,
  frontdeskTaxResolver,
  quoteCommand
} from "../support/frontdesk-fixtures.js";

const SERVICE_PATH = "../../../src/mbt/" + "customer-charge-request-service.js";
const requestService = /** @type {Record<string, Function>} */ (await import(SERVICE_PATH).catch(() => ({})));

const ACTOR = Object.freeze({
  operatorId: `customer-charge-${crypto.randomUUID().slice(0, 8)}`,
  roles: Object.freeze(["mbt_frontdesk"])
});
const ADMIN_ACTOR = Object.freeze({
  operatorId: `customer-charge-admin-${crypto.randomUUID().slice(0, 8)}`,
  roles: Object.freeze(["admin"])
});

after(async () => {
  await closeDb();
});

/** @param {string} name */
function requiredOperation(name) {
  assert.equal(typeof requestService[name], "function", `Customer charge request service must export ${name}.`);
  return requestService[name];
}

/** @param {string} prefix @param {Record<string, unknown>} fields */
function command(prefix, fields) {
  return {
    actor: ACTOR,
    ...fields,
    reason: `${prefix} regression`,
    idempotencyKey: `${prefix}-${crypto.randomUUID()}`,
    correlationId: `${prefix}-correlation-${crypto.randomUUID()}`,
    requestId: `${prefix}-request-${crypto.randomUUID()}`
  };
}

/** @param {() => Promise<unknown>} operation @param {string} code @param {number} [status] */
async function rejectsCode(operation, code, status) {
  await assert.rejects(
    operation,
    (error) => error?.code === code && (status === undefined || error?.status === status)
  );
}

/** @param {Awaited<ReturnType<typeof createFrontdeskPrerequisites>>} fixture */
async function configureCustomerChargeRates(fixture) {
  await query(
    `UPDATE mbt_frontdesk_charge_catalog
        SET active = true,
            density_lbs_per_yard = CASE item_code
              WHEN 'AGG_CLEAR_LIMESTONE_34' THEN 2700
              WHEN 'AGG_CRUSHER_RUN' THEN 2850
              WHEN 'AGG_HPB' THEN 2600
              WHEN 'AGG_SCREENING' THEN 2750
              ELSE density_lbs_per_yard
            END,
            revision = revision + 1,
            updated_by = $1,
            updated_at = now()
      WHERE item_kind IN ('aggregate_material', 'fixed_dump')`,
    [ACTOR.operatorId]
  );
  const amounts = {
    AGG_CLEAR_LIMESTONE_34: 5_250,
    AGG_CRUSHER_RUN: 4_800,
    AGG_HPB: 6_500,
    AGG_SCREENING: 4_200,
    AGG_LOADING: 5_000,
    DUMP_SOIL: 85_000,
    DUMP_ASPHALT: 72_500,
    DUMP_CONCRETE: 92_500
  };
  for (const [itemCode, amountMinor] of Object.entries(amounts)) {
    await query(
      `INSERT INTO mbt_frontdesk_charge_rates (
         charge_rate_id, rate_card_version_id, item_code, amount_minor,
         currency, active, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, 'CAD', true, $5, $5)`,
      [crypto.randomUUID(), fixture.rateCardVersionId, itemCode, amountMinor, ACTOR.operatorId]
    );
  }
  for (const [index, band] of [
    { code: "AGG_0_30", minimum: 0, maximum: 30_000, amount: 15_000 },
    { code: "AGG_30_50", minimum: 30_000, maximum: 50_000, amount: 20_000 },
    { code: "AGG_50_75", minimum: 50_000, maximum: 75_000, amount: 27_500 }
  ].entries()) {
    await query(
      `INSERT INTO mbt_frontdesk_aggregate_distance_bands (
         aggregate_distance_band_id, rate_card_version_id, band_code,
         sequence_number, minimum_metres, maximum_metres, amount_minor,
         currency, active, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CAD', true, $8, $8)`,
      [
        crypto.randomUUID(), fixture.rateCardVersionId, band.code, index + 1,
        band.minimum, band.maximum, band.amount, ACTOR.operatorId
      ]
    );
  }
}

/** @param {string} label */
async function convertedContract(label) {
  const fixture = await createFrontdeskPrerequisites({ label });
  await configureCustomerChargeRates(fixture);
  const created = await createFrontdeskQuote(
    quoteCommand(fixture, { actor: ACTOR, identity: `${label}-${crypto.randomUUID()}` }),
    { resolveDistance: frontdeskDistanceResolver(fixture), resolveTaxPolicy: frontdeskTaxResolver }
  );
  const quoteId = created.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand(`${label}-issue`, ACTOR, {
    quoteId, expectedRevision: 1, validUntil: "2037-08-04T12:00:00.000Z"
  }));
  await acceptFrontdeskQuote(frontdeskCommand(`${label}-accept`, ACTOR, {
    quoteId, expectedRevision: 2, acceptedAt: "2037-08-03T10:00:00.000Z"
  }));
  const converted = await convertFrontdeskQuote(frontdeskCommand(`${label}-convert`, ACTOR, {
    quoteId, expectedRevision: 3
  }));
  return { fixture, created, converted };
}

/**
 * @param {Awaited<ReturnType<typeof createFrontdeskPrerequisites>>} fixture
 * @param {Record<string, any>} [overrides]
 */
function initialBinFields(fixture, overrides = {}) {
  const bin = overrides.bin === null
    ? null
    : {
        incomingContentCode: "garbage",
        incomingBinSizeYards: 14,
        binItemCode: fixture.binItemCode,
        incomingBinTypeId: fixture.binTypeId,
        deliveryItemCode: fixture.deliveryItemCode,
        proposedDeliveryAt: fixture.proposedDeliveryAt,
        proposedReturnAt: fixture.proposedReturnAt,
        ...(overrides.bin || {})
      };
  return {
    kind: "initial_bin",
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: false,
    distanceMetres: 12_500,
    aggregateLines: [],
    ...overrides,
    bin
  };
}

/** @param {Awaited<ReturnType<typeof createFrontdeskPrerequisites>>} fixture @param {string} label */
function initialGarbagePreview(fixture, label) {
  return requiredOperation("previewFrontdeskChargeRequest")(
    command(label, initialBinFields(fixture))
  );
}

test("admin atomically configures the complete real-rate customer-charge sheet with optimistic locking", async () => {
  const replaceConfiguration = requiredOperation("replaceFrontdeskCustomerChargeConfiguration");
  const getAdminConfiguration = requiredOperation("getFrontdeskCustomerChargeAdminConfiguration");
  const getFrontdeskConfiguration = requiredOperation("getFrontdeskCustomerChargeConfiguration");
  const fixture = await createFrontdeskPrerequisites({ label: "charge-admin-configuration" });
  const outboxBefore = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  const input = command("charge-admin-configuration", {
    actor: ADMIN_ACTOR,
    rateCardVersionId: fixture.rateCardVersionId,
    expectedRevision: 0,
    aggregateItems: [
      { itemCode: "AGG_CLEAR_LIMESTONE_34", amountMinor: 5_250, densityLbsPerYard: 2_700 },
      { itemCode: "AGG_CRUSHER_RUN", amountMinor: 4_800, densityLbsPerYard: 2_850 },
      { itemCode: "AGG_HPB", amountMinor: 6_500, densityLbsPerYard: 2_600 },
      { itemCode: "AGG_SCREENING", amountMinor: 4_200, densityLbsPerYard: 2_750 }
    ],
    fixedDumpItems: [
      { itemCode: "DUMP_SOIL", amountMinor: 85_000 },
      { itemCode: "DUMP_ASPHALT", amountMinor: 72_500 },
      { itemCode: "DUMP_CONCRETE", amountMinor: 92_500 }
    ],
    aggregateDistanceBands: [
      { bandCode: "AGG_0_30", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 15_000 },
      { bandCode: "AGG_30_50", minimumMetres: 30_000, maximumMetres: 50_000, amountMinor: 20_000 },
      { bandCode: "AGG_50_PLUS", minimumMetres: 50_000, maximumMetres: null, amountMinor: 27_500 }
    ]
  });

  await assert.rejects(
    () => getAdminConfiguration({ actor: ACTOR, rateCardVersionId: fixture.rateCardVersionId }),
    (error) => error?.code === "MBT_ADMIN_REQUIRED" && error?.status === 403
  );
  await assert.rejects(
    () => replaceConfiguration({
      ...input,
      aggregateItems: input.aggregateItems.slice(0, 3),
      idempotencyKey: `${input.idempotencyKey}-partial`
    }),
    (error) => error?.code === "MBT_FRONTDESK_CONFIGURATION_INVALID" && error?.status === 422
  );
  await assert.rejects(
    () => replaceConfiguration({
      ...input,
      aggregateDistanceBands: [
        { bandCode: "AGG_0_30", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 14_999 }
      ],
      idempotencyKey: `${input.idempotencyKey}-wrong-standard`
    }),
    (error) => error?.code === "MBT_FRONTDESK_CONFIGURATION_INVALID" && error?.status === 422
  );
  await assert.rejects(
    () => replaceConfiguration({
      ...input,
      expectedRevision: 1,
      idempotencyKey: `${input.idempotencyKey}-stale-create`
    }),
    (error) => error?.code === "MBT_STALE_REVISION" && error?.status === 409
  );
  const unconfiguredAdmin = await getAdminConfiguration({
    actor: ADMIN_ACTOR,
    rateCardVersionId: fixture.rateCardVersionId
  });
  assert.equal(unconfiguredAdmin.revision, 0);
  assert.equal(unconfiguredAdmin.complete, false);
  assert.equal(unconfiguredAdmin.createdAt, null);
  assert.equal(unconfiguredAdmin.updatedAt, null);
  assert.equal(unconfiguredAdmin.aggregateItems.every((item) => item.amountMinor === null), true);
  assert.equal(unconfiguredAdmin.fixedDumpItems.every((item) => item.amountMinor === null), true);
  const unconfiguredFrontdesk = await getFrontdeskConfiguration({
    actor: ACTOR,
    rateCardVersionId: fixture.rateCardVersionId
  });
  assert.equal(unconfiguredFrontdesk.configurationRevision, 0);
  assert.equal(unconfiguredFrontdesk.complete, false);
  assert.deepEqual(unconfiguredFrontdesk.aggregateItems, []);
  assert.deepEqual(unconfiguredFrontdesk.fixedDumpItems, []);
  const beforeSave = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_frontdesk_charge_configurations
         WHERE rate_card_version_id = $1::uuid) AS configurations,
       (SELECT count(*)::int FROM mbt_frontdesk_charge_rates
         WHERE rate_card_version_id = $1::uuid) AS rates,
       (SELECT count(*)::int FROM mbt_frontdesk_aggregate_distance_bands
         WHERE rate_card_version_id = $1::uuid) AS bands`,
    [fixture.rateCardVersionId]
  );
  assert.deepEqual(beforeSave.rows[0], { configurations: 0, rates: 0, bands: 0 });

  const saved = await replaceConfiguration(input);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.configuration.revision, 1);
  assert.equal(saved.body.configuration.complete, true);
  assert.equal(saved.body.configuration.aggregateLoadingFeeMinor, 5_000);

  const adminRead = await getAdminConfiguration({
    actor: ADMIN_ACTOR,
    rateCardVersionId: fixture.rateCardVersionId
  });
  assert.equal(adminRead.revision, 1);
  assert.equal(adminRead.aggregateItems.length, 4);
  assert.equal(adminRead.fixedDumpItems.length, 3);
  assert.deepEqual(
    adminRead.aggregateDistanceBands.map((band) => [band.minimumMetres, band.maximumMetres, band.amountMinor]),
    [[0, 30_000, 15_000], [30_000, 50_000, 20_000], [50_000, null, 27_500]]
  );

  const frontdeskRead = await getFrontdeskConfiguration({
    actor: ACTOR,
    rateCardVersionId: fixture.rateCardVersionId
  });
  assert.equal(frontdeskRead.configurationRevision, 1);
  assert.equal(frontdeskRead.aggregateItems.length, 4);
  assert.equal(frontdeskRead.fixedDumpItems.length, 3);

  const updated = await replaceConfiguration({
    ...input,
    expectedRevision: 1,
    aggregateItems: input.aggregateItems.map((item) => item.itemCode === "AGG_HPB"
      ? { ...item, amountMinor: 6_750 }
      : item),
    reason: "charge-admin-configuration second revision",
    idempotencyKey: `charge-admin-configuration-second-${crypto.randomUUID()}`,
    correlationId: `charge-admin-configuration-second-correlation-${crypto.randomUUID()}`,
    requestId: `charge-admin-configuration-second-request-${crypto.randomUUID()}`
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.configuration.revision, 2);
  assert.equal(
    updated.body.configuration.aggregateItems.find((item) => item.itemCode === "AGG_HPB").amountMinor,
    6_750
  );

  await assert.rejects(
    () => replaceConfiguration({ ...input, idempotencyKey: `${input.idempotencyKey}-stale` }),
    (error) => error?.code === "MBT_STALE_REVISION" && error?.status === 409
  );
  const outboxAfter = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  assert.equal(outboxAfter.rows[0].count, outboxBefore.rows[0].count);
});

test("standalone aggregate preview uses persisted per-yard rates and exact upper-inclusive distance bands", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const getConfiguration = requiredOperation("getFrontdeskCustomerChargeConfiguration");
  const fixture = await createFrontdeskPrerequisites({ label: "aggregate-preview" });
  await configureCustomerChargeRates(fixture);

  const configuration = await getConfiguration({ actor: ACTOR, rateCardVersionId: fixture.rateCardVersionId });
  assert.deepEqual(configuration.aggregateItems.map((item) => [item.itemCode, item.unitOfMeasure]), [
    ["AGG_CLEAR_LIMESTONE_34", "YARD"],
    ["AGG_CRUSHER_RUN", "YARD"],
    ["AGG_HPB", "YARD"],
    ["AGG_SCREENING", "YARD"]
  ]);
  assert.equal(configuration.aggregateDistanceBands[0].maximumMetres, 30_000);
  assert.equal(configuration.aggregateDistanceBands[0].amountMinor, 15_000);

  const result = await preview(command("aggregate-preview", {
    kind: "aggregate_order",
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "card",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 30_000,
    aggregateLines: [
      { itemCode: "AGG_HPB", quantityYards: "2.500" },
      { itemCode: "AGG_CRUSHER_RUN", quantityYards: "1.000" }
    ]
  }));
  assert.equal(result.status, 201);
  assert.equal(result.body.request.paymentCategory, "non_cash");
  assert.equal(result.body.request.preTaxRevenueMinor, 36_050);
  assert.equal(result.body.request.addedHstMinor, 4_687);
  assert.equal(result.body.request.newRequestChargeableMinor, 40_737);
  assert.equal(result.body.request.dueNowMinor, 40_737);
  assert.equal(result.body.request.netsuiteExportPolicy, "eligible_non_cash");
  assert.equal(result.body.request.lines.some((line) => line.lineType === "aggregate_loading_fee"), false);
  assert.equal(result.body.request.lines.find((line) => line.lineType === "aggregate_delivery").configuredAmountMinor, 15_000);
});

test("garbage pricing fails closed when its deposit rule is missing or not CAD", async () => {
  const missing = await createFrontdeskPrerequisites({ label: "garbage-deposit-missing" });
  await configureCustomerChargeRates(missing);
  await query("DELETE FROM mbt_deposit_rules WHERE deposit_rule_id = $1::uuid", [missing.depositRuleId]);
  await assert.rejects(
    () => initialGarbagePreview(missing, "garbage-deposit-missing"),
    (error) => error?.code === "MBT_FRONTDESK_DEPOSIT_RATE_MISSING" && error?.status === 422
  );

  const wrongCurrency = await createFrontdeskPrerequisites({ label: "garbage-deposit-usd" });
  await configureCustomerChargeRates(wrongCurrency);
  await query(
    "UPDATE mbt_deposit_rules SET currency = 'USD' WHERE deposit_rule_id = $1::uuid",
    [wrongCurrency.depositRuleId]
  );
  await assert.rejects(
    () => initialGarbagePreview(wrongCurrency, "garbage-deposit-usd"),
    (error) => error?.code === "MBT_FRONTDESK_CURRENCY_MISMATCH" && error?.status === 422
  );

  const stored = await query(
    `SELECT count(*)::int AS count
       FROM mbt_frontdesk_charge_requests
      WHERE rate_card_version_id = ANY($1::uuid[])`,
    [[missing.rateCardVersionId, wrongCurrency.rateCardVersionId]]
  );
  assert.equal(stored.rows[0].count, 0);
});

test("confirming a standalone aggregate request creates one linked Dispatch order and no NetSuite outbox work", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const confirm = requiredOperation("confirmFrontdeskChargeRequest");
  const fixture = await createFrontdeskPrerequisites({ label: "aggregate-confirm" });
  await configureCustomerChargeRates(fixture);
  const draft = await preview(command("aggregate-confirm-preview", {
    kind: "aggregate_order",
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 12_000,
    aggregateLines: [
      { itemCode: "AGG_HPB", quantityYards: "2.500" },
      { itemCode: "AGG_CRUSHER_RUN", quantityYards: "1.000" }
    ]
  }));
  const chargeRequestId = draft.body.request.chargeRequestId;
  const outboxBefore = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  const confirmed = await confirm(command("aggregate-confirm", {
    chargeRequestId,
    expectedRevision: 1
  }));
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.request.status, "confirmed");
  assert.equal(confirmed.body.request.netsuiteExportPolicy, "excluded_cash");
  assert.equal(confirmed.body.dispatchOrder.weightLbs, 9_350);
  assert.match(confirmed.body.dispatchOrder.orderDetails, /HPB · 2\.500 YARD/u);
  assert.match(confirmed.body.dispatchOrder.orderDetails, /Crusher Run · 1\.000 YARD/u);
  const retained = await query(
    `SELECT count(*)::int AS count, min(mbt_source) AS source
       FROM dispatch_custom_orders
      WHERE mbt_charge_request_id = $1`,
    [chargeRequestId]
  );
  assert.deepEqual(retained.rows[0], { count: 1, source: "frontdesk_aggregate" });
  const outboxAfter = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  assert.equal(outboxAfter.rows[0].count, outboxBefore.rows[0].count);

  const replay = await confirm({
    ...command("unused", { chargeRequestId, expectedRevision: 1 }),
    reason: "aggregate-confirm regression",
    idempotencyKey: confirmed.body.request.confirmationIdempotencyKey
  });
  assert.equal(replay.replayed, true);
});

test("active contract add-bin preview reports current, request, resulting, deposit, and attached aggregate due now", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const confirm = requiredOperation("confirmFrontdeskChargeRequest");
  const { fixture, created, converted } = await convertedContract("add-bin-preview");
  const contract = converted.body.contract;
  const beforeLines = await query(
    "SELECT count(*)::int AS count FROM mbt_contract_service_lines WHERE contract_id = $1",
    [contract.contractId]
  );
  const result = await preview(command("add-bin-preview", {
    kind: "add_bin",
    contractId: contract.contractId,
    expectedContractRevision: contract.revision,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 12_500,
    bin: {
      incomingContentCode: "garbage",
      incomingBinSizeYards: 14,
      binItemCode: fixture.binItemCode,
      incomingBinTypeId: fixture.binTypeId,
      deliveryItemCode: fixture.deliveryItemCode,
      discountMinor: 2_500,
      discountReason: "Repeat customer",
      proposedDeliveryAt: "2037-08-20T12:00:00.000Z",
      proposedReturnAt: "2037-09-03T12:00:00.000Z"
    },
    aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "1.000" }]
  }));
  const request = result.body.request;
  assert.equal(request.currentContractTotalMinor, created.body.quote.pricing.totalMinor);
  assert.equal(request.requiredDepositMinor, 10_000);
  assert.equal(request.lines.filter((line) => line.lineType === "aggregate_loading_fee").length, 1);
  assert.equal(request.lines.some((line) => line.lineType === "fixed_dump"), false);
  const aggregateDue = request.lines
    .filter((line) => line.paymentTiming === "due_now")
    .reduce((sum, line) => sum + line.customerAmountMinor, 0);
  assert.equal(request.dueNowMinor, 10_000 + aggregateDue);
  assert.equal(
    request.resultingContractTotalMinor,
    request.currentContractTotalMinor + request.newRequestChargeableMinor
  );

  const confirmed = await confirm(command("add-bin-confirm", {
    chargeRequestId: request.chargeRequestId,
    expectedRevision: request.revision
  }));
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.request.status, "confirmed");
  const addedLines = await query(
    `SELECT line.service_line_id::text, line.source_charge_request_id::text,
            visit.service_snapshot
       FROM mbt_contract_service_lines line
       JOIN mbt_service_visits visit
         ON visit.service_line_id = line.service_line_id
        AND visit.service_action = 'delivery'
      WHERE line.contract_id = $1::uuid
      ORDER BY line.line_number`,
    [contract.contractId]
  );
  assert.equal(addedLines.rowCount, beforeLines.rows[0].count + 1);
  const added = addedLines.rows.find((row) => row.source_charge_request_id === request.chargeRequestId);
  assert.ok(added, "The new physical bin must retain its confirmed charge-request identity.");
  assert.deepEqual(added.service_snapshot.attachedAggregate.materials.map((line) => line.itemCode), ["AGG_HPB"]);
  assert.equal(added.service_snapshot.attachedAggregate.loadingFeeMinor, 5_000);
  const separateDispatch = await query(
    "SELECT count(*)::int AS count FROM dispatch_custom_orders WHERE mbt_charge_request_id = $1",
    [request.chargeRequestId]
  );
  assert.equal(separateDispatch.rows[0].count, 0);
});

test("cash initial then card add rolls both confirmed amounts into the next customer total", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const confirm = requiredOperation("confirmFrontdeskChargeRequest");
  const list = requiredOperation("listFrontdeskContractChargeRequests");
  const fixture = await createFrontdeskPrerequisites({ label: "mixed-payment-rolling-total" });
  await configureCustomerChargeRates(fixture);
  const outboxBefore = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  const created = await createFrontdeskQuote({
    ...quoteCommand(fixture, { actor: ACTOR, identity: `mixed-total-${crypto.randomUUID()}` }),
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: false,
    dumpItemCode: undefined,
    estimatedTonnes: undefined,
    serviceLines: [{
      binItemCode: fixture.binItemCode,
      binTypeId: fixture.binTypeId,
      contentCode: "garbage",
      discountMinor: 0,
      proposedDeliveryAt: fixture.proposedDeliveryAt,
      proposedReturnAt: fixture.proposedReturnAt,
      siteProfileId: fixture.siteProfileId
    }],
    aggregateLines: []
  }, { resolveDistance: frontdeskDistanceResolver(fixture), resolveTaxPolicy: frontdeskTaxResolver });
  const quote = created.body.quote;
  await issueFrontdeskQuote(frontdeskCommand("mixed-total-issue", ACTOR, {
    quoteId: quote.quoteId, expectedRevision: 1, validUntil: "2037-08-04T12:00:00.000Z"
  }));
  await acceptFrontdeskQuote(frontdeskCommand("mixed-total-accept", ACTOR, {
    quoteId: quote.quoteId, expectedRevision: 2, acceptedAt: "2037-08-03T10:00:00.000Z"
  }));
  const converted = await convertFrontdeskQuote(frontdeskCommand("mixed-total-convert", ACTOR, {
    quoteId: quote.quoteId, expectedRevision: 3
  }));
  const contract = converted.body.contract;
  const cardDraft = await preview(command("mixed-total-card-add", {
    kind: "add_bin",
    contractId: contract.contractId,
    expectedContractRevision: contract.revision,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "card",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 12_500,
    bin: {
      incomingContentCode: "garbage",
      incomingBinSizeYards: 14,
      binItemCode: fixture.binItemCode,
      incomingBinTypeId: fixture.binTypeId,
      deliveryItemCode: fixture.deliveryItemCode,
      proposedDeliveryAt: "2037-08-20T12:00:00.000Z",
      proposedReturnAt: "2037-09-03T12:00:00.000Z"
    },
    aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "1.000" }]
  }));
  assert.equal(quote.pricing.paymentCategory, "cash");
  assert.equal(quote.pricing.addedHstMinor, 0);
  assert.equal(cardDraft.body.request.paymentCategory, "non_cash");
  assert.equal(cardDraft.body.request.includedHstMinor, 0);
  assert.equal(cardDraft.body.request.addedHstMinor > 0, true);
  await confirm(command("mixed-total-card-confirm", {
    chargeRequestId: cardDraft.body.request.chargeRequestId,
    expectedRevision: cardDraft.body.request.revision
  }));
  const currentContract = await query(
    "SELECT revision::int FROM mbt_contracts WHERE contract_id = $1::uuid",
    [contract.contractId]
  );
  const nextDraft = await preview(command("mixed-total-next-cash", {
    kind: "add_bin",
    contractId: contract.contractId,
    expectedContractRevision: currentContract.rows[0].revision,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: false,
    distanceMetres: 12_500,
    bin: {
      incomingContentCode: "garbage",
      incomingBinSizeYards: 14,
      binItemCode: fixture.binItemCode,
      incomingBinTypeId: fixture.binTypeId,
      deliveryItemCode: fixture.deliveryItemCode,
      proposedDeliveryAt: "2037-09-10T12:00:00.000Z",
      proposedReturnAt: "2037-09-24T12:00:00.000Z"
    },
    aggregateLines: []
  }));
  assert.equal(
    nextDraft.body.request.currentContractTotalMinor,
    quote.pricing.totalMinor + cardDraft.body.request.newRequestChargeableMinor
  );
  assert.equal(
    nextDraft.body.request.resultingContractTotalMinor,
    nextDraft.body.request.currentContractTotalMinor + nextDraft.body.request.newRequestChargeableMinor
  );
  const policies = await query(
    `SELECT payment_category, netsuite_export_policy
       FROM mbt_frontdesk_charge_requests
      WHERE source_quote_id = $1::uuid OR charge_request_id = $2::uuid
      ORDER BY created_at, charge_request_id`,
    [quote.quoteId, cardDraft.body.request.chargeRequestId]
  );
  assert.deepEqual(policies.rows, [
    { payment_category: "cash", netsuite_export_policy: "excluded_cash" },
    { payment_category: "non_cash", netsuite_export_policy: "eligible_non_cash" }
  ]);
  const retainedRequests = await list({ actor: ACTOR, contractId: contract.contractId });
  assert.equal(retainedRequests.contractId, contract.contractId);
  assert.deepEqual(
    retainedRequests.items.map((item) => item.paymentCategory),
    ["cash", "non_cash", "cash"]
  );
  assert.deepEqual(
    retainedRequests.items.map((item) => item.status),
    ["confirmed", "confirmed", "draft"]
  );
  assert.deepEqual(
    retainedRequests.items.slice(1).map((item) => item.chargeRequestId),
    [cardDraft.body.request.chargeRequestId, nextDraft.body.request.chargeRequestId]
  );
  const outboxAfter = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  assert.equal(outboxAfter.rows[0].count, outboxBefore.rows[0].count);
});

test("confirmed soil-to-garbage exchange collects the garbage deposit and carries aggregate on one exchange visit", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const confirm = requiredOperation("confirmFrontdeskChargeRequest");
  const { fixture, converted } = await convertedContract("exchange-confirm");
  const contract = converted.body.contract;
  const line = converted.body.serviceLines[0];
  const draft = await preview(command("exchange-preview", {
    kind: "exchange_bin",
    contractId: contract.contractId,
    serviceLineId: line.serviceLineId,
    expectedContractRevision: contract.revision,
    expectedServiceLineRevision: line.revision,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 12_500,
    bin: {
      incomingContentCode: "garbage",
      incomingBinSizeYards: 14,
      outgoingContentCode: "soil",
      outgoingBinSizeYards: 14,
      binItemCode: fixture.binItemCode,
      incomingBinTypeId: fixture.binTypeId,
      deliveryItemCode: fixture.deliveryItemCode,
      proposedDeliveryAt: "2037-08-10T12:00:00.000Z",
      proposedReturnAt: "2037-08-17T12:00:00.000Z"
    },
    aggregateLines: [{ itemCode: "AGG_CRUSHER_RUN", quantityYards: "2.000" }]
  }));
  assert.equal(draft.body.request.requiredDepositMinor, 10_000);

  const confirmed = await confirm(command("exchange-confirm", {
    chargeRequestId: draft.body.request.chargeRequestId,
    expectedRevision: draft.body.request.revision
  }));
  assert.equal(confirmed.status, 201);
  const visits = await query(
    `SELECT service_snapshot
       FROM mbt_service_visits
      WHERE service_line_id = $1::uuid AND service_action = 'exchange_bin'`,
    [line.serviceLineId]
  );
  assert.equal(visits.rowCount, 1);
  assert.equal(visits.rows[0].service_snapshot.chargeRequestId, draft.body.request.chargeRequestId);
  assert.deepEqual(
    visits.rows[0].service_snapshot.attachedAggregate.materials.map((entry) => entry.itemCode),
    ["AGG_CRUSHER_RUN"]
  );
  const separateDispatch = await query(
    "SELECT count(*)::int AS count FROM dispatch_custom_orders WHERE mbt_charge_request_id = $1",
    [draft.body.request.chargeRequestId]
  );
  assert.equal(separateDispatch.rows[0].count, 0);
});

test("initial soil contract uses a fixed dump charge, one card HST calculation, and no estimated tonnes", async () => {
  const fixture = await createFrontdeskPrerequisites({ label: "initial-fixed-dump" });
  await configureCustomerChargeRates(fixture);
  const outboxBefore = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  const created = await createFrontdeskQuote({
    ...quoteCommand(fixture, { actor: ACTOR, identity: `initial-fixed-${crypto.randomUUID()}` }),
    paymentMethod: "card",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    dumpItemCode: undefined,
    estimatedTonnes: undefined,
    serviceLines: [{
      binItemCode: fixture.binItemCode,
      binTypeId: fixture.binTypeId,
      contentCode: "soil",
      discountMinor: 0,
      proposedDeliveryAt: fixture.proposedDeliveryAt,
      proposedReturnAt: fixture.proposedReturnAt,
      siteProfileId: fixture.siteProfileId
    }],
    aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "1.000" }]
  }, { resolveDistance: frontdeskDistanceResolver(fixture), resolveTaxPolicy: frontdeskTaxResolver });
  const quote = created.body.quote;
  assert.equal(created.status, 201);
  assert.equal(quote.pricing.pricingModel, "fixed_bin_customer_charge");
  assert.equal(quote.pricing.preTaxRevenueMinor, 144_000);
  assert.equal(quote.pricing.addedHstMinor, 18_720);
  assert.equal(quote.pricing.totalMinor, 162_720);
  assert.equal(quote.depositRequiredMinor, 0);
  assert.equal(quote.pricing.lines.filter((line) => line.lineType === "fixed_dump").length, 1);
  assert.equal(quote.pricing.lines.filter((line) => line.lineType === "aggregate_loading_fee").length, 1);
  assert.equal(quote.pricing.lines.some((line) => /tonne|estimate/iu.test(JSON.stringify(line))), false);
  assert.equal(quote.pricing.netsuiteReadySnapshot.includesTaxChargeLine, false);

  const initialRequest = await query(
    `SELECT charge_request_id::text, status, source_quote_id::text,
            added_hst_minor::int, netsuite_export_policy
       FROM mbt_frontdesk_charge_requests
      WHERE source_quote_id = $1::uuid`,
    [quote.quoteId]
  );
  assert.deepEqual(initialRequest.rows[0], {
    charge_request_id: quote.pricing.chargeRequestId,
    status: "draft",
    source_quote_id: quote.quoteId,
    added_hst_minor: 18_720,
    netsuite_export_policy: "eligible_non_cash"
  });

  await issueFrontdeskQuote(frontdeskCommand("initial-fixed-issue", ACTOR, {
    quoteId: quote.quoteId, expectedRevision: 1, validUntil: "2037-08-04T12:00:00.000Z"
  }));
  await acceptFrontdeskQuote(frontdeskCommand("initial-fixed-accept", ACTOR, {
    quoteId: quote.quoteId, expectedRevision: 2, acceptedAt: "2037-08-03T10:00:00.000Z"
  }));
  const converted = await convertFrontdeskQuote(frontdeskCommand("initial-fixed-convert", ACTOR, {
    quoteId: quote.quoteId, expectedRevision: 3
  }));
  const retained = await query(
    `SELECT request.status, request.contract_id::text,
            line.estimated_weight_kg, line.dump_item_code,
            visit.service_snapshot
       FROM mbt_frontdesk_charge_requests request
       JOIN mbt_contract_service_lines line
         ON line.source_charge_request_id = request.charge_request_id
       JOIN mbt_service_visits visit
         ON visit.service_line_id = line.service_line_id
        AND visit.service_action = 'delivery'
      WHERE request.charge_request_id = $1::uuid`,
    [quote.pricing.chargeRequestId]
  );
  assert.equal(retained.rows[0].status, "confirmed");
  assert.equal(retained.rows[0].contract_id, converted.body.contract.contractId);
  assert.equal(retained.rows[0].estimated_weight_kg, null);
  assert.equal(retained.rows[0].dump_item_code, null);
  assert.deepEqual(
    retained.rows[0].service_snapshot.attachedAggregate.materials.map((line) => line.itemCode),
    ["AGG_HPB"]
  );
  const addPreview = await requiredOperation("previewFrontdeskChargeRequest")(command("fixed-initial-add-preview", {
    kind: "add_bin",
    contractId: converted.body.contract.contractId,
    expectedContractRevision: converted.body.contract.revision,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: false,
    distanceMetres: 12_500,
    bin: {
      incomingContentCode: "garbage",
      incomingBinSizeYards: 14,
      binItemCode: fixture.binItemCode,
      incomingBinTypeId: fixture.binTypeId,
      deliveryItemCode: fixture.deliveryItemCode,
      proposedDeliveryAt: "2037-08-20T12:00:00.000Z",
      proposedReturnAt: "2037-09-03T12:00:00.000Z"
    },
    aggregateLines: []
  }));
  assert.equal(addPreview.body.request.currentContractTotalMinor, quote.pricing.totalMinor);
  const outboxAfter = await query("SELECT count(*)::int AS count FROM mbt_netsuite_outbox");
  assert.equal(outboxAfter.rows[0].count, outboxBefore.rows[0].count);
});

test("rate-card and customer guards fail closed before a charge request is stored", async () => {
  const getConfiguration = requiredOperation("getFrontdeskCustomerChargeConfiguration");
  const getAdminConfiguration = requiredOperation("getFrontdeskCustomerChargeAdminConfiguration");
  const preview = requiredOperation("previewFrontdeskChargeRequest");

  await rejectsCode(
    () => getAdminConfiguration({ actor: ADMIN_ACTOR, rateCardVersionId: crypto.randomUUID() }),
    "MBT_FRONTDESK_RATE_NOT_FOUND",
    404
  );

  const inactive = await createFrontdeskPrerequisites({ label: "charge-rate-inactive" });
  await query("UPDATE mbt_rate_cards SET active = false WHERE rate_card_id = $1::uuid", [inactive.rateCardId]);
  await rejectsCode(
    () => getConfiguration({ actor: ACTOR, rateCardVersionId: inactive.rateCardVersionId }),
    "MBT_FRONTDESK_RATE_NOT_ACTIVE",
    409
  );

  const wrongCurrency = await createFrontdeskPrerequisites({ label: "charge-rate-usd" });
  await query("UPDATE mbt_rate_cards SET currency = 'USD' WHERE rate_card_id = $1::uuid", [wrongCurrency.rateCardId]);
  await rejectsCode(
    () => getConfiguration({ actor: ACTOR, rateCardVersionId: wrongCurrency.rateCardVersionId }),
    "MBT_FRONTDESK_CURRENCY_MISMATCH",
    422
  );
  await rejectsCode(
    () => getAdminConfiguration({ actor: ADMIN_ACTOR, rateCardVersionId: wrongCurrency.rateCardVersionId }),
    "MBT_FRONTDESK_CURRENCY_MISMATCH",
    422
  );

  const customerGuard = await createFrontdeskPrerequisites({ label: "charge-customer-guard" });
  await configureCustomerChargeRates(customerGuard);
  const aggregateFields = {
    kind: "aggregate_order",
    customerNetsuiteId: customerGuard.customerNetsuiteId,
    rateCardVersionId: customerGuard.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 10_000,
    aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "1.000" }]
  };
  await rejectsCode(
    () => preview(command("charge-customer-malformed", { ...aggregateFields, customerNetsuiteId: "customer-33" })),
    "MBT_FRONTDESK_INPUT_INVALID",
    400
  );
  await rejectsCode(
    () => preview(command("charge-customer-inactive", { ...aggregateFields, customerNetsuiteId: "999999999999999" })),
    "MBT_FRONTDESK_CUSTOMER_NOT_READY",
    409
  );
});

test("aggregate request validation rejects malformed, duplicate, and unpriced material evidence", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const fixture = await createFrontdeskPrerequisites({ label: "aggregate-request-guards" });
  await configureCustomerChargeRates(fixture);
  const fields = {
    kind: "aggregate_order",
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 10_000,
    aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "1" }]
  };
  const integerQuantity = await preview(command("aggregate-integer-quantity", fields));
  assert.equal(integerQuantity.body.request.lines.find(
    (line) => line.lineType === "aggregate_material"
  ).quantityMilliUnits, 1_000);

  await rejectsCode(
    () => preview(command("aggregate-null-line", { ...fields, aggregateLines: [null] })),
    "MBT_FRONTDESK_INPUT_INVALID",
    400
  );
  await rejectsCode(
    () => preview(command("aggregate-too-large", {
      ...fields,
      aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "1000.001" }]
    })),
    "MBT_FRONTDESK_INPUT_INVALID",
    400
  );
  await rejectsCode(
    () => preview(command("aggregate-duplicate", {
      ...fields,
      aggregateLines: [
        { itemCode: "AGG_HPB", quantityYards: "1.000" },
        { itemCode: "agg_hpb", quantityYards: "2.000" }
      ]
    })),
    "MBT_FRONTDESK_AGGREGATE_DUPLICATE",
    400
  );
  await rejectsCode(
    () => preview(command("aggregate-rate-missing", {
      ...fields,
      aggregateLines: [{ itemCode: "AGG_UNKNOWN", quantityYards: "1.000" }]
    })),
    "MBT_FRONTDESK_AGGREGATE_RATE_MISSING",
    422
  );
  await rejectsCode(
    () => preview(command("aggregate-lines-not-array", { ...fields, aggregateLines: {} })),
    "MBT_CHARGE_AGGREGATE_REQUIRED",
    400
  );
});

test("bin pricing rejects invalid schedules and each missing active rate selection", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const inputGuard = await createFrontdeskPrerequisites({ label: "bin-input-guards" });
  await configureCustomerChargeRates(inputGuard);
  await rejectsCode(
    () => preview(command("bin-object-missing", initialBinFields(inputGuard, { bin: null }))),
    "MBT_FRONTDESK_INPUT_INVALID",
    400
  );
  await rejectsCode(
    () => preview(command("bin-time-invalid", initialBinFields(inputGuard, {
      bin: { proposedDeliveryAt: "not-a-time" }
    }))),
    "MBT_FRONTDESK_INPUT_INVALID",
    400
  );
  await rejectsCode(
    () => preview(command("bin-return-before-delivery", initialBinFields(inputGuard, {
      bin: {
        proposedDeliveryAt: "2037-08-17T12:00:00.000Z",
        proposedReturnAt: "2037-08-03T12:00:00.000Z"
      }
    }))),
    "MBT_FRONTDESK_INPUT_INVALID",
    400
  );
  await rejectsCode(
    () => preview(command("bin-size-mismatch", initialBinFields(inputGuard, {
      bin: { incomingBinSizeYards: 20 }
    }))),
    "MBT_FRONTDESK_BIN_TYPE_NOT_ACTIVE",
    409
  );

  const rentalMissing = await createFrontdeskPrerequisites({ label: "bin-rental-missing" });
  await configureCustomerChargeRates(rentalMissing);
  await rejectsCode(
    () => preview(command("bin-rental-missing", initialBinFields(rentalMissing, {
      bin: {
        incomingBinSizeYards: 20,
        incomingBinTypeId: "00000000-0000-4000-8000-000000000020",
        binItemCode: "20YD"
      }
    }))),
    "MBT_FRONTDESK_RENTAL_RATE_MISSING",
    422
  );

  const deliveryMissing = await createFrontdeskPrerequisites({ label: "bin-delivery-missing" });
  await configureCustomerChargeRates(deliveryMissing);
  await query(
    "DELETE FROM mbt_rate_distance_bands WHERE rate_distance_band_id = $1::uuid",
    [deliveryMissing.rateDistanceBandId]
  );
  await rejectsCode(
    () => initialGarbagePreview(deliveryMissing, "bin-delivery-missing"),
    "MBT_FRONTDESK_RATE_BAND_MISSING",
    422
  );

  const dumpMissing = await createFrontdeskPrerequisites({ label: "bin-dump-missing" });
  await configureCustomerChargeRates(dumpMissing);
  await query(
    `UPDATE mbt_frontdesk_charge_rates
        SET active = false, revision = revision + 1, updated_at = now()
      WHERE rate_card_version_id = $1::uuid AND item_code = 'DUMP_SOIL'`,
    [dumpMissing.rateCardVersionId]
  );
  await rejectsCode(
    () => preview(command("bin-dump-missing", initialBinFields(dumpMissing, {
      bin: { incomingContentCode: "soil" }
    }))),
    "MBT_FRONTDESK_DUMP_RATE_MISSING",
    422
  );
});

test("percentage garbage deposits are recalculated once and an initial-only confirmation stays local", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const confirm = requiredOperation("confirmFrontdeskChargeRequest");
  const fixture = await createFrontdeskPrerequisites({ label: "percentage-deposit" });
  await configureCustomerChargeRates(fixture);
  await query(
    `UPDATE mbt_deposit_rules
        SET rule_type = 'percentage', fixed_amount_minor = NULL,
            percentage_basis_points = 2000
      WHERE deposit_rule_id = $1::uuid`,
    [fixture.depositRuleId]
  );
  const draft = await preview(command("percentage-deposit-preview", initialBinFields(fixture)));
  assert.equal(draft.body.request.requiredDepositMinor, 9_500);
  assert.equal(draft.body.request.dueNowMinor, 9_500);
  const confirmed = await confirm(command("percentage-deposit-confirm", {
    chargeRequestId: draft.body.request.chargeRequestId,
    expectedRevision: draft.body.request.revision
  }));
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.request.status, "confirmed");
  assert.equal(Object.hasOwn(confirmed.body, "operation"), false);
  assert.equal(Object.hasOwn(confirmed.body, "dispatchOrder"), false);
  await rejectsCode(
    () => confirm(command("percentage-deposit-stale-confirm", {
      chargeRequestId: draft.body.request.chargeRequestId,
      expectedRevision: draft.body.request.revision
    })),
    "MBT_STALE_REVISION",
    409
  );
});

test("contract and confirmation guards reject missing, mismatched, and stale subjects", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const confirm = requiredOperation("confirmFrontdeskChargeRequest");
  const missingFixture = await createFrontdeskPrerequisites({ label: "charge-contract-missing" });
  await rejectsCode(
    () => preview(command("charge-contract-missing", initialBinFields(missingFixture, {
      kind: "add_bin",
      contractId: crypto.randomUUID(),
      expectedContractRevision: 1
    }))),
    "MBT_FRONTDESK_CONTRACT_NOT_FOUND",
    404
  );
  await rejectsCode(
    () => confirm(command("charge-confirm-missing", {
      chargeRequestId: crypto.randomUUID(),
      expectedRevision: 1
    })),
    "MBT_FRONTDESK_CHARGE_REQUEST_NOT_FOUND",
    404
  );

  const guarded = await convertedContract("charge-contract-guards");
  const contract = guarded.converted.body.contract;
  const serviceLine = guarded.converted.body.serviceLines[0];
  const addFields = initialBinFields(guarded.fixture, {
    kind: "add_bin",
    contractId: contract.contractId,
    expectedContractRevision: contract.revision
  });
  await rejectsCode(
    () => preview(command("charge-contract-revision-stale", {
      ...addFields,
      expectedContractRevision: contract.revision + 1
    })),
    "MBT_STALE_REVISION",
    409
  );

  const otherRate = await createFrontdeskPrerequisites({ label: "charge-contract-other-rate" });
  await rejectsCode(
    () => preview(command("charge-contract-rate-mismatch", {
      ...addFields,
      rateCardVersionId: otherRate.rateCardVersionId
    })),
    "MBT_FRONTDESK_RATE_CARD_MISMATCH",
    409
  );
  await rejectsCode(
    () => preview(command("charge-service-line-stale", initialBinFields(guarded.fixture, {
      kind: "exchange_bin",
      contractId: contract.contractId,
      serviceLineId: serviceLine.serviceLineId,
      expectedContractRevision: contract.revision,
      expectedServiceLineRevision: serviceLine.revision + 1,
      bin: { outgoingContentCode: "garbage", outgoingBinSizeYards: 14 }
    }))),
    "MBT_STALE_REVISION",
    409
  );
  await query(
    `UPDATE mbt_contracts
        SET status = 'closed', revision = revision + 1, updated_at = now()
      WHERE contract_id = $1::uuid`,
    [contract.contractId]
  );
  await rejectsCode(
    () => preview(command("charge-contract-state", {
      ...addFields,
      expectedContractRevision: contract.revision + 1
    })),
    "MBT_FRONTDESK_CONTRACT_STATE_CONFLICT",
    409
  );

  const staleConfirmation = await convertedContract("charge-confirm-contract-stale");
  const staleContract = staleConfirmation.converted.body.contract;
  const draft = await preview(command("charge-confirm-contract-stale-preview", initialBinFields(
    staleConfirmation.fixture,
    {
      kind: "add_bin",
      contractId: staleContract.contractId,
      expectedContractRevision: staleContract.revision
    }
  )));
  await query(
    `UPDATE mbt_contracts
        SET revision = revision + 1, updated_at = now()
      WHERE contract_id = $1::uuid`,
    [staleContract.contractId]
  );
  await rejectsCode(
    () => confirm(command("charge-confirm-contract-stale", {
      chargeRequestId: draft.body.request.chargeRequestId,
      expectedRevision: draft.body.request.revision
    })),
    "MBT_FRONTDESK_PRICE_STALE",
    409
  );
});

test("corrupt aggregate pricing evidence cannot materialize Dispatch work", async () => {
  const preview = requiredOperation("previewFrontdeskChargeRequest");
  const confirm = requiredOperation("confirmFrontdeskChargeRequest");
  const fixture = await createFrontdeskPrerequisites({ label: "aggregate-corrupt-evidence" });
  await configureCustomerChargeRates(fixture);
  const draft = await preview(command("aggregate-corrupt-preview", {
    kind: "aggregate_order",
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 10_000,
    aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "1.000" }]
  }));
  await query(
    `UPDATE mbt_frontdesk_charge_requests
        SET pricing_snapshot = '{}'::jsonb,
            revision = revision + 1, updated_at = now()
      WHERE charge_request_id = $1::uuid`,
    [draft.body.request.chargeRequestId]
  );
  await rejectsCode(
    () => confirm(command("aggregate-corrupt-confirm", {
      chargeRequestId: draft.body.request.chargeRequestId,
      expectedRevision: draft.body.request.revision + 1
    })),
    "MBT_FRONTDESK_AGGREGATE_WEIGHT_MISSING",
    422
  );
});
