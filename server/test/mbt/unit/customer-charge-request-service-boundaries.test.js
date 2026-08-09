// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  confirmFrontdeskChargeRequest,
  getFrontdeskCustomerChargeAdminConfiguration,
  getFrontdeskCustomerChargeConfiguration,
  listFrontdeskContractChargeRequests,
  persistPreparedFrontdeskInitialCharge,
  prepareFrontdeskInitialCharge,
  previewFrontdeskChargeRequest,
  replaceFrontdeskCustomerChargeConfiguration
} from "../../../src/mbt/customer-charge-request-service.js";

const RATE_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_LINE_ID = "33333333-3333-4333-8333-333333333333";
const FRONTDESK = Object.freeze({ operatorId: "frontdesk-boundary", roles: Object.freeze(["mbt_frontdesk"]) });
const ADMIN = Object.freeze({ operatorId: "admin-boundary", roles: Object.freeze(["admin"]) });

const AGGREGATES = Object.freeze([
  Object.freeze({ itemCode: "AGG_CLEAR_LIMESTONE_34", amountMinor: 5_250, densityLbsPerYard: 2_700 }),
  Object.freeze({ itemCode: "AGG_CRUSHER_RUN", amountMinor: 4_800, densityLbsPerYard: 2_850 }),
  Object.freeze({ itemCode: "AGG_HPB", amountMinor: 6_500, densityLbsPerYard: 2_600 }),
  Object.freeze({ itemCode: "AGG_SCREENING", amountMinor: 4_200, densityLbsPerYard: 2_750 })
]);
const DUMPS = Object.freeze([
  Object.freeze({ itemCode: "DUMP_SOIL", amountMinor: 85_000 }),
  Object.freeze({ itemCode: "DUMP_ASPHALT", amountMinor: 72_500 }),
  Object.freeze({ itemCode: "DUMP_CONCRETE", amountMinor: 92_500 })
]);
const BANDS = Object.freeze([
  Object.freeze({ bandCode: "AGG_0_30", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 15_000 }),
  Object.freeze({ bandCode: "AGG_30_PLUS", minimumMetres: 30_000, maximumMetres: null, amountMinor: 20_000 })
]);

function identity() {
  return {
    idempotencyKey: `charge-boundary-${crypto.randomUUID()}`,
    correlationId: `charge-boundary-correlation-${crypto.randomUUID()}`,
    requestId: `charge-boundary-request-${crypto.randomUUID()}`,
    reason: "Customer-charge boundary regression"
  };
}

/** @param {Record<string, any>} [patch] */
function configurationCommand(patch = {}) {
  return {
    actor: ADMIN,
    rateCardVersionId: RATE_VERSION_ID,
    expectedRevision: 0,
    aggregateItems: structuredClone(AGGREGATES),
    fixedDumpItems: structuredClone(DUMPS),
    aggregateDistanceBands: structuredClone(BANDS),
    ...identity(),
    ...patch
  };
}

/** @param {Record<string, any>} [patch] */
function previewCommand(patch = {}) {
  return {
    actor: FRONTDESK,
    kind: "aggregate_order",
    customerNetsuiteId: "33",
    rateCardVersionId: RATE_VERSION_ID,
    paymentMethod: "cash",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 10_000,
    aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "1.000" }],
    ...identity(),
    ...patch
  };
}

/** @param {() => Promise<unknown>} operation @param {string} code */
async function rejects(operation, code) {
  await assert.rejects(
    operation,
    (error) => error?.code === code && Number(error?.status) >= 400
  );
}

