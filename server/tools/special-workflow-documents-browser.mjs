import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const output = '/app/test-artifacts/special-workflow-review/quantity-documents';
const pdf = await readFile(`${output}/quote.pdf`);
const orders = Object.fromEntries(await Promise.all(['sales_order-sales','purchase_order-sales','purchase_order-scm'].map(async name => [name, await readFile(`${output}/${name}.pdf`)])));
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
const results = [];
const fixture = linked => ({ id: 7100, requestRef: 'SPREQ-TEST-7100', revision: 7, stage: linked ? 'confirmed' : 'new_enquiry',
  customerId: 8899100, customerName: 'TEST Customer', customerPhone: '416-555-0100', vendorId: 8899200, vendorName: 'TEST Vendor',
  storeLocationId: 1, storeName: '3445', operationalYardLocationId: 1, inquiryDate: '2099-01-01', fulfillmentMethod: 'yard_pickup', closeStatus: 'active',
  salesOrderId: linked ? 101 : null, salesOrderRef: linked ? 'TEST-SO' : null, salesOrderStatus: 'Pending Fulfillment', salesOrderApproved: linked,
  purchaseOrderId: linked ? 102 : null, purchaseOrderRef: linked ? 'TEST-PO' : null, purchaseOrderStatus: 'Pending Receipt',
  lines: [{ id: 1, productName: 'TEST Coping', quantity: 2, packageQuantity: 2, uom: 'PLT', rateUom: 'PLT', originalRate: 50, discountPercent: 10, pricingSource: 'enquiry',
    conversionToPc: 10, salesDecision: linked ? 'accepted' : 'pending', supplyStatus: linked ? 'in_stock' : null,
    itemResolution: linked ? { itemId: 2055, description: 'TEST Coping', salesQuantity: 20, salesUom: 'PC' } : null }],
  salesOrderLines: linked ? [{ caseLineId: 1, itemId: 2055, description: 'TEST Coping', quantity: 20, uom: 'PC', rate: 4.5 }] : [],
  purchaseOrderLines: linked ? [{ caseLineId: 1, itemId: 2055, description: 'TEST Coping', quantity: 20, uom: 'PC', unitPurchaseCost: 4 }] : [],
  media: [], events: [], readinessAlerts: [] });
