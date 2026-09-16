/* global window, localStorage */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const directory = "test-artifacts/operator-receiving-identity";
const order = {
  netsuite_id: "-49090675180799", tranid: "SN1400409", order_type: "purchase_order",
  vendor: "Unilock Ltd", destination_location_id: 1, destination_location: "3445",
  trandate: "2026-09-14", status: "E", status_text: "Pending Billing/Partially Received",
  line_count: 2, lines: [
    { id: "-197653810387700", item_name: "UNI-TV80S-RDM-STORM", sku: "UNI-TV80S-RDM-STORM",
      item_type: "InvtPart", item_type_text: "Inventory Item", quantity: 2284.8, unit: "SQFT",
      pallet_qty: 28, to_plt: 81.6, to_lyr: 11.66, netsuite_received_qty: 0, netsuite_active: true },
    { id: "-148565277608979", item_name: "PALLET", sku: "PALLET", item_type: "InvtPart",
      item_type_text: "Inventory Item", quantity: 28, unit: "EACH", pallet_qty: 0,
      to_plt: 0, to_lyr: 0, to_pcs: 0, netsuite_received_qty: 0, netsuite_active: true }
  ]
};
const api = {
  "/api/auth/me": { operator: { id: "identity-browser", display_name: "Receiving test", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } },
  "/api/delivery/notifications": { total: 0, salesOrder: {}, transferOrder: {}, items: [] },
  "/api/delivery/current-draft": null,
  "/api/receiving/vendors": [], "/api/receiving/sources": [], "/api/receiving/items": []
};

async function serve(route, failed, detail) {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith("/api/")) {
    let value = api[url.pathname];
    let status = 200;
    if (url.pathname === "/api/receiving/orders") { value = [order]; }
    if (url.pathname === `/api/receiving/orders/${order.netsuite_id}`) {
      value = failed ? { error: "Operator record not found." } : detail;
      status = failed ? 404 : 200;
    }
    return route.fulfill({ status: value === undefined ? 404 : status,
      contentType: "application/json", body: JSON.stringify(value ?? {}) });
  }
  const file = url.pathname === "/operator" ? "operator.html" : url.pathname.slice(1);
  if (file.startsWith("vendor/")) { return route.fulfill({ contentType: "application/javascript", body: "" }); }
  const target = path.resolve("public", file);
  assert.ok(target.startsWith(`${path.resolve("public")}/`));
  const contentType = file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
  return route.fulfill({ contentType, body: readFileSync(target) });
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  for (const name of ["before", "after", "allocated-partial"]) {
    const failed = name === "before";
    const detail = name === "allocated-partial" ? { ...order, lines: order.lines.map(line => ({
      ...line, original_quantity: line.quantity, quantity: line.quantity / 2,
      pallet_qty: line.pallet_qty / 2, netsuite_received_qty: line.quantity / 2,
      so_allocated_sales_qty: line.quantity, so_allocated_pallet_qty: line.pallet_qty
    })) } : order;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost:32189/**", route => serve(route, failed, detail));
    await page.addInitScript(({ sessionKey }) => {
      window.EventSource = class { addEventListener() {} close() {} };
      localStorage.setItem("mbbs.staff.token", "test-receiving-browser");
      localStorage.setItem("mbbs.operator.token", "test-receiving-browser");
      localStorage.setItem("mbbs.operator.locationId", "1");
      localStorage.setItem("mbbs.ui.language", "en");
      localStorage.setItem("mbbs.operator.state", JSON.stringify({ locationId: 1, currentModule: "receiving", accountId: "identity-browser", sessionKey }));
    }, { sessionKey: createHash("sha256").update("test-receiving-browser").digest("hex") });
    await page.goto("http://localhost:32189/operator");
    await page.locator("#receivingSearch").fill("SN1400409");
    if (failed) {
      await expect(page.locator("#toast")).toContainText("Operator record not found.");
      await page.locator('[data-action="set-language"][data-language="zh-CN"]').click();
      await page.locator('[data-action="set-language"][data-language="en"]').click();
      await expect(page.locator(`[data-receiving-order="${order.netsuite_id}"]`)).toBeVisible();
      await expect(page.locator(".receiving-lines .line-card")).toHaveCount(0);
    } else {
      await expect(page.locator(`[data-receiving-order="${order.netsuite_id}"]`)).toBeVisible();
      await expect(page.locator(".receiving-lines .line-card")).toHaveCount(2);
      await expect(page.locator(".receiving-lines")).toContainText("UNI-TV80S-RDM-STORM");
      await expect(page.locator(".receiving-lines")).toContainText("PALLET");
      if (name === "allocated-partial") {
        await expect(page.locator('.receiving-lines .line-card').first().locator('.measure').filter({ hasText: "Open PLT" }).locator('b')).toHaveText("14");
        await expect(page.locator('.receiving-lines .line-card').last().locator('.measure').filter({ hasText: "Open EACH" }).locator('b')).toHaveText("14");
      }
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${directory}/receiving-${name}.png`, fullPage: true });
    results.push({ scenario: name, visibleLines: failed ? 0 : 2, browserErrors: errors.length });
    await page.close();
  }
  writeFileSync(`${directory}/browser.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
