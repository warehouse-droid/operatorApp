/* global window, document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const folder = "test-artifacts/operator-direct-orderline";
mkdirSync(folder, { recursive: true });
const source = readFileSync("public/operator.js", "utf8");
const css = readFileSync("public/operator.css", "utf8");
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [], coverage = [];

function snippet(name, next) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`async function ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  return "\n".repeat(source.slice(0, start).split("\n").length - 1) + source.slice(start, end);
}

try {
  for (const kind of ["delivery", "pickup", "receiving"]) {
    for (const effective of [true, false]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await page.setContent(`<style>${css}</style><main><p id="status"></p><p id="stage"></p></main>`);
      await page.evaluate(({ mode, enabled }) => {
        const receiving = mode === "receiving", policy = { effective: enabled, gateKey: "test", revision: 1 };
        Object.assign(window, {
          fulfillmentOrder: { netsuite_id: 7, order_type: mode === "delivery" ? "transfer_order" : "sales_order" },
          receiptOrder: { netsuite_id: 8, order_type: "purchase_order" },
          fulfillmentSubmitting: false, receiptSubmitting: false,
          fulfillmentPhotoDataUrls: ["data:image/jpeg;base64,cGhvdG8x", "data:image/jpeg;base64,cGhvdG8y"],
          receiptPhotoDataUrls: ["data:image/jpeg;base64,cGhvdG8x", "data:image/jpeg;base64,cGhvdG8y"],
          fulfillmentNetSuitePolicy: policy, receiptNetSuitePolicy: policy,
          currentModule: mode === "pickup" ? "customer-pickup-load" : "delivery",
          fulfillmentLoadRequestId: "load-id", receiptRequestId: "receipt-id", locationId: 1,
          deliveryOrderType: "transfer_order", receivingOrderType: "purchase_order", receivingSelectedSourceId: null,
          fulfillmentProgressTimer: null, receiptProgressTimer: null, calls: [],
          render: () => {
            document.getElementById("status").textContent = receiving ? window.receiptStatusText : window.fulfillmentStatusText;
            document.getElementById("stage").textContent = receiving ? window.receiptJobStage : window.fulfillmentJobStage;
          },
          showToast: message => window.calls.push({ type: "toast", message }),
          operatorNetSuitePostingIsLocalOnly: () => false, refreshCustomerPickupPhotoRequirement: async () => {},
          fulfillmentRequiredPhotoCount: () => 2, loadOperatorNetSuitePostingPolicy: async () => policy,
          operatorNetSuitePolicyToken: value => value, stopFulfillmentCamera: () => {}, stopReceiptCamera: () => {},
          prepareOperatorBackgroundPhotos: async () => ({ backgroundPhotos: [{ id: "photo-one" }, { id: "photo-two" }] }),
          resumeOperatorBackgroundPhotos: () => {},
          uploadOperatorPhotos: async () => { window.calls.push({ type: "upload" }); return ["r2://one", "r2://two"]; },
          api: async (path, options) => {
            window.calls.push({ type: "post", path, payload: JSON.parse(options.body) });
            await new Promise(resolve => { window.releasePosting = resolve; });
            return { status: "complete", result: { complete: true } };
          }
        });
      }, { mode: kind, enabled: effective });
      const [name, next] = kind === "receiving" ? ["confirmReceipt", "pollReceiptJob"] : ["confirmFulfillment", "pollFulfillmentJob"];
      await page.addScriptTag({ content: `${snippet(name, next)}\n//# sourceURL=http://operator.invalid/public/operator.js?${kind}-${effective}` });
      await page.evaluate(fn => { window.confirming = window[fn](); }, name);
      await page.waitForFunction(() => typeof window.releasePosting === "function");
      const status = await page.locator("#status").textContent();
      const stage = await page.locator("#stage").textContent();
      const calls = await page.evaluate(() => window.calls);
      assert.equal(calls.filter(call => call.type === "upload").length, effective ? 0 : 1);
      assert.equal(calls.filter(call => call.type === "post").length, 1);
      if (effective) { assert.match(status, /NetSuite/u); assert.equal(stage, "Posting to NetSuite"); }
      await page.screenshot({ path: `${folder}/posting-${kind}-${effective}.png` });
      await page.evaluate(async () => { window.releasePosting(); await window.confirming; });
      coverage.push(...await page.coverage.stopJSCoverage());
      results.push({ kind, effective, status, stage, prePostingR2Uploads: calls.filter(call => call.type === "upload").length });
      await page.close();
    }
  }
  const page = await browser.newPage();
  await page.clock.install();
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.addScriptTag({ content: `${snippet("pollOperatorNetSuitePostingJob", "editReloadPacking")}\n//# sourceURL=http://operator.invalid/public/operator.js?poll` });
  await page.evaluate(() => {
    window.pollCalls = 0; window.progress = [];
    window.api = async () => ++window.pollCalls === 18 ? { status: "completed", result: { verified: true } }
      : { status: "posting", steps: [{ status: "pending" }] };
    window.confirming = window.pollOperatorNetSuitePostingJob("job", value => window.progress.push(value));
  });
  await page.clock.runFor(15000);
  assert.equal(await page.evaluate(() => window.pollCalls), 15);
  assert.match(await page.evaluate(() => window.progress.at(-1).message), /taking longer/u);
  await page.clock.runFor(3000);
  assert.equal((await page.evaluate(() => window.confirming)).verified, true);
  coverage.push(...await page.coverage.stopJSCoverage());
  results.push({ delayedPolls: 18, prematureSuccess: false });
  await page.close();
} finally {
  await browser.close();
}

const changes = JSON.parse(readFileSync(`${folder}/changes.json`, "utf8")).find(row => row.file === "public/operator.js");
const lines = changes.changedLines.filter(line => source.split("\n")[line - 1].trim()
  && !/^\s*(?:\/\/|\*|[{};]+\s*$)/u.test(source.split("\n")[line - 1]));
const covered = new Set();
for (const entry of coverage.filter(candidate => candidate.url.includes("/public/operator.js?"))) {
  const sourceLines = entry.source.split("\n");
  let start = 0;
  for (const [index, text] of sourceLines.entries()) {
    const offset = start + text.search(/\S/u);
    const ranges = entry.functions.flatMap(fn => fn.ranges).filter(range => range.startOffset <= offset && range.endOffset > offset)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    if (text.trim() && ranges[0]?.count > 0) { covered.add(index + 1); }
    start += text.length + 1;
  }
}
const changedCoverage = { total: lines.length, covered: lines.filter(line => covered.has(line)).length, missing: lines.filter(line => !covered.has(line)) };
const report = { sourceSha256: createHash("sha256").update(source).digest("hex"), results, changedCoverage };
writeFileSync(`${folder}/browser.json`, JSON.stringify(report, null, 2));
writeFileSync(`${folder}/browser-coverage.json`, JSON.stringify(coverage));
assert.deepEqual(changedCoverage.missing, []);
console.log(JSON.stringify(report));
