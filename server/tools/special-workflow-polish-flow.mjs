import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createOperator } from '../src/auth-repository.js';
import { query, closeDb } from '../src/db.js';
import { configureSpecialStockReviewBoundary } from '../src/special-stock-request-service.js';

if (process.env.MBT_TEST_ISOLATED !== '1' || !process.env.DATABASE_URL?.endsWith('/mbt_verify')) throw new Error('Isolated verification database required');
const output = 'test-artifacts/special-workflow-polish/frontend-flow';
await mkdir(output, { recursive: true });
const suffix = crypto.randomUUID().slice(0, 8), users = [], requests = [], stages = [];
const gate = 'special_stock_request_test_skip_orders';
const previous = (await query('SELECT enabled FROM mbt_feature_flags WHERE flag_key=$1', [gate])).rows[0].enabled;
const workflowPrevious = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
let browser, listener, netSuiteCalls = 0;
const boundary = async () => { netSuiteCalls++; throw new Error('A skip must not call NetSuite'); };
configureSpecialStockReviewBoundary(Object.fromEntries(['resolveLocations','resolveOrderUnits','findMarkerOrders','createSalesOrder','transformEstimate','createPurchaseOrder','fetchSalesOrderReference','fetchPurchaseOrderReference','synchronizeSalesDescriptions'].map(name => [name, boundary])));
try {
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN($1,'special_stock_request_workflow')", [gate]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899321,'TEST-POLISH-FLOW','TEST Polish Flow Customer','TEST Polish Flow Customer','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
  await query("INSERT INTO dispatch_vendor_mappings(netsuite_vendor_id,netsuite_vendor_name,local_vendor,active) SELECT '8899322','TEST Polish Flow Vendor','TEST Polish Flow Vendor',true WHERE NOT EXISTS(SELECT 1 FROM dispatch_vendor_mappings WHERE netsuite_vendor_id='8899322')");
  for (const role of ['sales','scm']) {
    const username = `polish-flow-${role}-${suffix}`;
    await createOperator({ username, displayName: `TEST flow ${role}`, password: 'test-polish-flow-isolated', role, roles: [role], yardLocationIds: [1] });
    users.push(username);
  }
  const { app } = await import('../src/server.js');
  listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const pages = {}, contexts = [], errors = [];
  for (const role of ['sales','scm']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage(); pages[role] = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/${role}/stock-requests`);
    await page.locator('[name=username]').fill(`polish-flow-${role}-${suffix}`);
    await page.locator('[name=password]').fill('test-polish-flow-isolated');
    await page.locator('[data-form=dispatch-login] button[type=submit]').click();
    await page.locator(role === 'sales' ? '[data-sales-stock-action=special]' : '[data-stock-request-tab=special]').click();
    await page.locator('.special-stage-filter').waitFor();
  }
  const { sales, scm } = pages;
  async function submit(page, button, path) {
    const waiting = page.waitForResponse(response => response.url().endsWith(path) && ['POST','PUT'].includes(response.request().method()));
    await button.click();
    const response = await waiting, body = await response.json();
    assert.equal(response.ok(), true, JSON.stringify(body));
    return body;
  }
  await sales.locator('[data-special-sales-action=new]').click();
  await sales.locator('[data-special-case-customer-search]').fill('TEST Polish Flow Customer');
  await sales.locator('[data-special-sales-action=choose-case-customer]').filter({ hasText: 'TEST Polish Flow Customer' }).click();
  await sales.locator('[data-special-case-vendor-search]').fill('TEST Polish Flow Vendor');
  await sales.locator('[data-special-sales-action=choose-case-vendor]').filter({ hasText: 'TEST Polish Flow Vendor' }).click();
  await sales.locator('[data-special-initial-fulfillment]').selectOption('mbt_delivery');
  await sales.locator('[name=deliveryAddress]').fill('TEST delivery address, isolated verification only');
  assert.equal(await sales.locator('[name=deliveryContactName], [name=deliveryContactPhone]').count(), 0);
  const line = sales.locator('[data-special-composer-line]');
  await line.locator('[name=productName]').fill('TEST frontend skip product');
  await line.locator('[name=quantity]').fill('2');
  await line.locator('[name=rate]').fill('144');
  await line.locator('[name=requiredDate]').fill('2099-03-01');
  let detail = await submit(sales, sales.locator('[data-special-case-form] button[type=submit]'), '/api/sales/special-stock-requests');
  requests.push(detail.id); stages.push(detail.stage);
  await scm.locator('[data-special-scm-search]').fill(detail.requestRef);
  await scm.locator('[data-special-scm-search]').press('Enter');
  await scm.locator('.stock-request-detail h2').filter({ hasText: detail.requestRef }).waitFor();
  const stock = scm.locator('[data-special-response-form]');
  await stock.locator('[name=vendorYard]').fill('TEST vendor pickup location');
  assert.equal(await stock.locator('[name=vendorId]').isVisible(), false);
  detail = await submit(scm, stock.locator('button[type=submit]'), `/api/scm/special-stock-requests/${detail.id}/lines/${detail.lines[0].id}/response`);
  stages.push(detail.stage);
  await sales.locator('[data-special-sales-action=refresh]').click();
  detail = await submit(sales, sales.locator('[data-special-decision-form] button[type=submit]'), `/api/sales/special-stock-requests/${detail.id}/lines/${detail.lines[0].id}/decision`);
  const so = sales.locator('[data-special-so-form]');
  assert.equal(await so.locator('[name=conversionToPc]').count(),0);
  await so.locator('[name=palletTotal]').fill('0');
  detail = await submit(sales, so.locator('button[type=submit]'), `/api/sales/special-stock-requests/${detail.id}/sales-order-draft`);
  detail = await submit(sales, sales.getByRole('button', { name: 'Skip SO creation', exact: true }), `/api/sales/special-stock-requests/${detail.id}/sales-order/skip`);
  assert.equal(detail.stage, 'confirmed'); assert.equal(detail.salesOrderId, null); stages.push(detail.stage);
  await scm.locator('[data-special-scm-action=refresh]').click();
  const po = scm.locator('[data-special-po-form]');
  await po.locator('[name=description]').fill('TEST revised PO and simulated SO description');
  await po.locator('[name=quantity]').fill('2');
  await po.locator('[name=unitPurchaseCost]').fill('4');
  detail = await submit(scm, po.getByRole('button', { name: 'Skip PO Creation', exact: true }), `/api/scm/special-stock-requests/${detail.id}/purchase-order/skip`);
  stages.push(detail.stage);
  assert.equal(detail.stage, 'dispatch_arrangement');
  assert.equal(detail.purchaseOrderId, null); assert.equal(detail.handoff, null);
  assert.equal(detail.salesOrderLines[0].quantity, 2);
  assert.equal(detail.salesOrderLines[0].description, 'TEST revised PO and simulated SO description');
  assert.equal(netSuiteCalls, 0); assert.deepEqual(errors, []);
  await sales.locator('[data-special-sales-action=refresh]').click();
  for (const [index, role] of ['sales','scm'].entries()) {
    await pages[role].screenshot({ path: `${output}/${role}.png`, fullPage: true });
    await contexts[index].tracing.stop({ path: `${output}/${role}-trace.zip` });
  }
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, requestRef: detail.requestRef, stages, salesOrderId: detail.salesOrderId,
    purchaseOrderId: detail.purchaseOrderId, liveHandoff: detail.handoff, netSuiteCalls, pageErrors: errors, fixtureCleanedUp: true }, null, 2));
  console.log('Real frontend enquiry → stock check → customer confirmation → SO skip → PO skip passed; zero NetSuite calls.');
} finally {
  await browser?.close();
  if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [requests]);
  await query('DELETE FROM operators WHERE username=ANY($1::text[])', [users]);
  await query('UPDATE mbt_feature_flags SET enabled=$2 WHERE flag_key=$1', [gate, previous]);
  await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [workflowPrevious]);
  await closeDb();
}
