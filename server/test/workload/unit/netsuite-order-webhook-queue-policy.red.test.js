// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  compareNetSuiteWebhookVersions,
  netSuiteWebhookEntityKey,
  netSuiteWebhookPayloadHash,
  normalizeNetSuiteWebhookEnvelope,
  webhookRetryDelayMs
} from "../../../src/netsuite-order-webhook-queue-policy.js";

test("WL-01 webhook identity and hash are deterministic without retaining the shared secret", () => {
  const payload = {
    recordType: "salesorder",
    id: 441,
    tranid: "SO-PRIVATE",
    eventType: "edit",
    lastModifiedDate: "2026-08-27T16:15:01.000Z",
    secret: "must-not-be-retained",
    lines: [{ line: 1, itemId: 9, quantity: 2 }]
  };
  const envelope = normalizeNetSuiteWebhookEnvelope({ payload, rawBody: JSON.stringify(payload) });
  assert.equal(envelope.entityKey, "sales_order:441");
  assert.equal(envelope.recordType, "sales_order");
  assert.equal(envelope.sourceModifiedAt, "2026-08-27T16:15:01.000Z");
  assert.equal(envelope.payload.secret, undefined);
  assert.equal(netSuiteWebhookEntityKey({ recordType: "SalesOrd", id: "441" }), envelope.entityKey);
  assert.equal(netSuiteWebhookPayloadHash(envelope.payload), netSuiteWebhookPayloadHash({
    lines: [{ quantity: 2, itemId: 9, line: 1 }],
    lastModifiedDate: "2026-08-27T16:15:01.000Z",
    eventType: "edit",
    tranid: "SO-PRIVATE",
    id: 441,
    recordType: "salesorder"
  }));
  assert.doesNotMatch(JSON.stringify(envelope), /must-not-be-retained/u);
});

test("WL-02 webhook versions order by source time and deterministically break ties", () => {
  const older = normalizeNetSuiteWebhookEnvelope({ payload: {
    recordType: "transfer_order", id: 17, eventType: "edit",
    lastModifiedDate: "2026-08-27T16:15:00.000Z", lines: []
  } });
  const newer = normalizeNetSuiteWebhookEnvelope({ payload: {
    recordType: "transfer_order", id: 17, eventType: "edit",
    lastModifiedDate: "2026-08-27T16:15:02.000Z", lines: []
  } });
  assert.equal(compareNetSuiteWebhookVersions(older, newer), -1);
  assert.equal(compareNetSuiteWebhookVersions(newer, older), 1);
  assert.equal(compareNetSuiteWebhookVersions(newer, newer), 0);
});

test("WL-03 malformed identities and impossible source dates fail before durable enqueue", () => {
  assert.throws(() => normalizeNetSuiteWebhookEnvelope({ payload: { recordType: "sales_order" } }), /ID/u);
  assert.throws(() => normalizeNetSuiteWebhookEnvelope({ payload: { recordType: "unknown", id: 1 } }), /record type/u);
  assert.throws(() => normalizeNetSuiteWebhookEnvelope({ payload: {
    recordType: "purchase_order", id: 1, lastModifiedDate: "not-a-date"
  } }), /modification time/u);
});

test("WL-04 retry delay is bounded exponential backoff", () => {
  assert.equal(webhookRetryDelayMs(1), 1_000);
  assert.equal(webhookRetryDelayMs(2), 2_000);
  assert.equal(webhookRetryDelayMs(20), 300_000);
});
