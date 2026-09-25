/* global window, document */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { OPERATOR_NETSUITE_GATE_DEFINITIONS, OPERATOR_NETSUITE_RETURN_GATE_DEFINITIONS } from "../src/operator-netsuite-posting-policy.js";

const folder = "test-artifacts/return-ra-workflow";
mkdirSync(folder, { recursive: true });
const source = readFileSync("public/operator.js", "utf8");
const css = readFileSync("public/operator.css", "utf8");
function extract(text, name) {
  const match = text.match(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(match, name);
  const next = text.slice(match.index + match[0].length).search(/\n(?:async )?function /);
  return text.slice(match.index, next < 0 ? undefined : match.index + match[0].length + next);
}
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [];
try {
  for (const effective of [true, false]) {
    for (const width of [1024, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      await page.setContent(`<style>${css}</style><main id="app"></main>`);
      await page.evaluate(enabled => {
        Object.assign(window, {
          returnMode: "stock", returnType: "normal", returnStage: "review", returnResult: null,
          returnVehiclePlate: "TEST", returnHeaderNote: "", returnBusy: false, returnValidationMessage: "",
          returnPostingPolicies: {}, returnPostingError: "", returnPostingLoading: false, returnPostingGeneration: 0,
          returnPalletQuantity: 2, locationId: 1, returnDraftId: "", calls: [], returnDirty: true,
          returnSelectedRows: () => [{}], returnOrderRef: () => "SOB123", returnCustomerName: () => "Test customer",
          t: (_key, fallback) => fallback, localizeMessage: value => value,
          escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
          renderReturnPhotoWorkspace: () => '<div class="fulfillment-card">Return photos verified</div>',
          renderReturnCustomerSummary: () => "<p>Test customer</p>", renderReturnYardBanner: () => "<p>Yard 3445</p>",
          renderReturnReviewLine: () => "<div>Stock: 1 Each</div>", renderReturnPalletReviewLine: () => "<div>Pallet: 2 Each</div>",
          loadOperatorNetSuitePostingPolicy: key => new Promise(resolve => {
            window.calls.push(key);
            setTimeout(() => resolve({ functionKey: key, locationId: 1, gateKey: key, effective: enabled, revision: 1 }), 100);
          }),
          render: () => { document.getElementById("app").innerHTML = window.returnStage === "success" ? window.renderReturnSuccess() : window.renderReturnReview(); },
          validateReturnForReview: () => "", uploadReturnEvidence: async () => {}, showToast: () => {},
          buildReturnPayload: () => ({ expectedPostingPolicies: window.returnPostingPolicies }),
          api: async (_path, options) => {
            window.sent = JSON.parse(options.body);
            return { batchReference: "RB1", stockReturn: { workflowVersion: 2, reference: "SR1",
              netSuiteSyncStatus: enabled ? "succeeded" : "disabled", netSuiteTransactionRef: enabled ? "RA101" : "" },
              palletReturn: { workflowVersion: 2, reference: "PR1", netSuiteSyncStatus: enabled ? "pending" : "disabled" } };
          }
        });
      }, effective);
      const functions = ["operatorNetSuitePolicyToken", "returnPostingFunctions", "returnPostingReady", "loadReturnPostingPolicies",
        "renderReturnPostingPolicies", "renderReturnReview", "returnNetSuiteResultLabel", "renderReturnSuccess", "submitReturn"];
      await page.addScriptTag({ content: functions.map(name => extract(source, name)).join("\n") });
      await page.evaluate(() => { window.loading = window.loadReturnPostingPolicies(); });
      await page.locator('[data-action="return-confirm-submit"][disabled]').waitFor();
      await page.evaluate(() => window.loading);
      assert.equal(await page.locator('[data-posting-mode]').count(), 2);
      assert.equal(await page.locator(`[data-posting-mode="${effective ? "netsuite" : "local"}"]`).count(), 2);
      assert.equal(await page.locator('[data-action="return-confirm-submit"]').isEnabled(), true);
      const button = await page.locator('[data-action="return-confirm-submit"]').boundingBox();
      assert.ok(button && button.y + button.height <= 844, "Confirm must fit the viewport");
      await page.screenshot({ path: `${folder}/review-${width}-${effective}.png` });
      await page.evaluate(() => window.submitReturn());
      const text = await page.locator("#app").innerText();
      assert.match(text, effective ? /NetSuite RA RA101/ : /Local only/);
      assert.deepEqual(await page.evaluate(() => Object.keys(window.sent.expectedPostingPolicies).sort()), ["pallet_return", "stock_return"]);
      results.push({ effective, width, passed: true });
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(`<style>${readFileSync("public/mbt-shell.css", "utf8")}</style><div id="matrix"></div>`);
  const gates = [...OPERATOR_NETSUITE_GATE_DEFINITIONS, ...OPERATOR_NETSUITE_RETURN_GATE_DEFINITIONS]
    .map(gate => ({ ...gate, gateGroup: "operator_netsuite_posting", configured: false, effective: false, environmentAllowed: true, revision: 1 }));
  await page.evaluate(data => { Object.assign(window, { saving: false, inventory: { gates: data, netSuiteDirectAccessAllowed: true },
    operatorNetSuiteGateMatrix: document.getElementById("matrix") }); }, gates);
  const gateSource = readFileSync("public/mbt-gates.js", "utf8");
  await page.addScriptTag({ content: ["operatorGateCell", "renderOperatorNetSuiteGateMatrix"].map(name => extract(gateSource, name)).join("\n") });
  await page.evaluate(() => window.renderOperatorNetSuiteGateMatrix());
  assert.equal(await page.locator("button[data-gate-toggle]").count(), 20);
  assert.equal(await page.locator('button[data-gate-toggle*="return_ra"]').count(), 8);
  await page.screenshot({ path: `${folder}/gates.png` });
  results.push({ gateMatrix: true, passed: true });
} finally {
  await browser.close();
}
writeFileSync(`${folder}/browser.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
