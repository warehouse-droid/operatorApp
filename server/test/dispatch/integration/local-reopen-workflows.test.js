import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { app, loadDispatchOrdersForResponse } from "../../../src/server.js";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { loginOperator } from "../../../src/auth-repository.js";
import { previewOperatorOrderReopen, reopenOperatorOrder } from "../../../src/operator-order-reopen-repository.js";
import { listDeliveryOrders, findCustomerPickupOrder, saveDeliveryOrderForOperator, listSavedDeliveryOrdersForOperator, listSavedDeliveryOrderKeysForOperator } from "../../../src/delivery-repository.js";
import { isBilledSalesOrderIdentifier, listBilledSalesOrderFamilyRefs, reconcileSalesOrderFromNetSuite } from "../../../src/sales-order-reconciliation-repository.js";
import { overlayFulfilledSalesDeliveryPlanning } from "../../../src/dispatch-fulfilled-so-repository.js";
import { scrubBilledSalesOrderFamiliesFromPlan } from "../../../src/dispatch-plan-repository.js";
import { reopenFixture, state, resetInput, seedReopenGroup } from "../../support/control-order-reopen-fixture.mjs";

let server, base;
before(async () => { server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise(resolve => server.close(resolve)); await closeDb(); });
async function fixture(method = "Delivery") {
  const f = await reopenFixture();
  await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed',sales_order_type=$2 WHERE netsuite_id=$1", [f.id, method]);
  return f;
}
async function reopen(f) {
  const preview = await previewOperatorOrderReopen({ orderRef: f.ref, actor: f.actor });
  assert.equal(preview.allowed, true, JSON.stringify(preview.blockers));
  return reopenOperatorOrder(resetInput(f, preview));
}
const remote = f => ({ kind: "SO", id: Number(f.id), tranid: f.ref, status: "G", statusText: "Sales Order : Billed",
  lines: [{ sourceLineKey: "1", itemId: Number(f.line.item_id), itemName: "Reopen Material", itemType: "InvtPart", quantity: 20, unit: "PC", cumulativeProgressQuantity: 0 }] });

test("real HTTP: audited billed reopen restores Operator detail, active pool and preparation", async () => {
  const f = await fixture();
  const login = await loginOperator(f.packer.username, f.password);
  const headers = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
  const url = `${base}/api/delivery/orders/${f.id}?locationId=1`;
  assert.equal((await fetch(url, { headers })).status, 404);
  await reopen(f);
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).operator_status, "open");
  const pool = await listDeliveryOrders({ locationId: 1, status: "active", orderType: "sales_order", allowedOperatorYards: [1] });
  assert.ok(pool.some(row => row.tranid === f.ref), "Reopened Billed order is available in Operator's active pool");
  const prepare = await fetch(`${base}/api/delivery/orders/${f.id}/status?locationId=1`, { method: "POST", headers, body: JSON.stringify({ status: "preparing" }) });
  assert.equal(prepare.status, 200, await prepare.clone().text());
  assert.equal((await state(f)).header.operator_status, "preparing");
  assert.equal((await state(f)).header.status, "G");
});

test("customer pickup lookup and API honor an audited local reopen", async () => {
  const f = await fixture("Pick-Up");
  assert.equal(await findCustomerPickupOrder(f.ref, { locationId: 1 }), null);
  await reopen(f);
  assert.equal(String(await findCustomerPickupOrder(f.ref, { locationId: 1 })), f.id);
  const login = await loginOperator(f.packer.username, f.password);
  const response = await fetch(`${base}/api/customer-pickup/orders/${f.id}?locationId=1`, { headers: { authorization: `Bearer ${login.token}` } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).operator_status, "open");
});

test("Dispatch's default pool and stale plan become locally open after audited reopen", () => withTransaction(async () => {
  const f = await fixture();
  await reopen(f);
  const order = (await loadDispatchOrdersForResponse({ type: "SO" })).find(row => row.id === f.ref);
  assert.ok(order, "Reopened order must be in the default pool without a historical search");
  assert.equal(order.localOrderReopened, true);
  assert.equal(order.operatorStatus, "open");
  assert.notEqual(order.dispatchCompletionStatus, "completed");
  assert.notEqual(order.scm?.status, "Completed");
  assert.equal(order.netsuiteStatusText, "Sales Order : Billed");
  const [refreshed] = await overlayFulfilledSalesDeliveryPlanning([{ ...order, operatorStatus: "loaded", localYardOrderStatus: "Loaded", dispatchCompletionStatus: "completed", scm: { status: "Completed" } }], { preserveUnchanged: true });
  assert.equal(refreshed.operatorStatus, "open");
  assert.notEqual(refreshed.dispatchCompletionStatus, "completed");
  const plan = await scrubBilledSalesOrderFamiliesFromPlan({ orders: [refreshed], trucks: [] });
  assert.ok(plan.orders.some(row => row.id === f.ref));
}, { rollback: true }));

