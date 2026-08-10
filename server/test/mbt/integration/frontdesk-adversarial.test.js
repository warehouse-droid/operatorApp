import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  createFrontdeskPrerequisites,
  frontdeskCommand,
  frontdeskDistanceResolver,
  frontdeskTaxResolver,
  quoteCommand
} from "../support/frontdesk-fixtures.js";

import {
  acceptFrontdeskQuote,
  convertFrontdeskQuote,
  createFrontdeskQuote,
  extendFrontdeskContract,
  getFrontdeskConfiguration,
  getFrontdeskContractTimeline,
  issueFrontdeskQuote,
  searchFrontdeskCustomers
} from "../../../src/mbt/frontdesk-service.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `p3-frontdesk-adversarial-${RUN_ID}`,
  roles: Object.freeze(["mbt_frontdesk"])
});
const FUTURE_VALID_UNTIL = "2037-08-04T12:00:00.000Z";

/** @param {unknown} error @param {string} code @param {number} status */
function isMbtFailure(error, code, status) {
  return error instanceof MbtError && error.code === code && error.status === status;
}

/** @param {Promise<unknown>} promise @param {string} code @param {number} status */
async function rejectsMbt(promise, code, status) {
  await assert.rejects(promise, (error) => isMbtFailure(error, code, status));
}

/** @param {string} label @param {Record<string, unknown>} [overrides] @param {Record<string, Function>} [options] */
async function createDraft(label, overrides = {}, options = {}) {
  const fixture = await createFrontdeskPrerequisites({ label });
  const input = {
    ...quoteCommand(fixture, { actor: ACTOR, identity: `${RUN_ID}-${label}` }),
    ...overrides
  };
  const result = await createFrontdeskQuote(input, {
    resolveDistance: frontdeskDistanceResolver(fixture),
    resolveTaxPolicy: frontdeskTaxResolver,
    ...options
  });
  return { fixture, input, result, quoteId: result.body.quote.quoteId };
}

/** @param {string} label @param {{validUntil?: string}} [options] */
async function createIssued(label, options = {}) {
  const draft = await createDraft(label);
  const issued = await issueFrontdeskQuote(frontdeskCommand(`issue-${label}`, ACTOR, {
    quoteId: draft.quoteId,
    expectedRevision: 1,
    validUntil: options.validUntil || FUTURE_VALID_UNTIL
  }));
  return { ...draft, issued };
}

/** @param {string} label */
async function createAccepted(label) {
  const issued = await createIssued(label);
  const accepted = await acceptFrontdeskQuote(frontdeskCommand(`accept-${label}`, ACTOR, {
    quoteId: issued.quoteId,
    expectedRevision: 2,
    acceptedAt: "2037-08-03T10:00:00.000Z"
  }));
  return { ...issued, accepted };
}

/** @param {string} label */
async function createConverted(label) {
  const accepted = await createAccepted(label);
  const converted = await convertFrontdeskQuote(frontdeskCommand(`convert-${label}`, ACTOR, {
    quoteId: accepted.quoteId,
    expectedRevision: 3
  }));
  return { ...accepted, converted, contractId: converted.body.contract.contractId };
}

/** @param {Awaited<ReturnType<typeof createFrontdeskPrerequisites>>} fixture @param {string} label @param {Record<string, unknown>} [overrides] @param {Record<string, Function>} [options] */
async function rejectedQuote(fixture, label, overrides = {}, options = {}) {
  const input = {
    ...quoteCommand(fixture, { actor: ACTOR, identity: `${RUN_ID}-${label}` }),
    ...overrides
  };
  return createFrontdeskQuote(input, {
    resolveDistance: frontdeskDistanceResolver(fixture),
    resolveTaxPolicy: frontdeskTaxResolver,
    ...options
  });
}

after(async () => {
  await closeDb();
});

