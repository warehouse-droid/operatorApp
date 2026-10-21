import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

test('split dialog blocks shortage and excess immediately, then saves the corrected balance', async () => {
  const order = { id: 'SOA09140', type: 'SO', sourceTable: 'sales_orders', customer: 'Quantity test',
    address: 'Isolated Test Road', destinationAddress: 'Isolated Test Road', sourceYard: '3445',
    pickupLocations: ['3445'], netsuiteId: '1006337', salesQty: 8432, pallets: 136, operatorStatus: 'open',
    items: [{ lineId: 4997388, itemId: 2055, itemName: 'MBBS-Special Order',
      sku: 'MBBS-Special Order', itemType: 'NonInvtPart', quantity: 8432, unit: 'SQFT', pallets: 136 }] };
  const saves = [], audits = [], requests = [];
  let pauseSeed = false, releaseSeed;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.pathname);
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url))); return;
    }
    if (!url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dispatch.css"></head><body><main id="dispatchApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script></body></html>');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    let result = {};
    if (url.pathname.endsWith('/split-preview')) result = order;
    else if (url.pathname.endsWith('/split-seed')) {
      if (pauseSeed) await new Promise(resolve => { releaseSeed = resolve; });
      result = { nextSuffix: 1 };
    }
    else if (url.pathname === '/api/dispatch/orders') result = [order];
    else if (url.pathname === '/api/dispatch/plans/split-quantity-test' && req.method === 'PUT') {
      saves.push(payload); result = { ...payload, id: 'split-quantity-test', revision: 2, status: 'draft' };
    } else if (url.pathname === '/api/dispatch/v2/plans/split-quantity-test/commands') {
      saves.push(payload.payload);
      result = { plan: { ...payload.payload, id: 'split-quantity-test', revision: 2, digest: 'saved-digest', status: 'draft' } };
    } else if (url.pathname.includes('audit')) audits.push(payload);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = [normalizeOrder(input)]; orderCatalog = structuredClone(orders);
      trucks = []; fleet = []; splitParts = 2;
      currentPlanDate = todayLocalDate();
      currentPlan = { id: 'split-quantity-test', planDate: currentPlanDate, revision: 1,
        status: 'draft', orders, trucks: [] };
      dispatchConfig = { plannerOrderPoolMode: 'off', plannerCommandMode: 'off', googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = 'ready';
      planEditMode = true; planEditLeaseToken = 'test-token';
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      selectedOrderId = ''; selectedOrderIds = new Set();
      render({ save: false });
    }, order);
    const edgeCases = await page.evaluate(() => {
      const source = orders[0];
      ensureSplitDraft(source, true);
      const key = Object.keys(splitDraft.items)[0];
      const missing = splitQuantityValidationMessage({});
      splitDraft.items[key] = [{ quantity: -1 }, { quantity: 8433 }];
      const negative = splitQuantityValidationMessage(source);
      splitDraft.items[key] = [{ quantity: 0 }, { quantity: 8432 }];
      const empty = splitQuantityValidationMessage(source);
      const absent = splitOrder('missing');
      orders.push({ ...source, id: 'CUSTOM-TEST', type: 'CUSTOM' },
        { ...source, id: 'GROUP-TEST', childOrders: ['SOA09140'] });
      const custom = splitOrder('CUSTOM-TEST'), group = splitOrder('GROUP-TEST');
      orders = [source];
      ensureSplitDraft(source, true);
      return { missing, negative, empty, absent, custom, group };
    });
    assert.match(edgeCases.missing, /source item quantities are missing/u);
    assert.match(edgeCases.negative, /nonnegative/u);
    assert.match(edgeCases.empty, /positive quantity/u);
    assert.equal(edgeCases.absent, false);
    assert.equal(edgeCases.custom, false);
    assert.equal(edgeCases.group, false);
    await page.locator('.order-card[data-order="SOA09140"]').click();
    await page.locator('[data-action="open-split-modal"]').click();
    await page.locator('#splitParts').fill('2');
    await page.locator('#splitParts').dispatchEvent('change');
    const confirm = page.locator('[data-action="confirm-split"]');
    const first = page.locator('[data-split-index="0"]');
    const second = page.locator('[data-split-index="1"]');
    await first.fill('1860');
    await second.fill('2356');
    await expect(confirm).toBeDisabled();
    await expect(page.locator('[data-split-quantity-validation]')).toContainText('4,216 SQFT short');
    await page.evaluate(() => {
      const button = document.querySelector('[data-action="confirm-split"]');
      button.disabled = false;
      button.click();
    });
    await expect(confirm).toBeDisabled();
    assert.equal(saves.length, 0);
    assert.equal(await page.evaluate(() => orders.some(order => order.id === 'SOA09140')), true);
    await second.fill('6573');
    await expect(confirm).toBeDisabled();
    await expect(page.locator('[data-split-quantity-validation]')).toContainText('1 SQFT over');
    await second.fill('6572');
    await expect(confirm).toBeEnabled();
    await expect(page.locator('[data-split-quantity-validation]')).toBeHidden();
    await page.evaluate(() => { routeNotice = ''; });
    pauseSeed = true;
    await confirm.click();
    await expect.poll(() => typeof releaseSeed).toBe('function');
    await second.fill('2356');
    releaseSeed();
    await expect.poll(() => page.evaluate(() => routeNotice)).toContain('4,216 SQFT short');
    assert.equal(saves.length, 0);
    assert.equal(await page.evaluate(() => orders.some(order => order.id === 'SOA09140')), true);
    pauseSeed = false;
    await second.fill('6572');
    await confirm.click();
    await expect.poll(() => saves.length).toBeGreaterThan(0);
    const saved = saves.at(-1).orders.filter(order => order.originalOrderId === 'SOA09140');
    assert.deepEqual(saved.map(order => order.items[0].quantity), [1860, 6572]);
    assert.equal(saved.reduce((sum, order) => sum + order.items[0].quantity, 0), 8432);
    assert.equal(audits.filter(row => row.action === 'order_split').length, 1);
    assert.deepEqual(errors, []);
    const coverage = (await page.coverage.stopJSCoverage()).filter(row => row.url.endsWith('/dispatch.js'))
      .map(row => ({ ...row, url: 'file:///app/public/dispatch.js' }));
    await mkdir('test-artifacts/split-quantity-20261020/browser', { recursive: true });
    await writeFile('test-artifacts/split-quantity-20261020/browser/coverage.json', JSON.stringify({ result: coverage }));
    await page.screenshot({ path: 'test-artifacts/split-quantity-20261020/browser/balanced-splits.png', fullPage: true });
    await writeFile('test-artifacts/split-quantity-20261020/browser/result.json', JSON.stringify({
      shortageBlocked: true, excessBlocked: true, correctedQuantities: [1860, 6572], pageErrors: errors,
      saves: saves.length, splitAudits: audits.filter(row => row.action === 'order_split').length,
      changedWhileAwaitingSeedBlocked: true, edgeCases
    }, null, 2));
  } finally {
    releaseSeed?.();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
