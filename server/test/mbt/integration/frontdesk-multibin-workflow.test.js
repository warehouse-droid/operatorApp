import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  acceptFrontdeskQuote,
  collectFrontdeskServiceLine,
  confirmFrontdeskServiceLineCustomerChange,
  convertFrontdeskQuote,
  createFrontdeskQuote,
  exchangeFrontdeskServiceLine,
  extendFrontdeskServiceLine,
  getFrontdeskContractTimeline,
  getFrontdeskCustomerContracts,
  issueFrontdeskQuote,
  markFrontdeskServiceLineDispatchChange,
  searchFrontdeskCustomers
} from "../../../src/mbt/frontdesk-service.js";
import {
  createFrontdeskPrerequisites,
  frontdeskCommand,
  frontdeskDistanceResolver,
  frontdeskTaxResolver,
  quoteCommand
} from "../support/frontdesk-fixtures.js";

const ACTOR = Object.freeze({
  operatorId: `frontdesk-multibin-${crypto.randomUUID().slice(0, 8)}`,
  roles: Object.freeze(["mbt_frontdesk"])
});
const DISPATCHER = Object.freeze({
  operatorId: `frontdesk-multibin-dispatch-${crypto.randomUUID().slice(0, 8)}`,
  roles: Object.freeze(["dispatcher"])
});

after(async () => {
  await closeDb();
});

function syntheticCustomerId() {
  return String(7_500_000_000_000n + (BigInt(`0x${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`) % 1_000_000_000_000n));
}

async function createAdditionalSite(fixture, label, addressLine1) {
  const addressId = crypto.randomUUID();
  const siteProfileId = crypto.randomUUID();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const payloadHash = crypto.createHash("sha256").update(`${fixture.customerNetsuiteId}:${addressLine1}`).digest("hex");
  await query(
    `INSERT INTO netsuite_customer_addresses (
       address_id, customer_netsuite_id, netsuite_address_id, label,
       addressee, address_line_1, city, region, postal_code, country_code,
       active, source_modified_at, source_version, payload_hash
     ) VALUES (
       $1, $2, $3, $4, $4, $5, 'Toronto', 'ON', 'M2M 2M2', 'CA',
       true, now(), $6, $7
     )`,
    [addressId, fixture.customerNetsuiteId, `LOCAL-TEST-${suffix}`, label, addressLine1, `test-${suffix}`, payloadHash]
  );
  await query(
    `INSERT INTO mbt_customer_site_profiles (
       site_profile_id, customer_netsuite_id, address_id, site_instructions,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [siteProfileId, fixture.customerNetsuiteId, addressId, `Instructions for ${label}`, ACTOR.operatorId]
  );
  return { addressId, siteProfileId, label, addressLine1 };
}

test("MBT Front Desk customer search: an active imported customer needs no pre-existing subsidiary, address, or site", async () => {
  const customerNetsuiteId = syntheticCustomerId();
  const marker = `Core-only ${crypto.randomUUID().slice(0, 8)}`;
  const payloadHash = crypto.createHash("sha256").update(marker).digest("hex");
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency,
       phone, active, source_modified_at, source_version, payload_hash
     ) VALUES ($1, $2, $3, $3, 'CAD', '+1-416-555-0199', true, now(), $4, $5)`,
    [customerNetsuiteId, `CORE-${customerNetsuiteId}`, marker, `local-core-${customerNetsuiteId}`, payloadHash]
  );

  const result = await searchFrontdeskCustomers({
    actor: ACTOR,
    query: marker,
    pilotCustomerIds: [customerNetsuiteId]
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].customerNetsuiteId, customerNetsuiteId);
  assert.equal(result.items[0].serviceReady, true);
  assert.equal(result.items[0].binOrderSiteRequired, true);
  assert.deepEqual(result.items[0].sites, []);
});