test("P3-F13 adversarial: actor and command input validation fail closed", async () => {
  await rejectsMbt(searchFrontdeskCustomers({
    actor: { operatorId: "", roles: ["mbt_frontdesk"] },
    query: "customer"
  }), "MBT_FRONTDESK_INPUT_INVALID", 400);
  await rejectsMbt(searchFrontdeskCustomers({
    actor: { operatorId: "unauthorized", roles: ["dispatcher"] },
    query: "customer"
  }), "MBT_FRONTDESK_FORBIDDEN", 403);
  await rejectsMbt(searchFrontdeskCustomers({
    actor: { roles: "mbt_frontdesk" },
    query: "customer"
  }), "MBT_FRONTDESK_INPUT_INVALID", 400);

  const fixture = await createFrontdeskPrerequisites({ label: "input-validation" });
  await rejectsMbt(rejectedQuote(fixture, "bad-uuid", { siteProfileId: "not-a-uuid" }),
    "MBT_FRONTDESK_INPUT_INVALID", 400);
  await rejectsMbt(rejectedQuote(fixture, "bad-customer", { customerNetsuiteId: "abc" }),
    "MBT_FRONTDESK_INPUT_INVALID", 400);
  await rejectsMbt(rejectedQuote(fixture, "bad-service", { serviceCode: "Delivery!" }),
    "MBT_FRONTDESK_INPUT_INVALID", 400);
  await rejectsMbt(rejectedQuote(fixture, "bad-time", { proposedDeliveryAt: "not-a-time" }),
    "MBT_FRONTDESK_INPUT_INVALID", 400);
  await rejectsMbt(rejectedQuote(fixture, "bad-order", {
    proposedReturnAt: fixture.proposedDeliveryAt
  }), "MBT_FRONTDESK_INPUT_INVALID", 400);
  await rejectsMbt(createFrontdeskQuote(
    quoteCommand(fixture, { actor: ACTOR, identity: `${RUN_ID}-missing-resolver` })
  ), "MBT_FRONTDESK_PRICING_UNAVAILABLE", 503);

  await rejectsMbt(issueFrontdeskQuote(frontdeskCommand("bad-revision", ACTOR, {
    quoteId: crypto.randomUUID(), expectedRevision: 0, validUntil: FUTURE_VALID_UNTIL
  })), "MBT_FRONTDESK_INPUT_INVALID", 400);
  await rejectsMbt(extendFrontdeskContract(frontdeskCommand("bad-window-object", ACTOR, {
    contractId: crypto.randomUUID(), expectedRevision: 1, returnWindow: null
  })), "MBT_FRONTDESK_CONFIGURATION_INVALID", 422);
});

test("P3-F13 adversarial: pilot scoping, limiting, and active configuration remain narrow", async () => {
  const first = await createFrontdeskPrerequisites({ label: "scope-first" });
  const second = await createFrontdeskPrerequisites({ label: "scope-second" });
  assert.deepEqual(await searchFrontdeskCustomers({
    actor: ACTOR,
    query: "Synthetic Front Desk Customer",
    pilotCustomerIds: []
  }), { schemaVersion: "mbt-frontdesk-customers-v1", items: [] });

  const limited = await searchFrontdeskCustomers({
    actor: ACTOR,
    query: "Synthetic Front Desk Customer",
    limit: 1,
    pilotCustomerIds: [first.customerNetsuiteId, second.customerNetsuiteId]
  });
  assert.equal(limited.items.length, 1);
  const derived = await searchFrontdeskCustomers({
    actor: ACTOR,
    query: first.marker
  });
  assert.deepEqual(derived.items.map(({ customerNetsuiteId }) => customerNetsuiteId), [
    first.customerNetsuiteId
  ]);

  const configuration = await getFrontdeskConfiguration({ actor: ACTOR });
  assert.equal(configuration.schemaVersion, "mbt-frontdesk-configuration-v1");
  assert.ok(configuration.binTypes.some(({ typeCode }) => typeCode === "14YD"));
  assert.ok(configuration.services.some((service) => (
    service.templateVersionId === first.templateVersionId
      && service.rateCardVersionId === first.rateCardVersionId
      && service.serviceCode === "delivery"
  )));
  assert.ok(configuration.services.some((service) => (
    service.templateVersionId === second.templateVersionId
      && service.rateCardVersionId === second.rateCardVersionId
      && service.serviceCode === "delivery"
  )));
  assert.equal(configuration.services.some(({ serviceCode }) => serviceCode === "mbbs_cross_charge"), false);
  assert.ok(configuration.services.every((service) => (
    service.rateCardDisplayName && service.rateCardCode && service.rateCardVersionNumber > 0
  )));
});

