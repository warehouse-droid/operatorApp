import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  createFrontdeskPrerequisites,
  FRONTDESK_PRICING,
  frontdeskCommand,
  frontdeskDistanceResolver,
  frontdeskTaxResolver,
  quoteCommand
} from "../support/frontdesk-fixtures.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `p3-frontdesk-${RUN_ID}`,
  roles: Object.freeze(["mbt_frontdesk"])
});

const frontdesk = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/frontdesk-service.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

/** @param {string} name */
function requiredOperation(name) {
  const operation = frontdesk[name];
  assert.equal(
    typeof operation,
    "function",
    `P3.7 requires the ${name} Front Desk operation.`
  );
  return operation;
}

/** @param {unknown} error @param {string} code @param {number} [status] */
function isMbtFailure(error, code, status = 409) {
  return error instanceof MbtError && error.code === code && error.status === status;
}

/** @param {string} label */
async function createDraftQuote(label) {
  const createFrontdeskQuote = requiredOperation("createFrontdeskQuote");
  const fixture = await createFrontdeskPrerequisites({ label });
  const input = quoteCommand(fixture, {
    actor: ACTOR,
    identity: `${RUN_ID}-${label}`
  });
  const result = await createFrontdeskQuote(input, {
    resolveDistance: frontdeskDistanceResolver(fixture),
    resolveTaxPolicy: frontdeskTaxResolver
  });
  return { fixture, input, result };
}

/** @param {string} label */
async function createAcceptedQuote(label) {
  const draft = await createDraftQuote(label);
  const issueFrontdeskQuote = requiredOperation("issueFrontdeskQuote");
  const acceptFrontdeskQuote = requiredOperation("acceptFrontdeskQuote");
  const quoteId = draft.result.body.quote.quoteId;
  const issued = await issueFrontdeskQuote(frontdeskCommand("issue", ACTOR, {
    quoteId,
    expectedRevision: 1,
    validUntil: "2037-08-04T12:00:00.000Z"
  }));
  const accepted = await acceptFrontdeskQuote(frontdeskCommand("accept", ACTOR, {
    quoteId,
    expectedRevision: 2,
    acceptedAt: "2037-08-03T10:00:00.000Z"
  }));
  return { ...draft, quoteId, issued, accepted };
}

