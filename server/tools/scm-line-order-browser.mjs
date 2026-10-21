import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { projectSmartScmCreatedPo } from "../src/smart-scm-created-po.js";

const directory = "test-artifacts/scm-line-order";
await fs.mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (process.env.SCM_LINE_ORDER_V8_DIRECTORY) await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.setContent('<main class="smart-shell" id="smartScmApp"></main>');
  for (const css of ["dispatch.css", "scm-smart.css", "scm-smart-proposals.css", "scm-smart-vendor.css"]) await page.addStyleTag({ path: `public/${css}` });
  await page.evaluate(() => {
    const lines = [1, 2, 3].map((id) => ({ id, itemId: 100 + id, itemName: `Material ${id}`,
      itemDescription: "Order fixture", destinationLocationId: 1, destinationName: "3445", unit: "EACH", purchaseUnit: "EACH",
      requiredPallets: id, proposedPallets: id, confirmedPallets: id, salesQuantity: id * 10,
      toPlt: 10, palletWeightLbs: 1000, lineWeightLbs: id * 1000, lastPurchasePrice: 5, reason: {} }));
    const proposal = { id: 10, runId: 1, proposalType: "PO", sourceName: "Vendor", destinationLocationId: 1,
      destinationName: "3445", phase: "direct_vendor", vendor: "Vendor", status: "held", totalPallets: 6, totalWeightLbs: 6240,
      utilization: .08, workflowId: 5, canEditVendorReply: true, lines,
      physicalPalletLines: [{ id: "physical-pallet:10:1", itemId: 1784, itemName: "PALLET", ancillaryPallet: true,
        destinationLocationId: 1, destinationName: "3445", quantity: 6, automaticQuantity: 6, unit: "EACH", purchaseUnit: "EACH",
        purchaseQuantity: 6, lastPurchasePrice: 35, itemWeightLbs: 40, lineWeightLbs: 240 }],
      lineOrder: ["line:1", "line:2", "line:3", "pallet:1"] };
    window.record = proposal;
    window.smartState = { plan: { id: 1, proposals: [proposal] }, vendorReplyLoads: [proposal], data: { yards: [] }, busy: "", selectedProposalIds: new Set() };
    window.smartScmApp = document.getElementById("smartScmApp");
    window.smartCanWrite = () => true;
    window.smartEscape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
    window.smartNumber = (value, places = 2) => Number(value ?? 0).toFixed(places);
    window.smartPercent = (value) => `${Math.round(Number(value) * 100)}%`;
    window.smartPill = (status, label) => label || status || "";
    window.smartDate = () => "";
    window.smartCoverageEvidence = () => "";
    window.smartFilteredProposals = () => [];
    window.smartProposalCard = () => "";
    window.smartRender = () => {};
    window.apiCalls = [];
    window.savedOrder = [...proposal.lineOrder];
    window.smartApi = async (url, options) => {
      window.apiCalls.push({ url, options });
      if (window.rejectNext) { window.rejectNext = false; throw new Error("Order changed. Reload and try again."); }
      window.savedOrder = [...options.body.lineOrder];
      return { ...proposal, lineOrder: window.savedOrder };
    };
    window.smartWork = async (_label, fn) => fn();
  });
  for (const name of ["scm-smart-line-order-core.js", "scm-smart-line-order.js", "scm-smart-proposals.js", "scm-smart-vendor.js"]) {
    const baseline = process.env.SCM_LINE_ORDER_BROWSER_BASELINE === "1" && ["scm-smart-proposals.js", "scm-smart-vendor.js"].includes(name);
    await page.addScriptTag({ path: baseline ? `${directory}/baseline/public/${name}` : `public/${name}` });
  }
  await page.evaluate(() => { smartScmApp.innerHTML = smartProposalCard(record); });
  assert.equal(await page.locator("[data-smart-line-drag]").count(), 4, "each material and PALLET has a reorder handle");
  const keys = () => page.locator("tbody [data-smart-line-order-key]").evaluateAll((rows) => rows.map((row) => row.dataset.smartLineOrderKey));
  await page.locator('[data-smart-proposal-line="3"] input[data-smart-proposal-pallets]').fill("9");
  await page.locator('[data-smart-line-order-key="pallet:1"] [data-smart-line-drag]').dragTo(
    page.locator('[data-smart-line-order-key="line:3"] td').first(), { targetPosition: { x: 10, y: 3 } });
  await page.waitForFunction(() => document.querySelector("[data-smart-line-order-message]")?.textContent === "Order saved.");
  assert.deepEqual(await keys(), ["line:1", "line:2", "pallet:1", "line:3"]);
  assert.equal(await page.locator('[data-smart-proposal-line="3"] input[data-smart-proposal-pallets]').inputValue(), "9");
  assert.equal(await page.evaluate(() => apiCalls[0].url), "/api/scm/smart/proposals/10/line-order");
  results.push("native drag saves PALLET third and preserves unsaved inputs");
  await page.screenshot({ path: `${directory}/proposal-pallet-third.png`, fullPage: true });

  await page.evaluate(() => { record.status = "order_requested"; record.lineOrder = savedOrder; smartScmApp.innerHTML = smartVendorLoadCard(record); });
  assert.deepEqual(await keys(), ["line:1", "line:2", "pallet:1", "line:3"]);
  await page.locator('[data-smart-line-order-key="pallet:1"] [data-smart-line-drag]').press("ArrowUp");
  await page.waitForFunction(() => document.querySelector("[data-smart-line-order-message]")?.textContent === "Order saved.");
  assert.deepEqual(await keys(), ["line:1", "pallet:1", "line:2", "line:3"]);
  await page.locator('[data-smart-line-order-key="pallet:1"] [data-smart-line-drag]').press("ArrowDown");
  await page.waitForFunction(() => document.querySelector("[data-smart-line-order-message]")?.textContent === "Order saved.");
  assert.deepEqual(await keys(), ["line:1", "line:2", "pallet:1", "line:3"]);
  assert.deepEqual(await page.locator("[data-smart-line-number]").allTextContents(), ["1", "2", "3", "4"]);
  results.push("Vendor Replies reload and keyboard reordering preserve the same combined order");

  await page.evaluate(() => { rejectNext = true; });
  await page.locator('[data-smart-line-order-key="pallet:1"] [data-smart-line-drag]').press("ArrowUp");
  await page.waitForFunction(() => document.querySelector("[data-smart-line-order-message]")?.textContent.includes("Order changed"));
  assert.deepEqual(await keys(), ["line:1", "line:2", "pallet:1", "line:3"]);
  results.push("failed save restores the visible order and shows the conflict");

  await page.locator('[data-vendor-reply-line="3"] [data-vendor-decision-input]').fill("2");
  await page.evaluate(() => smartReceiveLineOrder({ proposalId: 10, lineOrder: ["line:1", "pallet:1", "line:2", "line:3"] }));
  assert.deepEqual(await keys(), ["line:1", "pallet:1", "line:2", "line:3"]);
  assert.equal(await page.locator('[data-vendor-reply-line="3"] [data-vendor-decision-input]').inputValue(), "2");
  results.push("incoming order events move existing rows without discarding drafts");

  await page.evaluate(() => {
    smartScmApp.innerHTML = smartVendorLoadCard(record) + smartVendorLoadCard({ ...record, id: 20, workflowId: 6 });
  });
  const countBefore = await page.evaluate(() => apiCalls.length);
  await page.locator('article[data-vendor-load="10"] [data-smart-line-order-key="pallet:1"] [data-smart-line-drag]').dragTo(
    page.locator('article[data-vendor-load="20"] [data-smart-line-order-key="line:1"] td').first());
  assert.equal(await page.evaluate(() => apiCalls.length), countBefore);
  results.push("cross-load drop is ignored");

  const synced = projectSmartScmCreatedPo({ lines: [], physicalPalletLines: [] }, { header: { vendor: "Vendor" }, lines: [
    { line_id: 9, item_id: 101, item_name: "Material 1", raw: { line_sequence_number: 1 } },
    { line_id: 1, item_id: 1784, item_name: "PALLET", raw: { line_sequence_number: 3 } },
    { line_id: 2, item_id: 103, item_name: "Material 3", raw: { line_sequence_number: 4 } },
    { line_id: 8, item_id: 102, item_name: "Material 2", raw: { line_sequence_number: 2 } }
  ].map((row) => ({ ...row, location_id: 1, location: "3445", quantity: 6, rate: 5, amount: 30, unit: "EACH", item_weight: 40 })) });
  await page.evaluate((projection) => { smartScmApp.innerHTML = smartVendorLoadCard({ ...record, ...projection, status: "completed", netsuitePurchaseOrderId: 500, canCreatePurchaseOrder: false }); }, synced);
  assert.deepEqual(await page.locator("tbody tr td:first-child strong").allTextContents(), ["Material 1", "Material 2", "PALLET", "Material 3"]);
  assert.equal(await page.locator("[data-smart-line-drag]").count(), 0);
  await page.screenshot({ path: `${directory}/vendor-netsuite-order.png`, fullPage: true });
  results.push("synced NetSuite PO displays PALLET third and prevents local reordering");
  await page.evaluate(() => { record.proposalType = "TO"; record.status = "held"; smartScmApp.innerHTML = smartProposalCard(record); });
  await page.locator('[data-smart-line-order-key="line:1"] [data-smart-line-drag]').press("ArrowDown");
  await page.waitForFunction(() => document.querySelector("[data-smart-line-order-message]")?.textContent === "Order saved.");
  assert.deepEqual(await keys(), ["pallet:1", "line:1", "line:2", "line:3"]);
  results.push("TO proposal supports the same keyboard reorder");
  const eventPage = await browser.newPage();
  eventPage.on("pageerror", (error) => errors.push(error.message));
  await eventPage.setContent('<main id="smartScmApp"></main>');
  if (process.env.SCM_LINE_ORDER_V8_DIRECTORY) await eventPage.coverage.startJSCoverage();
  await eventPage.evaluate(() => {
    window.requireDispatchLogin = () => {};
    window.EventSource = class {
      addEventListener(_type, handler) { window.receiveAppEvent = handler; }
      close() {}
    };
  });
  for (const name of ["scm-smart.js", "scm-smart-line-order-core.js", "scm-smart-line-order.js", "scm-smart-vendor.js", "scm-smart-proposals.js"]) await eventPage.addScriptTag({ path: `public/${name}` });
  const eventRecord = await page.evaluate(() => ({ ...record, proposalType: "PO", status: "order_requested" }));
  await eventPage.evaluate((proposal) => {
    smartState.operator = { role: "scm" };
    smartState.tab = "vendors";
    smartState.vendorReplyLoads = [proposal];
    smartScmApp.innerHTML = smartVendorLoadCard(proposal);
    smartConnectEvents();
  }, eventRecord);
  await eventPage.locator('[data-vendor-reply-line="3"] [data-vendor-decision-input]').fill("2");
  await eventPage.evaluate(() => window.receiveAppEvent({ data: JSON.stringify({ type: "scm.smart.line-order.updated", payload: { proposalId: 10, lineOrder: ["line:1", "line:2", "pallet:1", "line:3"] } }) }));
  assert.deepEqual(await eventPage.locator("tbody [data-smart-line-order-key]").evaluateAll((rows) => rows.map((row) => row.dataset.smartLineOrderKey)), ["line:1", "line:2", "pallet:1", "line:3"]);
  assert.equal(await eventPage.locator('[data-vendor-reply-line="3"] [data-vendor-decision-input]').inputValue(), "2");
  results.push("actual Smart SCM event listener preserves drafts while applying another user's order");
  assert.deepEqual(errors, []);
  if (process.env.SCM_LINE_ORDER_V8_DIRECTORY) {
    const coverage = [...await page.coverage.stopJSCoverage(), ...await eventPage.coverage.stopJSCoverage()];
    const scripts = coverage.filter((entry) => entry.url.startsWith("public/scm-smart"));
    await fs.writeFile(`${directory}/browser-coverage-shape.json`, JSON.stringify(scripts.map((entry) => ({ url: entry.url, keys: Object.keys(entry) })), null, 2));
    assert.ok(scripts.every((entry) => Array.isArray(entry.functions)), "capture Chromium block coverage");
    await fs.writeFile(path.join(process.env.SCM_LINE_ORDER_V8_DIRECTORY, `browser-${Date.now()}.json`), JSON.stringify({
      result: scripts.map((entry, index) => ({ scriptId: `browser-${index}`, functions: entry.functions, url: pathToFileURL(path.resolve(entry.url)).href }))
    }));
  }
  console.log(JSON.stringify({ passed: results.length, checks: results, browserErrors: errors.length }));
} finally {
  await browser.close();
}
