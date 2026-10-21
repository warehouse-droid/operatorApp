/* global MouseEvent, SubmitEvent */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const out = 'test-artifacts/special-operation-progress';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
const fixture = (role = 'sales') => ({ id: 91, requestRef: 'SPREQ-TEST-91', revision: 4, storeLocationId: 1, storeName: '3445', stage: 'so_draft', closeStatus: 'active', customerId: 88, customerName: 'TEST Customer', vendorName: 'TEST Vendor', vendorId: 90, inquiryDate: '2099-01-01', fulfillmentMethod: 'yard_pickup', palletTotal: 0, operationalYardLocationId: 1,
  salesOrderId: role === 'scm' ? 101 : null, salesOrderRef: role === 'scm' ? 'TEST-SO' : null, salesOrderApproved: true,
  lines: [{ id: 91, productName: 'TEST material', quantity: 5, packageQuantity: 5, uom: 'Pcs', rateUom: 'PC', originalRate: 20, discountPercent: 0, conversionToPc: 1, salesDecision: 'accepted', supplyStatus: 'in_stock', pricingSource: 'enquiry' }],
  salesOrderLines: [{ caseLineId: 91, itemId: 2055, quantity: 5, uom: 'PC', rate: 20, description: 'TEST material' }], purchaseOrderLines: [{ caseLineId: 91, itemId: 2055, quantity: 5, uom: 'PC', unitPurchaseCost: 12, description: 'TEST material' }], events: [], media: [], readinessAlerts: [] });
