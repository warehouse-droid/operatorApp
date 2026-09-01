// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { createNetSuiteOrderWebhookWorker } from "../../../src/netsuite-order-webhook-worker-service.js";

test("WL-23 worker is single-flight and completes one claimed payload at a time", async () => {
  const jobs = [{ id: "1", leaseToken: "test-lease-1" }, { id: "2", leaseToken: "test-lease-2" }];
  let active = 0;
  let maximumActive = 0;
  const completed = [];
  const worker = createNetSuiteOrderWebhookWorker({
    claim: async () => jobs.shift() || null,
    process: async (job) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { id: job.id };
    },
    complete: async (input) => completed.push(input.id),
    fail: async () => assert.fail("successful work must not fail"),
    renew: async () => true,
    heartbeatMs: 50
  });
  const [first, duplicateTick] = await Promise.all([worker.tick(), worker.tick()]);
  assert.equal([first, duplicateTick].filter((result) => result.processed).length, 1);
  await worker.tick();
  assert.equal(maximumActive, 1);
  assert.deepEqual(completed, ["1", "2"]);
});

test("WL-24 worker records a failed lease and continues on the next tick", async () => {
  const jobs = [{ id: "bad", leaseToken: "test-lease-bad" }, { id: "good", leaseToken: "test-lease-good" }];
  const failed = [];
  const completed = [];
  const worker = createNetSuiteOrderWebhookWorker({
    claim: async () => jobs.shift() || null,
    process: async (job) => {
      if (job.id === "bad") throw new Error("synthetic failure");
      return { ok: true };
    },
    complete: async (input) => completed.push(input.id),
    fail: async (input) => failed.push([input.id, input.error.message]),
    renew: async () => true
  });
  const bad = await worker.tick();
  const good = await worker.tick();
  assert.equal(bad.failed, true);
  assert.equal(good.processed, true);
  assert.deepEqual(failed, [["bad", "synthetic failure"]]);
  assert.deepEqual(completed, ["good"]);
});

test("WL-25 an atomic processor may commit the lease with application work", async () => {
  let completedOutsideTransaction = false;
  const worker = createNetSuiteOrderWebhookWorker({
    claim: async () => ({ id: "atomic", leaseToken: "test-lease-atomic" }),
    process: async () => ({ ok: true }),
    complete: async () => { completedOutsideTransaction = true; },
    fail: async () => assert.fail("atomic success must not fail"),
    completeInProcess: true
  });
  const result = await worker.tick();
  assert.equal(result.processed, true);
  assert.equal(completedOutsideTransaction, false);
});
