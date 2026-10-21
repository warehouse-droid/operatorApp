/* global window */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { app } from "../../../src/server.js";
import { closeDb, query } from "../../../src/db.js";
import { loginOperator } from "../../../src/auth-repository.js";
import { reopenFixture, state } from "../../support/control-order-reopen-fixture.mjs";

let server, baseUrl;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await closeDb(); });

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(baseUrl + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, payload: await response.json(), cache: response.headers.get("cache-control") };
}

test("real Control API enforces login, roles and manager yards for preview and reset", async () => {
  const f = await reopenFixture();
  const path = `/api/control/operator-orders/${encodeURIComponent(f.ref)}`;
  assert.equal((await request(path + "/reopen-preview")).status, 401);
  const packer = await loginOperator(f.packer.username, f.password);
  for (const [method, suffix] of [["GET", "/reopen-preview"], ["POST", "/reopen"]]) {
    assert.equal((await request(path + suffix, { token: packer.token, method, body: method === "POST" ? {} : undefined })).status, 403);
  }
  const other = await reopenFixture({ yard: 26 });
  const manager = await loginOperator(other.actor.username, other.password);
  assert.equal((await request(path + "/reopen-preview", { token: manager.token })).status, 403);
  assert.equal((await request(path + "/reopen", { token: manager.token, method: "POST", body: {
    requestId: crypto.randomUUID(), reason: "Unauthorized reset", expectedStateHash: "0".repeat(64) } })).status, 403);
  assert.equal((await state(f)).header.operator_status, "packed");
});

test("real HTTP reset retains proof, returns the same retry result and fences stale previews", async () => {
  const f = await reopenFixture();
  const login = await loginOperator(f.actor.username, f.password);
  const path = `/api/control/operator-orders/${encodeURIComponent(f.ref)}`;
  const found = await request(`/api/control/operator-orders?search=${encodeURIComponent(f.ref)}`, { token: login.token });
  assert.equal(found.status, 200);
  assert.equal(found.payload[0].orderRef, f.ref);
  const preview = await request(path + "/reopen-preview", { token: login.token });
  assert.equal(preview.status, 200);
  assert.equal(preview.cache, "no-store");
  const body = { requestId: crypto.randomUUID(), reason: "Correct an imported stale local load.", expectedStateHash: preview.payload.stateHash };
  const reset = await request(path + "/reopen", { token: login.token, method: "POST", body });
  assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  assert.equal(reset.payload.retainedPhotoCount, 2);
  assert.equal((await state(f)).header.operator_status, "open");
  const retry = await request(path + "/reopen", { token: login.token, method: "POST", body });
  assert.deepEqual(retry.payload, reset.payload);
  const stale = await request(path + "/reopen", { token: login.token, method: "POST", body: { ...body, requestId: crypto.randomUUID() } });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.code, "OPERATOR_REOPEN_STALE");
});

