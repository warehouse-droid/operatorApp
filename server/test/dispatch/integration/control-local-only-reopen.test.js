import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import fc from "fast-check";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { app, loadDispatchOrdersForResponse } from "../../../src/server.js";
import { config } from "../../../src/config.js";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import { loginOperator } from "../../../src/auth-repository.js";
import { previewOperatorOrderReopen, reopenOperatorOrder, searchOperatorReopenOrders } from "../../../src/operator-order-reopen-repository.js";
import { locallyReopenedSalesOrderIds } from "../../../src/local-sales-order-reopen.js";
import { listDeliveryOrders, getDeliveryOrder } from "../../../src/delivery-repository.js";
import { reopenFixture, resetInput, state, seedReopenGroup } from "../../support/control-order-reopen-fixture.mjs";

let server, base;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await closeDb(); });
const rollback = run => withTransaction(run, { rollback: true });

async function fulfilledFixture(status = "F", kind = "sales_order") {
  const f = await reopenFixture({ kind });
  await query(`UPDATE ${f.header} SET status=$2,status_text=$3,fulfillment_status='fulfilled',
    last_item_fulfillment_id=123,last_item_fulfillment_tranid='IF-OLD',fulfilled_at=now() WHERE netsuite_id=$1`,
  [f.id, status, status === "F" ? "Sales Order : Pending Billing" : "Sales Order : Billed"]);
  await query(`UPDATE ${f.table} SET fulfilled_piece_qty=20,fulfilled_pallet_qty=1,fulfilled_layer_qty=1,fulfilled_section_qty=1 WHERE id=$1`, [f.line.id]);
  f.fulfillment = (await query(`INSERT INTO delivery_fulfillment_records(order_id,item_fulfillment_id,photo_data_url)
    VALUES($1,123,$2) RETURNING *`, [f.id, f.photos[0]])).rows[0];
  return f;
}

