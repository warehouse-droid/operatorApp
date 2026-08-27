// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { createOperator } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";
import {
  applySalesOrderReattemptCurrentItemCorrection,
  getSalesOrderReattemptCurrentItemCorrectionPreview
} from "../../../src/sales-order-reattempt-correction-repository.js";
import {
  createSalesOrderReattemptCorrectionFixture
} from "../../support/sales-order-reattempt-correction-fixture.mjs";

const runId = crypto.randomUUID().replaceAll("-", "");
const username = `reattempt-concurrency-${runId}`;
const fixtures = [];
let actor;

function command(fixture, preview, idempotencyKey = crypto.randomUUID()) {
  return {
    orderRef: fixture.childRef,
    idempotencyKey,
    netsuiteLineId: fixture.netsuiteLineId,
    expectedStateFingerprint: preview.lines[0].expectedStateFingerprint,
    reason: "Concurrent physical-current-item verification",
    physicallyDeliveredCurrentItem: true
  };
}

before(async () => {
  actor = await createOperator({
    username,
    displayName: "Re-attempt concurrency Admin",
    password: `correction-${runId}`,
    role: "admin",
    roles: ["admin"]
  });
  fixtures.push(
    await createSalesOrderReattemptCorrectionFixture({ actorId: actor.id, label: "same-key" }),
    await createSalesOrderReattemptCorrectionFixture({ actorId: actor.id, label: "different-key" })
  );
});

after(async () => {
  // Correction rows are deliberately undeletable. The entire isolated database
  // is discarded by the gauntlet after this suite.
  await closeDb();
});

test("concurrent retries with one idempotency key append exactly one correction", async () => {
  const fixture = fixtures[0];
  const preview = await getSalesOrderReattemptCurrentItemCorrectionPreview(fixture.childRef);
  const sharedCommand = command(fixture, preview);
  const results = await Promise.all([
    applySalesOrderReattemptCurrentItemCorrection(sharedCommand, actor),
    applySalesOrderReattemptCurrentItemCorrection(sharedCommand, actor)
  ]);
  assert.deepEqual(results.map((result) => result.idempotent).sort(), [false, true]);
  assert.equal(results[0].correction.correctionId, results[1].correction.correctionId);
  assert.equal(Number((await query(
    "SELECT count(*)::int AS count FROM sales_order_reattempt_item_corrections WHERE reattempt_order_id = $1",
    [fixture.childId]
  )).rows[0].count), 1);
});

test("different concurrent keys cannot append competing corrections from one stale state", async () => {
  const fixture = fixtures[1];
  const preview = await getSalesOrderReattemptCurrentItemCorrectionPreview(fixture.childRef);
  const results = await Promise.allSettled([
    applySalesOrderReattemptCurrentItemCorrection(command(fixture, preview), actor),
    applySalesOrderReattemptCurrentItemCorrection(command(fixture, preview), actor)
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "REATTEMPT_CORRECTION_STALE");
  assert.equal(Number((await query(
    "SELECT count(*)::int AS count FROM sales_order_reattempt_item_corrections WHERE reattempt_order_id = $1",
    [fixture.childId]
  )).rows[0].count), 1);
});
