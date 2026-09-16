import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { config } from "../../../src/config.js";
import { query, closeDb } from "../../../src/db.js";
import { operatorPostingTelemetry } from "../../../src/operator-netsuite-posting-telemetry.js";
import { transformSalesOrderToItemFulfillment, transformTransferOrderToItemFulfillment, transformPurchaseOrderToItemReceipt, transformTransferOrderToItemReceipt, fetchItemReceiptFromNetSuite, fetchItemFulfillmentFromNetSuite, suiteql } from "../../../src/netsuite.js";

const previous = { ...config.netsuite };
const nativeFetch = globalThis.fetch, nativeInfo = console.info;
const events = [];
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  config.netsuite.directAccessEnabled = true;
  config.netsuite.restBaseUrl = "https://netsuite.invalid/services/rest";
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'private-test-token',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
  console.info = (value) => events.push(JSON.parse(value));
});
after(async () => { Object.assign(config.netsuite, previous); globalThis.fetch = nativeFetch; console.info = nativeInfo; await closeDb(); });
const context = (type, stage, work) => operatorPostingTelemetry.context({ commandId: `test-${type}`, transactionType: type, stage }, work);

test("all four IF/IR transforms and receipt/fulfillment reads log actual HTTP body duration", async () => {
  globalThis.fetch = async (input) => {
    assert.equal(new URL(input).hostname, "netsuite.invalid");
    const response = new Response('{"id":123,"private":"private-body"}', { status: 200, headers: { "content-type": "application/json", location: "https://netsuite.invalid/record/v1/itemReceipt/123" } });
    const read = response.text.bind(response);
    response.text = async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return read(); };
    return response;
  };
  for (const [type, call] of [["IF", transformSalesOrderToItemFulfillment], ["IF", transformTransferOrderToItemFulfillment], ["IR", transformPurchaseOrderToItemReceipt], ["IR", transformTransferOrderToItemReceipt]]) {
    const beforeCount = events.length;
    await context(type, "transform", () => call(999, { memo: "private-memo" }));
    const http = events.slice(beforeCount).find((entry) => entry.operation === "netsuite.http");
    assert.ok(http, "Every transform emits its HTTP timing");
    assert.equal(http.method, "POST");
    assert.equal(http.attempt, 1);
    assert.equal(http.status, 200);
    assert.equal(http.commandId, `test-${type}`);
    assert.equal(http.transactionType, type);
    assert.equal(http.stage, "transform");
    assert.ok(http.durationMs >= 15, "Timing includes delayed response body, not just headers");
  }
  await context("IR", "verification", () => fetchItemReceiptFromNetSuite(123));
  await context("IF", "verification", () => fetchItemFulfillmentFromNetSuite(123));
  assert.equal(events.filter((entry) => entry.operation === "netsuite.http" && entry.method === "GET").length, 2);
  assert.doesNotMatch(JSON.stringify(events), /private|expandSubResources/);
});

test("REST and SuiteQL retries record each attempt, HTTP errors, and queue wait", async () => {
  let restCalls = 0, sqlCalls = 0;
  const start = events.length;
  globalThis.fetch = async (input) => {
    const sql = new URL(input).pathname.endsWith("/suiteql");
    const attempt = sql ? ++sqlCalls : ++restCalls;
    return new Response(sql ? '{"items":[],"hasMore":false}' : "{}", {
      status: attempt === 1 ? 429 : 200, headers: { "content-type": "application/json", "retry-after": "0.001" }
    });
  };
  await context("IR", "transform", () => transformPurchaseOrderToItemReceipt(999, {}));
  await context("IF", "duplicate_check", () => suiteql("SELECT private_value FROM private_table"));
  const http = events.slice(start).filter((entry) => entry.operation === "netsuite.http");
  assert.deepEqual(http.map((entry) => [entry.attempt, entry.status]), [[1, 429], [2, 200], [1, 429], [2, 200]]);
  assert.equal(http[0].outcome, "error");
  assert.ok(events.slice(start).some((entry) => entry.operation === "netsuite.queue"));
  assert.doesNotMatch(JSON.stringify(events), /private/);
  globalThis.fetch = async () => { throw Object.assign(new Error("private-secret"), { code: "ECONNRESET" }); };
  await assert.rejects(context("IR", "verification", () => fetchItemReceiptFromNetSuite(123)), { code: "ECONNRESET" });
  assert.equal(events.at(-1).errorCode, "ECONNRESET");
  globalThis.fetch = async () => new Response("private body", { status: 400 });
  await assert.rejects(context("IR", "source_validation", () => suiteql("SELECT private_value")), /SuiteQL failed: 400/);
  assert.equal(events.at(-1).status, 400);
  assert.equal(events.at(-1).outcome, "error");
  assert.doesNotMatch(JSON.stringify(events), /private/);
});

test("simultaneous IF/IR requests keep queue and HTTP timings attached to their command", async () => {
  const start = events.length;
  globalThis.fetch = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return new Response("{}", { status: 200 }); };
  await Promise.all([
    context("IF", "transform", () => transformSalesOrderToItemFulfillment(999, {})),
    context("IR", "transform", () => transformPurchaseOrderToItemReceipt(999, {}))
  ]);
  const entries = events.slice(start);
  assert.ok(entries.find((entry) => entry.operation === "netsuite.queue" && entry.commandId === "test-IR").durationMs >= 20);
  for (const entry of entries) { assert.equal(entry.commandId, `test-${entry.transactionType}`); }
});