const results = [];
try {
  for (const role of ['sales', 'scm']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`);
    await page.locator('[name=username]').fill(`review-${role}`);
    await page.locator('[name=password]').fill('SpecialReview-2026!'); // secret-scan: allow -- disposable review account
    await page.locator('[data-form=dispatch-login] button[type=submit]').click(); await page.locator('.special-stock-page').waitFor();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const coverage = [];
    let loaded = false;
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const calls = [];
    let detail = fixture(role), pending, respond, lists = 0;
    await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} }; });
    await page.route(`**/api/${role}/special-stock-requests**`, async route => {
      const path = new URL(route.request().url()).pathname.split('/special-stock-requests')[1];
      if (path === '/policy') return route.fulfill({ json: { enabled: true } });
      if (route.request().method() !== 'GET') {
        calls.push({ path, body: route.request().postDataJSON() });
        pending = route; respond?.(); return;
      }
      if (!path) { lists++; return route.fulfill({ json: { requests: [detail, { ...fixture(role), id: 92, requestRef: 'SPREQ-TEST-92' }], yards: [{ locationId: 1, yardCode: '3445' }] } }); }
      return route.fulfill({ json: detail });
    });
    const load = async () => {
      const previous = await page.coverage.stopJSCoverage();
      if (loaded) coverage.push(...previous);
      await page.goto('about:blank');
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`); await page.locator('.stock-request-detail h2').waitFor();
      loaded = true;
    };
    const start = async (button, message) => {
      const received = new Promise(resolve => { respond = resolve; }); await button.click(); await received;
      assert.equal(await button.isDisabled(), true, 'the initiating action must disable before the response');
      assert.match(await page.locator('[data-special-operation-status]').innerText(), message);
      assert.equal(await page.locator('.stock-request-detail').getAttribute('aria-busy'), 'true');
      assert.equal(await page.locator('.stock-request-detail button:enabled').count(), 0);
      const count = calls.length;
      await button.evaluate(node => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); if (node.form) node.form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: node })); });
      assert.equal(calls.length, count, 'duplicate actions must not issue requests');
    };
    const finish = async (error = false) => {
      await pending.fulfill({ status: error ? 400 : 200, json: error ? { error: 'TEST NetSuite unavailable' } : detail });
      await page.waitForFunction(() => document.querySelector('.stock-request-detail')?.getAttribute('aria-busy') !== 'true');
    };
    await load();
    const create = role === 'sales' ? '[data-special-sales-action=create-so]' : '[data-special-po-form] button[type=submit]';
    await start(page.locator(create), /Creating.*(?:Sales|Purchase) Order.*NetSuite/i);
    assert.equal(calls[0].body.expectedRevision, 4);
    if (role === 'scm') { assert.equal(calls[0].body.lines[0].quantity, '5'); assert.equal(calls[0].body.lines[0].unitPurchaseCost, '12'); }
    await finish(true); assert.equal(await page.locator(create).isEnabled(), true);
    if (role === 'scm') { assert.equal(await page.locator('[data-special-po-line] [name=quantity]').inputValue(), '5'); assert.equal(await page.locator('[data-special-readiness-form] [name=eta]').isDisabled(), true); }
    await start(page.locator(create), /Creating/); detail = { ...detail, salesOrderId: 101, salesOrderRef: 'TEST-SO', ...(role === 'scm' ? { purchaseOrderId: 102, purchaseOrderRef: 'TEST-PO' } : {}) }; await finish();
    assert.equal(await page.locator('[data-special-document=sales_order]').isEnabled(), true);
    for (const state of [{ salesOrderOperationStatus: 'creating' }, { purchaseOrderOperationStatus: 'creating' }, { quantityReview: { id: 'q', status: 'applying', lines: [] }, quantityReviewPending: true }, { closeStatus: 'closure_pending', closureReview: { id: 'c', status: 'applying' } }]) {
      detail = { ...fixture(role), ...state }; await load();
      assert.equal(await page.locator('.stock-request-detail button:enabled').count(), 0);
      await page.locator('[data-special-operation-status]').waitFor();
      const before = lists; await page.locator('.stock-request-card[data-id="92"]').click();
      assert.equal(await page.locator('[data-special-operation-status]').count(), 0); assert.equal(lists, before);
    }
    if (role === 'scm') {
      for (const kind of ['quantity', 'closure']) {
        detail = { ...fixture(role), purchaseOrderId: 102, purchaseOrderRef: 'TEST-PO', ...(kind === 'quantity' ? { quantityReviewPending: true, quantityReview: { id: 'q', status: 'pending', lines: [{ productName: 'TEST material', fromQuantity: 5, toQuantity: 6 }] } } : { closeStatus: 'closure_pending', closureReason: 'TEST reason', closureReview: { id: 'c', status: 'pending' } }) };
        await load(); const form = `[data-special-${kind}-review-form]`, button = page.locator(`${form} button[value=approve]`);
        await page.locator(`${form} [name=reason]`).fill('Reviewed TEST');
        await start(button, kind === 'quantity' ? /Updating.*NetSuite/ : /Closing.*NetSuite/);
        assert.equal(calls.at(-1).body.reason, 'Reviewed TEST'); assert.equal(calls.at(-1).body.decision, 'approve');
        detail[kind === 'quantity' ? 'quantityReview' : 'closureReview'].status = 'attention';
        await finish(true); assert.equal(await button.isEnabled(), true);
        assert.equal(await page.locator(`${form} [name=reason]`).inputValue(), 'Reviewed TEST');
      }
    } else {
      for (const legacy of [false, true, 'attention']) {
        detail = { ...fixture('scm'), ...(legacy ? { closeStatus: 'closure_pending', closureReason: 'TEST reason' } : {}), ...(legacy === 'attention' ? { closureReview: { id: 'c', status: 'attention', requiresScm: false, error: 'TEST incomplete' } } : {}) };
        await load(); const form = '[data-special-close-form]';
        await page.locator(`${form} [name=reason]`).fill('TEST reason');
        await start(page.locator(`${form} button[type=submit]`), /Closing.*Sales Order.*NetSuite/);
        assert.equal(calls.at(-1).body.reason, 'TEST reason');
        detail.closeStatus = 'closed'; detail.stage = 'closed'; await finish();
        assert.equal(await page.locator(form).count(), 0);
      }
    }
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 390, height: 844 }); detail = { ...fixture(role), salesOrderOperationStatus: 'creating' }; await load();
    await page.screenshot({ path: `${out}/busy-${role}-mobile.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    coverage.push(...await page.coverage.stopJSCoverage());
    await writeFile(`${out}/browser-coverage-${role}.json`, JSON.stringify(coverage));
    results.push({ role, passed: true, mutationRequests: calls.length }); await context.close();
  }
  await writeFile(`${out}/browser.json`, JSON.stringify(results)); console.log(JSON.stringify(results));
} finally { await browser.close(); }