async function externalAndLegacyCounts() {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain) AS sales_order_chains,
       (SELECT count(*)::int FROM mbt_deposit_records) AS deposit_records,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox_rows,
       (SELECT count(*)::int FROM mbt_netsuite_outbox_attempts) AS outbox_attempts,
       (SELECT count(*)::int FROM mbt_netsuite_reconciliations) AS netsuite_reconciliations,
       (SELECT count(*)::int FROM sales_orders) AS ordinary_sales_orders,
       (SELECT count(*)::int FROM purchase_orders) AS ordinary_purchase_orders,
       (SELECT count(*)::int FROM transfer_orders) AS ordinary_transfer_orders,
       (SELECT count(*)::int FROM dispatch_plans) AS ordinary_dispatch_plans,
       (SELECT count(*)::int FROM driver_job_records) AS ordinary_driver_jobs,
       (SELECT count(*)::int FROM operator_saved_delivery_orders) AS ordinary_operator_orders`
  );
  return result.rows[0];
}

/** @param {string} quoteId */
async function quoteConversionEvidence(quoteId) {
  const result = await query(
    `SELECT
       q.status AS quote_status,
       q.revision::int AS quote_revision,
       (SELECT count(*)::int FROM mbt_contracts c WHERE c.quote_id = q.quote_id) AS contracts,
       (SELECT count(*)::int
          FROM mbt_service_visits v
          JOIN mbt_contracts c ON c.contract_id = v.contract_id
         WHERE c.quote_id = q.quote_id) AS visits,
       (SELECT count(*)::int
          FROM mbt_billing_cases b
          JOIN mbt_contracts c ON c.contract_id = b.contract_id
         WHERE c.quote_id = q.quote_id AND b.case_type = 'mbt_contract') AS billing_cases
       FROM mbt_quotes q
      WHERE q.quote_id = $1`,
    [quoteId]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

after(async () => {
  await closeDb();
});

test("P3-F13: canonical customer search exposes only active service-ready pilot records", async () => {
  const searchFrontdeskCustomers = requiredOperation("searchFrontdeskCustomers");
  const ready = await createFrontdeskPrerequisites({ label: "search-ready" });
  const inactive = await createFrontdeskPrerequisites({ label: "search-inactive" });
  await query(
    "UPDATE netsuite_customers SET active = false, updated_at = now() WHERE netsuite_id = $1",
    [inactive.customerNetsuiteId]
  );

  const result = await searchFrontdeskCustomers({
    actor: ACTOR,
    query: "Synthetic Front Desk Customer",
    limit: 50,
    pilotCustomerIds: [ready.customerNetsuiteId, inactive.customerNetsuiteId]
  });
  assert.equal(result.schemaVersion, "mbt-frontdesk-customers-v1");
  assert.deepEqual(result.items.map(({ customerNetsuiteId }) => customerNetsuiteId), [
    ready.customerNetsuiteId
  ]);
  assert.equal(result.items[0].serviceReady, true);
  assert.deepEqual(result.items[0].sites.map(({ siteProfileId }) => siteProfileId), [
    ready.siteProfileId
  ]);
  assert.equal(JSON.stringify(result).includes(`${inactive.customerNetsuiteId}`), false);
});

test("P3-F13: server-owned metres, rates, and tax produce an exact-cent draft through accepted quote", async () => {
  const { fixture, input, result, quoteId, issued, accepted } = await createAcceptedQuote("exact-price");
  assert.equal(result.status, 201);
  assert.equal(result.replayed, false);
  assert.equal(result.body.schemaVersion, "mbt-frontdesk-quote-v1");
  assert.deepEqual({
    status: result.body.quote.status,
    revision: result.body.quote.revision,
    currency: result.body.quote.pricing.currency,
    distanceMetres: result.body.quote.pricing.distanceMetres,
    subtotalMinor: result.body.quote.pricing.subtotalMinor,
    taxMinor: result.body.quote.pricing.taxMinor,
    totalMinor: result.body.quote.pricing.totalMinor,
    depositRequiredMinor: result.body.quote.depositRequiredMinor
  }, {
    status: "draft",
    revision: 1,
    currency: FRONTDESK_PRICING.currency,
    distanceMetres: FRONTDESK_PRICING.distanceMetres,
    subtotalMinor: FRONTDESK_PRICING.subtotalMinor,
    taxMinor: FRONTDESK_PRICING.taxMinor,
    totalMinor: FRONTDESK_PRICING.totalMinor,
    depositRequiredMinor: FRONTDESK_PRICING.depositRequiredMinor
  });
  assert.deepEqual(result.body.quote.pricing.lines.map(({ code, amountMinor }) => ({
    code,
    amountMinor
  })), [
    { code: "bin_base_rental", amountMinor: FRONTDESK_PRICING.rentalMinor },
    { code: "estimated_dump_weight", amountMinor: 0 },
    { code: "one_way_delivery", amountMinor: FRONTDESK_PRICING.transportMinor }
  ]);
  assert.notEqual(result.body.quote.pricing.totalMinor, input.clientDisplayTotals.totalMinor);
  assert.deepEqual({
    status: issued.body.quote.status,
    revision: issued.body.quote.revision,
    acceptedAt: accepted.body.quote.acceptedAt,
    acceptedStatus: accepted.body.quote.status,
    acceptedRevision: accepted.body.quote.revision
  }, {
    status: "issued",
    revision: 2,
    acceptedAt: "2037-08-03T10:00:00.000Z",
    acceptedStatus: "accepted",
    acceptedRevision: 3
  });

  const stored = await query(
    `SELECT q.status, q.revision::int AS revision,
            q.customer_netsuite_id::text AS customer_netsuite_id,
            q.customer_site_profile_id::text AS site_profile_id,
            q.service_template_version_id::text AS template_version_id,
            q.rate_card_version_id::text AS rate_version_id,
            q.bin_type_id::text AS bin_type_id,
            q.deposit_required_minor::int AS deposit_required_minor,
            q.pricing_snapshot,
            d.provider, d.provider_metres::int AS provider_metres,
            d.calculated_amount_minor::int AS calculated_amount_minor,
            d.route_hash
       FROM mbt_quotes q
       JOIN mbt_distance_snapshots d ON d.distance_snapshot_id = q.distance_snapshot_id
      WHERE q.quote_id = $1`,
    [quoteId]
  );
  assert.equal(stored.rowCount, 1);
  assert.deepEqual({
    status: stored.rows[0].status,
    revision: stored.rows[0].revision,
    customerNetsuiteId: stored.rows[0].customer_netsuite_id,
    siteProfileId: stored.rows[0].site_profile_id,
    templateVersionId: stored.rows[0].template_version_id,
    rateVersionId: stored.rows[0].rate_version_id,
    binTypeId: stored.rows[0].bin_type_id,
    depositRequiredMinor: stored.rows[0].deposit_required_minor,
    provider: stored.rows[0].provider,
    providerMetres: stored.rows[0].provider_metres,
    calculatedAmountMinor: stored.rows[0].calculated_amount_minor
  }, {
    status: "accepted",
    revision: 3,
    customerNetsuiteId: fixture.customerNetsuiteId,
    siteProfileId: fixture.siteProfileId,
    templateVersionId: fixture.templateVersionId,
    rateVersionId: fixture.rateCardVersionId,
    binTypeId: fixture.binTypeId,
    depositRequiredMinor: FRONTDESK_PRICING.depositRequiredMinor,
    provider: "synthetic_route_engine",
    providerMetres: FRONTDESK_PRICING.distanceMetres,
    calculatedAmountMinor: FRONTDESK_PRICING.transportMinor
  });
  assert.match(stored.rows[0].route_hash, /^[0-9a-f]{64}$/);
  assert.equal(stored.rows[0].pricing_snapshot.totalMinor, FRONTDESK_PRICING.totalMinor);
});

test("P3-F13: the explicit 150 price table reaches distance pricing and remains in quote evidence", async () => {
  const createFrontdeskQuote = requiredOperation("createFrontdeskQuote");
  const fixture = await createFrontdeskPrerequisites({ label: "origin-150" });
  const input = {
    ...quoteCommand(fixture, { actor: ACTOR, identity: `${RUN_ID}-origin-150` }),
    pricingOriginYardCode: "150"
  };
  let distanceRequest;
  const fixtureResolver = frontdeskDistanceResolver(fixture);
  const result = await createFrontdeskQuote(input, {
    resolveDistance: async (request) => {
      distanceRequest = request;
      return fixtureResolver(request);
    },
    resolveTaxPolicy: frontdeskTaxResolver
  });

  assert.equal(distanceRequest.originYardCode, "150");
  assert.equal(distanceRequest.pricingOriginYardCode, "150");
  assert.equal(result.body.quote.pricing.pricingOriginYardCode, "150");
  assert.equal(result.body.quote.pricing.serviceLines[0].pricingOriginYardCode, "150");
});

test("P3-F13: accepted conversion is atomic, exactly replayable, explicitly ordered, and local-only", async () => {
  const convertFrontdeskQuote = requiredOperation("convertFrontdeskQuote");
  const accepted = await createAcceptedQuote("exact-convert");
  const beforeArtifacts = await externalAndLegacyCounts();
  const input = frontdeskCommand("convert", ACTOR, {
    quoteId: accepted.quoteId,
    expectedRevision: 3
  });
  const first = await convertFrontdeskQuote(input);
  const replay = await convertFrontdeskQuote({ ...input });

  assert.equal(first.status, 201);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.equal(first.body.schemaVersion, "mbt-frontdesk-conversion-v1");
  assert.deepEqual({
    status: first.body.contract.status,
    revision: first.body.contract.revision,
    quoteId: first.body.contract.quoteId,
    billingType: first.body.billingCase.caseType,
    billingStatus: first.body.billingCase.status
  }, {
    status: "confirmed",
    revision: 1,
    quoteId: accepted.quoteId,
    billingType: "mbt_contract",
    billingStatus: "open"
  });
  assert.equal(first.body.visits.length, 2);
  const [delivery, returnVisit] = first.body.visits;
  assert.deepEqual({
    number: delivery.visitNumber,
    action: delivery.serviceAction,
    status: delivery.status,
    predecessorVisitId: delivery.predecessorVisitId
  }, {
    number: 1,
    action: "delivery",
    status: "ready",
    predecessorVisitId: null
  });
  assert.deepEqual({
    number: returnVisit.visitNumber,
    action: returnVisit.serviceAction,
    status: returnVisit.status,
    predecessorVisitId: returnVisit.predecessorVisitId
  }, {
    number: 2,
    action: "return_bin",
    status: "tentative",
    predecessorVisitId: delivery.visitId
  });

  const durable = await query(
    `SELECT c.contract_id::text AS contract_id, c.status AS contract_status,
            c.revision::int AS contract_revision,
            c.customer_snapshot, c.site_snapshot, c.terms_snapshot,
            c.tax_snapshot, c.pricing_snapshot,
            v.service_visit_id::text AS visit_id,
            v.visit_number::int AS visit_number, v.service_action, v.status,
            to_jsonb(v)->>'predecessor_visit_id' AS predecessor_visit_id,
            v.customer_snapshot AS visit_customer_snapshot,
            v.site_snapshot AS visit_site_snapshot,
            v.service_snapshot,
            b.billing_case_id::text AS billing_case_id, b.case_type,
            b.status AS billing_status
       FROM mbt_contracts c
       JOIN mbt_service_visits v ON v.contract_id = c.contract_id
       JOIN mbt_billing_cases b ON b.contract_id = c.contract_id
      WHERE c.quote_id = $1
      ORDER BY v.visit_number`,
    [accepted.quoteId]
  );
  assert.equal(durable.rowCount, 2);
  assert.equal(new Set(durable.rows.map(({ contract_id }) => contract_id)).size, 1);
  assert.equal(new Set(durable.rows.map(({ billing_case_id }) => billing_case_id)).size, 1);
  assert.deepEqual(durable.rows.map((row) => ({
    visitNumber: row.visit_number,
    serviceAction: row.service_action,
    status: row.status,
    predecessorVisitId: row.predecessor_visit_id
  })), [
    { visitNumber: 1, serviceAction: "delivery", status: "ready", predecessorVisitId: null },
    {
      visitNumber: 2,
      serviceAction: "return_bin",
      status: "tentative",
      predecessorVisitId: durable.rows[0].visit_id
    }
  ]);
  assert.equal(durable.rows[0].customer_snapshot.netsuiteId, accepted.fixture.customerNetsuiteId);
  assert.deepEqual(durable.rows[0].site_snapshot, {});
  assert.equal(durable.rows[0].visit_site_snapshot.siteProfileId, accepted.fixture.siteProfileId);
  assert.equal(durable.rows[0].terms_snapshot.rentalCalendarDays, 14);
  assert.equal(durable.rows[0].tax_snapshot.basisPoints, FRONTDESK_PRICING.taxBasisPoints);
  assert.equal(durable.rows[0].pricing_snapshot.totalMinor, FRONTDESK_PRICING.totalMinor);
  assert.equal(
    durable.rows[1].service_snapshot.predecessorVisitId,
    durable.rows[0].visit_id
  );
  assert.deepEqual(await quoteConversionEvidence(accepted.quoteId), {
    quote_status: "converted",
    quote_revision: 4,
    contracts: 1,
    visits: 2,
    billing_cases: 1
  });

  const commandEvidence = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = 'mbt.frontdesk.quote.convert'
           AND idempotency_key = $2) AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND action = 'mbt.frontdesk.quote.converted'
           AND idempotency_key = $2) AS audits`,
    [ACTOR.operatorId, input.idempotencyKey]
  );
  assert.deepEqual(commandEvidence.rows[0], { receipts: 1, audits: 1 });
  assert.deepEqual(await externalAndLegacyCounts(), beforeArtifacts);

  await assert.rejects(
    () => convertFrontdeskQuote({ ...input, expectedRevision: 99 }),
    (error) => isMbtFailure(error, "MBT_IDEMPOTENCY_CONFLICT")
  );
  assert.deepEqual(await quoteConversionEvidence(accepted.quoteId), {
    quote_status: "converted",
    quote_revision: 4,
    contracts: 1,
    visits: 2,
    billing_cases: 1
  });
});