test("P3-F13 adversarial: incomplete and inactive canonical configuration cannot quote", async () => {
  const fixture = await createFrontdeskPrerequisites({ label: "configuration-guards" });
  await rejectsMbt(rejectedQuote(fixture, "missing-selection", {
    customerNetsuiteId: "999999999999999"
  }), "MBT_FRONTDESK_CONFIGURATION_INCOMPLETE", 422);

  await query("UPDATE netsuite_customers SET active = false WHERE netsuite_id = $1", [fixture.customerNetsuiteId]);
  await rejectsMbt(rejectedQuote(fixture, "inactive-customer"), "MBT_FRONTDESK_CUSTOMER_NOT_READY", 409);
  await query("UPDATE netsuite_customers SET active = true WHERE netsuite_id = $1", [fixture.customerNetsuiteId]);

  await query("UPDATE mbt_service_templates SET active = false WHERE template_id = $1", [fixture.templateId]);
  await rejectsMbt(rejectedQuote(fixture, "inactive-template"), "MBT_FRONTDESK_TEMPLATE_NOT_ACTIVE", 409);
  await query("UPDATE mbt_service_templates SET active = true WHERE template_id = $1", [fixture.templateId]);

  await query("UPDATE mbt_rate_cards SET active = false WHERE rate_card_id = $1", [fixture.rateCardId]);
  await rejectsMbt(rejectedQuote(fixture, "inactive-rate"), "MBT_FRONTDESK_RATE_NOT_ACTIVE", 409);
  await query("UPDATE mbt_rate_cards SET active = true WHERE rate_card_id = $1", [fixture.rateCardId]);

  try {
    await query("UPDATE mbt_bin_types SET active = false WHERE bin_type_id = $1", [fixture.binTypeId]);
    await rejectsMbt(rejectedQuote(fixture, "inactive-bin"), "MBT_FRONTDESK_BIN_TYPE_NOT_ACTIVE", 409);
  } finally {
    await query("UPDATE mbt_bin_types SET active = true WHERE bin_type_id = $1", [fixture.binTypeId]);
  }

  const other = await createFrontdeskPrerequisites({ label: "configuration-mismatch" });
  await query("UPDATE mbt_rate_cards SET service_template_id = $2 WHERE rate_card_id = $1", [
    fixture.rateCardId, other.templateId
  ]);
  await rejectsMbt(rejectedQuote(fixture, "mismatched-rate"), "MBT_FRONTDESK_CONFIGURATION_MISMATCH", 422);
  await query("UPDATE mbt_rate_cards SET service_template_id = $2 WHERE rate_card_id = $1", [
    fixture.rateCardId, fixture.templateId
  ]);

  await query("UPDATE mbt_rate_card_versions SET effective_from = '2038-01-01T00:00:00Z' WHERE rate_card_version_id = $1", [
    fixture.rateCardVersionId
  ]);
  await rejectsMbt(rejectedQuote(fixture, "ineffective-rate"), "MBT_FRONTDESK_RATE_NOT_EFFECTIVE", 409);
});

