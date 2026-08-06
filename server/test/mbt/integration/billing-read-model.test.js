import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import pg from "pg";

import {
  getLocalBillingCase,
  listLocalBillingCases
} from "../../../src/mbt/shadow-billing-service.js";
import { billingActor, createBillingFixture } from "../support/billing-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let fixture;
let incompleteFixture;

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createBillingFixture(client);
    incompleteFixture = await createBillingFixture(client, { completed: false });
  } finally {
    client.release();
  }
});

test("billing queue exposes only completed/shipped operational work", async () => {
  const queue = await listLocalBillingCases({
    actor: billingActor("eligible-only"),
    caseType: "mbt_contract",
    limit: 100
  });
  assert.equal(queue.items.some(({ billingCaseId }) => billingCaseId === fixture.billingCaseId), true);
  assert.equal(
    queue.items.some(({ billingCaseId }) => billingCaseId === incompleteFixture.billingCaseId),
    false,
    "An open case must remain hidden until its bound service visit is durably completed."
  );
});

after(async () => {
  await pool.end();
});

test("P3-F25 read model exposes the atomically bound visit and immutable visit-distance identity", async () => {
  const actor = billingActor("read-model");
  const detail = await getLocalBillingCase(fixture.billingCaseId, actor);
  assert.equal(detail.billingCaseId, fixture.billingCaseId);
  assert.equal(detail.contractId, fixture.contractId);
  assert.equal(detail.serviceVisitId, fixture.visitId);
  assert.equal(detail.visitDistanceSnapshotId, fixture.distanceSnapshotId);
  assert.equal(detail.postingMode, "local_only");
  assert.deepEqual(detail.versions, []);

  const queue = await listLocalBillingCases({
    actor,
    caseType: "mbt_contract",
    status: "open",
    billingMonth: "2038-01",
    limit: 100
  });
  const item = queue.items.find(({ billingCaseId }) => billingCaseId === fixture.billingCaseId);
  assert.ok(item, "The bound billing case must be present in the server-owned queue.");
  assert.equal(item.serviceVisitId, fixture.visitId);
  assert.equal(item.visitDistanceSnapshotId, fixture.distanceSnapshotId);
  assert.equal(item.completedAt, "2038-01-01T11:00:00.000Z");

  const outsideMonth = await listLocalBillingCases({
    actor,
    caseType: "mbt_contract",
    status: "open",
    billingMonth: "2038-02",
    limit: 100
  });
  assert.equal(outsideMonth.items.some(({ billingCaseId }) => billingCaseId === fixture.billingCaseId), false);
});

test("P3-F27 read model is role-bound and rejects unbounded or unknown queue filters", async () => {
  await assert.rejects(
    () => getLocalBillingCase(fixture.billingCaseId, {
      operatorId: "dispatcher-only",
      roles: ["dispatcher"]
    }),
    (error) => error?.code === "MBT_BILLING_FORBIDDEN"
  );
  await assert.rejects(
    () => listLocalBillingCases({ actor: billingActor("bad-limit"), limit: 101 }),
    (error) => error?.code === "MBT_BILLING_INPUT_INVALID"
  );
  await assert.rejects(
    () => listLocalBillingCases({ actor: billingActor("bad-status"), status: "posting_now" }),
    (error) => error?.code === "MBT_BILLING_INPUT_INVALID"
  );
  await assert.rejects(
    () => listLocalBillingCases({ actor: billingActor("bad-month"), billingMonth: "2038-13" }),
    (error) => error?.code === "MBT_BILLING_INPUT_INVALID"
  );
});
