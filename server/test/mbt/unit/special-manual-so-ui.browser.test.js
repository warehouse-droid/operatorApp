import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from '@playwright/test';

const coverage = [];
after(async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile('test-artifacts/special-so-link-sqft-20261006/browser-coverage.json', JSON.stringify(coverage));
});
async function collect(page) {
  coverage.push(...(await page.coverage.stopJSCoverage()).filter(entry => entry.url.includes('/sales-special-stock-requests.js')));
}

const fixture = () => ({ id: 1, requestRef: 'SPREQ-TEST-1', revision: 3, status: 'active', storeLocationId: 1,
  storeName: '3445', stage: 'await_customer_confirmation', customerId: 10, customerName: 'TEST Customer',
  vendorId: 9, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup', operationalYardLocationId: 1,
  closeStatus: 'active', inquiryDate: '2099-01-01', expiresOn: '2099-02-01', palletTotal: 0,
  netsuiteSalesRepId: 17, salesOrderLines: [], purchaseOrderLines: [], events: [], media: [], readinessAlerts: [],
  lines: [{ id: 1, lineNumber: 1, productName: 'TEST SQFT Material', quantity: 125.75, packageQuantity: 125.75,
    uom: 'SQFT', rateUom: 'SQFT', originalRate: 10.67, pricingSource: 'enquiry', discountPercent: 0,
    salesDecision: 'accepted', supplyStatus: 'in_stock', responseVendorId: 9, itemResolution: null }] });

async function browserFixture(run) {
  let detail = fixture();
  const writes = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let result;
        if (url.pathname.endsWith('/policy')) result = { enabled: true };
        else if (url.pathname.endsWith('/sales-reps')) result = { salesReps: [{ id: 17, name: 'TEST Rep' }] };
        else if (url.pathname.endsWith('/order-links')) result = { orders: [{ id: 99, ref: 'TEST-SO-99', entityName: 'TEST Customer', status: 'Pending Fulfillment' }] };
        else if (req.method === 'PUT' || req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const input = JSON.parse(body);
          writes.push({ path: url.pathname, input });
          if (url.pathname.endsWith('/sales-order/link')) detail = { ...detail, salesOrderId: 99,
            salesOrderRef: 'TEST-SO-99', salesOrderApproved: true, salesOrderSource: 'manual_link' };
          result = detail;
        } else if (/\/special-stock-requests\/?$/.test(url.pathname)) result = {
          requests: [detail], yards: [{ locationId: 1, yardCode: '3445' }], vendors: [] };
        else result = detail;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<div id="salesStockRequestApp"></div><script>window.EventSource=class extends EventTarget{close(){}};</script><script src="/sales-special-stock-requests.js"></script><script>window.MBBSSalesSpecialStock.open({operator:{id:"TEST",display_name:"TEST"},yards:[{locationId:1,yardCode:"3445"}]});</script>');
        return;
      }
      const root = resolve('public'), path = resolve(root, '.' + url.pathname);
      if (!path.startsWith(root + '/')) throw new Error('Invalid fixture resource');
      res.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'text/css' });
      res.end(await readFile(path));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try { await run(browser, `http://127.0.0.1:${server.address().port}`, writes); }
  finally { await browser.close(); await new Promise(done => server.close(done)); }
}

test('real Sales browser offers one SO number field and links a selected suggestion on desktop and mobile', async () => {
  await browserFixture(async (browser, baseUrl, writes) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      await page.coverage.startJSCoverage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(baseUrl);
      const form = page.locator('[data-special-link-so-form]');
      await form.waitFor();
      assert.equal(await form.locator('input').count(), 1);
      await form.locator('[name=salesOrderRef]').fill('TEST-SO');
      await page.locator('[data-special-sales-action=choose-so-link]').first().click();
      assert.equal(await form.locator('[name=salesOrderRef]').inputValue(), 'TEST-SO-99');
      await form.locator('button[type=submit]').click();
      await page.waitForFunction(() => !document.querySelector('[data-special-link-so-form]'));
      assert.deepEqual(writes.at(-1).input, { expectedRevision: 3, salesOrderRef: 'TEST-SO-99' });
      assert.deepEqual(errors, []);
      await collect(page);
      await page.close();
  });
  await browserFixture(async (browser, baseUrl, writes) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 960 } });
    await page.coverage.startJSCoverage();
    await page.goto(baseUrl);
    const form = page.locator('[data-special-link-so-form]');
    await form.waitFor();
    assert.equal(await form.locator('input').count(), 1);
    await form.locator('[name=salesOrderRef]').fill('TEST-SO-99');
    await form.locator('button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('[data-special-link-so-form]'));
    assert.deepEqual(writes.at(-1).input, { expectedRevision: 3, salesOrderRef: 'TEST-SO-99' });
    await collect(page);
    await page.close();
  });
});

test('real Sales browser previews and submits SQFT without relabeling or repricing', async () => {
  await browserFixture(async (browser, baseUrl, writes) => {
    const page = await browser.newPage();
    await page.coverage.startJSCoverage();
    await page.goto(baseUrl);
    await page.locator('[data-special-native]').waitFor();
    assert.match(await page.locator('[data-special-native]').innerText(), /125\.75 SQFT/);
    await page.locator('[data-special-so-form] button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#salesStockRequestApp')?.textContent.includes('Sales Order draft saved.'));
    const material = writes.at(-1).input.materialLines[0];
    assert.equal(material.uom, 'SQFT');
    assert.equal(material.quantity, 125.75);
    assert.equal(Number(material.rate), 10.67);
    await collect(page);
    await page.close();
  });
});
