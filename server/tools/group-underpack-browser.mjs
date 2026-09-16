import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, expect } from "@playwright/test";
import { app } from "../src/server.js";
import { createOperator, loginOperator } from "../src/auth-repository.js";
import { query, closeDb } from "../src/db.js";
import { packingGroup } from "../test/support/group-underpack-fixture.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const directory = "test-artifacts/group-underpack-20260915/browser";
mkdirSync(directory, { recursive: true });
let server, browser;
try {
  const username = `rounding-${crypto.randomUUID()}`, password = crypto.randomUUID();
  await createOperator({ username, password, displayName: "Packing rounding test", role: "operator", operatorYardLocationIds: [1] });
  const session = await loginOperator(username, password);
  const replay = JSON.parse(readFileSync("test-artifacts/group-underpack-20260915/replay-input.json", "utf8"));
  const captured = replay.orders.filter(row => ["SOB120124", "SOB120358"].includes(row.tranid));
  assert.equal(captured.length, 2);
  for (const [table, fields, rows] of [["sales_orders", replay.headerFields, captured],
    ["sales_order_lines", replay.lineFields, captured.flatMap(row => row.lines)]]) {
    assert(fields.every(field => /^[a-z_]+$/.test(field)));
    const columns = fields.join(",");
    await query(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`, [JSON.stringify(rows)]);
  }
  await query("UPDATE sales_order_lines SET confirmed=true");
  const orders = captured.map(row => ({ id: row.netsuite_id, ref: row.tranid,
    lineId: row.lines.find(line => line.sku === "UNI-BH60S-0715-MC")?.id }));
  const order = orders.find(row => row.ref === "SOB120124"), pallet = orders.find(row => row.ref === "SOB120358");
  const groupId = await packingGroup([order, pallet]);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.addInitScript(({ token }) => {
    localStorage.setItem("mbbs.staff.token", token);
    localStorage.setItem("mbbs.operator.token", token);
    localStorage.setItem("mbbs.operator.locationId", "1");
    localStorage.setItem("mbbs.ui.language", "en");
    window.EventSource = class { addEventListener() {} close() {} };
  }, { token: session.token });
  await page.goto(`http://127.0.0.1:${server.address().port}/operator`);
  await page.waitForFunction(() => typeof operator !== "undefined" && operator?.id);
  const refresh = () => page.evaluate(async id => {
    currentModule = "delivery"; deliveryPrepMode = "standard"; viewMode = "packed"; deliveryOrderType = "sales_order";
    compactLineMode = true; linePage = 0;
    orders = await api("/api/delivery/orders?locationId=1&status=packed&orderType=sales_order");
    selectedId = id; selectedOrder = await api(`/api/delivery/orders/${encodeURIComponent(id)}`);
    selectedLineId = selectedOrder.lines.find(line => line.sku === "UNI-BH60S-0715-MC").id;
    render();
  }, groupId);
  await refresh();
  const card = page.locator(`[data-order="${groupId}"]`);
  await expect(card.locator(".status-pill")).toHaveText("Packed");
  await expect(card).not.toHaveClass(/underpack/);
  await expect(page.locator(".line-card")).toHaveCount(5);
  await expect(page.locator(".line-card.underpacked")).toHaveCount(0);
  const boundary = await page.evaluate(() => [wholeUnitsFromSalesQty(1.9, 1), wholeUnitsFromSalesQty(1.899999, 1)]);
  assert.deepEqual(boundary, [2, 1]);
  await page.screenshot({ path: `${directory}/packed.png`, fullPage: true });
  await query("UPDATE sales_order_lines SET packed_layer_qty=7 WHERE id=$1", [order.lineId]);
  await refresh();
  await expect(card.locator(".status-pill")).toHaveText("Underpack");
  await expect(card).toHaveClass(/underpack/);
  await expect(page.locator(".line-card.underpacked")).toHaveCount(1);
  await page.screenshot({ path: `${directory}/missing-layer.png`, fullPage: true });
  assert.deepEqual(errors, []);
  const entries = (await page.coverage.stopJSCoverage()).filter(entry => new URL(entry.url).pathname === "/operator.js");
  writeFileSync(`${directory}/coverage.json`, JSON.stringify({ result: entries.map(entry => ({ url: "file:///app/public/operator.js", functions: entry.functions })) }));
  const result = { actualHttpResponses: true, replayedProductionLines: 5, boundary, fullyPackedBadge: "Packed", missingLayerBadge: "Underpack", browserErrors: errors };
  writeFileSync(`${directory}/result.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  if (server) {await new Promise(resolve => server.close(resolve));}
  await closeDb();
}
