// @ts-check

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  claimNetSuiteOrderWebhook,
  completeNetSuiteOrderWebhook,
  enqueueNetSuiteOrderWebhook,
  failNetSuiteOrderWebhook,
  getNetSuiteOrderWebhookQueueStatus,
  retryNetSuiteOrderWebhook,
  setNetSuiteOrderWebhookQueuePaused
} from "../../../src/netsuite-order-webhook-queue-repository.js";

const payload = (id, modified, quantity = 1) => ({
  recordType: "sales_order",
  id,
  tranid: `SO-${id}`,
  eventType: "edit",
  lastModifiedDate: modified,
  lines: [{ line: 1, itemId: 91, quantity }]
});

before(async () => {
  await query("SELECT 1");
});

beforeEach(async () => {
  await query("TRUNCATE netsuite_order_webhook_attempts, netsuite_order_webhook_inbox RESTART IDENTITY CASCADE");
  await query("UPDATE netsuite_order_webhook_control SET paused = false, updated_at = now() WHERE singleton = true");
});

after(async () => {
  await closeDb();
});

test("WL-05 exact duplicate enqueue is idempotent and queued payload never retains secret", async () => {
  const body = { ...payload(1, "2026-08-27T15:00:00.000Z"), secret: "do-not-store" };
  const first = await enqueueNetSuiteOrderWebhook({ payload: body, rawBody: JSON.stringify(body) });
  const duplicate = await enqueueNetSuiteOrderWebhook({ payload: body, rawBody: JSON.stringify(body) });
  assert.equal(first.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, first.id);
  const stored = (await query("SELECT payload, raw_body FROM netsuite_order_webhook_inbox WHERE id = $1", [first.id])).rows[0];
  assert.equal(stored.payload.secret, undefined);
  assert.doesNotMatch(stored.raw_body, /do-not-store/u);
});

test("WL-06 newest full entity payload coalesces queued work and stale arrivals never apply", async () => {
  const old = await enqueueNetSuiteOrderWebhook({ payload: payload(2, "2026-08-27T15:00:00.000Z", 1) });
  const newest = await enqueueNetSuiteOrderWebhook({ payload: payload(2, "2026-08-27T15:00:02.000Z", 3) });
  const stale = await enqueueNetSuiteOrderWebhook({ payload: payload(2, "2026-08-27T15:00:01.000Z", 2) });
  assert.equal(newest.coalesced, 1);
  assert.equal(stale.superseded, true);
  const states = await query("SELECT id::text, status FROM netsuite_order_webhook_inbox ORDER BY id");
  assert.deepEqual(states.rows.map((row) => row.status), ["superseded", "queued", "superseded"]);
  const claimed = await claimNetSuiteOrderWebhook({ workerId: "serial-a", leaseMs: 30_000 });
  assert.equal(claimed.id, newest.id);
  assert.equal(claimed.payload.lines[0].quantity, 3);
  await completeNetSuiteOrderWebhook({ id: claimed.id, leaseToken: claimed.leaseToken, result: { ok: true } });
  const lateOld = await enqueueNetSuiteOrderWebhook({ payload: payload(2, "2026-08-27T14:59:59.000Z", 9) });
  assert.equal(lateOld.superseded, true);
});

test("WL-06A a later webhook without a source timestamp must not be discarded by payload-hash order", async () => {
  const oldLocation = {
    recordType: "sales_order",
    id: 9,
    tranid: "SO-9",
    eventType: "edit",
    locationId: "28",
    locationText: "2967",
    lines: [{ line: 1, itemId: 91, quantity: 1, locationId: "28", locationText: "2967" }]
  };
  const currentLocation = {
    ...oldLocation,
    lines: [{ line: 1, itemId: 91, quantity: 11, locationId: "15", locationText: "12441" }]
  };

  const first = await enqueueNetSuiteOrderWebhook({ payload: oldLocation });
  const firstClaim = await claimNetSuiteOrderWebhook({ workerId: "missing-source-time-first", leaseMs: 30_000 });
  assert.equal(firstClaim.id, first.id);
  await completeNetSuiteOrderWebhook({
    id: firstClaim.id,
    leaseToken: firstClaim.leaseToken,
    result: { ok: true }
  });

  const later = await enqueueNetSuiteOrderWebhook({ payload: currentLocation });
  assert.equal(later.superseded, false, "Arrival order must win when NetSuite omits both source timestamps.");
  const currentClaim = await claimNetSuiteOrderWebhook({ workerId: "missing-source-time-current", leaseMs: 30_000 });
  assert.equal(currentClaim.id, later.id);
  assert.equal(currentClaim.payload.lines[0].locationText, "12441");
});

