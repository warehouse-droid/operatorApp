import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { chromium } from '@playwright/test';
import { displayFixture, displayApiResponse } from '../../support/operator-display-refresh-fixture.mjs';

let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }); });
after(async () => { await browser?.close(); });
const notice = { orderId: 1092133, tranid: 'TOB01263', type: 'transfer_order', locationId: 1,
  expectedDeliveryDate: '2026-10-26', dispatchPlanDate: '2026-10-26', dispatchPlannedAt: '2026-10-26T17:55:00Z',
  dispatchPlanned: true, truck: 'CC46868', load: 'Load 4', parkingSpot: '' };

async function session(t) {
  const fixture = displayFixture();
  const actor = { id: 'popup-test', role: 'operator', roles: ['operator'], operatorYardLocationIds: [1] };
  const token = 'test-popup-session';
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let page = null;
  t.after(async () => {
    try {
      if (page && process.env.OPERATOR_POPUP_COVERAGE === '1') {
        const samples = (await page.coverage.stopJSCoverage()).filter(entry => /\/operator(?:-popup-audit)?\.js\?/.test(entry.url));
        await mkdir('test-artifacts/popup-browser', { recursive: true });
        await writeFile(`test-artifacts/popup-browser/${crypto.randomUUID()}.json`, JSON.stringify(samples));
      }
    } finally { await context.close(); }
  });
  await context.addInitScript(({ user, auth, sessionKey }) => {
    localStorage.setItem('mbbs.operator.token', auth);
    localStorage.setItem('mbbs.staff.token', auth);
    localStorage.setItem('mbbs.ui.language', 'en');
    localStorage.setItem('mbbs.operator.state', JSON.stringify({ accountId: user.id, sessionKey, locationId: 1, currentModule: 'menu' }));
    window.EventSource = class {
      constructor() { window.popupEvents = this; this.handlers = {}; }
      addEventListener(type, handler) { this.handlers[type] = handler; }
      close() {}
      emit(type, payload) { this.handlers['app-event']?.({ data: JSON.stringify({ type, payload }) }); }
    };
  }, { user: actor, auth: token, sessionKey: crypto.createHash('sha256').update(token).digest('hex') });
  page = await context.newPage();
  if (process.env.OPERATOR_POPUP_COVERAGE === '1') { await page.coverage.startJSCoverage({ resetOnNavigation: false }); }
  page.setDefaultTimeout(5000);
  await page.clock.setFixedTime(new Date('2026-10-26T18:00:00Z'));
  const records = [], errors = [];
  let failures = 0;
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) {
      const file = url.pathname === '/operator' ? 'operator.html' : url.pathname.slice(1);
      try {
        await route.fulfill({ status: 200, contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream', body: await readFile(path.join('public', file)) });
      } catch { await route.fulfill({ status: 404, body: '' }); }
      return;
    }
    if (url.pathname === '/api/delivery/notification-events') {
      records.push(route.request().postDataJSON());
      const failed = failures > 0;
      if (failed) { failures -= 1; }
      await route.fulfill({ status: failed ? 503 : 200, json: failed ? { error: 'Test outage' } : { recorded: true } });
      return;
    }
    await route.fulfill({ status: 200, json: displayApiResponse(url, fixture, actor) });
  });
  await page.goto('http://localhost/operator');
  await page.waitForFunction(() => Boolean(operator) && deliveryNotificationStateReady);
  const planned = (item = notice) => { fixture.notifications = { items: [item], total: 1, salesOrder: {}, transferOrder: {} }; };
  const emit = (type = 'dispatch.plan.saved', payload = { affectedOrderRefs: ['GOB-123046-123053'] }) =>
    page.evaluate(({ event, data }) => window.popupEvents.emit(event, data), { event: type, data: payload });
  return { page, planned, emit, records, failNext: count => { failures = count; } };
}

test('P1 blank parking spot alerts and records a visible popup', async t => {
  const { page, planned, emit, records } = await session(t);
  planned(); await emit();
  await page.locator('.urgent-delivery-alert').waitFor({ state: 'visible' });
  assert.match(await page.locator('.urgent-delivery-alert').innerText(), /TOB01263/);
  await page.waitForTimeout(150);
  assert.ok(records.some(row => row.action === 'displayed' && String(row.orderId) === '1092133'));
});

test('P2 delayed follow-up completion alerts the linked TO', async t => {
  const { page, planned, emit } = await session(t);
  await emit(); await page.waitForTimeout(650);
  assert.equal(await page.locator('.urgent-delivery-alert').count(), 0);
  planned(); await emit('dispatch.plan.followups.completed', { changedOrderRefs: ['GOB-123046-123053'] });
  await page.locator('.urgent-delivery-alert').waitFor({ state: 'visible' });
});

test('P3 group-only explicit references retain changed linked TO alerts', async t => {
  const { page, planned, emit } = await session(t);
  planned(); await emit('dispatch.plan.saved', { changedOperatorRefs: ['GOB-123046-123053'] });
  await page.locator('.urgent-delivery-alert').waitFor({ state: 'visible' });
});

test('P4 repeated events do not redisplay a dismissed version; a new load alerts', async t => {
  const { page, planned, emit, records } = await session(t);
  planned(); await emit();
  await page.locator('[data-action="dismiss-urgent-delivery-alert"]').click();
  await emit('dispatch.plan.saved', { changedOperatorRefs: ['TOB01263'] });
  await page.waitForTimeout(650);
  assert.equal(await page.locator('.urgent-delivery-alert').count(), 0);
  assert.equal(records.filter(row => row.action === 'displayed').length, 1);
  const dismissed = records.find(row => row.action === 'dismissed');
  assert.ok(dismissed);
  assert.equal(dismissed.popupId, records.find(row => row.action === 'displayed').popupId);
  planned({ ...notice, load: 'Load 5' }); await emit();
  await page.locator('.urgent-delivery-alert').waitFor({ state: 'visible' });
});

test('P5 opening logs the same popup and still navigates to the order', async t => {
  const { page, planned, emit, records } = await session(t);
  planned(); await emit();
  await page.locator('[data-action="open-urgent-delivery-alert"]').click();
  await page.waitForTimeout(150);
  assert.ok(records.some(row => row.action === 'opened'));
  assert.equal(records.find(row => row.action === 'opened').popupId, records.find(row => row.action === 'displayed').popupId);
  assert.equal(await page.evaluate(() => currentModule), 'delivery');
});

test('P6 audit outage does not block the popup and retries the same receipt', async t => {
  const { page, planned, emit, records, failNext } = await session(t);
  failNext(1); planned(); await emit();
  await page.locator('.urgent-delivery-alert').waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);
  assert.ok(records.length >= 3);
  const first = records[0];
  assert.equal(records.filter(row => row.popupId === first.popupId && row.action === first.action).length, 2);
});

test('P7 a hidden tab queues but does not claim display until visible', async t => {
  const { page, planned, emit, records } = await session(t);
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
  planned(); await emit(); await page.waitForTimeout(700);
  assert.ok(records.some(row => row.action === 'queued'));
  assert.equal(records.filter(row => row.action === 'displayed').length, 0);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(200);
  assert.equal(records.filter(row => row.action === 'displayed').length, 1);
});
