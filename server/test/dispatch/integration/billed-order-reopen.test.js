import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { app } from "../../../src/server.js";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { loginOperator } from "../../../src/auth-repository.js";
import { previewOperatorOrderReopen, reopenOperatorOrder } from "../../../src/operator-order-reopen-repository.js";
import { previewScmDependencyMutation } from "../../../src/scm-dependency-preview-service.js";
import { reopenFixture, state, resetInput } from "../../support/control-order-reopen-fixture.mjs";

let server, baseUrl;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await closeDb(); });

async function billedFixture() {
  const f = await reopenFixture({ yard: 26 });
  await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed' WHERE netsuite_id=$1", [f.id]);
  return f;
}

test("browser: Control reopens a billed order and displays retained evidence", async () => {
  const f = await billedFixture();
  const login = await loginOperator(f.actor.username, f.password);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.addInitScript(token => {
      globalThis.localStorage.setItem("mbbs.staff.token", token);
      globalThis.localStorage.setItem("mbbs.control.token", token);
    }, login.token);
    await page.goto(baseUrl + "/control/order-reopen");
    const panel = page.locator("[data-operator-order-reopen]");
    await panel.locator("[data-reopen-search]").fill(f.ref);
    await panel.locator('[data-form="operator-order-reopen-search"] button').click();
    await panel.locator('[data-reopen-action="preview"]').click();
    await panel.locator("[data-reopen-preview]").waitFor();
    await panel.locator("[data-reopen-reason]").fill("Correct incorrectly billed local workflow; preserve the NetSuite record.");
    page.once("dialog", dialog => dialog.accept());
    await panel.locator('[data-reopen-action="confirm"]').click();
    await panel.locator('[role="status"]').waitFor();
    assert.match(await panel.locator('[role="status"]').innerText(), /reopened in Operator.*2 images retained/u);
    assert.equal((await state(f)).header.status, "G");
    assert.equal((await state(f)).header.operator_status, "open");
    await page.screenshot({ path: "test-artifacts/billed-order-reopen-20261015/browser-billed-reopen.png", fullPage: true });
  } finally { await browser.close(); }
});

test("real HTTP: billed order reopens locally, retains NetSuite truth and becomes PO-linkable", async () => {
  const f = await billedFixture();
  const initial = await state(f);
  const command = { action: "link_po", targetRef: f.ref, payload: { poRef: "SN1402415" } };
  assert.equal((await previewScmDependencyMutation(command)).allowed, false);
  const login = await loginOperator(f.actor.username, f.password);
  const headers = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
  const url = baseUrl + `/api/control/operator-orders/${f.ref}`;
  const previewResponse = await fetch(url + "/reopen-preview", { headers });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  const input = { expectedStateHash: preview.stateHash, requestId: crypto.randomUUID(), reason: "NetSuite billed the order incorrectly; goods have not shipped." };
  const response = await fetch(url + "/reopen", { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  const final = await state(f);
  assert.equal(final.header.status, "G");
  assert.equal(final.header.status_text, "Sales Order : Billed");
  assert.equal(final.header.operator_status, "open");
  assert.equal(final.header.fulfillment_status, "not_fulfilled");
  assert.equal(Number(final.lines[0].loaded_qty), 0);
  assert.equal(final.lines[0].quantity, initial.lines[0].quantity);
  assert.deepEqual((await query("SELECT * FROM operator_load_records WHERE id=$1", [f.record.id])).rows[0], f.record);
  assert.equal(result.retainedPhotoCount, 2);
  assert.equal((await previewScmDependencyMutation(command)).allowed, true);
  const retry = await fetch(url + "/reopen", { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), result);
  const audit = (await query("SELECT reason,before_state FROM operator_order_reopens WHERE target_ref=$1", [f.ref])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, input.reason);
  assert.equal(audit[0].before_state[0].header.status, "G");
});

for (const [label, patch] of [
  ["Pending Billing", "status='F',status_text='Sales Order : Pending Billing'"],
  ["fulfillment ID", "last_item_fulfillment_id=123"],
  ["fulfillment timestamp", "fulfilled_at=now()"],
  ["fulfillment status", "fulfillment_status='fulfilled'"],
  ["inactive", "netsuite_active=false"],
  ["closed", "status='H',status_text='Sales Order : Closed'"]
]) {
  test(`${label} still blocks reopening a billed order`, () => withTransaction(async () => {
    const f = await billedFixture();
    await query(`UPDATE sales_orders SET ${patch} WHERE netsuite_id=$1`, [f.id]);
    const initial = await state(f);
    const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
    assert.equal(preview.allowed, false);
    await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview)), { status: 409 });
    assert.deepEqual(await state(f), initial);
  }, { rollback: true }));
}

test("fulfilled line quantities still block a billed order reset", () => withTransaction(async () => {
  const f = await billedFixture();
  await query("UPDATE sales_order_lines SET fulfilled_piece_qty=1 WHERE id=$1", [f.line.id]);
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(preview.allowed, false);
  assert.ok(preview.blockers.some(row => row.code === "OPERATOR_REOPEN_NETSUITE_EVIDENCE"));
}, { rollback: true }));

for (const fulfillmentId of [123, null]) {
  test(`fulfillment record ID=${fulfillmentId}: posted evidence governs billed reopen`, () => withTransaction(async () => {
    const f = await billedFixture();
    await query(`INSERT INTO delivery_fulfillment_records(order_id,item_fulfillment_id,photo_data_url)
      VALUES($1,$2,$3)`, [f.id, fulfillmentId, f.photos[0]]);
    const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
    assert.equal(preview.allowed, fulfillmentId === null, JSON.stringify(preview.blockers));
    if (fulfillmentId) { await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview)), { code: "OPERATOR_REOPEN_NETSUITE_EVIDENCE" }); }
  }, { rollback: true }));
}
