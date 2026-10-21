import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

const pair = ['SOA09143-S5', 'SOA09140-S5'].map((id, index) => ({
  id, type: 'SO', originalOrderId: id.split('-')[0], resplitSourceOrderId: id.replace('S5', 'S4'),
  globalOrderDefinition: true, globalOrderDefinitionKind: 'split', isSplit: true,
  globalOrderSourcePlanId: '364', globalOrderSourcePlanDate: '2026-10-20',
  sourceTable: 'sales_orders', customer: 'Grouping test', address: 'Test delivery',
  sourceYard: '3445', pickupLocations: ['3445'], salesQty: index ? 2232 : 37,
  catalogHydrated: true, itemCount: index ? 1 : 2, operatorStatus: 'open',
  items: (index ? [2232] : [36, 1]).map((quantity, n) => ({
    lineId: index * 100 + n, itemId: index * 100 + n, sku: `ITEM-${index}-${n}`, quantity,
    pallets: 0, layers: 0, pieces: 0, sections: 0
  }))
}));

async function fixture(run) {
  const requests = [], saves = [], errors = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (/\.(js|css)$/.test(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url))); return;
    }
    if (!url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><link rel="stylesheet" href="/dispatch.css"></head><body><main id="dispatchApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script></body></html>');
      return;
    }
    requests.push(url.pathname + url.search);
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    let result = {};
    if (url.pathname.endsWith('/planned-assignments')) {
      if (url.searchParams.get('includeSnapshots') !== 'false') await new Promise(resolve => setTimeout(resolve, 2200));
      result = [];
    } else if (url.pathname.endsWith('/acquire')) {
      result = { lease: { active: true, sessionId: input.sessionId, planDate: input.planDate }, editLeaseToken: 'isolated-lease' };
    } else if (url.pathname.endsWith('/heartbeat')) {
      result = { lease: { active: true, sessionId: input.sessionId, planDate: input.planDate } };
    } else if (url.pathname.endsWith('/bootstrap')) {
      result = { plan: { id: '364', planDate: '2026-10-20', revision: 51, digest: 'saved', trucks: [], assignedOrderSnapshots: [] } };
    } else if (url.pathname.includes('/order-feed/')) {
      await new Promise(resolve => setTimeout(resolve, 180));
      result = { order: pair.find(order => order.id === decodeURIComponent(url.pathname.split('/').at(-1))) };
    } else if (url.pathname.endsWith('/orders')) result = pair.map(order => ({ ...order, catalogHydrated: false }));
    else if (url.pathname.includes('/commands')) {
      saves.push(input);
      result = { plan: { ...input.payload, id: '364', planDate: '2026-10-20', revision: 52, digest: 'group-saved' } };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  let browser, page;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = input.map(normalizeOrder); orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      currentPlanDate = '2026-10-20';
      currentPlan = { id: '364', planDate: currentPlanDate, revision: 51, digest: 'saved', status: 'draft' };
      dispatchConfig = { plannerCommandMode: 'on', plannerOrderPoolMode: 'off', googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = 'ready';
      selectedOrderId = input[0].id; selectedOrderIds = new Set(input.map(order => order.id));
      planEditMode = false; planEditLease = null; planEditLeaseToken = '';
      window.__clicks = [];
      app.addEventListener('click', event => window.__clicks.push(event.target.closest('button')?.dataset.action), true);
      render({ save: false });
    }, pair);
    await run({ page, requests, saves });
    assert.deepEqual(errors, []);
    const out = 'test-artifacts/edit-group-browser';
    await mkdir(out, { recursive: true });
    await writeFile(`${out}/coverage-${requests.length}-${Date.now()}.json`, JSON.stringify(await page.coverage.stopJSCoverage()));
  } catch (error) {
    console.error(JSON.stringify({ requests, saves: saves.length, errors,
      state: await page?.evaluate(() => ({ notice: routeNotice, editing: planEditMode,
        dirty: localPlanDirty, snapshot: dispatchPlannerSnapshotState, selected: selectedOrderId,
        pending: Boolean(pendingDispatchPlanAction), orderIds: orders.map(order => order.id),
        groupPending: Boolean(dispatchGroupHydrationPromise), detailsPending: dispatchOrderHydrationPromises.size,
        clicks: window.__clicks, modal: modalType })).catch(() => null) }));
    throw error;
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('Edit Mode refreshes ownership without downloading full assignment snapshots', () => fixture(async ({ page, requests }) => {
  const started = Date.now();
  await page.locator('[data-action="enter-edit-mode"]').click();
  await expect(page.locator('[data-action="exit-edit-mode"]')).toBeVisible({ timeout: 1400 });
  assert.ok(Date.now() - started < 1800);
  assert.ok(requests.includes('/api/dispatch/planned-assignments?includeSnapshots=false'));
  assert.ok(requests.some(url => url.includes('/acquire')));
  assert.ok(requests.some(url => url.includes('/bootstrap')));
}));

test('group hydration survives queued background events and retains every selected item', () => fixture(async ({ page }) => {
  const result = await page.evaluate(async () => {
    orders[0].catalogHydrated = false;
    const pending = hydrateDispatchGroupSelection();
    queueDispatchOrderPoolRefresh('Unrelated order updated', { orderId: 'SO-OTHER' });
    queueDispatchOrderPoolRefresh('Selected source updated', { orderId: 'SOA09143' });
    await pending;
    return selectedOrders().map(order => ({ id: order.id, items: order.items.map(item => item.quantity),
      needsHydration: dispatchGroupOrderNeedsHydration(order) }));
  });
  assert.deepEqual(result, pair.map(order => ({ id: order.id, items: order.items.map(item => item.quantity), needsHydration: false })));
}));

test('group container has its own identity while children retain their split identities', () => fixture(async ({ page }) => {
  const group = await page.evaluate(() => {
    if (!groupOrder(selectedOrderId)) throw new Error(routeNotice);
    return orderById(selectedOrderId);
  });
  assert.equal(group.id, 'GOA-9140S5-9143S5');
  assert.ok(!group.originalOrderId);
  assert.ok(!group.resplitSourceOrderId);
  assert.notEqual(group.globalOrderDefinitionKind, 'split');
  assert.equal(group.isSplit, false);
  assert.deepEqual(group.childOrderDetails.map(order => [order.id, order.originalOrderId]),
    pair.map(order => [order.id, order.originalOrderId]));
  assert.deepEqual(group.items.map(item => item.quantity), [36, 1, 2232]);
}));

test('confirming Group sends one save containing all split members and quantities', () => fixture(async ({ page, saves }) => {
  await page.evaluate(async () => {
    await enterDispatchEditMode();
    orders[0].catalogHydrated = false;
    render({ save: false });
  });
  await page.locator('[data-action="open-group-modal"]').click();
  await page.locator('[data-action="confirm-group"]').click();
  await expect.poll(() => saves.length).toBe(1);
  const group = saves[0].payload.orders.find(order => order.id === 'GOA-9140S5-9143S5');
  assert.ok(group);
  assert.ok(!group.originalOrderId);
  assert.deepEqual(group.items.map(item => item.quantity), [36, 1, 2232]);
  assert.deepEqual(group.childOrderDetails.map(order => order.id), pair.map(order => order.id));
}));

for (const change of ['selection', 'generation', 'date']) {
  test(`group hydration rejects a changed ${change} without grouping`, () => fixture(async ({ page }) => {
    const message = await page.evaluate(async change => {
      orders[0].catalogHydrated = false;
      const pending = hydrateDispatchGroupSelection();
      if (change === 'selection') selectedOrderIds = new Set([orders[0].id]);
      if (change === 'generation') localPlanGeneration++;
      if (change === 'date') currentPlanDate = '2026-10-21';
      try { await pending; return ''; } catch (error) { return error.message; }
    }, change);
    assert.match(message, /selection|changed|complete/i);
    assert.equal(await page.evaluate(() => orders.some(order => order.id.startsWith('GO'))), false);
  }));
}