test("saved Operator work survives a Billed reconciliation with no fulfillment", () => withTransaction(async () => {
  const f = await fixture();
  await reopen(f);
  await saveDeliveryOrderForOperator(f.packer.id, { locationId: 1, orderId: f.id });
  const initial = await state(f);
  const result = await reconcileSalesOrderFromNetSuite({ order: remote(f), dryRun: false, source: "local-reopen-test" });
  assert.equal(result.billed, true, "NetSuite billing remains a fact");
  assert.equal(result.calculatedApplicationStatus, "Queued");
  assert.equal(result.fulfilledByHeader, false);
  const saved = await listSavedDeliveryOrdersForOperator(f.packer.id, { locationId: 1, allowedOperatorYards: [1] });
  assert.ok(saved.some(row => row.tranid === f.ref));
  assert.ok((await listSavedDeliveryOrderKeysForOperator(f.packer.id, { locationId: 1, allowedOperatorYards: [1] })).includes(f.id));
  assert.deepEqual(await state(f), initial);
}, { rollback: true }));

test("a plain Open header cannot replace the required audited local reopen", () => withTransaction(async () => {
  const f = await fixture();
  await query("UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open' WHERE netsuite_id=$1", [f.id]);
  await query("UPDATE sales_order_lines SET loaded_qty=0 WHERE sales_order_id=$1", [f.id]);
  assert.equal(await isBilledSalesOrderIdentifier(f.id), true);
  const [forged] = await overlayFulfilledSalesDeliveryPlanning([{ id: f.ref, type: "SO", localOrderReopened: true }]);
  assert.equal(forged.localOrderReopened, false);
  await reopen(f);
  assert.equal(await isBilledSalesOrderIdentifier(f.id), false);
  assert.equal((await listBilledSalesOrderFamilyRefs()).some(row => row.ref === f.ref.toUpperCase()), false);
}, { rollback: true }));

test("browser: Control states that reopen restores both local workflows", async () => {
  const f = await fixture();
  const login = await loginOperator(f.actor.username, f.password);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.addInitScript(token => {
      globalThis.localStorage.setItem("mbbs.staff.token", token);
      globalThis.localStorage.setItem("mbbs.control.token", token);
    }, login.token);
    await page.goto(base + "/control/order-reopen");
    const panel = page.locator("[data-operator-order-reopen]");
    assert.match(await panel.innerText(), /locally in Operator and Dispatch/u);
    await panel.locator("[data-reopen-search]").fill(f.ref);
    await panel.locator('[data-form="operator-order-reopen-search"] button').click();
    await panel.locator('[data-reopen-action="preview"]').click();
    await panel.locator("[data-reopen-preview]").waitFor();
    await panel.locator("[data-reopen-reason]").fill("Restore local Dispatch and Operator while NetSuite billing is corrected.");
    page.once("dialog", dialog => dialog.accept());
    await panel.locator('[data-reopen-action="confirm"]').click();
    await panel.locator('[role="status"]').waitFor();
    assert.match(await panel.locator('[role="status"]').innerText(), /reopened in Operator and Dispatch/u);
    assert.equal(await isBilledSalesOrderIdentifier(f.id), false);
    assert.equal((await state(f)).header.status, "G");
    await page.screenshot({ path: "test-artifacts/local-reopen-20261015/browser-local-reopen.png", fullPage: true });
    writeFileSync("test-artifacts/local-reopen-20261015/browser-coverage.json", JSON.stringify(await page.coverage.stopJSCoverage()));
  } finally { await browser.close(); }
});

test("local reopen authority follows actual lifecycle and fulfillment evidence", () => withTransaction(async () => {
  const f = await fixture(); await reopen(f);
  for (const status of ["open", "preparing", "confirmed", "packed"]) {
    await query("UPDATE sales_orders SET operator_status=$2 WHERE netsuite_id=$1", [f.id, status]);
    assert.equal(await isBilledSalesOrderIdentifier(f.id), false, status);
  }
  for (const patch of ["operator_status='loaded'", "fulfillment_status='fulfilled'", "last_item_fulfillment_id=123", "fulfilled_at=now()", "netsuite_active=false", "local_yard_order_status='Hold'"]) {
    await withTransaction(async () => {
      await query(`UPDATE sales_orders SET ${patch} WHERE netsuite_id=$1`, [f.id]);
      assert.equal(await isBilledSalesOrderIdentifier(f.id), true, patch);
      const [current] = await overlayFulfilledSalesDeliveryPlanning([{ id: f.ref, type: "SO", localOrderReopened: true }]);
      assert.equal(current.localOrderReopened, false, patch);
    }, { rollback: true });
  }
  for (const patch of ["fulfilled_piece_qty=1", "fulfilled_layer_qty=1", "loaded_qty=1"]) {
    await withTransaction(async () => {
      await query(`UPDATE sales_order_lines SET ${patch} WHERE id=$1`, [f.line.id]);
      assert.equal(await isBilledSalesOrderIdentifier(f.id), true, patch);
    }, { rollback: true });
  }
  await query("INSERT INTO delivery_fulfillment_records(order_id,item_fulfillment_id,photo_data_url) VALUES($1,123,$2)", [f.id, f.photos[0]]);
  assert.equal(await isBilledSalesOrderIdentifier(f.id), true);
}, { rollback: true }));

