// Manual browser verification against synthetic requests in the isolated app.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {chromium, expect} from '@playwright/test';
import {fixture} from '../../test/mbt/helpers/backorder-already-ordered.js';
import {createSalesStockRequest, cancelSalesStockRequest} from '../../src/stock-request-repository.js';
import {createSpecialStockCase, requestSpecialCaseClosure} from '../../src/special-stock-request-repository.js';
import {execFileSync} from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out = 'test-artifacts/stock-request-apply-20261010';
const files = JSON.parse(await (await import('node:fs/promises')).readFile(out + '/files.json'));
for (const file of files.filter(n => n.endsWith('.js'))) execFileSync(process.execPath, ['--check', file]);
const f = await fixture({sku: 88999221}), ids = [], results = [];
let browser;
try {
  await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,synced_at) VALUES(88999221,28,'2967',100,100,now())");
  const regular = [];
  for (let i = 0; i < 2; i++) {
    const d = await createSalesStockRequest({destinationLocationId: 1, lines: [{itemId: 88999221, sourceLocationId: 28, salesQty: 2}]}, {operatorId: f.users.sales.id, authorizedDestinationLocationIds: [1]});
    ids.push(d.id); regular.push(d);
    await f.query('UPDATE sales_stock_requests SET request_ref=$2 WHERE id=$1', [d.id, `STREQ-TEST21-${i}`]);
    if (i) await cancelSalesStockRequest(d.id, {expectedRevision: d.revision}, {operatorId: f.users.sales.id, authorizedDestinationLocationIds: [1]});
  }
  const backorder = await f.create(1);
  await f.query('UPDATE sales_stock_requests SET request_ref=$2 WHERE id=$1', [backorder.id, 'STREQ-TEST21-BACKORDER']);
  regular.push(backorder);
  const special = [];
  for (let i = 0; i < 2; i++) {
    const d = await createSpecialStockCase({storeLocationId: 1, fulfillmentMethod: 'yard_pickup', inquiryDate: '2099-01-01', customerName: 'TEST Customer 21', vendorName: 'TEST Vendor', lines: [{productName: 'TEST Special material 21', quantity: 2, uom: 'SQFT', rate: 2, requiredDate: '2099-02-01'}]}, {operatorId: f.users.sales.id, authorizedStoreLocationIds: [1]});
    ids.push(d.id); special.push(d);
    if (i) await requestSpecialCaseClosure(d.id, {expectedRevision: d.revision, reason: 'TEST local closure'}, {operatorId: f.users.sales.id, authorizedStoreLocationIds: [1]});
  }
  browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  for (const width of [1440, 390]) for (const audience of ['sales', 'scm']) for (const kind of ['regular', 'special']) {
    const context = await browser.newContext({viewport: {width, height: 900}, serviceWorkers: 'block'});
    try {
      await context.addInitScript(token => {
        localStorage.setItem('mbbs.staff.token', token);
        window.EventSource = class extends EventTarget { constructor() { super(); } close() {} };
      }, f.users[audience].token);
      const page = await context.newPage(), errors = [], calls = [];
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        const url = new URL(request.url());
        if (/^\/api\/(sales|scm)\/(special-)?stock-requests$/.test(url.pathname)) calls.push(url);
      });
      const prefix = `/api/${audience}/${kind === 'special' ? 'special-' : ''}stock-requests`;
      const response = () => page.waitForResponse(r => new URL(r.url()).pathname === prefix && r.request().method() === 'GET');
      await page.goto(`${f.base}/${audience}/stock-requests?tab=${kind}`);
      await page.locator('.stock-request-filters, .special-stage-filter').first().waitFor();
      await page.waitForLoadState('networkidle');
      const menuSelectors = await page.locator('details:has(.stock-request-filter-actions)').evaluateAll(elements => elements.map(element =>
        element.dataset.salesMultiFilter ? `[data-sales-multi-filter="${element.dataset.salesMultiFilter}"]` : element.dataset.yardFilter ? `[data-yard-filter="${element.dataset.yardFilter}"]` : element.classList.contains('special-vendor-filter') ? '.special-vendor-filter' : '.special-stage-filter'));
      for (const selector of menuSelectors) {
        const menu = page.locator(selector);
        await menu.locator('summary').click();
        const row = menu.locator('.stock-request-filter-actions');
        await expect(row.getByRole('button', {name: 'Clear selection', exact: true})).toBeVisible();
        const apply = row.getByRole('button', {name: 'Apply', exact: true});
        await expect(apply).toBeVisible();
        const boxes = await row.getByRole('button').evaluateAll(buttons => buttons.map(button => {const b = button.getBoundingClientRect(); return {x:b.x,y:b.y,right:b.right};}));
        assert.equal(boxes.length, 2); assert(Math.abs(boxes[0].y - boxes[1].y) < 2); assert(boxes[1].x > boxes[0].right);
        const before = calls.length;
        const pending = response(); await apply.click(); assert.equal((await pending).status(), 200);
        await page.waitForLoadState('networkidle');
        await expect(menu).not.toHaveAttribute('open', '');
        assert.equal(calls.length, before + 1, 'Apply should load exactly its own request type');
      }
      if (kind === 'special') {
        await page.locator('.special-stage-filter summary').click();
        const pending = response(); await page.locator('.special-stage-filter input[value=new_enquiry]').check(); await pending;
        await page.waitForLoadState('networkidle');
        await expect(page.locator(`.stock-request-card[data-id="${special[1].id}"]`)).toHaveCount(0);
      } else if (audience === 'sales') {
        await page.locator('[data-sales-multi-filter=backorderStageFilter] summary').click();
        const pending = response(); await page.locator('[data-sales-stock-filter=backorderStageFilter][value=new_enquiry]').check(); await pending;
        await page.waitForLoadState('networkidle');
      }
      const search = page.locator('[data-sales-stock-search], [data-scm-stock-search], [data-special-search], [data-special-scm-search]');
      await search.fill('21');
      let pending = response();
      if (kind === 'special') await search.press('Enter');
      else await page.locator(`[data-${audience}-stock-action=apply-filters]`).click();
      const searched = new URL((await pending).url());
      await page.waitForLoadState('networkidle');
      assert.equal(searched.pathname, prefix); assert.equal(searched.searchParams.get('search'), '21');
      assert.equal(searched.searchParams.get(kind === 'special' ? 'stages' : 'allStatuses'), kind === 'special' ? '' : '1');
      const expected = kind === 'special' ? special : regular;
      for (const d of expected) await expect(page.locator(`.stock-request-card[data-id="${d.id}"]`)).toBeVisible();
      for (const d of kind === 'special' ? regular : special) await expect(page.locator(`.stock-request-card[data-id="${d.id}"]`)).toHaveCount(0);
      if (kind === 'special') {
        await page.locator('.special-stage-filter summary').click();
        pending = response(); await page.locator('[data-special-apply-stages]').click(); await pending;
        await page.waitForLoadState('networkidle');
        for (const d of special) await expect(page.locator(`.stock-request-card[data-id="${d.id}"]`)).toBeVisible();
      }
      await page.screenshot({path: `${out}/${process.env.STOCK_APPLY_MODE}-${audience}-${kind}-${width}.png`, fullPage: true});
      await search.fill(''); pending = response();
      if (kind === 'special') await search.press('Enter'); else await page.locator(`[data-${audience}-stock-action=apply-filters]`).click();
      const restored = new URL((await pending).url());
      await page.waitForLoadState('networkidle');
      if (kind === 'special') {
        assert.equal(restored.searchParams.get('stages'), 'new_enquiry');
        await expect(page.locator(`.stock-request-card[data-id="${special[1].id}"]`)).toHaveCount(0);
      } else assert.equal(restored.searchParams.has('allStatuses'), false);
      assert.deepEqual(errors, []);
      results.push({audience, kind, width, applyMenus: menuSelectors.length, searchAcrossStatuses: true, restoredStatusFilter: true, errors});
      console.log(JSON.stringify(results.at(-1)));
    } finally { await context.close(); }
  }
  await writeFile(`${out}/${process.env.STOCK_APPLY_MODE}-results.json`, JSON.stringify({passed: true, screens: results}, null, 2));
} finally {
  await browser?.close();
  try { await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [ids]); }
  finally { await f.close(); }
}
