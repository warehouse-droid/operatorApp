import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serverSource = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");

test("DSR-W1: webhook uses durable enqueue and no in-memory delayed status map", () => {
  assert.doesNotMatch(serverSource, /delayedTransactionStatusRefreshes/);
  assert.doesNotMatch(serverSource, /function scheduleTransactionStatusRefresh/);
  assert.match(serverSource, /await enqueueDelayedStatusRefresh\(\{[\s\S]*?orderType: "sales_order"/);
  assert.match(serverSource, /await enqueueDelayedStatusRefresh\(\{[\s\S]*?orderType: "purchase_order"/);
});

test("DSR-W2: server starts the durable worker without global pending-order polling", () => {
  assert.match(serverSource, /delayedStatusRefreshWorker\.runOnce/);
  const workerSource = fs.readFileSync(
    new URL("../../../src/netsuite-delayed-status-refresh-service.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(workerSource, /listPendingApprovalCandidates|reconcilePendingApprovalOrders/);
  assert.doesNotMatch(workerSource, /setTimeout/);
});