test("P3-F13: failures after contract or visit persistence roll back every conversion boundary", async () => {
  const convertFrontdeskQuote = requiredOperation("convertFrontdeskQuote");
  for (const [label, hookName] of [
    ["after-contract", "afterContractInsert"],
    ["after-visits", "afterVisitsInsert"]
  ]) {
    const accepted = await createAcceptedQuote(`rollback-${label}`);
    const input = frontdeskCommand(`rollback-${label}`, ACTOR, {
      quoteId: accepted.quoteId,
      expectedRevision: 3
    });
    let hookCalls = 0;
    await assert.rejects(
      () => convertFrontdeskQuote(input, {
        [hookName]: async () => {
          hookCalls += 1;
          throw new Error(`INJECTED_FRONTDESK_${label.toUpperCase()}`);
        }
      }),
      new RegExp(`INJECTED_FRONTDESK_${label.toUpperCase()}`)
    );
    assert.equal(hookCalls, 1);
    assert.deepEqual(await quoteConversionEvidence(accepted.quoteId), {
      quote_status: "accepted",
      quote_revision: 3,
      contracts: 0,
      visits: 0,
      billing_cases: 0
    });
    const evidence = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_command_receipts
           WHERE actor_operator_id = $1 AND idempotency_key = $2) AS receipts,
         (SELECT count(*)::int FROM mbt_audit_events
           WHERE actor_operator_id = $1 AND idempotency_key = $2) AS audits`,
      [ACTOR.operatorId, input.idempotencyKey]
    );
    assert.deepEqual(evidence.rows[0], { receipts: 0, audits: 0 });
  }
});

test("P3-F14: later canonical and configuration edits cannot rewrite contract or visit snapshots", async () => {
  const convertFrontdeskQuote = requiredOperation("convertFrontdeskQuote");
  const getFrontdeskContractTimeline = requiredOperation("getFrontdeskContractTimeline");
  const accepted = await createAcceptedQuote("snapshot-stability");
  const converted = await convertFrontdeskQuote(frontdeskCommand("snapshot-convert", ACTOR, {
    quoteId: accepted.quoteId,
    expectedRevision: 3
  }));
  const contractId = converted.body.contract.contractId;
  const before = await query(
    `SELECT c.customer_snapshot, c.site_snapshot, c.terms_snapshot,
            c.tax_snapshot, c.pricing_snapshot,
            jsonb_agg(jsonb_build_object(
              'visitId', v.service_visit_id::text,
              'customer', v.customer_snapshot,
              'site', v.site_snapshot,
              'service', v.service_snapshot
            ) ORDER BY v.visit_number) AS visits
       FROM mbt_contracts c
       JOIN mbt_service_visits v ON v.contract_id = c.contract_id
      WHERE c.contract_id = $1
      GROUP BY c.contract_id`,
    [contractId]
  );
  assert.equal(before.rowCount, 1);

  await query(
    `UPDATE netsuite_customers
        SET legal_name = 'Later canonical customer name',
            display_name = 'Later canonical customer display',
            source_modified_at = source_modified_at + interval '1 hour',
            source_version = source_version || '-later',
            payload_hash = $2,
            updated_at = now()
      WHERE netsuite_id = $1`,
    [accepted.fixture.customerNetsuiteId, "1".repeat(64)]
  );
  await query(
    `UPDATE netsuite_customer_addresses
        SET address_line_1 = '999 Later Source Street',
            source_modified_at = source_modified_at + interval '1 hour',
            source_version = source_version || '-later',
            payload_hash = $2,
            updated_at = now()
      WHERE address_id = $1`,
    [accepted.fixture.addressId, "2".repeat(64)]
  );
  await query(
    `UPDATE mbt_customer_site_profiles
        SET site_instructions = 'Later local instruction',
            revision = revision + 1, updated_at = now()
      WHERE site_profile_id = $1`,
    [accepted.fixture.siteProfileId]
  );
  await query(
    "UPDATE mbt_rate_cards SET display_name = 'Later rate card name', revision = revision + 1 WHERE rate_card_id = $1",
    [accepted.fixture.rateCardId]
  );
  await query(
    "UPDATE mbt_service_templates SET display_name = 'Later template name', revision = revision + 1 WHERE template_id = $1",
    [accepted.fixture.templateId]
  );

  const afterEdit = await query(
    `SELECT c.customer_snapshot, c.site_snapshot, c.terms_snapshot,
            c.tax_snapshot, c.pricing_snapshot,
            jsonb_agg(jsonb_build_object(
              'visitId', v.service_visit_id::text,
              'customer', v.customer_snapshot,
              'site', v.site_snapshot,
              'service', v.service_snapshot
            ) ORDER BY v.visit_number) AS visits
       FROM mbt_contracts c
       JOIN mbt_service_visits v ON v.contract_id = c.contract_id
      WHERE c.contract_id = $1
      GROUP BY c.contract_id`,
    [contractId]
  );
  assert.deepEqual(afterEdit.rows, before.rows);

  const timeline = await getFrontdeskContractTimeline({ actor: ACTOR, contractId });
  assert.equal(timeline.schemaVersion, "mbt-frontdesk-contract-v1");
  assert.equal(timeline.contract.customer.displayName, before.rows[0].customer_snapshot.displayName);
  assert.deepEqual(timeline.contract.site, {});
  assert.equal(timeline.serviceLines[0].site.addressLine1, "100 Test Route");
  assert.deepEqual(timeline.visits.map(({ visitId }) => visitId), converted.body.visits.map(({ visitId }) => visitId));
});

test("P3-F14: an extension appends one approved amendment and changes only an unstarted tentative return", async () => {
  const convertFrontdeskQuote = requiredOperation("convertFrontdeskQuote");
  const extendFrontdeskContract = requiredOperation("extendFrontdeskContract");
  const accepted = await createAcceptedQuote("extension");
  const converted = await convertFrontdeskQuote(frontdeskCommand("extension-convert", ACTOR, {
    quoteId: accepted.quoteId,
    expectedRevision: 3
  }));
  const contractId = converted.body.contract.contractId;
  const [delivery, returnVisit] = converted.body.visits;
  const before = await query(
    `SELECT service_visit_id::text AS visit_id, visit_number::int AS visit_number,
            status, scheduled_start_at, scheduled_end_at, revision::int AS revision,
            customer_snapshot, site_snapshot, service_snapshot
       FROM mbt_service_visits
      WHERE contract_id = $1
      ORDER BY visit_number`,
    [contractId]
  );
  const input = frontdeskCommand("extension", ACTOR, {
    contractId,
    expectedRevision: 1,
    returnWindow: {
      startAt: "2037-08-24T12:00:00.000Z",
      endAt: "2037-08-24T16:00:00.000Z"
    }
  });
  const extended = await extendFrontdeskContract(input);
  const replay = await extendFrontdeskContract({ ...input });
  assert.equal(extended.status, 200);
  assert.equal(extended.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, extended.body);
  assert.deepEqual({
    contractId: extended.body.contract.contractId,
    revision: extended.body.contract.revision,
    amendmentType: extended.body.amendment.amendmentType,
    amendmentStatus: extended.body.amendment.status,
    amendmentNumber: extended.body.amendment.amendmentNumber,
    returnVisitId: extended.body.returnVisit.visitId,
    returnRevision: extended.body.returnVisit.revision,
    returnStatus: extended.body.returnVisit.status
  }, {
    contractId,
    revision: 2,
    amendmentType: "extension",
    amendmentStatus: "approved",
    amendmentNumber: 1,
    returnVisitId: returnVisit.visitId,
    returnRevision: 2,
    returnStatus: "tentative"
  });

  const afterExtension = await query(
    `SELECT service_visit_id::text AS visit_id, visit_number::int AS visit_number,
            status, scheduled_start_at, scheduled_end_at, revision::int AS revision,
            customer_snapshot, site_snapshot, service_snapshot
       FROM mbt_service_visits
      WHERE contract_id = $1
      ORDER BY visit_number`,
    [contractId]
  );
  assert.deepEqual(afterExtension.rows[0], before.rows[0]);
  assert.equal(afterExtension.rows[0].visit_id, delivery.visitId);
  assert.deepEqual({
    visitId: afterExtension.rows[1].visit_id,
    revision: afterExtension.rows[1].revision,
    status: afterExtension.rows[1].status,
    scheduledStartAt: afterExtension.rows[1].scheduled_start_at.toISOString(),
    scheduledEndAt: afterExtension.rows[1].scheduled_end_at.toISOString(),
    customerSnapshot: afterExtension.rows[1].customer_snapshot,
    siteSnapshot: afterExtension.rows[1].site_snapshot,
    serviceSnapshot: afterExtension.rows[1].service_snapshot
  }, {
    visitId: returnVisit.visitId,
    revision: 2,
    status: "tentative",
    scheduledStartAt: input.returnWindow.startAt,
    scheduledEndAt: input.returnWindow.endAt,
    customerSnapshot: before.rows[1].customer_snapshot,
    siteSnapshot: before.rows[1].site_snapshot,
    serviceSnapshot: before.rows[1].service_snapshot
  });

  const amendment = await query(
    `SELECT amendment_number::int AS amendment_number, amendment_type, status,
            reason, before_snapshot, after_snapshot, approved_by,
            approved_at IS NOT NULL AS approved
       FROM mbt_contract_amendments
      WHERE contract_id = $1`,
    [contractId]
  );
  assert.equal(amendment.rowCount, 1);
  assert.deepEqual({
    amendmentNumber: amendment.rows[0].amendment_number,
    type: amendment.rows[0].amendment_type,
    status: amendment.rows[0].status,
    approvedBy: amendment.rows[0].approved_by,
    approved: amendment.rows[0].approved,
    beforeVisitId: amendment.rows[0].before_snapshot.returnVisitId,
    afterStartAt: amendment.rows[0].after_snapshot.returnWindow.startAt
  }, {
    amendmentNumber: 1,
    type: "extension",
    status: "approved",
    approvedBy: ACTOR.operatorId,
    approved: true,
    beforeVisitId: returnVisit.visitId,
    afterStartAt: input.returnWindow.startAt
  });

  await assert.rejects(
    () => extendFrontdeskContract(frontdeskCommand("stale-extension", ACTOR, {
      contractId,
      expectedRevision: 1,
      returnWindow: {
        startAt: "2037-08-31T12:00:00.000Z",
        endAt: "2037-08-31T16:00:00.000Z"
      }
    })),
    (error) => isMbtFailure(error, "MBT_STALE_REVISION")
  );
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM mbt_contract_amendments WHERE contract_id = $1",
    [contractId]
  )).rows[0].count, 1);

  await query(
    `UPDATE mbt_service_visits
        SET status = 'completed', actual_started_at = now(),
            actual_completed_at = now(), revision = revision + 1, updated_at = now()
      WHERE service_visit_id = $1`,
    [delivery.visitId]
  );
  await query(
    `UPDATE mbt_service_visits
        SET status = 'in_progress', actual_started_at = now(),
            revision = revision + 1, updated_at = now()
      WHERE service_visit_id = $1`,
    [returnVisit.visitId]
  );
  await assert.rejects(
    () => extendFrontdeskContract(frontdeskCommand("started-extension", ACTOR, {
      contractId,
      expectedRevision: 2,
      returnWindow: {
        startAt: "2037-09-07T12:00:00.000Z",
        endAt: "2037-09-07T16:00:00.000Z"
      }
    })),
    (error) => isMbtFailure(error, "MBT_FRONTDESK_RETURN_STARTED")
  );
  assert.equal((await query(
    "SELECT count(*)::int AS count FROM mbt_contract_amendments WHERE contract_id = $1",
    [contractId]
  )).rows[0].count, 1);
});