test("P3-F13 adversarial: untrusted distance, rate, tax, and deposit evidence fails closed", async () => {
  const fixture = await createFrontdeskPrerequisites({ label: "pricing-guards" });
  await rejectsMbt(rejectedQuote(fixture, "distance-not-object", {}, {
    resolveDistance: async () => null
  }), "MBT_FRONTDESK_CONFIGURATION_INVALID", 422);
  await rejectsMbt(rejectedQuote(fixture, "negative-distance", {}, {
    resolveDistance: async () => ({
      ...(await frontdeskDistanceResolver(fixture)()), providerMetres: -1
    })
  }), "MBT_FRONTDESK_CONFIGURATION_INVALID", 422);
  await rejectsMbt(rejectedQuote(fixture, "bad-route-hash", {}, {
    resolveDistance: async () => ({
      ...(await frontdeskDistanceResolver(fixture)()), routeHash: "untrusted"
    })
  }), "MBT_FRONTDESK_DISTANCE_INVALID", 422);
  await rejectsMbt(rejectedQuote(fixture, "missing-band", { serviceCode: "pickup" }),
    "MBT_FRONTDESK_RATE_BAND_MISSING", 422);

  await query(
    `UPDATE mbt_rate_distance_bands band
        SET currency = 'USD'
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card ON card.rate_card_id = version.rate_card_id
      WHERE band.rate_card_version_id = version.rate_card_version_id
        AND card.item_code = $1
        AND band.bin_type_id = $2::uuid`,
    [fixture.deliveryItemCode, fixture.binTypeId]
  );
  await rejectsMbt(rejectedQuote(fixture, "band-currency"), "MBT_FRONTDESK_CURRENCY_MISMATCH", 422);
  await query(
    `UPDATE mbt_rate_distance_bands band
        SET currency = 'CAD'
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card ON card.rate_card_id = version.rate_card_id
      WHERE band.rate_card_version_id = version.rate_card_version_id
        AND card.item_code = $1
        AND band.bin_type_id = $2::uuid`,
    [fixture.deliveryItemCode, fixture.binTypeId]
  );

  await query(
    `UPDATE mbt_rate_components component
        SET currency = 'USD'
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card ON card.rate_card_id = version.rate_card_id
      WHERE component.rate_card_version_id = version.rate_card_version_id
        AND card.item_code = $1
        AND component.component_kind = 'rental'`,
    [fixture.binItemCode]
  );
  await rejectsMbt(rejectedQuote(fixture, "component-currency"), "MBT_FRONTDESK_CURRENCY_MISMATCH", 422);
  await query(
    `UPDATE mbt_rate_components component
        SET currency = 'CAD'
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card ON card.rate_card_id = version.rate_card_id
      WHERE component.rate_card_version_id = version.rate_card_version_id
        AND card.item_code = $1
        AND component.component_kind = 'rental'`,
    [fixture.binItemCode]
  );

  const setDeliveryAmount = (amountMinor) => query(
    `UPDATE mbt_rate_distance_bands band
        SET amount_minor = $3
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card ON card.rate_card_id = version.rate_card_id
      WHERE band.rate_card_version_id = version.rate_card_version_id
        AND card.item_code = $1
        AND band.bin_type_id = $2::uuid`,
    [fixture.deliveryItemCode, fixture.binTypeId, amountMinor]
  );
  await setDeliveryAmount("9007199254740991");
  await rejectsMbt(rejectedQuote(fixture, "subtotal-overflow"), "MBT_FRONTDESK_CONFIGURATION_INVALID", 422);
  await setDeliveryAmount("9007199254705991");
  await rejectsMbt(rejectedQuote(fixture, "total-overflow", {}, {
    resolveTaxPolicy: async () => ({ code: "OVERFLOW", basisPoints: 1 })
  }), "MBT_FRONTDESK_CONFIGURATION_INVALID", 422);
  await setDeliveryAmount("9007199254000");
  await rejectsMbt(rejectedQuote(fixture, "tax-overflow", {}, {
    resolveTaxPolicy: async () => ({ code: "OVERFLOW", basisPoints: 1_000_000 })
  }), "MBT_FRONTDESK_CONFIGURATION_INVALID", 422);
  await setDeliveryAmount(12500);

  await query("UPDATE mbt_deposit_rules SET currency = 'USD' WHERE deposit_rule_id = $1", [fixture.depositRuleId]);
  await rejectsMbt(rejectedQuote(fixture, "deposit-currency"), "MBT_FRONTDESK_CURRENCY_MISMATCH", 422);
});

