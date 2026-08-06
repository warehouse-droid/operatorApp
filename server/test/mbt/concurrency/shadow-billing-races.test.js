// @ts-check

import assert from "node:assert/strict";
import test, { after } from "node:test";

import pg from "pg";

import {
  billingActor,
  billingCalculationCommand,
  createBillingFixture
} from "../support/billing-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 30 });
const SERVICE_PATH = "../../../src/mbt/" + "shadow-billing-service.js";
const serviceModule = /** @type {Record<string, Function>} */ (await import(SERVICE_PATH)
  .catch((importError) => ({ importError })));

/** @param {string} name */
function requiredOperation(name) {
  const operation = serviceModule[name];
  assert.equal(typeof operation, "function", `P3.10 requires shadow-billing-service.${name}.`);
  return operation;
}

async function isolatedFixture() {
  const client = await pool.connect();
  try {
    return await createBillingFixture(client);
  } finally {
    client.release();
  }
}

after(async () => {
  await pool.end();
});

test("P3-F27 25 simultaneous exact calculation retries return one complete draft version", async () => {
  const calculateMbtBillingCase = requiredOperation("calculateMbtBillingCase");
  const fixture = await isolatedFixture();
  const command = billingCalculationCommand(fixture, "race-exact-calculate");
  const results = await Promise.all(Array.from(
    { length: 25 },
    () => calculateMbtBillingCase(structuredClone(command))
  ));

  assert.equal(results.filter((result) => result.replayed === false).length, 1);
  assert.equal(results.filter((result) => result.replayed === true).length, 24);
  assert.equal(new Set(results.map((result) => result.body.billingVersionId)).size, 1);
  assert.ok(results.every((result) => result.body.lines.length === 3));
  const durable = await pool.query(
    `SELECT count(DISTINCT version.billing_version_id)::int AS versions,
            count(line.billing_line_id)::int AS lines,
            count(DISTINCT receipt.receipt_id)::int AS receipts
       FROM mbt_billing_versions version
       JOIN mbt_billing_lines line USING (billing_version_id)
       JOIN mbt_command_receipts receipt
         ON receipt.command_name = 'mbt.billing.calculate'
        AND receipt.entity_id = version.billing_case_id::text
      WHERE version.billing_case_id = $1`,
    [fixture.billingCaseId]
  );
  assert.deepEqual(durable.rows, [{ versions: 1, lines: 3, receipts: 1 }]);
});

test("P3-F27 25 independent calculation competitors have one atomic winner and no partial loser", async () => {
  const calculateMbtBillingCase = requiredOperation("calculateMbtBillingCase");
  const fixture = await isolatedFixture();
  const attempts = await Promise.allSettled(Array.from({ length: 25 }, (_, index) =>
    calculateMbtBillingCase(billingCalculationCommand(fixture, `race-independent-${index}`))
  ));
  const fulfilled = attempts.filter((entry) => entry.status === "fulfilled");
  const rejected = attempts.filter((entry) => entry.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 24);
  assert.ok(rejected.every((entry) => entry.reason?.code === "MBT_STALE_REVISION"));
  const durable = await pool.query(
    `SELECT count(DISTINCT version.billing_version_id)::int AS versions,
            count(line.billing_line_id)::int AS lines,
            max(billing_case.current_version_number)::int AS current_version,
            max(billing_case.revision)::int AS revision
       FROM mbt_billing_cases billing_case
       LEFT JOIN mbt_billing_versions version USING (billing_case_id)
       LEFT JOIN mbt_billing_lines line USING (billing_version_id)
      WHERE billing_case.billing_case_id = $1`,
    [fixture.billingCaseId]
  );
  assert.deepEqual(durable.rows, [{ versions: 1, lines: 3, current_version: 1, revision: 2 }]);
});

