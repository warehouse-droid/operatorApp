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

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const RACE_REPETITIONS = 25;
const ACTOR = Object.freeze({
  operatorId: `p3-frontdesk-race-${RUN_ID}`,
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

/** @param {unknown} error @param {string} code */
function hasConflict(error, code) {
  return error instanceof MbtError && error.status === 409 && error.code === code;
}

/** @param {number} iteration @param {string} label */
async function acceptedQuote(iteration, label) {
  const createFrontdeskQuote = requiredOperation("createFrontdeskQuote");
  const issueFrontdeskQuote = requiredOperation("issueFrontdeskQuote");
  const acceptFrontdeskQuote = requiredOperation("acceptFrontdeskQuote");
  const fixture = await createFrontdeskPrerequisites({ label: `${label}-${iteration}` });
  const draft = await createFrontdeskQuote(quoteCommand(fixture, {
    actor: ACTOR,
    identity: `${RUN_ID}-${label}-${iteration}`
  }), {
    resolveDistance: frontdeskDistanceResolver(fixture),
    resolveTaxPolicy: frontdeskTaxResolver
  });
  const quoteId = draft.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand(`issue-${label}-${iteration}`, ACTOR, {
    quoteId,
    expectedRevision: 1,
    validUntil: "2037-08-04T12:00:00.000Z"
  }));
  await acceptFrontdeskQuote(frontdeskCommand(`accept-${label}-${iteration}`, ACTOR, {
    quoteId,
    expectedRevision: 2,
    acceptedAt: "2037-08-03T10:00:00.000Z"
  }));
  return { fixture, quoteId };
}

async function postingArtifactCounts() {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain) AS chains,
       (SELECT count(*)::int FROM mbt_deposit_records) AS deposits,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
       (SELECT count(*)::int FROM mbt_netsuite_outbox_attempts) AS attempts,
       (SELECT count(*)::int FROM sales_orders) AS ordinary_sales_orders,
       (SELECT count(*)::int FROM dispatch_plans) AS dispatch_plans,
       (SELECT count(*)::int FROM driver_job_records) AS driver_jobs`
  );
  return result.rows[0];
}

after(async () => {
  await closeDb();
});

test("P3-F13: 25 independent two-client conversion races yield one contract, two visits, and one local case", {
  timeout: 180_000
}, async () => {
  const convertFrontdeskQuote = requiredOperation("convertFrontdeskQuote");
  const beforeArtifacts = await postingArtifactCounts();

  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const { quoteId } = await acceptedQuote(iteration, "conversion");
    const inputs = ["left", "right"].map((side) => frontdeskCommand(
      `convert-${iteration}-${side}`,
      ACTOR,
      { quoteId, expectedRevision: 3 }
    ));
    const outcomes = await Promise.allSettled(
      inputs.map((input) => convertFrontdeskQuote(input))
    );
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.ok(hasConflict(losers[0].reason, "MBT_FRONTDESK_QUOTE_STATE_CONFLICT"));

    const evidence = await query(
      `SELECT q.status, q.revision::int AS quote_revision,
              count(DISTINCT c.contract_id)::int AS contracts,
              count(DISTINCT v.service_visit_id)::int AS visits,
              count(DISTINCT b.billing_case_id)::int AS billing_cases,
              count(DISTINCT CASE WHEN v.status = 'ready' THEN v.service_visit_id END)::int AS ready_visits,
              count(DISTINCT CASE WHEN v.status = 'tentative' THEN v.service_visit_id END)::int AS tentative_visits
         FROM mbt_quotes q
         LEFT JOIN mbt_contracts c ON c.quote_id = q.quote_id
         LEFT JOIN mbt_service_visits v ON v.contract_id = c.contract_id
         LEFT JOIN mbt_billing_cases b ON b.contract_id = c.contract_id
        WHERE q.quote_id = $1
        GROUP BY q.quote_id`,
      [quoteId]
    );
    assert.deepEqual(evidence.rows[0], {
      status: "converted",
      quote_revision: 4,
      contracts: 1,
      visits: 2,
      billing_cases: 1,
      ready_visits: 1,
      tentative_visits: 1
    });
  }

  const commands = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = 'mbt.frontdesk.quote.convert') AS receipts,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND action = 'mbt.frontdesk.quote.converted') AS audits`,
    [ACTOR.operatorId]
  );
  assert.deepEqual(commands.rows[0], {
    receipts: RACE_REPETITIONS,
    audits: RACE_REPETITIONS
  });
  assert.deepEqual(await postingArtifactCounts(), beforeArtifacts);
});