async function convertedMultiBinContract(label) {
  const fixture = await createFrontdeskPrerequisites({ label });
  const created = await createFrontdeskQuote({
    ...quoteCommand(fixture, { actor: ACTOR, identity: `${label}-${crypto.randomUUID()}` }),
    serviceLines: [
      {
        binTypeId: fixture.binTypeId,
        proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
        proposedReturnAt: "2037-08-17T12:00:00.000Z"
      },
      {
        binTypeId: fixture.binTypeId,
        proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
        proposedReturnAt: "2037-08-17T12:00:00.000Z"
      }
    ]
  }, {
    resolveDistance: frontdeskDistanceResolver(fixture),
    resolveTaxPolicy: frontdeskTaxResolver
  });
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

async function addTwentyYardPricing(fixture) {
  const binType = await query(
    "SELECT bin_type_id::text FROM mbt_bin_types WHERE type_code = '20YD' AND active LIMIT 1"
  );
  assert.equal(binType.rowCount, 1, "the fixed 20YD rental item is available for local Front Desk pricing");
  const binTypeId = String(binType.rows[0].bin_type_id);
  const distanceBandId = crypto.randomUUID();
  const componentId = crypto.randomUUID();
  const depositRuleId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, service_code, bin_type_id,
       sequence_number, minimum_metres, maximum_metres, amount_minor, currency, description
     ) VALUES ($1, $2, 'delivery', $3, 1, 0, NULL, 19000, 'CAD', 'Synthetic 20YD transport')`,
    [distanceBandId, fixture.rateCardVersionId, binTypeId]
  );
  await query(
    `INSERT INTO mbt_rate_components (
       rate_component_id, rate_card_version_id, component_code, component_kind,
       service_code, bin_type_id, rate_basis, amount_minor, currency, taxable, description
     ) VALUES ($1, $2, 'rental_20yd_14_days', 'rental', 'delivery', $3, 'flat', 21000, 'CAD', true, 'Synthetic 20YD rental')`,
    [componentId, fixture.rateCardVersionId, binTypeId]
  );
  await query(
    `INSERT INTO mbt_deposit_rules (
       deposit_rule_id, rate_card_version_id, rule_code, rule_type, bin_type_id,
       fixed_amount_minor, currency, liability_account_mapping_key, description
     ) VALUES ($1, $2, 'bin_deposit_20yd', 'bin_type', $3, 11000, 'CAD', 'local_bin_deposit', 'Synthetic 20YD deposit')`,
    [depositRuleId, fixture.rateCardVersionId, binTypeId]
  );
  return { binTypeId, distanceBandId, componentId, depositRuleId };
}

test("MBT Front Desk multi-bin: one accepted quote materializes independent ready front legs and only local records", async () => {
  const { fixture, created, converted } = await convertedMultiBinContract("two-lines");
  assert.equal(converted.status, 201);
  assert.equal(converted.body.schemaVersion, "mbt-frontdesk-conversion-v2");
  assert.equal(converted.body.serviceLines.length, 2);
  assert.equal(converted.body.visits.length, 4);
  assert.equal(converted.body.billingCases.length, 2);
  assert.deepEqual(converted.body.serviceLines.map((line) => ({
    lineNumber: line.lineNumber,
    status: line.status,
    binTypeId: line.binTypeId,
    binItemCode: line.binItemCode,
    dumpItemCode: line.dumpItemCode,
    estimatedWeightKg: line.estimatedWeightKg
  })), [
    {
      lineNumber: 1, status: "scheduled", binTypeId: fixture.binTypeId,
      binItemCode: fixture.binItemCode, dumpItemCode: fixture.dumpItemCode,
      estimatedWeightKg: 1_000
    },
    {
      lineNumber: 2, status: "scheduled", binTypeId: fixture.binTypeId,
      binItemCode: fixture.binItemCode, dumpItemCode: fixture.dumpItemCode,
      estimatedWeightKg: 1_000
    }
  ]);
  for (const line of converted.body.serviceLines) {
    const visits = converted.body.visits.filter((visit) => visit.serviceLineId === line.serviceLineId);
    assert.deepEqual(visits.map((visit) => ({
      action: visit.serviceAction,
      status: visit.status,
      predecessor: visit.predecessorVisitId
    })), [
      { action: "delivery", status: "ready", predecessor: null },
      { action: "return_bin", status: "tentative", predecessor: visits[0].visitId }
    ]);
  }
  const visitMaterials = await query(
    `SELECT visit.service_action, material.material_code
       FROM mbt_service_visits visit
       LEFT JOIN mbt_materials material ON material.material_id = visit.material_id
      WHERE visit.contract_id = $1::uuid
      ORDER BY visit.visit_number`,
    [converted.body.contract.contractId]
  );
  assert.deepEqual(visitMaterials.rows, [
    { service_action: "delivery", material_code: null },
    { service_action: "return_bin", material_code: fixture.dumpItemCode },
    { service_action: "delivery", material_code: null },
    { service_action: "return_bin", material_code: fixture.dumpItemCode }
  ]);
  const retainedBilling = await query(
    `SELECT service_visit_id::text
       FROM mbt_billing_cases
      WHERE contract_id = $1::uuid AND case_type = 'mbt_contract'
      ORDER BY service_visit_id`,
    [converted.body.contract.contractId]
  );
  const deliveryVisitIds = converted.body.visits
    .filter((visit) => visit.serviceAction === "delivery")
    .map((visit) => visit.visitId)
    .sort();
  assert.deepEqual(
    retainedBilling.rows.map((row) => String(row.service_visit_id)).sort(),
    deliveryVisitIds,
    "Each physical bin must own an independent billing source visit."
  );
  assert.equal(created.body.quote.serviceLines.length, 2);
  assert.equal(created.body.quote.pricing.totalMinor > 0, true);

  const [master, timeline, phoneSearch] = await Promise.all([
    getFrontdeskCustomerContracts({ actor: ACTOR, customerNetsuiteId: fixture.customerNetsuiteId }),
    getFrontdeskContractTimeline({ actor: ACTOR, contractId: converted.body.contract.contractId }),
    searchFrontdeskCustomers({ actor: ACTOR, query: "0100", pilotCustomerIds: [fixture.customerNetsuiteId] })
  ]);
  assert.equal(master.items.length, 1);
  assert.equal(master.items[0].openServiceLineCount, 2);
  assert.equal(timeline.serviceLines.length, 2);
  assert.equal(timeline.visits.every((visit) => Boolean(visit.serviceLineId)), true);
  assert.deepEqual(phoneSearch.items.map((item) => item.customerNetsuiteId), [fixture.customerNetsuiteId]);
});

test("MBT Front Desk multi-bin: every bin size retains its own rental, transport, deposit, and delivery distance evidence", async () => {
  const fixture = await createFrontdeskPrerequisites({ label: "mixed-pricing" });
  const twenty = await addTwentyYardPricing(fixture);
  const created = await createFrontdeskQuote({
    ...quoteCommand(fixture, { actor: ACTOR, identity: `mixed-pricing-${crypto.randomUUID()}` }),
    serviceLines: [
      {
        binTypeId: fixture.binTypeId,
        proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
        proposedReturnAt: "2037-08-17T12:00:00.000Z"
      },
      {
        binItemCode: "20YD",
        binTypeId: twenty.binTypeId,
        proposedDeliveryAt: "2037-08-05T12:00:00.000Z",
        proposedReturnAt: "2037-08-19T12:00:00.000Z"
      }
    ]
  }, {
    resolveDistance: frontdeskDistanceResolver(fixture),
    resolveTaxPolicy: frontdeskTaxResolver
  });
  const [fourteenLine, twentyLine] = created.body.quote.serviceLines;
  assert.deepEqual(
    [fourteenLine.totalMinor, twentyLine.totalMinor, created.body.quote.pricing.totalMinor],
    [53_675, 45_200, 98_875]
  );
  assert.deepEqual(
    [fourteenLine.depositRequiredMinor, twentyLine.depositRequiredMinor, created.body.quote.depositRequiredMinor],
    [10_000, 11_000, 21_000]
  );
  assert.notEqual(twentyLine.rateDistanceBandId, fourteenLine.rateDistanceBandId);
  assert.equal(Array.isArray(twentyLine.lines), true, JSON.stringify(twentyLine));
  assert.equal(twentyLine.lines.some((line) => line.code === "bin_base_rental" && line.amountMinor === 21_000), true);

  const quoteId = created.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand("mixed-pricing-issue", ACTOR, {
    quoteId, expectedRevision: 1, validUntil: "2037-08-04T12:00:00.000Z"
  }));
  await acceptFrontdeskQuote(frontdeskCommand("mixed-pricing-accept", ACTOR, {
    quoteId, expectedRevision: 2, acceptedAt: "2037-08-03T10:00:00.000Z"
  }));
  const converted = await convertFrontdeskQuote(frontdeskCommand("mixed-pricing-convert", ACTOR, {
    quoteId, expectedRevision: 3
  }));
  const deliveryEvidence = await query(
    `SELECT line.bin_type_id::text, distance.rate_distance_band_id::text, distance.calculated_amount_minor::int
       FROM mbt_contract_service_lines line
       JOIN mbt_service_visits visit
         ON visit.service_line_id = line.service_line_id AND visit.service_action = 'delivery'
       JOIN mbt_distance_snapshots distance
         ON distance.subject_type = 'visit' AND distance.subject_id = visit.service_visit_id
      WHERE line.contract_id = $1::uuid
      ORDER BY line.line_number`,
    [converted.body.contract.contractId]
  );
  assert.deepEqual(deliveryEvidence.rows.map((row) => ({
    binTypeId: String(row.bin_type_id),
    rateDistanceBandId: String(row.rate_distance_band_id),
    transportMinor: Number(row.calculated_amount_minor)
  })), [
    { binTypeId: fixture.binTypeId, rateDistanceBandId: fourteenLine.rateDistanceBandId, transportMinor: 12_500 },
    { binTypeId: twenty.binTypeId, rateDistanceBandId: twentyLine.rateDistanceBandId, transportMinor: 19_000 }
  ]);
});

test("MBT Front Desk estimate adds base rental, estimated dump weight, one-way delivery, and manual surcharge", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await createFrontdeskPrerequisites({ label: "complete-estimate" });
      const surchargeItemCode = `SUR_${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      await query(
        `INSERT INTO mbt_local_item_settings (
           item_code, display_name, description, item_type, rental_period_days,
           category, bin_type_id, pricing_mode, system_owned,
           applicable_service_types, applicable_legacy_source_types,
           active, revision, created_by, updated_by
         ) VALUES (
           $1, 'Manual test surcharge', 'Explicit Front Desk order surcharge',
           'surcharge', NULL, 'surcharge', NULL, 'custom_price', false,
           ARRAY[]::text[], ARRAY[]::text[], true, 1, $2, $2
         )`,
        [surchargeItemCode, ACTOR.operatorId]
      );
      await query(
        `UPDATE mbt_dump_tariffs tariff
            SET amount_minor = 12345,
                minimum_amount_minor = 0
           FROM mbt_rate_card_versions version
           JOIN mbt_rate_cards card ON card.rate_card_id = version.rate_card_id
          WHERE tariff.rate_card_version_id = version.rate_card_version_id
            AND card.item_code = $1
            AND version.status = 'active'
            AND version.first_used_at IS NULL`,
        [fixture.dumpItemCode]
      );

      const created = await createFrontdeskQuote({
        ...quoteCommand(fixture, { actor: ACTOR, identity: `complete-estimate-${crypto.randomUUID()}` }),
        estimatedTonnes: "1.250",
        surcharges: [{ itemCode: surchargeItemCode, amountMinor: 5_000 }]
      }, {
        resolveDistance: frontdeskDistanceResolver(fixture),
        resolveTaxPolicy: frontdeskTaxResolver
      });

      const quote = created.body.quote;
      assert.deepEqual(quote.pricing.lines.map((line) => ({
        code: line.code,
        amountMinor: line.amountMinor
      })), [
        { code: "bin_base_rental", amountMinor: 35_000 },
        { code: "estimated_dump_weight", amountMinor: 15_431 },
        { code: "one_way_delivery", amountMinor: 12_500 },
        { code: `manual_surcharge_${surchargeItemCode.toLowerCase()}`, amountMinor: 5_000 }
      ]);
      assert.deepEqual({
        subtotalMinor: quote.pricing.subtotalMinor,
        taxMinor: quote.pricing.taxMinor,
        totalMinor: quote.pricing.totalMinor,
        depositRequiredMinor: quote.depositRequiredMinor
      }, {
        subtotalMinor: 67_931,
        taxMinor: 8_831,
        totalMinor: 76_762,
        depositRequiredMinor: 10_000
      });
      assert.equal(quote.serviceLines[0].estimatedWeightKg, 1_250);
      assert.equal(quote.serviceLines[0].lines[1].unitAmountMinor, 12_345);
      assert.equal(quote.serviceLines[0].lines[3].itemCode, surchargeItemCode);
    });
  } finally {
    await rollback.rollback();
  }
});