test("P3-F27 25 simultaneous exact approvals replay one immutable local decision", async () => {
  const calculateMbtBillingCase = requiredOperation("calculateMbtBillingCase");
  const approveLocalBillingVersion = requiredOperation("approveLocalBillingVersion");
  const fixture = await isolatedFixture();
  const calculated = await calculateMbtBillingCase(billingCalculationCommand(fixture, "race-approve-setup"));
  const command = {
    actor: billingActor("race-exact-approve"),
    billingCaseId: fixture.billingCaseId,
    billingVersionId: calculated.body.billingVersionId,
    expectedRevision: 2,
    reason: "Synthetic exact concurrent local approval",
    idempotencyKey: "p3.10-race-exact-approve",
    correlationId: "p3.10-race-exact-approve-correlation",
    requestId: "p3.10-race-exact-approve-request"
  };
  const results = await Promise.all(Array.from(
    { length: 25 },
    () => approveLocalBillingVersion(structuredClone(command))
  ));
  assert.equal(results.filter((result) => result.replayed === false).length, 1);
  assert.equal(results.filter((result) => result.replayed === true).length, 24);
  assert.equal(new Set(results.map((result) => result.body.billingVersionId)).size, 1);
  assert.ok(results.every((result) => result.body.status === "approved"));
  const durable = await pool.query(
    `SELECT version.status, version.approved_by, billing_case.status AS case_status,
            billing_case.revision::int AS revision,
            count(line.billing_line_id)::int AS lines
       FROM mbt_billing_versions version
       JOIN mbt_billing_cases billing_case USING (billing_case_id)
       JOIN mbt_billing_lines line USING (billing_version_id)
      WHERE version.billing_version_id = $1
      GROUP BY version.billing_version_id, billing_case.billing_case_id`,
    [calculated.body.billingVersionId]
  );
  assert.deepEqual(durable.rows, [{
    status: "approved",
    approved_by: command.actor.operatorId,
    case_status: "approved",
    revision: 3,
    lines: 3
  }]);
});

test("P3-F26 25 concurrent independent MBBS generations return the same deduped cases and allocations", async () => {
  const generateMbbsShadowBilling = requiredOperation("generateMbbsShadowBilling");
  const fixture = await isolatedFixture();
  const base = {
    actor: billingActor("race-mbbs"),
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    rateDistanceBandId: fixture.rateDistanceBandId,
    currency: "CAD",
    loads: [{
      physicalLoadId: `P310-RACE-LOAD-${fixture.fixtureId}`,
      planDate: "2038-02-01",
      completedAt: "2038-02-01T12:00:00.000Z",
      truckId: fixture.truckId,
      driverId: fixture.driverId,
      calculatedMetres: 10_000,
      sharedTotalMinor: 10_001,
      references: [
        { sourceType: "PO", rootReference: `PO-${fixture.fixtureId}` },
        { sourceType: "VRMA", rootReference: `VRMA-${fixture.fixtureId}` }
      ]
    }],
    reason: "Synthetic concurrent MBBS generation",
    correlationId: "p3.10-race-mbbs-correlation",
    requestId: "p3.10-race-mbbs-request"
  };
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) =>
    generateMbbsShadowBilling({
      ...structuredClone(base),
      idempotencyKey: `p3.10-race-mbbs-${index}`
    })
  ));
  const caseIdentitySets = results.map((result) => result.body.cases.map((entry) => entry.crossChargeCaseId).join("|"));
  const allocationIdentitySets = results.map((result) => result.body.allocationGroups.map((entry) => entry.allocationGroupId).join("|"));
  assert.equal(new Set(caseIdentitySets).size, 1);
  assert.equal(new Set(allocationIdentitySets).size, 1);
  const durable = await pool.query(
    `SELECT count(DISTINCT cross_charge_case.cross_charge_case_id)::int AS cases,
            count(DISTINCT version.billing_version_id)::int AS versions,
            count(DISTINCT line.billing_line_id)::int AS lines,
            count(DISTINCT allocation.cross_charge_allocation_id)::int AS allocations,
            sum(DISTINCT allocation.allocated_amount_minor)::int AS allocation_total
       FROM mbt_cross_charge_cases cross_charge_case
       JOIN mbt_billing_cases billing_case USING (cross_charge_case_id)
       JOIN mbt_billing_versions version USING (billing_case_id)
       JOIN mbt_billing_lines line USING (billing_version_id)
       JOIN mbt_cross_charge_allocations allocation USING (cross_charge_case_id)
      WHERE cross_charge_case.physical_load_id = $1`,
    [base.loads[0].physicalLoadId]
  );
  assert.deepEqual(durable.rows, [{
    cases: 2,
    versions: 2,
    lines: 2,
    allocations: 2,
    allocation_total: 10_001
  }]);
});
