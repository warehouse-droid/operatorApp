/* global window, localStorage */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const artifact = "test-artifacts/receiving-followup";
const publicRoot = path.resolve(process.env.RECEIVING_FOLLOWUP_PUBLIC || "public");
const base = { netsuite_id: "-81664606940713", tranid: "SN1400625", order_type: "purchase_order", vendor: "Receiving test",
  destination_location_id: 1, destination_location: "3445", trandate: "2026-09-17", status_text: "Partially Received" };
const lines = ["PRODUCT-4863", "PRODUCT-1229", "PRODUCT-5022", "PALLET"].map((sku, index) => ({
  id: String(index + 1), line_id: index + 1, item_id: index + 1, sku, item_name: sku, item_type: "InvtPart",
  item_type_text: "Inventory Item", quantity: index === 3 ? 28 : 360, unit: "PC", netsuite_active: true,
  netsuite_received_qty: 0, received_sales_qty: index === 3 ? 0 : 360
}));
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
const coverage = [];
try {
  for (const mode of ["partial", "remaining-only", "all-confirmed", "multiple-missing"]) {
    const visible = mode === "remaining-only" ? [{ ...lines[3], received_sales_qty: 28 }]
      : lines.map((line, index) => ({ ...line, received_sales_qty: mode === "all-confirmed" ? line.quantity
        : mode === "multiple-missing" && index > 0 ? 0 : line.received_sales_qty }));
    const order = { ...base, lines: visible, line_count: visible.length };
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, serviceWorkers: "block" });
    await page.coverage.startJSCoverage();
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost:32189/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/")) {
        if (route.request().method() !== "GET") {writes.push(url.pathname);}
        let value = {};
        if (url.pathname === "/api/auth/me") {value = { operator: { id: "followup-browser", display_name: "Receiving test", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };}
        else if (url.pathname === "/api/delivery/notifications") {value = { total: 0, salesOrder: {}, transferOrder: {}, items: [] };}
        else if (url.pathname === "/api/delivery/current-draft") {value = null;}
        else if (url.pathname === "/api/receiving/orders") {value = [order];}
        else if (url.pathname === `/api/receiving/orders/${order.netsuite_id}`) {value = order;}
        else if (["/api/receiving/vendors", "/api/receiving/sources", "/api/receiving/items"].includes(url.pathname)) {value = [];}
        else if (url.pathname === "/api/operator/netsuite-posting-policy") {value = { effective: true, gateKey: "operator_netsuite_receiving_ir_3445", revision: 1 };}
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
      }
      const file = url.pathname === "/operator" ? "operator.html" : url.pathname.slice(1);
      if (file.startsWith("vendor/")) {return route.fulfill({ contentType: "application/javascript", body: "" });}
      const candidate = path.resolve(publicRoot, file);
      assert.ok(candidate.startsWith(publicRoot + "/"));
      let body;
      try {body = readFileSync(candidate);}
      catch {body = readFileSync(path.resolve("public", file));}
      return route.fulfill({ body, contentType: file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html" });
    });
    await page.addInitScript(({ sessionKey }) => {
      window.EventSource = class { addEventListener() {} close() {} };
      localStorage.setItem("mbbs.staff.token", "followup-browser-token");
      localStorage.setItem("mbbs.operator.token", "followup-browser-token");
      localStorage.setItem("mbbs.operator.locationId", "1");
      localStorage.setItem("mbbs.ui.language", "en");
      localStorage.setItem("mbbs.operator.state", JSON.stringify({ locationId: 1, currentModule: "receiving", accountId: "followup-browser", sessionKey }));
    }, { sessionKey: createHash("sha256").update("followup-browser-token").digest("hex") });
    await page.goto("http://localhost:32189/operator");
    await page.locator("#receivingSearch").fill("SN1400625");
    await expect(page.locator(".receiving-lines .line-card")).toHaveCount(Math.min(3, visible.length));
    await page.locator('[data-action="start-receive"]').click();
    const dialog = page.locator("[data-receiving-partial-confirmation]");
    if (mode === "partial" || mode === "multiple-missing") {
      const missing = mode === "partial" ? 1 : 3;
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`${missing} of 4 lines`);
      await expect(dialog).toContainText("PALLET");
      // Repeated clicks must share the active decision, without advancing to photos.
      await page.locator('[data-action="start-receive"]').evaluate(element => element.click());
      await expect(dialog).toHaveCount(1);
      await expect(page.locator('[data-action="confirm-receive"]')).toHaveCount(0);
      await page.screenshot({ path: `${artifact}/popup-${mode}.png`, fullPage: true });
      await dialog.getByRole("button", { name: "Go back", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".receiving-lines .line-card")).toHaveCount(3);
      assert.deepEqual(writes, []);
      await page.locator('[data-action="start-receive"]').click();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".receiving-lines .line-card")).toHaveCount(3);
      assert.deepEqual(writes, []);
      await page.locator('[data-action="start-receive"]').click();
      await dialog.getByRole("button", { name: "Receive confirmed lines", exact: true }).click();
    } else {
      await expect(dialog).toHaveCount(0);
    }
    await expect(page.locator('[data-action="confirm-receive"]')).toBeVisible();
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    coverage.push(...(await page.coverage.stopJSCoverage()).filter(entry => new URL(entry.url).pathname === "/operator.js"));
    results.push({ mode, visibleLines: visible.length, browserErrors: 0, receiptSubmissions: 0 });
    await page.close();
  }
  const sourceHashes = Object.fromEntries(["operator.js", "operator.html", "service-worker.js", "operator-receiving-confirmation.css"]
    .map(file => [`public/${file}`, createHash("sha256").update(readFileSync(path.join(publicRoot, file))).digest("hex")]));
  const source = readFileSync(path.join(publicRoot, "operator.js"), "utf8");
  const start = source.indexOf("let receivingPartialConfirmation = null;"), end = source.indexOf("async function startReceipt()", start);
  assert.ok(start >= 0 && end > start);
  const covered = (begin, finish) => coverage.some(entry => {
    const ranges = entry.functions.flatMap(fn => fn.ranges)
      .filter(range => range.startOffset <= begin && range.endOffset >= finish)
      .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
    return ranges[0]?.count > 0;
  });
  const missing = [], executed = [];
  let offset = 0;
  for (const [index, line] of source.split("\n").entries()) {
    if ((offset >= start && offset < end || line.includes("if (!await confirmMissingReceivingLines(receivingSelectedOrder))")) && line.trim()) {
      const begin = offset + line.search(/\S/u), finish = offset + line.trimEnd().length;
      if (covered(begin, finish)) {executed.push(index + 1);}
      else {missing.push(index + 1);}
    }
    offset += line.length + 1;
  }
  writeFileSync(`${artifact}/browser-coverage.json`, JSON.stringify({ executed, missing }, null, 2));
  const evidence = { results, sourceHashes, changedLineCoverage: { executed: executed.length, missing } };
  writeFileSync(`${artifact}/browser.json`, JSON.stringify(evidence, null, 2));
  assert.deepEqual(missing, [], "Popup changed lines not executed in browser");
  console.log(JSON.stringify(evidence));
} finally {await browser.close();}