test("SQL authority rejects unsafe aliases and empty identity lists", async () => {
  const { locallyReopenedSalesOrderSql, locallyReopenedSalesOrderIds } = await import("../../../src/local-sales-order-reopen.js");
  for (const alias of ["", "x); DROP TABLE sales_orders; --", "x.y", null]) {
    assert.throws(() => locallyReopenedSalesOrderSql(alias), TypeError);
  }
  assert.equal((await locallyReopenedSalesOrderIds()).size, 0);
});

test("concurrent local reopen fences a stale Billed reconciliation before operational cleanup", async () => {
  const f = await fixture();
  await query("UPDATE sales_orders SET operator_status='open',local_yard_order_status='Open',preparing_operator_id=NULL,preparing_started_at=NULL WHERE netsuite_id=$1", [f.id]);
  await query("UPDATE sales_order_lines SET packed_pallet_qty=0,packed_layer_qty=0,packed_section_qty=0,packed_piece_qty=0,packed_sales_qty=0,confirmed=false,confirmed_at=NULL,loaded_qty=0 WHERE sales_order_id=$1", [f.id]);
  const applicationName = `reopen-race-${f.id}`;
  let child, finished, output = "";
  try {
    await withTransaction(async () => {
      await query("SELECT netsuite_id FROM sales_orders WHERE netsuite_id=$1 FOR UPDATE", [f.id]);
      const code = `import {reconcileSalesOrderFromNetSuite} from './src/sales-order-reconciliation-repository.js';
        import {closeDb} from './src/db.js';
        try { await reconcileSalesOrderFromNetSuite({order:JSON.parse(process.env.LOCAL_REOPEN_ORDER),dryRun:false});console.log('UNEXPECTED_APPLY'); }
        catch(error){console.log(JSON.stringify({code:error.code}));} finally {await closeDb();}`;
      child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, PGAPPNAME: applicationName, LOCAL_REOPEN_ORDER: JSON.stringify(remote(f)) }, stdio: ["ignore", "pipe", "pipe"] });
      finished = once(child, "close");
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        await query("SELECT pg_stat_clear_snapshot()");
        waiting = (await query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [applicationName])).rowCount > 0;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(waiting, true, output);
      await reopen(f);
    });
    await finished;
    assert.match(output, /SO_LOCAL_REOPEN_CHANGED/u);
    assert.doesNotMatch(output, /UNEXPECTED_APPLY/u);
    assert.equal(await isBilledSalesOrderIdentifier(f.id), false);
  } finally { if (child && child.exitCode === null) { child.kill("SIGTERM"); await finished; } }
});

test("ordinary NetSuite sync preserves local reopen until actual shipped quantity arrives", () => withTransaction(async () => {
  const { upsertSalesOrders, upsertSalesOrderLines } = await import("../../../src/order-sync-repository.js");
  const f = await fixture(); await reopen(f);
  const before = await state(f);
  await upsertSalesOrders([{ ...before.header, id: Number(f.id), delivery_method: "Delivery" }]);
  await upsertSalesOrderLines(f.id, [{ ...before.lines[0], netsuite_received_qty: 0 }]);
  assert.equal((await state(f)).header.operator_status, "open");
  assert.equal((await state(f)).header.status, "G");
  assert.equal(await isBilledSalesOrderIdentifier(f.id), false);
  await upsertSalesOrderLines(f.id, [{ ...before.lines[0], netsuite_received_qty: 1 }]);
  assert.equal(Number((await state(f)).lines[0].loaded_qty), 1);
  assert.equal(await isBilledSalesOrderIdentifier(f.id), true);
}, { rollback: true }));

test("new authoritative fulfilled quantities defeat the billing-only local exception", () => withTransaction(async () => {
  const f = await fixture(); await reopen(f);
  const snapshot = remote(f); snapshot.lines[0].cumulativeProgressQuantity = 20;
  const result = await reconcileSalesOrderFromNetSuite({ order: snapshot, dryRun: true });
  assert.equal(result.calculatedApplicationStatus, "Completed");
  assert.equal(result.fulfilledByHeader, true);
}, { rollback: true }));

test("group reopen opens only its exact members and preserves group planning", () => withTransaction(async () => {
  const first = await fixture(), second = await fixture(), other = await fixture();
  const ref = `${first.ref}+${second.ref}`;
  await seedReopenGroup(ref, [first.ref, second.ref]);
  await reopen({ ...first, ref });
  assert.equal(await isBilledSalesOrderIdentifier(first.id), false);
  assert.equal(await isBilledSalesOrderIdentifier(second.id), false);
  assert.equal(await isBilledSalesOrderIdentifier(other.id), true);
  const [group] = await overlayFulfilledSalesDeliveryPlanning([{ id: ref, type: "SO", childOrders: [first.ref, second.ref], dispatchCompletionStatus: "completed" }]);
  assert.equal(group.localOrderReopened, true);
  assert.notEqual(group.dispatchCompletionStatus, "completed");
}, { rollback: true }));