test("MBT Front Desk BIN order: all physical bins must share the one contract site", async () => {
  const fixture = await createFrontdeskPrerequisites({ label: "different-sites" });
  const secondSite = await createAdditionalSite(fixture, "Second project", "200 Second Test Route");
  await assert.rejects(createFrontdeskQuote({
    ...quoteCommand(fixture, { actor: ACTOR, identity: `different-sites-${crypto.randomUUID()}` }),
    siteProfileId: undefined,
    serviceLines: [
      { binTypeId: fixture.binTypeId, siteProfileId: fixture.siteProfileId, proposedDeliveryAt: "2037-08-03T12:00:00.000Z", proposedReturnAt: "2037-08-17T12:00:00.000Z" },
      { binTypeId: fixture.binTypeId, siteProfileId: secondSite.siteProfileId, proposedDeliveryAt: "2037-08-04T12:00:00.000Z", proposedReturnAt: "2037-08-18T12:00:00.000Z" }
    ]
  }, {
    resolveDistance: frontdeskDistanceResolver(fixture), resolveTaxPolicy: frontdeskTaxResolver
  }), (error) => error?.code === "MBT_FRONTDESK_INPUT_INVALID" && /one service site/i.test(error.message));
});

test("MBT Front Desk BIN order: an inline local address is created atomically and becomes the line site", async () => {
  const fixture = await createFrontdeskPrerequisites({ label: "inline-site" });
  const address = {
    label: "Fresh project",
    addressLine1: "300 Fresh Test Avenue",
    addressLine2: "Rear gate",
    city: "Toronto",
    region: "ON",
    postalCode: "M3M 3M3",
    countryCode: "CA",
    siteInstructions: "Call the site contact"
  };
  let resolvedSite;
  const created = await createFrontdeskQuote({
    ...quoteCommand(fixture, { actor: ACTOR, identity: `inline-site-${crypto.randomUUID()}` }),
    siteProfileId: undefined,
    site: address,
    serviceLines: [{
      binTypeId: fixture.binTypeId,
      proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
      proposedReturnAt: "2037-08-17T12:00:00.000Z"
    }]
  }, {
    resolveDistance: async ({ site }) => {
      resolvedSite = site;
      return {
        provider: "synthetic_route_engine",
        providerMetres: 12_500,
        routeHash: crypto.createHash("sha256").update(site.siteProfileId).digest("hex"),
        originSnapshot: { kind: "yard", yardCode: "12441" },
        destinationSnapshot: { kind: "customer_site", siteProfileId: site.siteProfileId },
        routeSnapshot: { local: true }
      };
    },
    resolveTaxPolicy: frontdeskTaxResolver
  });
  assert.equal(resolvedSite.addressLine1, address.addressLine1);
  assert.equal(created.body.quote.serviceLines[0].siteProfileId, resolvedSite.siteProfileId);
  const stored = await query(
    `SELECT address.netsuite_address_id, address.address_line_1, site.site_instructions
       FROM mbt_customer_site_profiles site
       JOIN netsuite_customer_addresses address
         ON address.customer_netsuite_id = site.customer_netsuite_id
        AND address.address_id = site.address_id
      WHERE site.site_profile_id = $1::uuid`,
    [resolvedSite.siteProfileId]
  );
  assert.equal(stored.rowCount, 1);
  assert.match(String(stored.rows[0].netsuite_address_id), /^LOCAL:/);
  assert.equal(stored.rows[0].address_line_1, address.addressLine1);
  assert.equal(stored.rows[0].site_instructions, address.siteInstructions);
});