test("P3-F14: 25 independent extension races yield one append-only amendment and one stale loser", {
  timeout: 180_000
}, async () => {
  const convertFrontdeskQuote = requiredOperation("convertFrontdeskQuote");
  const extendFrontdeskContract = requiredOperation("extendFrontdeskContract");
  const beforeArtifacts = await postingArtifactCounts();

  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const { quoteId } = await acceptedQuote(iteration, "extension");
    const converted = await convertFrontdeskQuote(frontdeskCommand(
      `extension-convert-${iteration}`,
      ACTOR,
      { quoteId, expectedRevision: 3 }
    ));
    const contractId = converted.body.contract.contractId;
    const [delivery, returnVisit] = converted.body.visits;
    const inputs = ["left", "right"].map((side, index) => frontdeskCommand(
      `extension-${iteration}-${side}`,
      ACTOR,
      {
        contractId,
        expectedRevision: 1,
        returnWindow: {
          startAt: `2037-09-${String((iteration % 20) + 1).padStart(2, "0")}T${index === 0 ? "12" : "13"}:00:00.000Z`,
          endAt: `2037-09-${String((iteration % 20) + 1).padStart(2, "0")}T${index === 0 ? "16" : "17"}:00:00.000Z`
        }
      }
    ));
    const outcomes = await Promise.allSettled(
      inputs.map((input) => extendFrontdeskContract(input))
    );
    const winners = outcomes.filter(({ status }) => status === "fulfilled");
    const losers = outcomes.filter(({ status }) => status === "rejected");
    assert.equal(winners.length, 1, JSON.stringify(outcomes));
    assert.equal(losers.length, 1, JSON.stringify(outcomes));
    assert.ok(hasConflict(losers[0].reason, "MBT_STALE_REVISION"));

    const evidence = await query(
      `SELECT c.revision::int AS contract_revision,
              count(DISTINCT a.amendment_id)::int AS amendments,
              count(DISTINCT CASE WHEN a.status = 'approved' THEN a.amendment_id END)::int AS approved,
              count(DISTINCT v.service_visit_id)::int AS visits,
              max(CASE WHEN v.service_visit_id = $2 THEN v.revision::int END) AS delivery_revision,
              max(CASE WHEN v.service_visit_id = $3 THEN v.revision::int END) AS return_revision,
              max(CASE WHEN v.service_visit_id = $3 THEN v.status END) AS return_status
         FROM mbt_contracts c
         LEFT JOIN mbt_contract_amendments a ON a.contract_id = c.contract_id
         LEFT JOIN mbt_service_visits v ON v.contract_id = c.contract_id
        WHERE c.contract_id = $1
        GROUP BY c.contract_id`,
      [contractId, delivery.visitId, returnVisit.visitId]
    );
    assert.deepEqual(evidence.rows[0], {
      contract_revision: 2,
      amendments: 1,
      approved: 1,
      visits: 2,
      delivery_revision: 1,
      return_revision: 2,
      return_status: "tentative"
    });
  }

  const amendments = await query(
    `SELECT count(*)::int AS count
       FROM mbt_audit_events
      WHERE actor_operator_id = $1
        AND action = 'mbt.frontdesk.contract.extended'`,
    [ACTOR.operatorId]
  );
  assert.equal(amendments.rows[0].count, RACE_REPETITIONS);
  assert.deepEqual(await postingArtifactCounts(), beforeArtifacts);
});
