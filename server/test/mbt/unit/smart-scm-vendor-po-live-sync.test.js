import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const publicRoot = new URL("../../../public/", import.meta.url);
const smart = fs.readFileSync(new URL("scm-smart.js", publicRoot), "utf8");
const server = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
const historyService = fs.readFileSync(new URL("../../../src/scm-netsuite-po-history-service.js", import.meta.url), "utf8");
const scheduled = fs.readFileSync(new URL("../../../netsuite-order-webhook-scheduled.js", import.meta.url), "utf8");
const direct = fs.readFileSync(new URL("../../../netsuite-order-webhook-user-event-direct.js", import.meta.url), "utf8");

test("both supported NetSuite webhook senders include unit price and amount", () => {
  for (const source of [scheduled, direct]) {
    assert.match(source, /rate:\s*numberValue\(getLineValueSafe\(rec, line, "rate"\)\)/);
    assert.match(source, /amount:\s*numberValue\(getLineValueSafe\(rec, line, "amount"\)\)/);
  }
});

test("the application forwards webhook financials and emits the Vendor Replies refresh event after commit", () => {
  assert.match(server, /\.\.\.netSuiteOrderWebhookLineFinancials\(line\)/);
  assert.match(server, /afterTransactionCommit\(\(\) => emitAppEvent\(poHistory\.event\.name/);
  assert.match(historyService, /name:\s*"scm\.smart\.updated"/);
});

test("an open Vendor Replies tab reloads only its queue when NetSuite publishes a Smart SCM update", () => {
  assert.match(smart, /new EventSource\("\/api\/events\?client=scm-smart"\)/);
  assert.match(smart, /event\?\.type !== "scm\.smart\.updated" \|\| smartState\.tab !== "vendors"/);
  assert.match(smart, /await smartReloadVendorLoads\(\);\s*smartRender\(\);/);
  assert.match(smart, /smartEventSource\?\.close\(\)/);
});