test("real browser: manager previews, confirms reset and sees retained images in Operator", async () => {
  const f = await reopenFixture();
  const login = await loginOperator(f.actor.username, f.password);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let page;
  const coverageEntries = [];
  try {
    page = await browser.newPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.addInitScript(token => { window.localStorage.setItem("mbbs.staff.token", token); window.localStorage.setItem("mbbs.control.token", token); }, login.token);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(baseUrl + "/control");
    await page.locator('[data-action="control-section"][data-section="reopen"]').click();
    await page.locator('[data-reopen-search]').fill(f.ref);
    await page.locator('[data-form="operator-order-reopen-search"] button').click();
    await page.locator('[data-reopen-action="preview"]').click();
    await page.locator('[data-reopen-preview]').waitFor();
    assert.match(await page.locator('[data-reopen-preview]').innerText(), /Pat Packer/u);
    assert.match(await page.locator('[data-reopen-preview]').innerText(), /2 existing images/u);
    await page.locator('[data-reopen-reason]').fill("Manager correction before relinking the PO.");
    page.once("dialog", dialog => dialog.accept());
    await page.locator('[data-reopen-action="confirm"]').click();
    await page.locator('[data-operator-order-reopen] [role="status"]').waitFor();
    assert.match(await page.locator('[role="status"]').innerText(), /2 images retained/u);
    assert.equal((await state(f)).header.operator_status, "open");
    coverageEntries.push(...await page.coverage.stopJSCoverage());
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const packer = await loginOperator(f.packer.username, f.password);
    await page.addInitScript(token => window.localStorage.setItem("mbbs.operator.token", token), packer.token);
    // Inspect the real detail API and execute the shipped Operator gallery renderer.
    const detail = await request(`/api/delivery/orders/${f.id}`, { token: packer.token });
    assert.equal(detail.status, 200, JSON.stringify(detail.payload));
    assert.deepEqual(detail.payload.operatorReopen.retainedPhotoReferences, f.photos);
    await page.goto(baseUrl + "/operator");
    await page.locator('[data-action="open-module"][data-module="delivery"]').waitFor();
    const html = await page.evaluate(order => {
      const markup = window.renderDetailPanel(order);
      window.document.getElementById("app").innerHTML = markup;
      return markup;
    }, detail.payload);
    assert.ok(html.includes(f.photos[0]));
    assert.ok(html.includes(f.photos[1]));
    assert.match(html, /2 retained images/u);
    assert.equal(await page.locator('[data-operator-reopen-evidence] [data-action="open-history-photo"]').count(), 2);
    assert.deepEqual(errors, []);
    assert.equal((await query("SELECT id FROM operator_order_reopens WHERE target_ref=$1", [f.ref])).rowCount, 1);
  } finally {
    if (page && process.env.CONTROL_REOPEN_COVERAGE_DIR) {
      const result = [...coverageEntries, ...await page.coverage.stopJSCoverage()].filter(row => new URL(row.url).pathname.endsWith(".js"))
        .map(row => ({ ...row, url: "file://" + resolvePath("public/" + new URL(row.url).pathname.split("/").at(-1)) }));
      writeFileSync(`${process.env.CONTROL_REOPEN_COVERAGE_DIR}/browser-${crypto.randomUUID()}.json`, JSON.stringify({ result }));
    }
    await browser.close();
  }
});

test("browser cancellation and a stale preview preserve the order and explain the retry", async () => {
  const f = await reopenFixture();
  const login = await loginOperator(f.actor.username, f.password);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let page;
  try {
    page = await browser.newPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.addInitScript(token => window.localStorage.setItem("mbbs.staff.token", token), login.token);
    await page.goto(baseUrl + "/control/order-reopen");
    await page.locator('[data-reopen-search]').fill(f.ref);
    await page.locator('[data-form="operator-order-reopen-search"] button').click();
    await page.locator('[data-reopen-action="preview"]').click();
    await page.locator('[data-reopen-action="confirm"]').click();
    assert.match(await page.locator('[role="alert"]').innerText(), /Enter a reason/u);
    await page.locator('[data-reopen-reason]').fill("Correct a stale draft.");
    page.once("dialog", dialog => dialog.dismiss());
    await page.locator('[data-reopen-action="confirm"]').click();
    assert.equal((await state(f)).header.operator_status, "packed");
    await query("UPDATE sales_order_lines SET packed_piece_qty=9 WHERE id=$1", [f.line.id]);
    page.once("dialog", dialog => dialog.accept());
    await page.locator('[data-reopen-action="confirm"]').click();
    await page.locator('[role="alert"]').waitFor();
    assert.match(await page.locator('[role="alert"]').innerText(), /changed.*preview/u);
    assert.equal((await state(f)).header.operator_status, "packed");
    assert.equal((await query("SELECT id FROM operator_order_reopens WHERE target_ref=$1", [f.ref])).rowCount, 0);
  } finally {
    if (page && process.env.CONTROL_REOPEN_COVERAGE_DIR) {
      const result = (await page.coverage.stopJSCoverage()).filter(row => new URL(row.url).pathname.endsWith(".js"))
        .map(row => ({ ...row, url: "file://" + resolvePath("public/" + new URL(row.url).pathname.split("/").at(-1)) }));
      writeFileSync(`${process.env.CONTROL_REOPEN_COVERAGE_DIR}/browser-${crypto.randomUUID()}.json`, JSON.stringify({ result }));
    }
    await browser.close();
  }
});