test("MBT Front Desk multi-bin: amendment, exchange, customer confirmation, and collection stay line-scoped", async () => {
  const { converted } = await convertedMultiBinContract("line-actions");
  const contractId = converted.body.contract.contractId;
  const [firstLine, secondLine] = converted.body.serviceLines;
  const extension = await extendFrontdeskServiceLine(frontdeskCommand("line-extension", ACTOR, {
    contractId,
    serviceLineId: secondLine.serviceLineId,
    expectedRevision: secondLine.revision,
    returnWindow: { startAt: "2037-08-24T12:00:00.000Z", endAt: "2037-08-24T16:00:00.000Z" }
  }));
  assert.equal(extension.body.serviceLine.serviceLineId, secondLine.serviceLineId);
  assert.equal(extension.body.serviceLine.plannedReturnAt, "2037-08-24T12:00:00.000Z");

  const afterExtension = await getFrontdeskContractTimeline({ actor: ACTOR, contractId });
  assert.equal(afterExtension.serviceLines.find((line) => line.serviceLineId === firstLine.serviceLineId).plannedReturnAt, "2037-08-17T12:00:00.000Z");

  const exchange = await exchangeFrontdeskServiceLine(frontdeskCommand("line-exchange", ACTOR, {
    contractId,
    serviceLineId: firstLine.serviceLineId,
    expectedRevision: firstLine.revision,
    exchangeWindow: { startAt: "2037-08-04T12:00:00.000Z", endAt: "2037-08-04T16:00:00.000Z" },
    incomingBinTypeId: "00000000-0000-4000-8000-000000000020",
    chargeMode: "free_internal",
    waiverReason: "Synthetic no-charge replacement"
  }));
  assert.equal(exchange.status, 201);
  assert.equal(exchange.body.exchangeVisit.serviceLineId, firstLine.serviceLineId);
  assert.equal(exchange.body.serviceLine.binItemCode, "20YD");
  assert.equal(exchange.body.serviceLine.customerConfirmation.status, "required");
  assert.equal(exchange.body.serviceLine.waiver.mode, "free_internal");

  const dispatchChange = await markFrontdeskServiceLineDispatchChange(frontdeskCommand("dispatch-change", DISPATCHER, {
    contractId,
    serviceLineId: firstLine.serviceLineId,
    expectedRevision: exchange.body.serviceLine.revision,
    change: { kind: "schedule", before: { startAt: "2037-08-04T12:00:00.000Z" }, after: { startAt: "2037-08-05T12:00:00.000Z" } }
  }));
  assert.equal(dispatchChange.body.serviceLine.customerConfirmation.status, "required");
  const confirmation = await confirmFrontdeskServiceLineCustomerChange(frontdeskCommand("customer-confirm", ACTOR, {
    contractId,
    serviceLineId: firstLine.serviceLineId,
    expectedRevision: dispatchChange.body.serviceLine.revision,
    decision: "confirmed"
  }));
  assert.equal(confirmation.body.serviceLine.customerConfirmation.status, "confirmed");

  const collection = await collectFrontdeskServiceLine(frontdeskCommand("line-collection", ACTOR, {
    contractId,
    serviceLineId: secondLine.serviceLineId,
    expectedRevision: extension.body.serviceLine.revision,
    collectionWindow: { startAt: "2037-08-25T12:00:00.000Z", endAt: "2037-08-25T16:00:00.000Z" }
  }));
  assert.equal(collection.body.serviceLine.status, "return_due");

  const events = await query(
    `SELECT event_type FROM mbt_contract_service_line_events
      WHERE contract_id = $1::uuid ORDER BY event_type`,
    [contractId]
  );
  assert.deepEqual(events.rows.map((row) => row.event_type), [
    "charge_waiver", "collection", "customer_confirmation", "dispatch_change", "exchange", "extension"
  ]);
});
