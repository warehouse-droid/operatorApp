// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  confirmFrontdeskChargeRequest,
  previewFrontdeskChargeRequest
} from "../../../src/mbt/customer-charge-request-service.js";
import { createFrontdeskPrerequisites } from "../support/frontdesk-fixtures.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `customer-charge-race-${RUN_ID}`,
  roles: Object.freeze(["mbt_frontdesk"])
});

after(async () => {
  await closeDb();
});

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

/** @param {string} rateCardVersionId */
async function configureAggregateRate(rateCardVersionId) {
  await query(
    `UPDATE mbt_frontdesk_charge_catalog
        SET active = true, density_lbs_per_yard = 2600,
            revision = revision + 1, updated_by = $1, updated_at = now()
      WHERE item_code = 'AGG_HPB'`,
    [ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_frontdesk_charge_rates (
       charge_rate_id, rate_card_version_id, item_code, amount_minor,
       currency, active, created_by, updated_by
     ) VALUES ($1, $2, 'AGG_HPB', 6500, 'CAD', true, $3, $3)`,
    [crypto.randomUUID(), rateCardVersionId, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_frontdesk_aggregate_distance_bands (
       aggregate_distance_band_id, rate_card_version_id, band_code,
       sequence_number, minimum_metres, maximum_metres, amount_minor,
       currency, active, created_by, updated_by
     ) VALUES ($1, $2, 'AGG_0_30', 1, 0, 30000, 15000,
       'CAD', true, $3, $3)`,
    [crypto.randomUUID(), rateCardVersionId, ACTOR.operatorId]
  );
}

test("customer-charge confirmation race creates exactly one Dispatch Aggregate Order", async () => {
  const fixture = await createFrontdeskPrerequisites({ label: `charge-race-${RUN_ID}` });
  await configureAggregateRate(fixture.rateCardVersionId);
  const preview = await previewFrontdeskChargeRequest(command("charge-race-preview", {
    kind: "aggregate_order",
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    paymentMethod: "card",
    billingAddressText: "100 Billing Avenue, Toronto, ON M1M 1M1",
    serviceAddressText: "200 Service Road, Toronto, ON M2M 2M2",
    contractTelephone: "416-555-0100",
    orderFrom150: true,
    distanceMetres: 12_000,
    aggregateLines: [{ itemCode: "AGG_HPB", quantityYards: "2.500" }]
  }));
  const chargeRequestId = preview.body.request.chargeRequestId;
  const attempts = Array.from({ length: 8 }, (_, index) => confirmFrontdeskChargeRequest(command(
    `charge-race-confirm-${index}`,
    { chargeRequestId, expectedRevision: 1 }
  )));
  const outcomes = await Promise.allSettled(attempts);
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");

  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 7, JSON.stringify(outcomes));
  assert.ok(losers.every((outcome) => (
    outcome.reason instanceof MbtError
      && outcome.reason.status === 409
      && outcome.reason.code === "MBT_STALE_REVISION"
  )));
  const evidence = await query(
    `SELECT request.status, request.revision::int,
            count(DISTINCT dispatch.id)::int AS dispatch_orders,
            count(DISTINCT audit.audit_event_id)::int AS confirmation_audits
       FROM mbt_frontdesk_charge_requests request
       LEFT JOIN dispatch_custom_orders dispatch
         ON dispatch.mbt_charge_request_id = request.charge_request_id
       LEFT JOIN mbt_audit_events audit
         ON audit.entity_id = request.charge_request_id::text
        AND audit.action = 'mbt.frontdesk.charge_request.confirmed'
      WHERE request.charge_request_id = $1::uuid
      GROUP BY request.charge_request_id`,
    [chargeRequestId]
  );
  assert.deepEqual(evidence.rows[0], {
    status: "confirmed",
    revision: 2,
    dispatch_orders: 1,
    confirmation_audits: 1
  });
});