test("WL-06B a later timestamp-free snapshot coalesces older queued work by arrival order", async () => {
  const oldLocation = {
    recordType: "sales_order",
    id: 10,
    tranid: "SO-10",
    eventType: "edit",
    locationId: "28",
    locationText: "2967",
    lines: [{ line: 1, itemId: 91, quantity: 1, locationId: "28", locationText: "2967" }]
  };
  const currentLocation = {
    ...oldLocation,
    lines: [{ line: 1, itemId: 91, quantity: 11, locationId: "15", locationText: "12441" }]
  };

  const first = await enqueueNetSuiteOrderWebhook({ payload: oldLocation });
  const later = await enqueueNetSuiteOrderWebhook({ payload: currentLocation });
  assert.equal(later.superseded, false);
  assert.equal(later.coalesced, 1, "The timestamp-free current snapshot must replace older queued work.");
  const states = await query(
    "SELECT id::text, status FROM netsuite_order_webhook_inbox WHERE id = ANY($1::bigint[]) ORDER BY id",
    [[first.id, later.id]]
  );
  assert.deepEqual(states.rows.map((row) => row.status), ["superseded", "queued"]);
  const claimed = await claimNetSuiteOrderWebhook({ workerId: "missing-source-time-coalesced", leaseMs: 30_000 });
  assert.equal(claimed.id, later.id);
  assert.equal(claimed.payload.lines[0].locationText, "12441");
});

test("WL-07 concurrent claimers receive one row total and a running row permits one newest trailing event", async () => {
  await enqueueNetSuiteOrderWebhook({ payload: payload(3, "2026-08-27T15:00:00.000Z") });
  const [left, right] = await Promise.all([
    claimNetSuiteOrderWebhook({ workerId: "serial-left", leaseMs: 30_000 }),
    claimNetSuiteOrderWebhook({ workerId: "serial-right", leaseMs: 30_000 })
  ]);
  assert.equal([left, right].filter(Boolean).length, 1);
  const running = left || right;
  const trailingA = await enqueueNetSuiteOrderWebhook({ payload: payload(3, "2026-08-27T15:00:01.000Z", 2) });
  const trailingB = await enqueueNetSuiteOrderWebhook({ payload: payload(3, "2026-08-27T15:00:02.000Z", 3) });
  assert.equal(trailingB.coalesced, 1);
  await completeNetSuiteOrderWebhook({ id: running.id, leaseToken: running.leaseToken, result: { ok: true } });
  const next = await claimNetSuiteOrderWebhook({ workerId: "serial-next", leaseMs: 30_000 });
  assert.equal(next.id, trailingB.id);
  assert.equal(next.payload.lines[0].quantity, 3);
  assert.notEqual(next.id, trailingA.id);
});

test("WL-08 failure, retry, pause, and resume are durable and observable", async () => {
  await enqueueNetSuiteOrderWebhook({ payload: payload(4, "2026-08-27T15:00:00.000Z") });
  const claimed = await claimNetSuiteOrderWebhook({ workerId: "serial-fail", leaseMs: 30_000 });
  await failNetSuiteOrderWebhook({ id: claimed.id, leaseToken: claimed.leaseToken, error: new Error("synthetic failure") });
  let status = await getNetSuiteOrderWebhookQueueStatus();
  assert.equal(status.failed, 1);
  await setNetSuiteOrderWebhookQueuePaused({ paused: true, actor: "test" });
  assert.equal(await claimNetSuiteOrderWebhook({ workerId: "paused", leaseMs: 30_000 }), null);
  await retryNetSuiteOrderWebhook({ id: claimed.id, actor: "test" });
  await setNetSuiteOrderWebhookQueuePaused({ paused: false, actor: "test" });
  const retried = await claimNetSuiteOrderWebhook({ workerId: "resumed", leaseMs: 30_000 });
  assert.equal(retried.id, claimed.id);
  status = await getNetSuiteOrderWebhookQueueStatus();
  assert.equal(status.running, 1);
});
