// Replay real repository projections through Chromium; all HTTP is intercepted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { withTransaction, closeDb } from "../src/db.js";
import { getReceivingOrder } from "../src/receiving-repository.js";
import { fixture, parent, child } from "../test/support/receiving-split-balance-fixture.mjs";

let order, split;
try {
  await withTransaction(async () => {
    await fixture();
    order = await getReceivingOrder(parent);
    split = await getReceivingOrder(child);
  }, { rollback: true });
} finally { await closeDb(); }
assert.equal(order.lines.length, 3);
assert.equal(split.lines.length, 14);
const root = path.resolve("public"), token = "receiving-split-browser-fixture";
const errors = [], confirmations = [], unexpected = [];
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, serviceWorkers: "block" });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (url.pathname === "/api/auth/me") body = { operator: { id: "receiving-split-check", display_name: "Receiving check", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
      else if (url.pathname === "/api/delivery/notifications") body = { total: 0, salesOrder: {}, transferOrder: {}, items: [] };
      else if (url.pathname === "/api/delivery/current-draft") body = null;
      else if (url.pathname === "/api/receiving/orders") body = [{ ...order, lines: undefined, line_count: 16 }, { ...split, lines: undefined, line_count: 14 }];
      else if (url.pathname === `/api/receiving/orders/${parent}`) body = order;
      else if (url.pathname === `/api/receiving/orders/${child}`) body = split;
      else if (["/api/receiving/vendors", "/api/receiving/sources", "/api/receiving/items"].includes(url.pathname)) body = [];
      else if (url.pathname === "/api/operator/netsuite-posting-policy") body = { effective: true, revision: 1, gateKey: "operator_netsuite_receiving_ir_3445" };
      if (request.method() !== "GET") {
        if (url.pathname === `/api/receiving/orders/${parent}/lines/confirm-page`) {
          const input = request.postDataJSON();
          confirmations.push(input);
          body = { ok: true, confirmed: input.lines.length, failures: [], order };
        } else unexpected.push(`${request.method()} ${url.pathname}`);
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    }
    const file = url.pathname === "/operator" ? "operator.html" : url.pathname.slice(1);
    if (file.startsWith("vendor/")) return route.fulfill({ contentType: "application/javascript", body: "" });
    const target = path.resolve(root, file);
    assert.ok(target.startsWith(root + path.sep));
    return route.fulfill({ body: readFileSync(target), contentType: file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html" });
  });
  await page.addInitScript(({ token, sessionKey, parent }) => {
    window.EventSource = class { addEventListener() {} close() {} };
    localStorage.setItem("mbbs.staff.token", token);
    localStorage.setItem("mbbs.operator.token", token);
    localStorage.setItem("mbbs.operator.locationId", "1");
    localStorage.setItem("mbbs.ui.language", "en");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({ accountId: "receiving-split-check", sessionKey, locationId: 1,
      currentModule: "receiving", receivingStep: "orders", receivingOrderType: "purchase_order", receivingSelectedId: parent, receivingLinePage: 0 }));
  }, { token, sessionKey: createHash("sha256").update(token).digest("hex"), parent });
  await page.goto("http://localhost:32189/operator");
  await page.locator("#receivingSearch").fill("POB03684");
  const cards = page.locator(".receiving-lines .line-card");
  await expect(cards).toHaveCount(3);
  await expect(page.locator(`[data-receiving-order="${parent}"]`)).toContainText("3 line(s)");
  await expect(cards.locator(".line-info strong")).toHaveText(["OAK-RKT-SG-1272", "OAK-PAV-AB-2424", "OAK-PAV-HL-1224"]);
  await expect(page.locator('[data-action="receiving-line-next"]')).toBeDisabled();
  await cards.nth(2).click();
  await expect(page.locator(".selected-panel .selected-measures .measure").first()).toHaveText(/Open PLT\s*1/);
  await page.locator('[data-action="confirm-receiving-page"]').click();
  await expect(page.locator("#toast")).toContainText("3 line confirmed");
  assert.deepEqual(confirmations[0].lines.map(line => line.lineId), order.lines.map(line => line.id));
  assert.deepEqual(confirmations[0].lines.map(line => line.values.pallets), [1, 1, "1"]);
  mkdirSync("test-artifacts/receiving-split-balance", { recursive: true });
  await page.screenshot({ path: "test-artifacts/receiving-split-balance/operator.png", fullPage: true });
  await page.locator(`[data-receiving-order="${child}"]`).click();
  await expect(page.locator(".detail-header h2")).toHaveText("#11619-1");
  await expect(page.locator(`[data-receiving-order="${child}"]`)).toContainText("14 line(s)");
  const seen = [];
  for (let index = 0; index < 5; index++) {
    const expected = split.lines.slice(index * 3, index * 3 + 3).map(line => line.id);
    await expect(cards).toHaveCount(expected.length);
    assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => element.dataset.line)), expected);
    seen.push(...expected);
    const next = page.locator('[data-action="receiving-line-next"]');
    if (index < 4) await next.click(); else await expect(next).toBeDisabled();
  }
  assert.equal(new Set(seen).size, 14);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ passed: true, parent: order.tranid, parentLines: 3, split: split.tranid,
    splitLines: 14, confirmedPageLineCount: confirmations[0].lines.length, browserErrors: 0,
    liveApiRequests: 0, receiptSubmissions: 0 }));
} finally { await browser.close(); }
