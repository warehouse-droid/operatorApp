import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import v8ToIstanbul from 'v8-to-istanbul';

const artifact = `test-artifacts/freshness-browser/${process.env.DISPATCH_FRESHNESS_PHASE || 'current'}`;
const fixtureOrder = (id = 'SO-FRESH') => ({ id, type: 'SO', customer: 'Freshness test',
  address: '30 Isolated Road', pickupLocations: ['3445'], sourceYard: '3445',
  pallets: 12, salesQty: 12, weight: 120, catalogHydrated: true,
  items: Array.from({ length: 12 }, (_, i) => ({ lineId: i + 1, itemId: 100 + i,
    sku: `ITEM-${i + 1}`, quantity: 1, salesQty: 1, pallets: 1, unit: 'EA' })) });

async function scenario(name, run) {
  const requests = [];
  const details = new Map();
  const responses = new Map();
  const pending = [];
  const pendingPool = [];
  let deferredPool = null;
  let defer = false, browser, page;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.pathname + url.search);
    if (/\.(js|css)$/u.test(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
    }
    if (!url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<link rel="stylesheet" href="/dispatch.css"><main id="dispatchApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-address-guard.js"></script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>');
    }
    const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (responses.has(url.pathname)) return send(responses.get(url.pathname));
    if (url.pathname.startsWith('/api/dispatch/v2/order-feed/')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1));
      const order = structuredClone(details.get(id) || fixtureOrder(id));
      if (defer) return pending.push(() => send({ order }));
      return send({ order });
    }
    if (url.pathname === '/api/dispatch/v2/order-pool') {
      if (deferredPool) return pendingPool.push(() => send({ orders: deferredPool, nextCursor: '' }));
      return send({ orders: [], nextCursor: '' });
    }
    if (url.pathname === '/api/dispatch/orders') return send([]);
    if (url.pathname.endsWith('/executed-order-reviews')) return send({ reviews: [] });
    if (url.pathname === '/api/dispatch/planned-assignments') return send([]);
    if (url.pathname === '/api/dispatch/driver-job-statuses' || url.pathname === '/api/dispatch/driver-truck-switches/attention') return send([]);
    if (url.pathname === '/api/dispatch/setup') return send({ trucks: [], drivers: [], ownYards: [] });
    if (url.pathname === '/api/dispatch/v2/bootstrap') return send({ exists: false });
    return send({});
  });
  try {
    await mkdir(artifact, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    if (process.env.DISPATCH_FRESHNESS_COVERAGE) await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} }; });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect.poll(() => page.evaluate(() => typeof applyDispatchOrderFeed)).toBe('function');
    await page.evaluate(input => {
      orders = [normalizeOrder(input)]; orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      currentPlanDate = todayLocalDate(); currentPlan = { id: 'freshness', planDate: currentPlanDate, revision: 1, digest: 'initial', status: 'draft' };
      dispatchConfig = { plannerOrderPoolMode: 'on', plannerCommandMode: 'off', googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = 'ready'; planEditMode = true;
      planEditLeaseToken = 'test-token'; planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      localPlanDirty = false; activeOrderType = 'SO'; selectedOrderId = input.id;
      selectedOrderIds = new Set([input.id]); render({ save: false });
    }, fixtureOrder());
    await run({ page, requests, details, responses, pending, pendingPool,
      setDeferred: value => { defer = value; }, setDeferredPool: value => { deferredPool = value; } });
  } finally {
    if (page) {
      await writeFile(`${artifact}/${name}-state.json`, JSON.stringify(await page.evaluate(() => ({
        snapshot: dispatchPlannerSnapshotState, error: dispatchPlannerSnapshotError, notice: routeNotice
      })).catch(() => ({})), null, 2));
      if (process.env.DISPATCH_FRESHNESS_COVERAGE) {
        for (const entry of (await page.coverage.stopJSCoverage()).filter(entry => entry.url.endsWith('/dispatch.js'))) {
          const converter = v8ToIstanbul('/app/public/dispatch.js', 0, { source: entry.source });
          await converter.load(); converter.applyCoverage(entry.functions);
          await writeFile(`${artifact}/${name}-coverage.json`, JSON.stringify(converter.toIstanbul()));
        }
      }
      await page.screenshot({ path: `${artifact}/${name}.png` }).catch(() => {});
      await writeFile(`${artifact}/${name}-requests.json`, JSON.stringify(requests, null, 2));
      await page.context().tracing.stop({ path: `${artifact}/${name}-trace.zip` }).catch(() => {});
    }
    pending.splice(0).forEach(finish => finish());
    pendingPool.splice(0).forEach(finish => finish());
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

test('freshness: a compact browse refresh must not discard unchanged hydrated cargo before dragging', () => scenario('compact-drag', async ({ page }) => {
  const result = await page.evaluate(() => {
    orders[0].catalogDetailSignature = 'unchanged';
    orderCatalog = structuredClone(orders);
    const card = { ...orders[0], items: orders[0].items.slice(0, 8), itemCount: 12, catalogHydrated: false };
    applyDispatchOrderFeed([card]); renderDispatchOrderPoolPatch();
    const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    document.querySelector('[data-order="SO-FRESH"]').dispatchEvent(event);
    return { itemCount: orderById('SO-FRESH').items.length, hydrated: orderById('SO-FRESH').catalogHydrated, cancelled: event.defaultPrevented };
  });
  assert.equal(result.itemCount, 12, 'browse update lost four already-loaded item lines');
  assert.equal(result.hydrated, true);
  assert.equal(result.cancelled, false, 'dispatcher should not have to drag the unchanged order twice');
}));

test('freshness: authoritative group details replace stale nested PO/TO link state', () => scenario('group-links', async ({ page }) => {
  const result = await page.evaluate(input => {
    const oldChild = { ...input, id: 'SO-MEMBER', orderDependencies: [], pickupLocations: ['3445'] };
    const group = { ...input, id: 'GOA-FRESH', childOrders: ['SO-MEMBER'], childOrderDetails: [oldChild] };
    orders = [normalizeOrder(group)]; orderCatalog = structuredClone(orders);
    const freshChild = { ...oldChild, pickupLocations: ['VENDOR'], orderDependencies: [{ id: 77, transferOrderRef: 'TO-FRESH', mode: 'direct_to_customer' }] };
    mergeTargetedDispatchMutationOrders({ orders: [{ ...group, childOrderDetails: [freshChild] }] });
    render({ save: false });
    const order = orderById('GOA-FRESH');
    return { dependencies: order.childOrderDetails[0].orderDependencies, children: order.childOrders };
  }, fixtureOrder());
  assert.equal(result.dependencies.length, 1, 'fresh group response retained the old child link state');
  assert.equal(result.dependencies[0].transferOrderRef, 'TO-FRESH');
  assert.deepEqual(result.children, ['SO-MEMBER']);
}));

test('freshness: old detail response cannot overwrite an order changed while it was loading', () => scenario('late-read', async ({ page, requests, details, pending, setDeferred }) => {
  details.set('SO-FRESH', { ...fixtureOrder(), customer: 'Old response' });
  setDeferred(true);
  await page.evaluate(() => { window.loadingOrder = applyTargetedDispatchOrderUpdate('SO-FRESH'); });
  await expect.poll(() => pending.length).toBe(1);
  await page.evaluate(input => {
    mergeTargetedDispatchMutationOrders({ orders: [{ ...input, customer: 'After link' }] });
    localPlanGeneration += 1;
  }, fixtureOrder());
  pending.shift()();
  await page.evaluate(() => loadingOrder);
  assert.equal(await page.evaluate(() => orderById('SO-FRESH').customer), 'After link');
  assert.ok(requests.some(url => url.includes('order-feed/SO-FRESH') && url.includes('fresh=true')), 'targeted refresh must bypass stale catalog');
}));

for (const eventType of ['dispatch.orders.updated', 'dispatch.co.updated']) {
test(`freshness: ${eventType} refresh includes searched groups, splits and COs outside the current browse page`, () => scenario(`related-events-${eventType}`, async ({ page, requests, details }) => {
  for (const id of ['SO-FRESH', 'GOA-FRESH', 'SO-FRESH-S2', 'CO-SO-FRESH']) details.set(id, { ...fixtureOrder(id), customer: 'Updated by event' });
  await page.evaluate(({ input, eventType }) => {
    orders = [input,
      { ...input, id: 'GOA-FRESH', childOrders: ['SO-FRESH'], childOrderDetails: [input] },
      { ...input, id: 'SO-FRESH-S2', originalOrderId: 'SO-FRESH' },
      { ...input, id: 'CO-SO-FRESH', type: 'CO', sourceOrderId: 'SO-FRESH' }].map(normalizeOrder);
    orderCatalog = structuredClone(orders); rememberDispatchPoolOrders(orders);
    render({ save: false }); connectEvents();
    eventSource.dispatchEvent(new MessageEvent('app-event', { data: JSON.stringify({ type: eventType, payload: { orderId: 'SO-FRESH', sourceOrderRef: 'SO-FRESH' } }) }));
  }, { input: fixtureOrder(), eventType });
  await expect.poll(() => page.evaluate(() => orderById('GOA-FRESH')?.customer), { timeout: 2500 }).toBe('Updated by event');
  for (const id of ['SO-FRESH', 'GOA-FRESH', 'SO-FRESH-S2', 'CO-SO-FRESH']) {
    assert.ok(requests.some(url => url.startsWith(`/api/dispatch/v2/order-feed/${id}?`)), `${id} was not refreshed`);
  }
}));
}

test('freshness: hover hydrates a compact order before the first drag and coalesces repeated hover', () => scenario('prefetch-drag', async ({ page, requests }) => {
  await page.evaluate(() => {
    orders[0].catalogHydrated = false; orderCatalog = structuredClone(orders); render({ save: false });
  });
  const card = page.locator('.order-card[data-order="SO-FRESH"]');
  await card.hover();
  await expect.poll(() => page.evaluate(() => orderById('SO-FRESH').catalogHydrated), { timeout: 2000 }).toBe(true);
  await card.hover();
  assert.equal(requests.filter(url => url.includes('/order-feed/SO-FRESH')).length, 1);
}));

test('freshness: a newly created CO outside the browse page receives its committed cargo details', () => scenario('new-co-event', async ({ page, details }) => {
  const ref = 'CO-SO-FRESH';
  const source = { ...fixtureOrder(), transitCo: { id: ref, fromYard: '3445', toYard: '12441' } };
  details.set('SO-FRESH', source);
  details.set(ref, { ...fixtureOrder(ref), type: 'CO', sourceOrderId: 'SO-FRESH', sourceTable: 'local_co_orders',
    coFromYard: '3445', coToYard: '12441', items: [{ itemId: 'COMMITTED-CO-LINE', sku: 'ITEM-1', quantity: 12, pallets: 12, unit: 'EA' }] });
  await page.evaluate(ref => {
    rememberDispatchPoolOrders(orders); connectEvents();
    eventSource.dispatchEvent(new MessageEvent('app-event', { data: JSON.stringify({ type: 'dispatch.co.updated',
      payload: { coRef: ref, sourceOrderRef: 'SO-FRESH', cancelled: false } }) }));
  }, ref);
  await expect.poll(() => page.evaluate(ref => orderById(ref)?.items?.[0]?.itemId, ref), { timeout: 2500 }).toBe('COMMITTED-CO-LINE');
}));

test('freshness: selection keeps the pressed card mounted before native drag begins', () => scenario('selection-before-drag', async ({ page }) => {
  const card = page.locator('.order-card[data-order="SO-FRESH"]');
  await page.evaluate(() => { window.pressedDragSource = document.querySelector('.order-card[data-order="SO-FRESH"]'); });
  await card.click();
  await page.mouse.down();
  try {
    // A human can pause with the button held before crossing the drag threshold.
    await page.waitForTimeout(240);
    assert.equal(await page.evaluate(() => pressedDragSource.isConnected), true,
      'selection removed the pressed card before native dragstart could cancel its timer');
    assert.equal(await page.evaluate(() => selectedOrderId), 'SO-FRESH');
  } finally { await page.mouse.up(); }
}));

test('freshness: the drag source stays mounted when selection has a delayed repaint', () => scenario('selection-drag-source', async ({ page }) => {
  await page.evaluate(() => {
    const card = document.querySelector('.order-card[data-order="SO-FRESH"]');
    window.originalDragSource = card;
    card.click();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  });
  // Cross the actual 180 ms selection debounce while the native source is held.
  await page.waitForTimeout(240);
  assert.equal(await page.evaluate(() => originalDragSource.isConnected), true,
    'the delayed selection repaint detached the native drag source before drop');
  assert.equal(await page.evaluate(() => dragged?.orderId), 'SO-FRESH');
  await page.evaluate(() => originalDragSource.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
}));

test('freshness: further split adopts the acknowledged digest before queuing its next save', () => scenario('resplit-fence', async ({ page, responses }) => {
  responses.set('/api/dispatch/split-orders/resplit', {
    orders: [{ ...fixtureOrder('SO-FRESH-S3'), originalOrderId: 'SO-FRESH' }, { ...fixtureOrder('SO-FRESH-S4'), originalOrderId: 'SO-FRESH' }],
    retiredGlobalOrderRefs: ['SO-FRESH-S2'], planRevision: 2, planDigest: 'after-resplit'
  });
  await page.evaluate(input => {
    const order = normalizeOrder({ ...input, id: 'SO-FRESH-S2', originalOrderId: 'SO-FRESH', operatorStatus: 'open' });
    orders = [order]; orderCatalog = structuredClone(orders); selectedOrderId = order.id;
    selectedOrderIds = new Set([order.id]); modalType = 'split'; modalOrderId = order.id;
    splitStatusLoading = false; splitStatusError = ''; splitParts = 2;
    render({ save: false });
  }, fixtureOrder());
  // Dispatch the real delegated click handler; split quantities are immaterial
  // to this response-adoption reproduction and are checked in database tests.
  await page.evaluate(() => {
    const button = document.createElement('button'); button.dataset.action = 'confirm-split';
    button.dataset.order = 'SO-FRESH-S2'; app.append(button); button.click();
  });
  await expect.poll(() => page.evaluate(() => currentPlan.revision)).toBe(2);
  assert.equal(await page.evaluate(() => currentPlan.digest), 'after-resplit', 'next save would send a new revision with the old digest');
}));

test('freshness: a slow browse response cannot replace a newer targeted detail response', () => scenario('browse-detail-race', async ({ page, details, pendingPool, setDeferredPool }) => {
  setDeferredPool([{ ...fixtureOrder(), customer: 'Old browse', catalogHydrated: false }]);
  await page.evaluate(() => { window.poolLoading = loadDispatchOrders(); });
  await expect.poll(() => pendingPool.length).toBe(1);
  details.set('SO-FRESH', { ...fixtureOrder(), customer: 'New detail' });
  await page.evaluate(() => applyTargetedDispatchOrderUpdate('SO-FRESH'));
  pendingPool.shift()();
  await page.evaluate(() => poolLoading);
  assert.equal(await page.evaluate(() => orderById('SO-FRESH').customer), 'New detail');
  assert.equal(await page.evaluate(() => orderById('SO-FRESH').catalogHydrated), true);
}));

test('freshness: grouping changes on another plan refresh their affected cards on this date', () => scenario('remote-group', async ({ page, details }) => {
  details.set('GOA-REMOTE', { ...fixtureOrder('GOA-REMOTE'), childOrders: ['SO-REMOTE'], childOrderDetails: [fixtureOrder('SO-REMOTE')] });
  await page.evaluate(() => {
    connectEvents();
    eventSource.dispatchEvent(new MessageEvent('app-event', { data: JSON.stringify({ type: 'dispatch.plan.saved', payload: {
      planDate: '2026-10-20', planId: 'another', affectedOrderRefs: ['GOA-REMOTE'], reactivatedGlobalOrderRefs: ['GOA-REMOTE']
    } }) }));
  });
  await expect.poll(() => page.evaluate(() => Boolean(orderById('GOA-REMOTE'))), { timeout: 2500 }).toBe(true);
}));

test('freshness: a temporary snapshot failure recovers editing readiness after the server is available', () => scenario('snapshot-recovery', async ({ page, responses }) => {
  const planDate = await page.evaluate(() => currentPlanDate);
  responses.set('/api/dispatch/v2/bootstrap', { exists: true, plan: { id: 'freshness', planDate, status: 'draft', revision: 1,
    digest: 'recovered', assignedOrderSnapshots: [], trucks: [], summary: {} } });
  responses.set('/api/dispatch/plans/freshness/revision', { id: 'freshness', revision: 1, digest: 'recovered' });
  await page.evaluate(async () => {
    dispatchPlannerSnapshotState = 'stale'; dispatchPlannerSnapshotError = 'Temporary network failure';
    localPlanDirty = false; render({ save: false }); await pollServerPlan();
  });
  assert.equal(await page.evaluate(() => dispatchPlannerSnapshotState), 'ready');
  assert.equal(await page.evaluate(() => currentPlan.digest), 'recovered');
}));

test('freshness: snapshot recovery never replaces an unsaved draft', () => scenario('snapshot-draft', async ({ page, requests }) => {
  const before = requests.length;
  await page.evaluate(async () => {
    dispatchPlannerSnapshotState = 'stale'; localPlanDirty = true; currentPlan.digest = 'unsaved-base';
    await pollServerPlan();
  });
  assert.equal(await page.evaluate(() => currentPlan.digest), 'unsaved-base');
  assert.equal(await page.evaluate(() => localPlanDirty), true);
  assert.equal(requests.slice(before).filter(url => url.includes('/bootstrap')).length, 0);
  await page.evaluate(async () => {
    currentPlan.id = null; dispatchPlannerSnapshotState = 'ready';
    await pollServerPlan({ discoverPlan: true });
  });
  assert.equal(await page.evaluate(() => currentPlan.digest), 'unsaved-base');
  assert.equal(requests.slice(before).filter(url => url.includes('/bootstrap')).length, 0);
}));

test('freshness: an observer on an empty day adopts a remotely created plan', () => scenario('new-day-observer', async ({ page, responses }) => {
  const planDate = await page.evaluate(() => currentPlanDate);
  responses.set('/api/dispatch/v2/bootstrap', { exists: true, plan: { id: 'remote-day', planDate, status: 'draft', revision: 1,
    digest: 'new-day-digest', assignedOrderSnapshots: [], trucks: [], summary: {} } });
  responses.set('/api/dispatch/plans/remote-day/revision', { id: 'remote-day', revision: 1, digest: 'new-day-digest' });
  await page.evaluate(() => {
    currentPlan = { id: null, planDate: currentPlanDate, revision: 0, digest: '' }; planEditMode = false;
    connectEvents();
    eventSource.dispatchEvent(new MessageEvent('app-event', { data: JSON.stringify({ type: 'dispatch.plan.saved', payload: {
      planDate: currentPlanDate, planId: 'remote-day', revision: 1
    } }) }));
  });
  await expect.poll(() => page.evaluate(() => currentPlan?.id), { timeout: 2500 }).toBe('remote-day');
  assert.equal(await page.evaluate(() => currentPlan.digest), 'new-day-digest');
}));

test('freshness: remote ungroup retires the old card and restores its member on another date', () => scenario('remote-ungroup', async ({ page, details }) => {
  details.set('SO-FRESH', fixtureOrder());
  await page.evaluate(input => {
    orders = [normalizeOrder({ ...input, id: 'GOA-RETIRED', childOrders: ['SO-FRESH'], childOrderDetails: [input] })];
    orderCatalog = structuredClone(orders); rememberDispatchPoolOrders(orders); render({ save: false });
    connectEvents();
    eventSource.dispatchEvent(new MessageEvent('app-event', { data: JSON.stringify({ type: 'dispatch.plan.saved', payload: {
      planDate: '2026-10-20', planId: 'another', refreshOrderPool: true,
      retiredGlobalOrderRefs: ['GOA-RETIRED'], reactivatedGlobalOrderRefs: ['SO-FRESH']
    } }) }));
  }, fixtureOrder());
  await expect.poll(() => page.evaluate(() => Boolean(orderById('GOA-RETIRED'))), { timeout: 2500 }).toBe(false);
  await expect.poll(() => page.evaluate(() => Boolean(orderById('SO-FRESH'))), { timeout: 2500 }).toBe(true);
}));

test('freshness: retiring a locally ungrouped order also removes its cached assignment identity', () => scenario('local-retirement-evidence', async ({ page }) => {
  const result = await page.evaluate(input => {
    const group = { ...input, id: 'GO-RETIRED', childOrders: [input.id], childOrderDetails: [input] };
    orders = [normalizeOrder(input)]; orderCatalog = [normalizeOrder(group)];
    rememberAssignedOrderEvidence([group]);
    queueGlobalOrderRetirement(group.id);
    return { inPool: orders.some(order => order.id === group.id), resolvesRetired: Boolean(orderById(group.id)),
      memberRetained: Boolean(orderById(input.id)) };
  }, fixtureOrder());
  assert.equal(result.inPool, false);
  assert.equal(result.resolvesRetired, false, 'retired group remains actionable through stale assignment evidence');
  assert.equal(result.memberRetained, true, 'unretired child evidence must remain available');
}));

for (const mode of ['browse', 'search', 'pagination', 'legacy']) {
test(`freshness: a lagging catalog ${mode} read started after a link cannot restore the old card`, () => scenario(`catalog-lag-${mode}`, async ({ page, details, responses, pendingPool, setDeferredPool }) => {
  details.set('SO-FRESH', { ...fixtureOrder(), customer: 'Verified after link', catalogDetailSignature: 'new' });
  await page.evaluate(() => applyTargetedDispatchOrderUpdate('SO-FRESH'));
  const stale = [{ ...fixtureOrder(), customer: 'Before link', catalogHydrated: false, catalogDetailSignature: 'old' }];
  if (mode === 'legacy') responses.set('/api/dispatch/orders', stale);
  else setDeferredPool(stale);
  await page.evaluate(mode => {
    if (mode === 'search' || mode === 'pagination') searchText = 'FRESH';
    if (mode === 'legacy') dispatchConfig.plannerOrderPoolMode = 'off';
    if (mode === 'pagination') dispatchOrderPoolNextCursor = 'next';
    window.poolLoading = mode === 'search' ? loadDispatchOrderSearch(searchText, orderSearchSequence)
      : mode === 'pagination' ? loadMoreDispatchOrders() : loadDispatchOrders();
  }, mode);
  if (mode !== 'legacy') { await expect.poll(() => pendingPool.length).toBe(1); pendingPool.shift()(); }
  await page.evaluate(() => poolLoading);
  assert.equal(await page.evaluate(() => orderById('SO-FRESH').customer), 'Verified after link');
  assert.equal(await page.evaluate(() => orderById('SO-FRESH').catalogHydrated), true);
}));
}

test('freshness: atomic link acknowledgements invalidate a detail read already in flight', () => scenario('atomic-link', async ({ page, details, pending, setDeferred }) => {
  details.set('SO-FRESH', { ...fixtureOrder(), customer: 'Before atomic link' });
  setDeferred(true);
  await page.evaluate(() => { window.loadingOrder = applyTargetedDispatchOrderUpdate('SO-FRESH'); });
  await expect.poll(() => pending.length).toBe(1);
  await page.evaluate(input => applyAtomicDependencyMutationPayload({ orders: [{ ...input, customer: 'Committed link' }] }), fixtureOrder());
  pending.shift()(); await page.evaluate(() => loadingOrder);
  assert.equal(await page.evaluate(() => orderById('SO-FRESH').customer), 'Committed link');
}));

test('freshness: clearing order data cannot be undone by an old pending detail request', () => scenario('data-clear', async ({ page, pending, setDeferred }) => {
  setDeferred(true);
  await page.evaluate(() => { window.loadingOrder = applyTargetedDispatchOrderUpdate('SO-FRESH'); });
  await expect.poll(() => pending.length).toBe(1);
  await page.evaluate(() => resetDispatchAfterOrderDataClear());
  assert.equal(await page.evaluate(() => Boolean(orderById('SO-FRESH'))), false);
  pending.shift()(); await page.evaluate(() => loadingOrder);
  assert.equal(await page.evaluate(() => Boolean(orderById('SO-FRESH'))), false);
}));

test('freshness: immediate order actions target the newly selected card before the delayed full render', () => scenario('selection-actions', async ({ page }) => {
  const selected = await page.evaluate(input => {
    orders.push(normalizeOrder({ ...input, id: 'SO-NEXT' })); orderCatalog = structuredClone(orders);
    selectedOrderId = 'SO-FRESH'; selectedOrderIds = new Set([selectedOrderId]); render({ save: false });
    document.querySelector('.order-card[data-order="SO-NEXT"]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    document.querySelector('[data-action="open-po-link-modal"]').click();
    return { target: modalOrderId, selection: selectedOrderId };
  }, fixtureOrder());
  assert.equal(selected.selection, 'SO-NEXT');
  assert.equal(selected.target, 'SO-NEXT', 'the stale action bar opened the previous order');
}));