test("P3-F13 adversarial: quote lifecycle rejects missing, stale, expired, and wrong-state commands", async () => {
  await rejectsMbt(issueFrontdeskQuote(frontdeskCommand("missing-quote", ACTOR, {
    quoteId: crypto.randomUUID(), expectedRevision: 1, validUntil: FUTURE_VALID_UNTIL
  })), "MBT_FRONTDESK_QUOTE_NOT_FOUND", 404);

  const staleIssue = await createDraft("stale-issue");
  await rejectsMbt(issueFrontdeskQuote(frontdeskCommand("stale-issue", ACTOR, {
    quoteId: staleIssue.quoteId, expectedRevision: 99, validUntil: FUTURE_VALID_UNTIL
  })), "MBT_STALE_REVISION", 409);
  const pastIssue = await createDraft("past-issue");
  await rejectsMbt(issueFrontdeskQuote(frontdeskCommand("past-issue", ACTOR, {
    quoteId: pastIssue.quoteId, expectedRevision: 1, validUntil: "2020-01-01T00:00:00.000Z"
  })), "MBT_FRONTDESK_INPUT_INVALID", 400);

  const wrongIssue = await createIssued("wrong-issue-state");
  await rejectsMbt(issueFrontdeskQuote(frontdeskCommand("wrong-issue-state", ACTOR, {
    quoteId: wrongIssue.quoteId, expectedRevision: 2, validUntil: FUTURE_VALID_UNTIL
  })), "MBT_FRONTDESK_QUOTE_STATE_CONFLICT", 409);
  const wrongAccept = await createDraft("wrong-accept-state");
  await rejectsMbt(acceptFrontdeskQuote(frontdeskCommand("wrong-accept-state", ACTOR, {
    quoteId: wrongAccept.quoteId, expectedRevision: 1, acceptedAt: "2037-08-03T10:00:00.000Z"
  })), "MBT_FRONTDESK_QUOTE_STATE_CONFLICT", 409);
  const staleAccept = await createIssued("stale-accept");
  await rejectsMbt(acceptFrontdeskQuote(frontdeskCommand("stale-accept", ACTOR, {
    quoteId: staleAccept.quoteId, expectedRevision: 99, acceptedAt: "2037-08-03T10:00:00.000Z"
  })), "MBT_STALE_REVISION", 409);
  const expired = await createIssued("expired-accept");
  await rejectsMbt(acceptFrontdeskQuote(frontdeskCommand("expired-accept", ACTOR, {
    quoteId: expired.quoteId, expectedRevision: 2, acceptedAt: FUTURE_VALID_UNTIL
  })), "MBT_FRONTDESK_QUOTE_EXPIRED", 409);

  const staleConvert = await createAccepted("stale-convert");
  await rejectsMbt(convertFrontdeskQuote(frontdeskCommand("stale-convert", ACTOR, {
    quoteId: staleConvert.quoteId, expectedRevision: 99
  })), "MBT_STALE_REVISION", 409);
  const incomplete = await createAccepted("incomplete-convert");
  await query("UPDATE mbt_quotes SET proposed_return_at = NULL WHERE quote_id = $1", [incomplete.quoteId]);
  await rejectsMbt(convertFrontdeskQuote(frontdeskCommand("incomplete-convert", ACTOR, {
    quoteId: incomplete.quoteId, expectedRevision: 3
  })), "MBT_FRONTDESK_QUOTE_INCOMPLETE", 422);
});

test("P3-F13 adversarial: successful conversion hooks execute inside the local transaction", async () => {
  const accepted = await createAccepted("successful-hooks");
  const calls = [];
  const result = await convertFrontdeskQuote(frontdeskCommand("successful-hooks", ACTOR, {
    quoteId: accepted.quoteId, expectedRevision: 3
  }), {
    afterContractInsert: async ({ contractId }) => calls.push(`contract:${contractId}`),
    afterVisitsInsert: async ({ visits }) => calls.push(`visits:${visits.length}`)
  });
  assert.deepEqual(calls, [
    `contract:${result.body.contract.contractId}`,
    "visits:2"
  ]);
});

