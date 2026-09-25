// Offline browser replay of the deployed Operator UI. Every request is intercepted.
// The incident fixture contains read-only production evidence; no real receipt is submitted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const artifact = path.resolve(process.env.SN1401278_ARTIFACT || 'test-artifacts/sn1401278-reproduction');
const publicRoot = path.join(artifact, 'live-public');
const evidence = JSON.parse(readFileSync(path.join(artifact, 'incident.json'), 'utf8'));
const output = path.join(artifact, 'browser');
mkdirSync(output, { recursive: true });
const origin = 'http://localhost:32198';
const token = 'offline-sn1401278-reproduction-token';
const sessionKey = createHash('sha256').update(token).digest('hex');
const incidentDurationMs = Date.parse(evidence.command.completed_at) - Date.parse(evidence.command.created_at);
const order = { ...evidence.order, order_type: 'purchase_order', vendor: 'Incident replay',
  receipt_status: 'pending', last_item_receipt_id: null, last_item_receipt_tranid: null,
  received_at: null, line_count: evidence.order.lines.length };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const reports = [];
const scenarios = [
  { name: 'purchase-normal', initialType: 'purchase_order', delayMs: incidentDurationMs },
  { name: 'purchase-reload-during-posting', initialType: 'purchase_order', reload: true },
  { name: 'transfer-search-normal', initialType: 'transfer_order' },
  { name: 'transfer-search-reload-during-posting', initialType: 'transfer_order', reload: true },
  { name: 'co-search-reload-during-posting', initialType: 'co_order', reload: true },
  { name: 'purchase-app-update-during-posting', initialType: 'purchase_order', appUpdate: true },
  { name: 'transfer-search-app-update-during-posting', initialType: 'transfer_order', appUpdate: true },
  { name: 'direct-mobile-normal', initialType: 'purchase_order', mobile: true, confirmPage: true, delayMs: incidentDurationMs },
  { name: 'direct-mobile-lost-response', initialType: 'purchase_order', mobile: true, confirmPage: true, lostResponse: true },
  { name: 'direct-mobile-app-update', initialType: 'purchase_order', mobile: true, confirmPage: true, appUpdate: true },
  { name: 'direct-mobile-legacy-normal', initialType: 'purchase_order', mobile: true, confirmPage: true, legacy: true },
  { name: 'direct-mobile-legacy-app-update', initialType: 'purchase_order', mobile: true, confirmPage: true, legacy: true, appUpdate: true },
];
const selectedScenarios = process.env.SN1401278_DIRECT_ONLY === '1'
  ? scenarios.filter(scenario => scenario.name.startsWith('direct-')) : scenarios;