for (const status of ["F", "G"]) {
  test(`${status}: old IF does not block confirmation and the reopened order is usable locally`, async () => {
    const f = await fulfilledFixture(status);
    const initial = await state(f);
    const login = await loginOperator(f.actor.username, f.password);
    const headers = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
    const path = base + `/api/control/operator-orders/${f.ref}`;
    const previewResponse = await fetch(path + "/reopen-preview", { headers });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
    const input = resetInput(f, preview);
    const response = await fetch(path + "/reopen", { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const final = await state(f);
    assert.equal(final.header.operator_status, "open");
    assert.equal(final.header.local_yard_order_status, "Open");
    assert.equal(final.header.fulfillment_status, "not_fulfilled");
    assert.equal(final.header.last_item_fulfillment_id, null);
    assert.equal(final.header.last_item_fulfillment_tranid, null);
    assert.equal(final.header.fulfilled_at, null);
    assert.equal(final.header.status, initial.header.status);
    assert.equal(final.header.status_text, initial.header.status_text);
    assert.equal(final.lines[0].quantity, initial.lines[0].quantity);
    for (const field of ["fulfilled_pallet_qty", "fulfilled_layer_qty", "fulfilled_section_qty", "fulfilled_piece_qty"]) {
      assert.equal(Number(final.lines[0][field]), 0, field);
    }
    assert.deepEqual((await query("SELECT * FROM delivery_fulfillment_records WHERE id=$1", [f.fulfillment.id])).rows[0], f.fulfillment);
    assert.deepEqual((await query("SELECT * FROM operator_load_records WHERE id=$1", [f.record.id])).rows[0], f.record);
    const correction = (await query("SELECT * FROM operator_order_reopens WHERE id=$1", [result.correctionId])).rows[0];
    assert.equal(correction.before_state[0].header.last_item_fulfillment_id, "123");
    assert.equal(Number(correction.before_state[0].lines[0].fulfilled_piece_qty), 20);
    assert.deepEqual((await getDeliveryOrder(f.id)).operatorReopen.retainedPhotoReferences, f.photos);
    assert.ok((await locallyReopenedSalesOrderIds([f.id])).has(f.id));
    assert.ok((await listDeliveryOrders({ locationId: 1, status: "active", orderType: "sales_order", allowedOperatorYards: [1] })).some(row => row.tranid === f.ref));
    const dispatch = (await loadDispatchOrdersForResponse({ type: "SO" })).find(row => row.id === f.ref);
    assert.ok(dispatch);
    assert.equal(dispatch.localOrderReopened, true);
    assert.equal(dispatch.operatorStatus, "open");
    assert.notEqual(dispatch.dispatchCompletionStatus, "completed");
  });
}

test("search, preview and reset work with NetSuite unavailable even when direct access is enabled", () => rollback(async () => {
  const f = await reopenFixture();
  const original = { enabled: config.netsuite.directAccessEnabled, url: config.netsuite.restBaseUrl, fetch: globalThis.fetch };
  let requests = 0;
  config.netsuite.directAccessEnabled = true;
  config.netsuite.restBaseUrl = "https://offline.invalid/services/rest";
  globalThis.fetch = async () => { requests++; throw new Error("NetSuite must not be contacted by Control reopen"); };
  try {
    assert.equal((await searchOperatorReopenOrders({ search: f.ref, actor: f.actor }))[0].orderRef, f.ref);
    const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
    assert.equal((await reopenOperatorOrder(resetInput(f, preview))).status, "open");
    assert.equal(requests, 0);
  } finally {
    config.netsuite.directAccessEnabled = original.enabled;
    config.netsuite.restBaseUrl = original.url;
    globalThis.fetch = original.fetch;
  }
}));

test("a new fulfillment record makes a preview stale and only captured historical records are superseded", () => rollback(async () => {
  const f = await fulfilledFixture("G");
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  await query("INSERT INTO delivery_fulfillment_records(order_id,item_fulfillment_id,photo_data_url) VALUES($1,124,$2)", [f.id, f.photos[0]]);
  await assert.rejects(() => reopenOperatorOrder(resetInput(f, preview)), { code: "OPERATOR_REOPEN_STALE" });
  const current = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  await reopenOperatorOrder(resetInput(f, current));
  assert.ok((await locallyReopenedSalesOrderIds([f.id])).has(f.id));
  await query("INSERT INTO delivery_fulfillment_records(order_id,item_fulfillment_id,photo_data_url) VALUES($1,125,$2)", [f.id, f.photos[0]]);
  assert.equal((await locallyReopenedSalesOrderIds([f.id])).has(f.id), false);
}));

test("posting a previously unposted historical record ends the local reopen exception", () => rollback(async () => {
  const f = await fulfilledFixture("G");
  await query("UPDATE delivery_fulfillment_records SET item_fulfillment_id=NULL WHERE id=$1", [f.fulfillment.id]);
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  await reopenOperatorOrder(resetInput(f, preview));
  assert.ok((await locallyReopenedSalesOrderIds([f.id])).has(f.id));
  await query("UPDATE delivery_fulfillment_records SET item_fulfillment_id=126 WHERE id=$1", [f.fulfillment.id]);
  assert.equal((await locallyReopenedSalesOrderIds([f.id])).has(f.id), false);
}));

test("an outbound TO with an old IF resets local fulfillment and preserves its history", () => rollback(async () => {
  const f = await fulfilledFixture("F", "transfer_order");
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  await reopenOperatorOrder(resetInput(f, preview));
  const final = await state(f);
  assert.equal(final.header.outbound_operator_status, "open");
  assert.equal(final.header.last_item_fulfillment_id, null);
  assert.equal(Number(final.lines[0].fulfilled_piece_qty), 0);
  assert.deepEqual((await query("SELECT * FROM delivery_fulfillment_records WHERE id=$1", [f.fulfillment.id])).rows[0], f.fulfillment);
}));

test("property: grouped IF corrections reset local quantities and retain exact history through retries", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async amount => rollback(async () => {
    const first = await fulfilledFixture("G"), second = await fulfilledFixture("F");
    const other = await fulfilledFixture("G");
    const ref = `${first.ref}+${second.ref}`;
    await seedReopenGroup(ref, [first.ref, second.ref]);
    await query("UPDATE sales_order_lines SET fulfilled_piece_qty=$2 WHERE sales_order_id=$1", [first.id, amount]);
    const preview = await previewOperatorOrderReopen({ orderRef: ref, actor: first.actor });
    assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
    const input = resetInput(first, preview, { orderRef: ref });
    const result = await reopenOperatorOrder(input);
    assert.deepEqual(await locallyReopenedSalesOrderIds([first.id, second.id, other.id]), new Set([first.id, second.id]));
    await query("UPDATE sales_order_lines SET packed_piece_qty=$2 WHERE sales_order_id=$1", [first.id, amount]);
    assert.deepEqual(await reopenOperatorOrder(input), result);
    assert.equal(Number((await state(first)).lines[0].packed_piece_qty), amount);
    assert.equal(Number((await state(second)).lines[0].fulfilled_piece_qty), 0);
    assert.equal((await query("SELECT * FROM delivery_fulfillment_records WHERE order_id=ANY($1::bigint[])", [[first.id, second.id]])).rowCount, 2);
  })), { numRuns: 8, seed: 20261021 });
});

test("browser: old IF shows Confirm reopen and completes the local reset", async () => {
  const f = await fulfilledFixture("G");
  const login = await loginOperator(f.actor.username, f.password);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.coverage.startJSCoverage();
    await page.addInitScript(token => globalThis.localStorage.setItem("mbbs.staff.token", token), login.token);
    await page.goto(base + "/control/order-reopen");
    const panel = page.locator("[data-operator-order-reopen]");
    await panel.locator("[data-reopen-search]").fill(f.ref);
    await panel.locator('[data-form="operator-order-reopen-search"] button').click();
    await panel.locator('[data-reopen-action="preview"]').click();
    await panel.locator("[data-reopen-preview]").waitFor();
    const confirm = panel.locator('[data-reopen-action="confirm"]');
    assert.equal(await confirm.count(), 1, "The old IF must not hide confirmation");
    assert.equal(await confirm.innerText(), "Confirm reopen");
    await panel.locator("[data-reopen-reason]").fill("IF deleted separately; reopen the local order.");
    page.once("dialog", dialog => dialog.accept());
    await confirm.click();
    await panel.locator('[role="status"]').waitFor();
    assert.match(await panel.locator('[role="status"]').innerText(), /reopened in Operator and Dispatch/u);
    assert.equal((await state(f)).header.operator_status, "open");
    if (process.env.REOPEN_BROWSER_COVERAGE_PATH) {
      writeFileSync(process.env.REOPEN_BROWSER_COVERAGE_PATH, JSON.stringify(await page.coverage.stopJSCoverage()));
    }
  } finally { await browser.close(); }
});
