// Offline browser replay of the deployed Operator UI. Every request is intercepted.
// The incident fixture contains read-only production evidence; no real receipt is submitted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const artifact = path.resolve('test-artifacts/receipt-confirmation');
const incidentRoot = path.resolve('test-artifacts/sn1401278-reproduction');
const publicRoot = path.resolve(process.env.RECEIPT_CONFIRMATION_PUBLIC || 'public');
const evidence = JSON.parse(readFileSync(path.join(incidentRoot, 'incident.json'), 'utf8'));
const output = path.join(artifact, 'browser');
mkdirSync(output, { recursive: true });
const origin = 'http://localhost:32198';
const token = 'test-offline-sn1401278-reproduction-token';
const sessionKey = createHash('sha256').update(token).digest('hex');
const incidentDurationMs = Date.parse(evidence.command.completed_at) - Date.parse(evidence.command.created_at);
const order = { ...evidence.order, order_type: 'purchase_order', vendor: 'Incident replay',
  receipt_status: 'pending', last_item_receipt_id: null, last_item_receipt_tranid: null,
  received_at: null, line_count: evidence.order.lines.length };
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const reports = [];
const scenarios = [
  { name: 'direct-mobile-normal', initialType: 'purchase_order', mobile: true, confirmPage: true, delayMs: incidentDurationMs },
  { name: 'direct-mobile-lost-response', initialType: 'purchase_order', mobile: true, confirmPage: true, lostResponse: true },
  { name: 'direct-mobile-app-update', initialType: 'purchase_order', mobile: true, confirmPage: true, appUpdate: true },
  { name: 'direct-mobile-legacy-app-update', initialType: 'purchase_order', mobile: true, confirmPage: true, legacy: true, appUpdate: true },
  { name: 'legacy-lookup-outage', initialType: 'purchase_order', legacy: true, appUpdate: true, lookupOutage: true },
  { name: 'transfer-search-reload', initialType: 'transfer_order', reload: true },
  { name: 'co-search-reload', initialType: 'co_order', reload: true },
  { name: 'completed-offline-reload', initialType: 'purchase_order', offlineCompleted: true },
  { name: 'partial-receipt-acknowledgement', initialType: 'purchase_order', partial: true },
];
const selectedScenarios = scenarios.filter(scenario => !process.env.RECEIPT_CONFIRMATION_SCENARIO
  || scenario.name === process.env.RECEIPT_CONFIRMATION_SCENARIO);