try {
  for (const scenario of selectedScenarios) {
    let submitted = 0, jobReads = 0, requestId = '', status = 'posting', postedAt = 0;
    let pageConfirmations = 0, loadCurrentAssets = !scenario.legacy;
    const requests = [], errors = [];
    const context = await browser.newContext({ viewport: scenario.mobile ? { width: 412, height: 915 } : { width: 1024, height: 768 },
      hasTouch: true, isMobile: Boolean(scenario.mobile), serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    const activate = locator => scenario.mobile ? locator.tap() : locator.click();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'Offline replay attempted an unexpected destination');
      if (url.pathname.startsWith('/api/')) {
        requests.push({ method: route.request().method(), path: url.pathname });
        let value = {};
        if (url.pathname === '/api/auth/me') {
          value = { operator: { id: 'incident-replay', display_name: 'Incident replay', role: 'operator',
            roles: ['operator'], operatorYardLocationIds: [1] } };
        } else if (url.pathname === '/api/delivery/notifications') {
          value = { total: 0, salesOrder: {}, transferOrder: {}, items: [] };
        } else if (url.pathname === '/api/delivery/current-draft') value = null;
        else if (url.pathname === '/api/receiving/orders') value = status === 'completed' ? [] : [order];
        else if (url.pathname === `/api/receiving/orders/${order.netsuite_id}`) {
          value = scenario.confirmPage && !pageConfirmations ? { ...order, lines: order.lines.map(line => ({ ...line,
            received_pallet_qty: 0, received_section_qty: 0, received_layer_qty: 0, received_piece_qty: 0, received_sales_qty: 0 })) } : order;
        } else if (url.pathname.endsWith('/lines/confirm-page')) {
          pageConfirmations += 1;
          value = { order, confirmed: order.lines.length, failures: [] };
        }
        else if (['/api/receiving/vendors', '/api/receiving/sources', '/api/receiving/items'].includes(url.pathname)) value = [];
        else if (url.pathname === '/api/operator/netsuite-posting-policy') {
          value = { effective: true, gateKey: 'operator_netsuite_receiving_ir_3445', revision: 4 };
        } else if (url.pathname === `/api/receiving/orders/${order.netsuite_id}/receive`) {
          submitted += 1;
          postedAt = Date.now();
          assert.equal(submitted, 1, 'Duplicate receipt submission');
          const body = route.request().postDataJSON();
          assert.equal(body.orderType, 'purchase_order');
          requestId = body.requestId;
          if (scenario.lostResponse) { status = 'completed'; return route.abort('failed'); }
          value = { status: 'running', posting: true, jobId: requestId };
        } else if (url.pathname.startsWith('/api/operator/netsuite-posting-jobs/')) {
          jobReads += 1;
          assert.equal(url.pathname.split('/').at(-1), requestId);
          value = { id: requestId, functionKey: 'receiving', status,
            result: status === 'completed' ? evidence.command.result : {},
            steps: evidence.steps.map(step => ({ transactionType: 'IR',
              status: status === 'completed' ? 'posted' : 'posting',
              transactionId: status === 'completed' ? step.netsuite_transaction_id : null,
              transactionRef: status === 'completed' ? step.netsuite_transaction_ref : null })) };
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      }
      const file = url.pathname === '/operator' ? 'operator.html' : url.pathname.slice(1);
      if (file === 'operator.js' && !loadCurrentAssets) {
        return route.fulfill({ contentType: 'application/javascript', body: readFileSync(path.join(artifact, 'legacy-operator.js')) });
      }
      const candidate = path.resolve(publicRoot, file);
      assert.ok(candidate.startsWith(publicRoot + '/'));
      return route.fulfill({ body: readFileSync(candidate), contentType:
        file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css'
          : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html' });
    });
    await page.addInitScript(({ token, sessionKey }) => {
      window.EventSource = class {
        addEventListener(name, callback) { if (name === 'app-event') window.incidentEvent = callback; }
        close() {}
      };
      localStorage.setItem('mbbs.staff.token', token);
      localStorage.setItem('mbbs.operator.token', token);
      localStorage.setItem('mbbs.operator.locationId', '1');
      localStorage.setItem('mbbs.ui.language', 'en');
      if (!localStorage.getItem('mbbs.operator.state')) localStorage.setItem('mbbs.operator.state',
        JSON.stringify({ locationId: 1, currentModule: 'receiving', accountId: 'incident-replay', sessionKey }));
      window.incidentClicks = [];
      document.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (button) window.incidentClicks.push(button.dataset.action || button.textContent.trim());
      }, true);
    }, { token, sessionKey });
    const snapshot = async () => page.evaluate(() => ({
      module: currentModule,
      heading: document.querySelector('h1')?.textContent,
      irVisible: document.querySelector('#app')?.textContent.includes('IR14813'),
      state: JSON.parse(localStorage.getItem('mbbs.operator.state')),
      journals: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('mbbs.operator.receipt:'))
        .map(key => [key, JSON.parse(localStorage.getItem(key))])),
      clicks: window.incidentClicks,
    }));
    const emit = async type => page.evaluate(({ type, orderId, jobId }) => window.incidentEvent({
      data: JSON.stringify({ type, payload: { orderId, jobId } }),
    }), { type, orderId: String(order.netsuite_id), jobId: requestId });

    try {
      await page.goto(origin + '/operator');
      if (scenario.initialType !== 'purchase_order') {
        await activate(page.locator(`[data-action="select-receiving-type"][data-order-type="${scenario.initialType}"]`));
      }
      await page.locator('#receivingSearch').fill(order.tranid);
      if (scenario.mobile) await page.locator('#receivingSearch').press('Enter');
      if (scenario.confirmPage) {
        await activate(page.locator('[data-action="confirm-receiving-page"]'));
        await expect(page.locator('[data-action="start-receive"]')).toBeEnabled();
      }
      await activate(page.locator('[data-action="start-receive"]'));
      await expect(page.locator('[data-action="confirm-receive"]')).toBeVisible();
      await page.evaluate(() => {
        receiptPhotoDataUrls = ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='];
        prepareOperatorBackgroundPhotos = async () => ({ backgroundPhotos: [{ id: 'offline-photo-1' }, { id: 'offline-photo-2' }] });
        resumeOperatorBackgroundPhotos = () => {};
        render();
      });
      await activate(page.locator('[data-action="confirm-receive"]'));
      if (scenario.legacy) await expect.poll(() => jobReads).toBeGreaterThan(0);
      else if (scenario.lostResponse) await expect(page.locator('.fulfillment-card.success')).toContainText('IR14813');
      else await expect(page.locator('[data-receipt-posting-status]')).toBeVisible();
      await expect.poll(() => submitted).toBe(1);
      const before = await snapshot();
      await page.screenshot({ path: path.join(output, scenario.name + '-posting.png'), fullPage: true });
      if (scenario.reload || scenario.appUpdate) {
        status = 'completed';
        if (scenario.appUpdate) {
          loadCurrentAssets = true;
          // Exercise the deployed controllerchange listener, which reloads the page automatically.
          await Promise.all([
            page.waitForEvent('load'),
            page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))),
          ]);
        } else await page.reload();
        await expect.poll(async () => (await snapshot()).heading).toMatch(/Receiving/);
      } else {
        if (scenario.delayMs) {
          await emit('dispatch.orders.updated');
          await page.waitForTimeout(Math.max(0, scenario.delayMs - (Date.now() - postedAt)));
          await expect(page.locator('#app')).toHaveAttribute('data-module', 'receiving-receipt');
        }
        // Real receipt completion wakes the same poller and triggers background refresh.
        status = 'completed';
        await emit('receiving.order.received');
        await expect(page.locator('.fulfillment-card.success')).toContainText('IR14813');
        await emit('dispatch.orders.updated');
      }
      await page.waitForTimeout(1200);
      const after = await snapshot();
      await page.screenshot({ path: path.join(output, scenario.name + '-after.png'), fullPage: true });
      assert.equal(submitted, 1);
      assert.deepEqual(errors, []);
      assert.ok(!before.clicks.includes('finish-receive'));
      assert.ok(!after.clicks.includes('finish-receive'));
      const report = { ...scenario, reproduced: after.module === 'receiving' && !after.irVisible,
        submitted, jobReads, pageConfirmations, before, after, errors, requests };
      const shouldReproduce = (scenario.reload || scenario.appUpdate)
        && (scenario.initialType !== 'purchase_order' || scenario.legacy);
      assert.equal(report.reproduced, Boolean(shouldReproduce), 'Unexpected reproduction outcome');
      if (shouldReproduce) {
        assert.equal(jobReads, 1, 'The wrong saved type must skip receipt recovery');
        assert.equal(Object.keys(after.journals).length, scenario.legacy ? 0 : 1);
      } else {
        assert.equal(after.irVisible, true);
        assert.equal(after.heading, 'Receiving Complete');
      }
      reports.push(report);
      console.log(JSON.stringify({ scenario: scenario.name, reproduced: report.reproduced,
        screen: after.heading, irVisible: after.irVisible, submitted, jobReads }));
    } catch (error) {
      await page.screenshot({ path: path.join(output, scenario.name + '-error.png'), fullPage: true }).catch(() => {});
      console.error(JSON.stringify({ scenario: scenario.name, error: error.message, state: await snapshot().catch(() => null), errors }));
      throw error;
    } finally {
      await context.tracing.stop({ path: path.join(output, scenario.name + '-trace.zip') });
      await context.close();
    }
  }
} finally {
  writeFileSync(path.join(output, process.env.SN1401278_DIRECT_ONLY === '1' ? 'direct-results.json' : 'results.json'), JSON.stringify({ browser: browser.version(),
    sources: evidence.assets,
    legacyOperatorSha256: createHash('sha256').update(readFileSync(path.join(artifact, 'legacy-operator.js'))).digest('hex'),
    reproducerSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    incidentReceipt: evidence.order.last_item_receipt_tranid,
    network: 'disabled; all browser requests intercepted', reports }, null, 2) + '\n');
  await browser.close();
}