try {
  for (const role of ['sales','scm']) {
    const login = await browser.newContext(), auth = await login.newPage();
    await auth.goto(`http://127.0.0.1:3000/${role}/stock-requests`);
    await auth.locator('[name=username]').fill(`review-${role}`);
    await auth.locator('[name=password]').fill('SpecialReview-2026!'); // secret-scan: allow -- isolated disposable review account
    await auth.locator('[data-form=dispatch-login] button[type=submit]').click();
    const tab = role === 'sales' ? '[data-sales-stock-action=special]' : '[data-stock-request-tab=special]';
    await auth.locator(tab).waitFor();
    const storageState = await login.storageState(); await login.close();
    for (const width of [1440,390]) {
      const context = await browser.newContext({ storageState, viewport: { width, height: 960 }, acceptDownloads: true });
      const page = await context.newPage(), errors = [], requests = [];
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      let current = fixture(false), fail = false, delay = false;
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.previewUrls = new Set();
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = create(blob); window.previewUrls.add(url); return url; };
        URL.revokeObjectURL = url => { window.previewUrls.delete(url); revoke(url); };
      });
      await page.route(`**/api/${role}/special-stock-requests**`, async route => {
        const request = route.request(), path = new URL(request.url()).pathname.split('/special-stock-requests')[1];
        requests.push({ path, method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
        if (path.endsWith('.pdf') || path === '/quote-preview') {
          if (delay) await new Promise(resolve => setTimeout(resolve, 350));
          return route.fulfill(fail ? { status: 409, contentType: 'application/json', body: '{"error":"TEST document changed"}' }
            : { contentType: 'application/pdf', headers: { 'content-disposition': 'inline; filename="TEST-document.pdf"' }, body: path.includes('/orders/sales_order') ? orders['sales_order-sales'] : path.includes('/orders/purchase_order') ? orders[`purchase_order-${role}`] : pdf });
        }
        const payload = path === '/policy' ? { enabled: true, testSkipOrdersEnabled: false }
          : !path ? { requests: [current], yards: [{ locationId: 1, yardCode: '3445' }] }
          : path === '/customers' ? { customers: [] } : path === '/vendors' ? { vendors: [] } : current;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
      });
      await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`); await page.locator(tab).click();
      await page.locator('[data-special-document=quote]').waitFor();
      async function open(kind) {
        await page.locator(`[data-special-document=${kind}]`).click();
        await page.locator('dialog.special-document-dialog iframe').waitFor();
        assert.match(await page.locator('[data-document-download]').getAttribute('href'), /^blob:/);
        const box = await page.locator('dialog.special-document-dialog').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'Dialog fits viewport');
      }
      async function close(kind) {
        await page.locator('[data-document-close]').focus(); await page.keyboard.press('Escape');
        await page.locator('dialog.special-document-dialog').waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => window.previewUrls.size), 0);
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.specialDocument), kind);
      }
      await open('quote');
      const downloading = page.waitForEvent('download'); await page.locator('[data-document-download]').click();
      assert.equal((await downloading).suggestedFilename(), 'TEST-document.pdf'); await close('quote');
      if (role === 'sales') {
        await page.locator('[data-special-sales-action=new]').click();
        assert.equal(await page.locator('[name=estimateId]').count(), 0);
        await page.locator('[name=customerName]').fill('New local customer'); await page.locator('[name=vendorName]').fill('Local vendor');
        await page.locator('[data-special-initial-fulfillment]').selectOption('yard_pickup');
        await page.locator('[name=productName]').fill('Local quote product'); await page.locator('[name=quantity]').fill('2');
        await page.locator('[name=rate]').fill('50'); await page.locator('[name=requiredDate]').fill('2099-02-01');
        await open('draft_quote');
        const sent = requests.find(r => r.path === '/quote-preview'); assert.equal(sent.body.lines[0].quantity, '2');
        await close('draft_quote'); assert.equal(await page.locator('[name=customerName]').inputValue(), 'New local customer');
        assert.equal(requests.filter(r => r.method === 'POST' && r.path !== '/quote-preview').length, 0);
        await page.locator('[data-special-sales-action=cancel-compose]').click();
      }
      current = fixture(true); await page.locator(`[data-special-${role}-action=refresh]`).click();
      await page.locator('[data-special-document=sales_order]').waitFor(); assert.equal(await page.locator('[data-special-document=quote]').count(), 0);
      for (const kind of ['sales_order','purchase_order']) {
        await open(kind); await page.waitForTimeout(1000); await page.screenshot({ path: `${output}/${role}-${width}-${kind}.png` }); await close(kind);
      }
      fail = true; await page.locator('[data-special-document=sales_order]').click();
      await page.getByRole('alert').filter({ hasText: 'TEST document changed' }).waitFor(); await close('sales_order');
      fail = false; delay = true; await page.locator('[data-special-document=purchase_order]').click();
      await page.locator('[data-document-close]').click(); await page.waitForTimeout(450);
      assert.equal(await page.locator('dialog.special-document-dialog').count(), 0);
      assert.equal(await page.evaluate(() => window.previewUrls.size), 0); assert.deepEqual(errors, []);
      results.push({ role, width, passed: true, scenarios: ['quote','saved-order-pdfs','download','close-focus','blob-cleanup','error','cancel-fetch',...(role === 'sales' ? ['draft-quote','preserved-form'] : [])] });
      const coverage = (await page.coverage.stopJSCoverage()).filter(entry => /\/(?:sales-special-stock-requests|scm-special-stock-requests|special-stock-documents)\.js$/.test(entry.url.split('?')[0]));
      await writeFile(`${output}/browser-coverage-${role}-${width}.json`, JSON.stringify(coverage));
      await context.close(); console.log(JSON.stringify(results.at(-1)));
    }
  }
} finally { await writeFile(`${output}/browser.json`, JSON.stringify(results, null, 2)); await browser.close(); }
