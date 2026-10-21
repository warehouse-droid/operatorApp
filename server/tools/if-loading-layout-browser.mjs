/* global fulfillmentOrder, selectedOrder, operator, locationId, currentModule, viewMode,
   fulfillmentSubmitting, fulfillmentResult, fulfillmentPhotoDataUrls, fulfillmentCameraActive,
   fulfillmentNetSuitePolicy, fulfillmentNetSuitePolicyError, fulfillmentJobStage,
   fulfillmentStatusText, fulfillmentStartedAt, fulfillmentValidation, consolidationLoadState,
   syncOperatorPhotoCamera, renderFulfillmentScreen */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const label = process.env.IF_LAYOUT_LABEL || "after";
const source = path.resolve(process.env.IF_LAYOUT_SOURCE || ".");
const folder = "test-artifacts/if-loading-layout";
mkdirSync(folder, { recursive: true });
const files = ["public/operator.js", "public/operator.css", "public/operator.html", "public/service-worker.js"];
const hashes = Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(path.join(source, file))).digest("hex")]));
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const rows = [];
const failures = [];
try {
  for (const [width, height] of [[390, 844], [700, 900], [768, 1024], [1024, 768], [1280, 600], [1920, 1080]]) {
    const page = await browser.newPage({ viewport: { width, height }, serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost:32191/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/")) {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ needed: false }) });
      }
      const file = url.pathname === "/operator" ? "public/operator.html" : `public${url.pathname}`;
      const target = path.resolve(source, file);
      assert.ok(target.startsWith(`${source}/public/`));
      const actual = existsSync(target) ? target : path.resolve(file);
      if (!existsSync(actual) || file.includes("/vendor/")) return route.fulfill({ body: "" });
      const contentType = file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      return route.fulfill({ contentType, body: readFileSync(actual) });
    });
    await page.goto("http://localhost:32191/operator");
    try {
      await page.locator('[data-form="login"]').waitFor({ timeout: 10000 });
    } catch (error) {
      await page.screenshot({ path: `${folder}/${label}-boot.png` });
      throw new Error(`Browser boot failed: ${JSON.stringify(errors)}; ${error.message}`);
    }
    // Exercise the real renderer, stylesheet, topbar and summary without camera hardware or external writes.
    await page.evaluate(() => { syncOperatorPhotoCamera = () => {}; });
    for (const state of ["ready", "posting", "attention", "unavailable", "local", "reload", "consolidated"]) {
      await page.evaluate(state => {
        operator = { id: "layout-preview", display_name: "Yard operator", role: "operator", operatorYardLocationIds: [26] };
        locationId = 26;
        currentModule = "customer-pickup-load";
        viewMode = "packed";
        const lines = [
          ["PER-EKO70S-RDM-GN", 62.76, "SQFT"], ["PER-EKO70S-0714-SB", 10.46, "SQFT"],
          ["PALLET", 1, "EACH"], ["Hydra Grout Sponge with long descriptive item name", 1, "EACH"],
          ["150-Dumping-Soil/Asphalt/Concrete", 1, "EACH"]
        ].map(([item_name, quantity, unit], index) => ({
          id: index + 1, item_id: index + 1, item_name, quantity, unit, packed_sales_qty: quantity,
          item_type: index === 4 ? "NonInvtPart" : "InvtPart"
        }));
        fulfillmentOrder = selectedOrder = { netsuite_id: "layout-order", tranid: "SOM06789", order_type: "sales_order", lines };
        fulfillmentResult = null;
        fulfillmentSubmitting = state === "posting";
        fulfillmentPhotoDataUrls = [];
        fulfillmentCameraActive = false;
        fulfillmentValidation = null;
        fulfillmentStartedAt = state === "posting" ? Date.now() - 12000 : 0;
        fulfillmentJobStage = state === "posting" ? "Posting to NetSuite" : "";
        fulfillmentStatusText = state === "posting" ? "Waiting for NetSuite transaction verification..." : "";
        fulfillmentNetSuitePolicy = { gateKey: "preview", revision: 1, effective: state !== "local", transactionType: "IF" };
        fulfillmentNetSuitePolicyError = state === "unavailable"
          ? "Could not load the live NetSuite posting mode. Refresh this screen before completing the order." : "";
        if (state === "posting" || state === "attention") {
          fulfillmentOrder.posting = {
            status: state === "attention" ? "attention" : "posting", loadBlocked: true,
            reason: state === "attention"
              ? "NetSuite transaction verification needs review. This load remains saved while its status is checked."
              : "The previous load is being checked. Check its status before continuing.",
            transactions: [{ ref: "IF123456" }]
          };
        }
        if (state === "reload") {
          fulfillmentOrder.reload_authorized = true;
          fulfillmentOrder.reload_reason = "Re-load the remaining packed items after the truck returned to the yard.";
        }
        if (state === "consolidated") {
          currentModule = "delivery-consolidation-load-proof";
          fulfillmentOrder.is_consolidation_load = true;
          consolidationLoadState.batch = { status: "ready", snapshot: { orders: [fulfillmentOrder] } };
        }
        renderFulfillmentScreen();
      }, state);
      const geometry = await page.evaluate(() => {
        const box = selector => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right };
        };
        const screen = document.querySelector(".fulfillment-form-screen");
        const posting = document.querySelector("[data-load-posting-status]");
        return {
          screen: box(".fulfillment-form-screen"), photo: box(".fulfillment-photo-card"),
          summary: box(".fulfillment-summary-card"), notice: box("[data-load-posting-status]"),
          notices: box(".fulfillment-notices"), actions: box(".fulfillment-form-screen > .selected-actions"),
          disabled: document.querySelector('[data-action="confirm-fulfill"]').disabled,
          postingButtonVisible: !posting || posting.querySelector("button").getBoundingClientRect().height >= 44,
          scrollWidth: screen.scrollWidth, clientWidth: screen.clientWidth,
          summaryRows: document.querySelectorAll(".fulfillment-summary-row, .consolidation-load-summary tbody tr").length
        };
      });
      const violations = [];
      if (geometry.scrollWidth > geometry.clientWidth + 1) violations.push("horizontal overflow");
      if (geometry.summaryRows !== 5) violations.push("missing displayed item");
      if (!geometry.postingButtonVisible) violations.push("status button too small");
      if (["posting", "attention", "unavailable"].includes(state) && !geometry.disabled) violations.push("posting guard changed");
      if (width > 700 && state !== "reload") {
        if (Math.abs(geometry.photo.y - geometry.summary.y) > 1) violations.push("photo and summary no longer share a row");
        const minimumPanelHeight = Math.min(250, height / 3);
        if (geometry.photo.height < minimumPanelHeight || geometry.summary.height < minimumPanelHeight) violations.push("main panels collapsed");
        if (geometry.notice && (geometry.notice.width < geometry.screen.width - 28 || geometry.notice.bottom > geometry.photo.y + 1)) {
          violations.push("notice consumes a panel column");
        }
        if (geometry.actions.bottom > height - 12) violations.push("load actions clipped");
      }
      if (width <= 700 || state === "reload") {
        await page.locator('[data-action="confirm-fulfill"]').scrollIntoViewIfNeeded();
        const button = await page.locator('[data-action="confirm-fulfill"]').boundingBox();
        if (button.y < 0 || button.y + button.height > height - 12) violations.push("load button cannot be reached");
      }
      if (state === "posting") {
        await page.locator(".fulfillment-form-screen").evaluate(node => { node.scrollTop = 0; });
        await page.screenshot({ path: `${folder}/${label}-posting-${width}.png` });
      }
      rows.push({ width, height, state, ...geometry, violations });
      if (violations.length) failures.push({ width, height, state, violations });
    }
    assert.deepEqual(errors, [], "Browser scripts must render without errors");
    await page.close();
  }
} finally {
  await browser.close();
  writeFileSync(`${folder}/${label}.json`, JSON.stringify({ sourceHashes: hashes, scenarios: rows.length, failures, rows }, null, 2) + "\n");
}
console.log(JSON.stringify({ label, scenarios: rows.length, failures }));
if (label !== "before") assert.deepEqual(failures, []);