test("customer-charge service validates actors, command identities, and revision envelopes before database work", async () => {
  const cases = [
    [() => getFrontdeskCustomerChargeConfiguration({ actor: { roles: ["mbt_frontdesk"] },
      rateCardVersionId: RATE_VERSION_ID }), "MBT_FRONTDESK_INPUT_INVALID"],
    [() => getFrontdeskCustomerChargeConfiguration({ actor: { operatorId: "operator", roles: [] },
      rateCardVersionId: RATE_VERSION_ID }), "MBT_FRONTDESK_FORBIDDEN"],
    [() => getFrontdeskCustomerChargeAdminConfiguration({ actor: FRONTDESK,
      rateCardVersionId: RATE_VERSION_ID }), "MBT_ADMIN_REQUIRED"],
    [() => getFrontdeskCustomerChargeAdminConfiguration({ actor: ADMIN,
      rateCardVersionId: "not-a-uuid" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [() => listFrontdeskContractChargeRequests({ actor: FRONTDESK, contractId: "bad" }),
      "MBT_FRONTDESK_INPUT_INVALID"],
    [() => persistPreparedFrontdeskInitialCharge({}, "bad"), "MBT_FRONTDESK_INPUT_INVALID"],
    [() => prepareFrontdeskInitialCharge({ actor: FRONTDESK, rateCardVersionId: "bad" }),
      "MBT_FRONTDESK_INPUT_INVALID"],
    [() => prepareFrontdeskInitialCharge({ actor: FRONTDESK, rateCardVersionId: RATE_VERSION_ID,
      customerNetsuiteId: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [() => confirmFrontdeskChargeRequest({ actor: FRONTDESK, chargeRequestId: "bad" }),
      "MBT_FRONTDESK_INPUT_INVALID"],
    [() => confirmFrontdeskChargeRequest({ actor: FRONTDESK, chargeRequestId: CONTRACT_ID,
      expectedRevision: 0 }), "MBT_FRONTDESK_INPUT_INVALID"],
    [() => confirmFrontdeskChargeRequest({ actor: FRONTDESK, chargeRequestId: CONTRACT_ID,
      expectedRevision: 1, reason: "x".repeat(2_001) }), "MBT_FRONTDESK_INPUT_INVALID"],
    [() => confirmFrontdeskChargeRequest({ actor: FRONTDESK, chargeRequestId: CONTRACT_ID,
      expectedRevision: 1, reason: "valid", idempotencyKey: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [() => confirmFrontdeskChargeRequest({ actor: FRONTDESK, chargeRequestId: CONTRACT_ID,
      expectedRevision: 1, reason: "valid", idempotencyKey: "id", correlationId: "" }),
      "MBT_FRONTDESK_INPUT_INVALID"],
    [() => confirmFrontdeskChargeRequest({ actor: FRONTDESK, chargeRequestId: CONTRACT_ID,
      expectedRevision: 1, reason: "valid", idempotencyKey: "id", correlationId: "correlation",
      requestId: "" }), "MBT_FRONTDESK_INPUT_INVALID"]
  ];
  for (const [operation, code] of cases) {
    await rejects(operation, code);
  }
});

test("customer-charge configuration rejects partial, duplicate, unsafe, and non-contiguous price sheets", async () => {
  const invalidAggregateRow = structuredClone(AGGREGATES);
  invalidAggregateRow[0] = null;
  const duplicateAggregate = structuredClone(AGGREGATES);
  duplicateAggregate[1].itemCode = duplicateAggregate[0].itemCode;
  const invalidDumpRow = structuredClone(DUMPS);
  invalidDumpRow[0] = [];
  const tooManyBands = Array.from({ length: 21 }, (_, index) => ({
    bandCode: `AGG_${index}`,
    minimumMetres: index * 1_000,
    maximumMetres: (index + 1) * 1_000,
    amountMinor: 15_000 + index
  }));
  const cases = [
    [configurationCommand({ expectedRevision: -1 }), "MBT_FRONTDESK_INPUT_INVALID"],
    [configurationCommand({ reason: "x".repeat(2_001) }), "MBT_FRONTDESK_INPUT_INVALID"],
    [configurationCommand({ aggregateItems: [] }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateItems: invalidAggregateRow }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateItems: duplicateAggregate }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateItems: AGGREGATES.map((row, index) => index === 0
      ? { ...row, itemCode: "!" } : row) }), "MBT_FRONTDESK_INPUT_INVALID"],
    [configurationCommand({ aggregateItems: AGGREGATES.map((row, index) => index === 0
      ? { ...row, amountMinor: 0 } : row) }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateItems: AGGREGATES.map((row, index) => index === 0
      ? { ...row, densityLbsPerYard: -1 } : row) }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ fixedDumpItems: invalidDumpRow }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: "bands" }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: [] }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: tooManyBands }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: [null] }), "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: [{ ...BANDS[0], bandCode: "!" }] }),
      "MBT_FRONTDESK_INPUT_INVALID"],
    [configurationCommand({ aggregateDistanceBands: [BANDS[0], { ...BANDS[1], bandCode: BANDS[0].bandCode }] }),
      "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: [{ ...BANDS[0], maximumMetres: 0 }] }),
      "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: [{ ...BANDS[0], minimumMetres: 1 }] }),
      "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: [BANDS[0], { ...BANDS[1], minimumMetres: 30_001 }] }),
      "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ aggregateDistanceBands: [BANDS[0], { ...BANDS[1], amountMinor: 15_000 }] }),
      "MBT_FRONTDESK_CONFIGURATION_INVALID"],
    [configurationCommand({ idempotencyKey: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [configurationCommand({ correlationId: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [configurationCommand({ requestId: "" }), "MBT_FRONTDESK_INPUT_INVALID"]
  ];
  for (const [operationInput, code] of cases) {
    await rejects(() => replaceFrontdeskCustomerChargeConfiguration(operationInput), code);
  }
});

test("customer-charge preview rejects malformed subjects and required customer-facing text before pricing", async () => {
  const cases = [
    [previewCommand({ kind: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ kind: "collection" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ rateCardVersionId: "bad" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ contractId: "bad" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ contractId: CONTRACT_ID, expectedContractRevision: 0 }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ serviceLineId: SERVICE_LINE_ID, expectedServiceLineRevision: 0 }),
      "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ kind: "add_bin" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ kind: "exchange_bin", contractId: CONTRACT_ID, expectedContractRevision: 1 }),
      "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ billingAddressText: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ billingAddressText: "x".repeat(1_001) }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ serviceAddressText: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ contractTelephone: "x".repeat(101) }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ reason: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ idempotencyKey: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ correlationId: "" }), "MBT_FRONTDESK_INPUT_INVALID"],
    [previewCommand({ requestId: "" }), "MBT_FRONTDESK_INPUT_INVALID"]
  ];
  for (const [operationInput, code] of cases) {
    await rejects(() => previewFrontdeskChargeRequest(operationInput), code);
  }
});
