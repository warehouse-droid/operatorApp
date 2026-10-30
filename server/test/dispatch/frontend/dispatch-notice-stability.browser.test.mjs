import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import v8ToIstanbul from 'v8-to-istanbul';

for (const width of [1440, 820]) test(`notices preserve stop nodes, scroll, focus and dimensions at ${width}px`, async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (/\.(js|css)$/u.test(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
    } else if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(url.pathname.endsWith('/revision') ? { revision: 2 } : { reviews: [] }));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><link rel="stylesheet" href="/dispatch.css"><main id="dispatchApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>');
    }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      currentPlanDate = todayLocalDate(); currentPlan = { id: 'notice-test', planDate: currentPlanDate, revision: 1, digest: 'original', status: 'draft' };
      dispatchConfig = { plannerOrderPoolMode: 'off', plannerCommandMode: 'off', googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = 'ready';
      orders = Array.from({ length: 15 }, (_, n) => normalizeOrder({ id: `SO${n}`, type: 'SO', customer: `Customer ${n}`,
        address: `${n + 1} Isolated Road`, pickupLocations: ['3445'], pallets: 1, weight: 100, items: [] }));
      orderCatalog = structuredClone(orders);
      trucks = [{ id: 'T1', plate: 'TEST', base: '3445', capacity: 100000, loads: [{ id: 'L1', name: 'Load 1', start: 480,
        stops: orders.map((o, i) => ({ id: `stop-${i}`, type: 'drop', orderId: o.id })) }] }];
      fleet = structuredClone(trucks); drivers = [];
      planEditMode = true; planEditLeaseToken = 'test-lease';
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      selectedLoadId = 'L1'; loadPreviewOpen = true; loadPreviewWidth = 530; localPlanDirty = true;
      render({ save: false });
      const list = document.querySelector('.preview-stop-list');
      const panel = document.querySelector('.load-preview-panel');
      const body = document.querySelector('.load-preview-body');
      const focus = document.querySelector('[data-action="toggle-sequence"]');
      body.scrollTop = 200; focus.focus({ preventScroll: true });
      window.noticeBefore = { list, panel, body, focus, stop: list.firstElementChild, scroll: body.scrollTop,
        bounds: JSON.stringify(panel.getBoundingClientRect().toJSON()), board: document.querySelector('.truck-board'),
        boardBounds: JSON.stringify(document.querySelector('.truck-board').getBoundingClientRect().toJSON()) };
    });
    const check = async () => assert.deepEqual(await page.evaluate(() => {
      const b = window.noticeBefore;
      return { list: b.list === document.querySelector('.preview-stop-list'), stop: b.stop === b.list.firstElementChild,
        panel: b.panel === document.querySelector('.load-preview-panel'), focus: b.focus === document.activeElement,
        scroll: b.scroll === b.body.scrollTop, bounds: b.bounds === JSON.stringify(b.panel.getBoundingClientRect().toJSON()),
        board: b.board === document.querySelector('.truck-board'), boardBounds: b.boardBounds === JSON.stringify(b.board.getBoundingClientRect().toJSON()) };
    }), { list: true, stop: true, panel: true, focus: true, scroll: true, bounds: true, board: true, boardBounds: true });
    await page.evaluate(() => pollServerPlan());
    await check();
    await page.evaluate(() => { routeNotice = 'A long save notice. '.repeat(30); renderDispatchNoticePatch(); });
    await check();
    await page.evaluate(() => document.querySelector('[data-action="close-route-notice"]').click());
    await check();
    await page.evaluate(async () => {
      await savePlanToServer({ planId: currentPlan.id, planDate: currentPlanDate,
        baseRevision: currentPlan.revision, baseDigest: currentPlan.digest, orders, trucks, summary: {} });
      if (!routeNotice.includes('Plan save failed')) throw new Error('Expected a failed save notice');
    });
    await check();
    await page.evaluate(async () => {
      pendingPlanSaveAttempt = null;
      executedOrderReviewPlanId = currentPlan.id;
      executedOrderReviews = [{ token: 'review', acknowledged: false, decisionRequired: false }];
      await confirmExecutedOrderReview('review');
    });
    await check();
    assert.deepEqual(errors, []);
    await mkdir('test-artifacts/source-save', { recursive: true });
    for (const entry of (await page.coverage.stopJSCoverage()).filter(item => item.url.endsWith('/dispatch.js'))) {
      const converter = v8ToIstanbul('/app/public/dispatch.js', 0, { source: entry.source });
      await converter.load(); converter.applyCoverage(entry.functions);
      await writeFile(`test-artifacts/source-save/browser-${width}-coverage.json`, JSON.stringify(converter.toIstanbul()));
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
