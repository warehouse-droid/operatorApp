// Isolated browser replay of SO11663. Every HTTP request is intercepted;
// confirmation clicks update only this in-memory fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const root = path.resolve("public");
const order = JSON.parse(readFileSync("test-artifacts/receiving-deleted-lines/order.json", "utf8"));
const active = order.lines.filter(line => line.netsuite_active);
const deleted = order.lines.filter(line => !line.netsuite_active);
assert.equal(active.length, 10);
assert.equal(deleted.length, 7);
const token = "receiving-display-browser-fixture";
const errors = [], requests = [], unexpected = [];
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, serviceWorkers: "block" });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (url.pathname === "/api/auth/me") body = { operator: { id: "receiving-display-check", display_name: "Receiving check", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
      else if (url.pathname === "/api/delivery/notifications") body = { total: 0, salesOrder: {}, transferOrder: {}, items: [] };
      else if (url.pathname === "/api/delivery/current-draft") body = null;
      else if (url.pathname === "/api/receiving/orders") body = [order];
      else if (url.pathname === `/api/receiving/orders/${order.netsuite_id}`) body = order;
      else if (["/api/receiving/vendors", "/api/receiving/sources", "/api/receiving/items"].includes(url.pathname)) body = [];
      else if (url.pathname === "/api/operator/netsuite-posting-policy") body = { effective: true, revision: 1, gateKey: "operator_netsuite_receiving_ir_3445" };
      if (request.method() !== "GET") {
        if (url.pathname === `/api/receiving/orders/${order.netsuite_id}/lines/confirm-page`) {
          const input = request.postDataJSON();
          requests.push(input);
          body = { ok: true, confirmed: input.lines.length, failures: [], order };
        } else {
          unexpected.push(`${request.method()} ${url.pathname}`);
        }
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    }
    const file = url.pathname === "/operator" ? "operator.html" : url.pathname.slice(1);
    if (file.startsWith("vendor/")) return route.fulfill({ contentType: "application/javascript", body: "" });
    const target = path.resolve(root, file);
    assert.ok(target.startsWith(root + path.sep));
    return route.fulfill({ body: readFileSync(target), contentType: file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html" });
  });
  await page.addInitScript(({ token, sessionKey, id, selected }) => {
    window.EventSource = class { addEventListener() {} close() {} };
    localStorage.setItem("mbbs.staff.token", token);
    localStorage.setItem("mbbs.operator.token", token);
    localStorage.setItem("mbbs.operator.locationId", "1");
    localStorage.setItem("mbbs.ui.language", "en");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({ accountId: "receiving-display-check", sessionKey, locationId: 1,
      currentModule: "receiving", receivingStep: "orders", receivingOrderType: "purchase_order", receivingSelectedId: id,
      receivingSelectedLineId: selected, receivingLinePage: 0 }));
  }, { token, sessionKey: createHash("sha256").update(token).digest("hex"), id: order.netsuite_id, selected: deleted[0].id });
  await page.goto("http://localhost:32189/operator");
  await page.locator("#receivingSearch").fill(order.tranid);
  const cards = page.locator(".receiving-lines .line-card");
  await expect(cards).toHaveCount(3);
  const seen = [];
  for (let index = 0; index < 4; index++) {
    const expected = active.slice(index * 3, index * 3 + 3).map(line => line.id);
    await expect(cards).toHaveCount(expected.length);
    assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => element.dataset.line)), expected);
    seen.push(...expected);
    await page.locator('[data-action="confirm-receiving-page"]').click();
    await expect(page.locator("#toast")).toContainText(`${expected.length} line confirmed`);
    assert.deepEqual(requests[index].lines.map(line => line.lineId), expected);
    const next = page.locator('[data-action="receiving-line-next"]');
    if (index < 3) await next.click();
    else await expect(next).toBeDisabled();
  }
  assert.equal(new Set(seen).size, 10);
  await page.locator('[data-action="start-receive"]').click();
  await expect(page.locator('[data-action="confirm-receive"]')).toBeVisible();
  await expect(page.locator("[data-receiving-partial-confirmation]")).toHaveCount(0);
  await expect(page.locator(".fulfillment-lines > div")).toHaveCount(10);
  for (const line of deleted) assert.ok(!(await page.locator(".fulfillment-lines").innerText()).includes(line.sku));

  // A saved confirmation on a removed line must not enter the receipt summary.
  await page.evaluate(id => {
    receiptOrder.lines.find(line => line.id === id).received_pallet_qty = 1;
    render();
  }, deleted[0].id);
  await expect(page.locator(".fulfillment-lines > div")).toHaveCount(10);

  // A real unconfirmed current line still requires the partial-receipt decision.
  await page.evaluate(id => {
    currentModule = "receiving";
    const line = receivingSelectedOrder.lines.find(item => item.id === id);
    for (const field of ["received_pallet_qty", "received_layer_qty", "received_section_qty", "received_piece_qty", "received_sales_qty"]) line[field] = 0;
    render();
  }, active[0].id);
  await page.locator('[data-action="start-receive"]').click();
  const dialog = page.locator("[data-receiving-partial-confirmation]");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1 of 10 lines");
  await expect(dialog.locator("li")).toHaveText([active[0].sku]);
  await dialog.getByRole("button", { name: "Go back", exact: true }).click();

  // Transit CO lines do not have NetSuite activity flags. Keep these receivable,
  // while either explicit inactive or deleted evidence removes an old line.
  await page.evaluate(template => {
    receivingSelectedOrder = { ...receivingSelectedOrder, order_type: "co_order", lines: [
      { ...template, id: "local-active", sku: "LOCAL-CO", netsuite_active: undefined, sync_exception: undefined },
      { ...template, id: "inactive-only", netsuite_active: false, sync_exception: null },
      { ...template, id: "deleted-only", netsuite_active: true, sync_exception: "line_deleted" },
      { ...template, id: "fully-received", netsuite_active: true, quantity: 0, original_quantity: template.quantity }
    ] };
    receivingLinePage = 0;
    render();
  }, active[0]);
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute("data-line", "local-active");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({passed:true, order:order.tranid, activeLines:10, removedLinesHidden:7, pages:4,
    pageConfirmationLineIds:requests.flatMap(request=>request.lines.map(line=>line.lineId)),
    falseMissingLineWarning:false, genuinePartialWarning:true, staleConfirmedDeletedLineHidden:true,
    transitCoPreserved:true, browserErrors:0, realApiRequests:0, receiptSubmissions:0}));
} finally { await browser.close(); }
