import {chooseRegularStatuses,expectRegularStatuses} from '../../support/regular-stock-status-browser.mjs';
import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import {mkdirSync, writeFileSync} from 'node:fs';
import {chromium, expect} from '@playwright/test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createSalesStockRequest, cancelSalesStockRequest, convertSalesStockRequestLines} from '../../../src/stock-request-repository.js';

const out = 'test-artifacts/status-filter-browser';
const ids = [], records = {};
let f, browser;
before(async () => {
  mkdirSync(out, {recursive: true});
  f = await fixture({sku: 88999509});
  await f.query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,to_plt,to_lyr,to_sec,to_pcs) VALUES(88999510,'TEST-FILTER-ITEM','TEST filter material','EA','TEST, Vendor A',10,5,2,1)");
  await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,synced_at) VALUES(88999510,28,'2967',100,100,now())");
  const sales = {operatorId: f.users.sales.id, authorizedDestinationLocationIds: [1]};
  const create = async () => {
    const d = await createSalesStockRequest({destinationLocationId: 1, lines: [{itemId: 88999510, sourceLocationId: 28, pieces: 2}]}, sales);
    ids.push(d.id); return d;
  };
  records.stocking = await create();
  await f.query("UPDATE sales_stock_requests SET workflow_version=2,regular_details='{\"deliveryMethod\":\"stocking\"}' WHERE id=$1",[records.stocking.id]);
  const accepted = await create();
  records.accepted = (await convertSalesStockRequestLines(accepted.id, {expectedRevision: accepted.revision, lineIds: [accepted.lines[0].id]}, {operatorId: f.users.scm.id})).request;
  const completed = await create();
  records.completed = await cancelSalesStockRequest(completed.id, {expectedRevision: completed.revision}, sales);
  records.activeBackorder = await f.create(1);
  records.completedBackorder = await f.ordered(await f.create(1));
  browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
});
after(async () => {
  await browser?.close();
  if (f) {
    try {
      await f.query('DELETE FROM sales_stock_transfers WHERE request_id=ANY($1::bigint[])', [ids]);
      await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [ids]);
    } finally { await f.close(); }
  }
});