test("P3-F13/F14 variants: nullable canonical fields and optional timeline evidence project safely", async () => {
  const fixture = await createFrontdeskPrerequisites({ label: "optional-evidence" });
  await query(
    `UPDATE netsuite_customers
        SET terms = NULL, tax_status = NULL, credit_status = NULL
      WHERE netsuite_id = $1`,
    [fixture.customerNetsuiteId]
  );
  await query(
    `UPDATE netsuite_customer_addresses
        SET label = '', address_line_1 = '', city = '', region = '', postal_code = ''
      WHERE address_id = $1`,
    [fixture.addressId]
  );
  await query("UPDATE mbt_rate_card_versions SET effective_to = '2037-12-31T00:00:00Z' WHERE rate_card_version_id = $1", [
    fixture.rateCardVersionId
  ]);
  await query("UPDATE mbt_rate_distance_bands SET description = '' WHERE rate_distance_band_id = $1", [
    fixture.rateDistanceBandId
  ]);
  await query("UPDATE mbt_rate_components SET description = '' WHERE rate_component_id = $1", [
    fixture.rentalComponentId
  ]);
  await query(
    `UPDATE mbt_deposit_rules
        SET rule_type = 'percentage', fixed_amount_minor = NULL,
            percentage_basis_points = 1000
      WHERE deposit_rule_id = $1`,
    [fixture.depositRuleId]
  );

  const search = await searchFrontdeskCustomers({
    actor: ACTOR,
    query: fixture.marker,
    pilotCustomerIds: [fixture.customerNetsuiteId]
  });
  assert.deepEqual({
    label: search.items[0].sites[0].label,
    addressLine1: search.items[0].sites[0].addressLine1,
    city: search.items[0].sites[0].city,
    region: search.items[0].sites[0].region,
    postalCode: search.items[0].sites[0].postalCode
  }, { label: "", addressLine1: "", city: "", region: "", postalCode: "" });

  const input = quoteCommand(fixture, { actor: ACTOR, identity: `${RUN_ID}-optional-evidence` });
  const distance = await frontdeskDistanceResolver(fixture)();
  delete distance.routeSnapshot;
  const draft = await createFrontdeskQuote(input, {
    resolveDistance: async () => distance,
    resolveTaxPolicy: async () => ({ code: "ON_HST_13", basisPoints: 1_300 })
  });
  assert.equal(draft.body.quote.depositRequiredMinor, 5_368);
  assert.deepEqual(draft.body.quote.pricing.lines.map(({ label }) => label), [
    "14YD", "DUMP · 1.000 t estimated", "Synthetic one-way BIN delivery"
  ]);
  const quoteId = draft.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand("optional-issue", ACTOR, {
    quoteId, expectedRevision: 1, validUntil: FUTURE_VALID_UNTIL
  }));
  await acceptFrontdeskQuote(frontdeskCommand("optional-accept", ACTOR, {
    quoteId, expectedRevision: 2, acceptedAt: "2037-08-03T10:00:00.000Z"
  }));
  await query(
    "UPDATE mbt_quotes SET accepted_at = NULL, pricing_snapshot = pricing_snapshot - 'serviceCode' WHERE quote_id = $1",
    [quoteId]
  );
  const converted = await convertFrontdeskQuote(frontdeskCommand("optional-convert", ACTOR, {
    quoteId, expectedRevision: 3
  }));
  const contractId = converted.body.contract.contractId;
  assert.equal(converted.body.contract.terms.customerTerms, null);
  assert.equal(converted.body.contract.terms.acceptedAt, null);
  assert.equal(converted.body.visits[0].serviceAction, "delivery");

  await query(
    `UPDATE mbt_service_visits
        SET scheduled_start_at = NULL, scheduled_end_at = NULL,
            actual_started_at = CASE WHEN service_action = 'delivery'
              THEN '2037-08-03T12:05:00Z'::timestamptz ELSE NULL END,
            actual_completed_at = CASE WHEN service_action = 'delivery'
              THEN '2037-08-03T12:35:00Z'::timestamptz ELSE NULL END,
            service_snapshot = CASE WHEN service_action = 'delivery'
              THEN service_snapshot - 'displayName' ELSE service_snapshot END
      WHERE contract_id = $1`,
    [contractId]
  );
  await query(
    "UPDATE mbt_contracts SET planned_delivery_at = NULL, planned_return_at = NULL WHERE contract_id = $1",
    [contractId]
  );
  const sparseTimeline = await getFrontdeskContractTimeline({ actor: ACTOR, contractId });
  assert.equal(sparseTimeline.contract.plannedDeliveryAt, null);
  assert.equal(sparseTimeline.contract.plannedReturnAt, null);
  assert.equal(sparseTimeline.visits[0].displayName, "delivery");
  assert.equal(sparseTimeline.visits[0].actualStartedAt, "2037-08-03T12:05:00.000Z");
  assert.equal(sparseTimeline.visits[0].actualCompletedAt, "2037-08-03T12:35:00.000Z");
  assert.equal(sparseTimeline.visits[1].scheduledStartAt, null);
  assert.equal(sparseTimeline.visits[1].scheduledEndAt, null);

  await extendFrontdeskContract(frontdeskCommand("optional-extension", ACTOR, {
    contractId,
    expectedRevision: 1,
    returnWindow: {
      startAt: "2037-09-01T12:00:00.000Z",
      endAt: "2037-09-01T16:00:00.000Z"
    }
  }));
  await query(
    `INSERT INTO mbt_contract_amendments (
       amendment_id, contract_id, amendment_number, amendment_type,
       status, reason, before_snapshot, after_snapshot, created_by, updated_by
     ) VALUES ($1, $2, 2, 'other', 'draft', 'Optional projection evidence', '{}', '{}', $3, $3)`,
    [crypto.randomUUID(), contractId, ACTOR.operatorId]
  );
  const amendedTimeline = await getFrontdeskContractTimeline({ actor: ACTOR, contractId });
  assert.equal(amendedTimeline.amendments[1].approvedAt, null);
  assert.equal(amendedTimeline.amendments[1].approvedBy, null);
});