try {
  for (const scenario of selectedScenarios) {
    let submitted = 0, jobReads = 0, requestId = '', status = 'posting', postedAt = 0;
    let pageConfirmations = 0, loadCurrentAssets = !scenario.legacy, lookupReads = 0, offline = false, navigations = 0;
    const requests = [], errors = [], coverage = [];
    const context = await browser.newContext({ viewport: scenario.mobile ? { width: 412, height: 915 } : { width: 1024, height: 768 },
      hasTouch: true, isMobile: Boolean(scenario.mobile), serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations += 1; });
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
        else if (url.pathname === '/api/receiving/orders') value = status === 'completed' && !scenario.partial ? [] : [order];
        else if (url.pathname.endsWith('/posting-status')) {
          lookupReads += 1;
          if (scenario.lookupOutage && lookupReads === 1) return route.abort('failed');
          value = { order, job: { id: requestId, requestId, functionKey: 'receiving', status,
            result: status === 'completed' ? evidence.command.result : {},
            steps: evidence.steps.map(step => ({ transactionType: 'IR', status: 'posted',
              transactionId: step.netsuite_transaction_id, transactionRef: step.netsuite_transaction_ref })) } };
        }
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
          if (offline) return route.abort('failed');
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
      if (file.startsWith('vendor/')) {
        return route.fulfill({ contentType: 'application/javascript', body: readFileSync(path.join(incidentRoot, 'live-public', file)) });
      }
      if (file === 'operator.js' && !loadCurrentAssets) {
        return route.fulfill({ contentType: 'application/javascript', body: readFileSync(path.join(incidentRoot, 'legacy-operator.js')) });
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
          if (scenario.legacy) {
            await Promise.all([
              page.waitForEvent('load'),
              page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))),
            ]);
          } else {
            await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
            await page.waitForTimeout(300);
            assert.equal(navigations, 1, 'An update must not dismiss active receiving');
            await emit('receiving.order.received');
          }
        } else await page.reload();
        if (scenario.lookupOutage) {
          await expect(page.locator('[data-receipt-posting-status]')).toContainText('Could not refresh');
          await page.locator('[data-action="refresh-receipt-posting"]').click();
        }
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
      await expect(page.locator('.fulfillment-card.success')).toContainText('IR14813');
      if (scenario.offlineCompleted) {
        offline = true;
        await page.reload();
        await expect(page.locator('[data-receipt-posting-status]')).toContainText('IR14813');
      }
      await page.waitForTimeout(1200);
      const after = await snapshot();
      await page.screenshot({ path: path.join(output, scenario.name + '-after.png'), fullPage: true });
      assert.equal(submitted, 1);
      assert.deepEqual(errors, []);
      assert.ok(!before.clicks.includes('finish-receive'));
      assert.ok(!after.clicks.includes('finish-receive'));
      const report = { ...scenario, submitted, jobReads, lookupReads, pageConfirmations, before, after, errors, requests };
      assert.equal(after.irVisible, true);
      assert.equal(after.module, 'receiving-receipt');
      // Preserve precise counts before acknowledgement can unload this script.
      coverage.push(...await page.coverage.stopJSCoverage());
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      if (!scenario.offlineCompleted) {
        assert.equal(after.heading, 'Receiving Complete');
        const beforeAcknowledgement = navigations;
        await page.locator('[data-action="finish-receive"]').first().click();
        await expect(page.locator('#receivingSearch')).toBeVisible();
        if (scenario.appUpdate && !scenario.legacy) {
          assert.equal(navigations, beforeAcknowledgement + 1, 'Deferred update applies after acknowledgement');
        }
        assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('mbbs.operator.receipt:')).length), 0);
        if (scenario.partial) {
          await page.locator('#receivingSearch').fill(order.tranid);
          await expect(page.locator('[data-action="start-receive"]')).toBeVisible();
          await page.reload();
          await expect(page.locator('[data-action="start-receive"]')).toBeVisible();
          assert.equal(lookupReads, 0, 'An acknowledged partial receipt must not be restored again');
          await page.locator('[data-action="start-receive"]').click();
          await expect(page.locator('[data-action="confirm-receive"]')).toBeVisible();
        }
      }
      assert.equal(submitted, 1);
      reports.push(report);
      console.log(JSON.stringify({ scenario: scenario.name, passed: true,
        screen: after.heading, irVisible: after.irVisible, submitted, jobReads }));
    } catch (error) {
      await page.screenshot({ path: path.join(output, scenario.name + '-error.png'), fullPage: true }).catch(() => {});
      console.error(JSON.stringify({ scenario: scenario.name, error: error.message, state: await snapshot().catch(() => null), errors }));
      throw error;
    } finally {
      coverage.push(...await page.coverage.stopJSCoverage());
      writeFileSync(path.join(output, scenario.name + '-coverage.json'), JSON.stringify(coverage));
      await context.tracing.stop({ path: path.join(output, scenario.name + '-trace.zip') });
      await context.close();
    }
  }
} finally {
  writeFileSync(path.join(output, 'results.json'), JSON.stringify({ browser: browser.version(),
    sources: Object.fromEntries(['operator.js','operator.html','service-worker.js'].map(file => [file, createHash('sha256').update(readFileSync(path.join(publicRoot, file))).digest('hex')])),
    legacyOperatorSha256: createHash('sha256').update(readFileSync(path.join(incidentRoot, 'legacy-operator.js'))).digest('hex'),
    reproducerSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    incidentReceipt: evidence.order.last_item_receipt_tranid,
    network: 'disabled; all browser requests intercepted', reports }, null, 2) + '\n');
  await browser.close();
}