test('Sales unified statuses, types and vendors combine, persist and work on mobile', async () => {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, serviceWorkers: 'block'});
  await context.addInitScript(token => {
    localStorage.setItem('mbbs.staff.token', token);
    localStorage.setItem('mbbs.sales.stockRequests.status', 'completed');
  }, f.users.sales.token);
  const page = await context.newPage(), errors = [], times = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const menu = name => page.locator(`[data-sales-multi-filter="${name}"]`);
  const shown = async expected => {
    await expect.poll(async () => (await page.locator('[data-sales-stock-action="select"]').evaluateAll(elements => elements.map(el => Number(el.dataset.id)))).sort((a,b) => a-b))
      .toEqual(expected.map(d => d.id).sort((a,b) => a-b));
    if (expected.length) await expect(page.locator('.stock-request-card.selected')).toHaveCount(1);
  };
  const open = async name => { if (!await menu(name).getAttribute('open').then(value=>value!==null)) await menu(name).locator('summary').click(); };
  const change = async (name,value,checked=true,keyboard=false) => {
    await open(name);
    const input = menu(name).locator(`input[value="${value}"]`);
    const [result] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/sales/stock-requests'),
      keyboard ? input.focus().then(()=>input.press('Space')) : input.setChecked(checked)
    ]);
    assert.equal(result.status(),200); assert.equal(new URL(result.url()).searchParams.has('status'),false);
    await expect(input).toBeChecked({checked});
    await expect(menu(name)).toHaveAttribute('open','');
  };
  const clear = async name => {
    await open(name);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/sales/stock-requests');
    await menu(name).getByRole('button',{name:'Clear selection',exact:true}).click();
    assert.equal((await response).status(),200);
    await expect(menu(name).locator('input:checked')).toHaveCount(0);
  };
  try {
    const started = performance.now(),active=[records.stocking,records.accepted,records.activeBackorder];
    await page.goto(f.base + '/sales/stock-requests?tab=regular', {waitUntil: 'domcontentloaded'});
    await shown(active);await expectRegularStatuses(page,'sales','active');
    await expect(page.locator('[data-sales-stock-filter="statusFilter"]')).toHaveCount(0);
    const statuses=page.locator('[data-yard-filter="unifiedStatus"]');
    await expect(statuses).toBeVisible();times.push({page:'sales-regular',ms:Math.round(performance.now()-started)});
    await chooseRegularStatuses(page,'sales','pending_scm,completed');await shown([records.stocking,records.activeBackorder,records.completedBackorder]);
    await page.screenshot({path:out+'/desktop.png',fullPage:true});
    await page.reload();await shown([records.stocking,records.activeBackorder,records.completedBackorder]);await expectRegularStatuses(page,'sales','pending_scm,completed');
    await chooseRegularStatuses(page,'sales','completed');await shown([records.completedBackorder]);
    await chooseRegularStatuses(page,'sales','all');await shown(Object.values(records));

    await change('requestTypeFilter','stocking');await shown([records.stocking]);
    await change('requestTypeFilter','backorder',true,true);await shown([records.stocking,records.activeBackorder,records.completedBackorder]);
    await chooseRegularStatuses(page,'sales','completed');await shown([records.completedBackorder]);
    await change('requestTypeFilter','backorder',false);await shown([]);
    await expect(page.locator('.stock-request-detail')).toContainText('Select a request');
    await expectRegularStatuses(page,'sales','completed');
    await chooseRegularStatuses(page,'sales','all');await shown([records.stocking]);
    await clear('requestTypeFilter');await shown(Object.values(records));

    await change('vendorFilter','TEST, Vendor A');await shown([records.stocking,records.accepted,records.completed]);
    await change('vendorFilter','TEST Vendor');await shown(Object.values(records));
    await chooseRegularStatuses(page,'sales','pending_scm');await shown([records.stocking,records.activeBackorder]);
    await page.reload();await shown([records.stocking,records.activeBackorder]);
    await open('vendorFilter');await expect(menu('vendorFilter').locator('input:checked')).toHaveCount(2);
    await page.locator('[data-sales-stock-action="clear-filters"]').click();await shown(active);
    await expect(page.locator('[data-sales-multi-filter]:not([data-yard-filter="unifiedStatus"]) input:checked')).toHaveCount(0);await expectRegularStatuses(page,'sales','active');
    await page.reload();await shown(active);

    await page.setViewportSize({width:390,height:844});
    await chooseRegularStatuses(page,'sales','pending_scm,completed');await shown([records.stocking,records.activeBackorder,records.completedBackorder]);
    await statuses.locator('summary').click();
    assert.ok(await statuses.locator(':scope > div').evaluate(el=>{const bounds=el.getBoundingClientRect();return bounds.left>=0&&bounds.right<=document.documentElement.clientWidth;}));
    await page.screenshot({path:out+'/mobile.png',fullPage:true});await statuses.locator('summary').click();
    await page.locator('[data-sales-stock-action="new"]').click();
    for(const name of ['requestTypeFilter','vendorFilter']) {
      await open(name);for(const input of await menu(name).locator('input').all())await expect(input).toBeDisabled();
      await expect(menu(name).getByRole('button',{name:'Clear selection',exact:true})).toBeDisabled();
    }
    await statuses.locator('summary').click();for(const input of await statuses.locator('input').all()){await expect(input).toBeDisabled();}
    assert.deepEqual(errors, []);
    writeFileSync(out+'/result.json',JSON.stringify({timings:times,errors,checks:['unified-statuses','old-status-ignored','status-union','type-union','vendor-comma-union','filter-intersection','persistence','clear','keyboard','mobile','composer']},null,2));
  } catch (error) {
    await page.screenshot({path:out+'/failure.png',fullPage:true});
    writeFileSync(out+'/failure.json',JSON.stringify({errors,message:error.message},null,2));
    throw error;
  } finally { await context.close(); }
});