test("P3-F14 adversarial: contract timeline and extension reject invalid contract chains", async () => {
  const missingContractId = crypto.randomUUID();
  await rejectsMbt(getFrontdeskContractTimeline({ actor: ACTOR, contractId: missingContractId }),
    "MBT_FRONTDESK_CONTRACT_NOT_FOUND", 404);
  await rejectsMbt(extendFrontdeskContract(frontdeskCommand("bad-window-order", ACTOR, {
    contractId: missingContractId,
    expectedRevision: 1,
    returnWindow: {
      startAt: "2037-09-01T16:00:00.000Z",
      endAt: "2037-09-01T12:00:00.000Z"
    }
  })), "MBT_FRONTDESK_INPUT_INVALID", 400);
  await rejectsMbt(extendFrontdeskContract(frontdeskCommand("missing-contract", ACTOR, {
    contractId: missingContractId,
    expectedRevision: 1,
    returnWindow: {
      startAt: "2037-09-01T12:00:00.000Z",
      endAt: "2037-09-01T16:00:00.000Z"
    }
  })), "MBT_FRONTDESK_CONTRACT_NOT_FOUND", 404);

  const cancelled = await createConverted("cancelled-contract");
  await query("UPDATE mbt_contracts SET status = 'cancelled', cancelled_at = now() WHERE contract_id = $1", [cancelled.contractId]);
  await rejectsMbt(extendFrontdeskContract(frontdeskCommand("cancelled-contract", ACTOR, {
    contractId: cancelled.contractId,
    expectedRevision: 1,
    returnWindow: {
      startAt: "2037-09-01T12:00:00.000Z",
      endAt: "2037-09-01T16:00:00.000Z"
    }
  })), "MBT_FRONTDESK_CONTRACT_STATE_CONFLICT", 409);

  const incomplete = await createConverted("incomplete-contract");
  await query("UPDATE mbt_service_visits SET service_action = 'unclassified' WHERE contract_id = $1", [
    incomplete.contractId
  ]);
  await rejectsMbt(extendFrontdeskContract(frontdeskCommand("incomplete-contract", ACTOR, {
    contractId: incomplete.contractId,
    expectedRevision: 1,
    returnWindow: {
      startAt: "2037-09-01T12:00:00.000Z",
      endAt: "2037-09-01T16:00:00.000Z"
    }
  })), "MBT_FRONTDESK_CONTRACT_INCOMPLETE", 422);

  const beforeDelivery = await createConverted("extension-before-delivery");
  await rejectsMbt(extendFrontdeskContract(frontdeskCommand("extension-before-delivery", ACTOR, {
    contractId: beforeDelivery.contractId,
    expectedRevision: 1,
    returnWindow: {
      startAt: "2037-08-01T12:00:00.000Z",
      endAt: "2037-08-01T16:00:00.000Z"
    }
  })), "MBT_FRONTDESK_INPUT_INVALID", 400);
});
