import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { buildSalesResplits } from '../../../src/dispatch-sales-resplit-repository.js';

test('S4 refreshed during entry submits S5 2232 and S6 2356 without losing the draft', async () => {
  const source = { id: 'SOA09140-S4', type: 'SO', originalOrderId: 'SOA09140',
    sourceTable: 'sales_orders', customer: 'Split identity fixture', operatorStatus: 'open',
    localYardOrderStatus: 'Open', pickupLocations: ['3445'], sourceYard: '3445',
    address: 'Isolated Test Road', destinationAddress: 'Isolated Test Road',
    salesQty: 4588, pallets: 0, items: [{ lineId: 4997388, lineRowId: 470031, itemId: 2055,
      sku: 'MBBS-Special Order', itemName: 'MBBS-Special Order', itemType: 'NonInvtPart',
      quantity: 4588, unit: 'SQFT', pallets: 0, layers: 0, sections: 0, pieces: 0,
      toPlt: 0, toLyr: 0, toSec: 0, toPcs: 0 }] };
  const fresh = { ...structuredClone(source), items: source.items.map(line => ({
    ...line, lineRowId: -133471750519201
  })) };
  const requests = [], saves = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html><head><link rel="stylesheet" href="/dispatch.css"></head><body><main id="dispatchApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script></body></html>');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    let result = {};
    if (url.pathname.endsWith('/split-preview')) result = source;
    else if (url.pathname === '/api/dispatch/orders') result = [fresh];
    else if (url.pathname === '/api/dispatch/split-orders/resplit') {
      requests.push(payload);
      result = { orders: buildSalesResplits(source, payload.parts, 5),
        retiredGlobalOrderRefs: [source.id], planRevision: 2, planDigest: 'split-saved' };
    } else if (url.pathname === '/api/dispatch/plans/split-identity-test' && req.method === 'PUT') {
      saves.push(payload); result = { ...payload, id: 'split-identity-test', revision: 2, status: 'draft' };
    } else if (url.pathname === '/api/dispatch/v2/plans/split-identity-test/commands') {
      saves.push(payload.payload);
      result = { plan: { ...payload.payload, id: 'split-identity-test', revision: 3,
        digest: 'plan-saved', status: 'draft' } };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
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
      currentPlan = { id: 'split-identity-test', planDate: currentPlanDate, revision: 1,
        status: 'draft', orders, trucks };
      dispatchConfig = { plannerOrderPoolMode: 'off', plannerCommandMode: 'off', googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = 'ready';
      planEditMode = true; planEditLeaseToken = 'test-token';
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      selectedOrderId = input.id; selectedOrderIds = new Set([input.id]);
      render({ save: false });
    }, fresh);
    await page.locator('[data-action="open-split-modal"]').click();
    const first = page.locator('[data-split-index="0"]');
    const second = page.locator('[data-split-index="1"]');
    const confirm = page.locator('[data-action="confirm-split"]');
    await first.fill('2232');
    await page.evaluate(input => { mergeDispatchOrderSearchFeed([input]); }, fresh);
    await second.fill('2356');
    assert.equal(await page.evaluate(() => splitQuantityValidationMessage(orderById('SOA09140-S4'))), '');
    await expect(confirm).toBeEnabled();
    await expect(page.locator('[data-split-quantity-validation]')).toBeHidden();
    await page.evaluate(input => {
      mergeDispatchOrderSearchFeed([input]);
      renderDispatchModalInPlace();
    }, source);
    await expect(first).toHaveValue('2232');
    await expect(second).toHaveValue('2356');
    await expect(confirm).toBeEnabled();
    await second.fill('2357');
    await expect(confirm).toBeDisabled();
    await expect(page.locator('[data-split-quantity-validation]')).toContainText('1 SQFT over');
    assert.equal(requests.length, 0);
    await second.fill('2356');
    await confirm.click();
    await expect.poll(() => requests.length).toBe(1);
    await expect.poll(() => saves.length).toBeGreaterThan(0);
    assert.deepEqual(requests[0].parts.map(part => part.items[0].quantity), [2232, 2356]);
    assert.equal(requests[0].orderRef, source.id);
    const saved = saves.at(-1).orders;
    assert.deepEqual(saved.map(order => [order.id, order.items[0].quantity]),
      [['SOA09140-S5', 2232], ['SOA09140-S6', 2356]]);
    assert.deepEqual(errors, []);
    const out = 'test-artifacts/split-draft-identity-20261020/browser';
    await mkdir(out, { recursive: true });
    const coverage = (await page.coverage.stopJSCoverage()).filter(row => row.url.endsWith('/dispatch.js'));
    await writeFile(out + '/coverage.json', JSON.stringify(coverage));
    await page.screenshot({ path: out + '/saved-s5-s6.png', fullPage: true });
    await writeFile(out + '/result.json', JSON.stringify({ requests: requests.length,
      saved: saved.map(order => [order.id, order.items[0].quantity]), pageErrors: errors,
      refreshDuringEntry: true, refreshAfterEntry: true, excessBlocked: true }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
