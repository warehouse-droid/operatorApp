/* global window, localStorage, receiptPhotoDataUrls, render, prepareOperatorBackgroundPhotos, resumeOperatorBackgroundPhotos */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const artifact = 'test-artifacts/receiving-posting-status';
mkdirSync(artifact, { recursive: true });
const publicRoot = path.resolve(process.env.RECEIPT_STATUS_PUBLIC || 'public');
const order = { netsuite_id: '1002959', tranid: 'POB03903', order_type: 'purchase_order', vendor: 'Receiving fixture',
  destination_location_id: 1, destination_location: '3445', trandate: '2026-09-23', status_text: 'Pending Receipt',
  line_count: 1, lines: [{ id: '1', line_id: 1, item_id: 1, sku: 'ITEM', item_name: 'ITEM', item_type: 'InvtPart',
    item_type_text: 'Inventory Item', quantity: 10, unit: 'PC', netsuite_active: true, netsuite_received_qty: 0, received_sales_qty: 10 }] };
const result = { receiptStatus: 'received', itemReceiptId: 1007837, itemReceiptTranid: 'IR14775',
  operatorNetSuitePosting: { transactions: [{ transactionType: 'IR', transactionRef: 'IR14775', transactionId: 1007837 }] } };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const evidence = [], coverage = [];
try {
  for (const mode of ['attention-reload', 'lost-response', 'polling-outage', 'completion-event']) {
    let status = 'attention', requestId = '', submissions = 0, reads = 0;
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:32189/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        let value = {};
        if (url.pathname === '/api/auth/me') value = { operator: { id: 'receipt-browser', display_name: 'Receiving fixture', role: 'operator', roles: ['operator'], operatorYardLocationIds: [1] } };
        else if (url.pathname === '/api/delivery/notifications') value = { total: 0, salesOrder: {}, transferOrder: {}, items: [] };
        else if (url.pathname === '/api/delivery/current-draft') value = null;
        else if (url.pathname === '/api/receiving/orders') value = [order];
        else if (url.pathname === `/api/receiving/orders/${order.netsuite_id}`) value = order;
        else if (['/api/receiving/vendors', '/api/receiving/sources', '/api/receiving/items'].includes(url.pathname)) value = [];
        else if (url.pathname === '/api/operator/netsuite-posting-policy') value = { effective: true, gateKey: 'operator_netsuite_receiving_ir_3445', revision: 1 };
        else if (url.pathname.endsWith('/receive')) {
          submissions += 1;
          assert.equal(submissions, 1, 'A recovery must never submit another receipt');
          requestId = route.request().postDataJSON().requestId;
          if (mode === 'lost-response') { status = 'completed'; return route.abort('failed'); }
          value = { status: 'running', posting: true, jobId: requestId };
        } else if (url.pathname.startsWith('/api/operator/netsuite-posting-jobs/')) {
          reads += 1;
          assert.equal(url.pathname.split('/').at(-1), requestId);
          if (mode === 'polling-outage' && reads === 1) return route.abort('failed');
          value = { id: requestId, functionKey: 'receiving', status,
            steps: [{ transactionType: 'IR', status: 'uncertain', observedTransaction: { id: 1007837, tranId: 'IR14775' } }],
            result: status === 'completed' ? { localFinalization: result } : {} };
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      }
      const file = url.pathname === '/operator' ? 'operator.html' : url.pathname.slice(1);
      if (file.startsWith('vendor/')) return route.fulfill({ contentType: 'application/javascript', body: '' });
      const candidate = path.resolve(publicRoot, file);
      assert.ok(candidate.startsWith(publicRoot + '/'));
      return route.fulfill({ body: readFileSync(candidate), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.addInitScript(({ sessionKey }) => {
      window.EventSource = class {
        addEventListener(name, callback) { if (name === 'app-event') window.receiptTestEvent = callback; }
        close() {}
      };
      localStorage.setItem('mbbs.staff.token', 'receipt-browser-token');
      localStorage.setItem('mbbs.operator.token', 'receipt-browser-token');
      localStorage.setItem('mbbs.operator.locationId', '1');
      localStorage.setItem('mbbs.ui.language', 'en');
      if (!localStorage.getItem('mbbs.operator.state')) localStorage.setItem('mbbs.operator.state', JSON.stringify({ locationId: 1, currentModule: 'receiving', accountId: 'receipt-browser', sessionKey }));
    }, { sessionKey: createHash('sha256').update('receipt-browser-token').digest('hex') });
    await page.goto('http://localhost:32189/operator');
    await page.locator('#receivingSearch').fill('POB03903');
    await page.locator('[data-action="start-receive"]').click();
    await expect(page.locator('[data-action="confirm-receive"]')).toBeVisible();
    await page.evaluate(() => {
      receiptPhotoDataUrls = ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='];
      prepareOperatorBackgroundPhotos = async () => ({ backgroundPhotos: [{ id: 'photo-one' }, { id: 'photo-two' }] });
      resumeOperatorBackgroundPhotos = () => {};
      render();
    });
    await page.locator('[data-action="confirm-receive"]').click();
    if (mode !== 'lost-response') {
      await expect(page.locator('[data-receipt-posting-status]')).toContainText('IR14775');
      await expect(page.locator('[data-receipt-posting-status]')).toContainText('NetSuite receipt created');
      await expect(page.locator('[data-action="confirm-receive"]')).toHaveCount(0);
      await page.screenshot({ path: `${artifact}/${mode}.png`, fullPage: true });
      if (['attention-reload', 'polling-outage'].includes(mode)) {
        await page.getByRole('button', { name: 'Back', exact: true }).click();
        await page.locator('[data-action="start-receive"]').click();
        await expect(page.locator('[data-receipt-posting-status]')).toContainText('IR14775');
      }
      if (mode === 'attention-reload') {
        await page.reload();
        await expect(page.locator('[data-receipt-posting-status]')).toContainText('IR14775');
      }
      status = 'completed';
      if (mode === 'completion-event') {
        await page.evaluate(() => window.receiptTestEvent({ data: JSON.stringify({ type: 'receiving.order.received', payload: { orderId: '1002959' } }) }));
      } else if (mode === 'polling-outage') {
        await expect(page.locator('[data-action="finish-receive"]')).toHaveCount(2, { timeout: 15000 });
      } else await page.locator('[data-action="refresh-receipt-posting"]').click();
    }
    await expect(page.locator('.fulfillment-card.success')).toContainText('IR14775');
    await expect(page.locator('.fulfillment-card.success')).toContainText('Receiving posted to NetSuite and verified.');
    await expect(page.locator('[data-action="confirm-receive"]')).toHaveCount(0);
    await page.screenshot({ path: `${artifact}/${mode}-complete.png`, fullPage: true });
    await page.locator('[data-action="finish-receive"]').first().click();
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('mbbs.operator.receipt:')).length), 0);
    assert.equal(submissions, 1);
    assert.deepEqual(errors, []);
    coverage.push(...(await page.coverage.stopJSCoverage()).filter(entry => new URL(entry.url).pathname === '/operator.js'));
    evidence.push({ mode, submissions, reads, browserErrors: errors.length });
    await page.close();
  }
  writeFileSync(`${artifact}/browser-coverage.json`, JSON.stringify(coverage));
  writeFileSync(`${artifact}/browser.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
