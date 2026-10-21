/* global localStorage, window, document, EventTarget, MessageEvent, Event */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

let browser;
const out = 'test-artifacts/special-workflow-review/special-alert-20260928';
before(async () => {
  await mkdir(out, { recursive: true });
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
});
after(async () => browser?.close());

async function fixture({ role = 'scm', roles = [role], width = 1440, shell = false, token = 'test-session', poll = false, publicSales = false, records = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 960 }, serviceWorkers: 'block' });
  await context.addInitScript(({ token, poll }) => {
    if (token) localStorage.setItem('mbbs.staff.token', token);
    window.testAlertEvents = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; window.testAlertEvents.push(this); }
      close() { this.closed = true; }
    };
    if (poll) {
      const interval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => interval(callback, delay === 30000 ? 150 : delay, ...args);
    }
  }, { token, poll });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const state = { counts: { newRequests: 2, confirmedOrders: 1, total: 3 }, status: 200, calls: 0, queries: [], errors: [], hold: null, records, posts: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (url.hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (/\/special-stock-requests\/1\/stock-check$/.test(path)) {
        assert.equal(route.request().method(), 'POST');
        const body = route.request().postDataJSON(); state.posts.push({ ...body.lines[0], expectedRevision: body.expectedRevision });
        state.records[0].lines[0] = { ...state.records[0].lines[0], ...body.lines[0] };
        state.records[0].revision++;
        return route.fulfill({ json: state.records[0] });
      }
      assert.equal(route.request().method(), 'GET');
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test-viewer', display_name: 'SCM Preview', role, roles, publicSales } } });
      if (path === '/api/scm/special-stock-requests/alerts') {
        state.calls++;
        const counts = { ...state.counts }, status = state.status;
        if (state.hold) await state.hold;
        return route.fulfill({ status, json: counts }).catch(() => {});
      }
      if (path === '/api/scm/aggregate-requests') return route.fulfill({ json: { requests: [{ status: 'submitted' }] } });
      if (path.endsWith('/special-stock-requests/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/special-stock-requests')) {
        state.queries.push(url.searchParams.get('stages'));
        return route.fulfill({ json: { yards: [{ locationId: 1, yardCode: '3445' }], requests: state.records } });
      }
      return route.fulfill({ json: { requests: [], yards: [], count: 0 } });
    }
    if (path === '/alert-preview') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Alert preview</title></head><body><header class="topbar"><div class="topbar-actions"></div></header><script src="/scm-aggregate-alert.js"></script><script src="/scm-special-alert.js"></script></body></html>' });
    const file = ({ '/scm': '/scm-menu.html', '/scm/stock-requests': '/scm-stock-requests.html', '/sales/stock-requests': '/sales-stock-requests.html' })[path] || path;
    try {
      return route.fulfill({ body: await readFile('public' + file), contentType: ({ js: 'application/javascript', css: 'text/css', html: 'text/html', svg: 'image/svg+xml' })[file.split('.').at(-1)] || 'application/octet-stream' });
    } catch { return route.fulfill({ status: 404, body: 'Not found' }); }
  });
  await page.goto('http://localhost' + (shell ? '/alert-preview' : '/scm'));
  await page.waitForFunction(() => Boolean(window.MBBSScmSpecialAlert));
  return { page, context, state };
}

const alert = page => page.locator('.scm-special-alert');
const emit = (page, type) => page.evaluate(type => {
  for (const source of window.testAlertEvents.filter(source => !source.closed)) source.dispatchEvent(new MessageEvent('app-event', { data: JSON.stringify({ type }) }));
}, type);

const transferCase = () => ({ id: 1, requestRef: 'SPREQ-TEST', stage: 'new_enquiry', revision: 1, storeName: '3445', storeLocationId: 1,
  customerName: 'TEST Customer', vendorName: 'TEST Vendor', vendorId: 8899200, inquiryDate: '2099-01-01', closeStatus: 'active', fulfillmentMethod: 'yard_pickup',
  lines: [{ id: 1, productName: 'TEST slab', quantity: 2, uom: 'PLT', salesDecision: 'pending', vendorYard: 'Vendor yard', salesVisibleNote: 'Sales reply', scmInternalNote: 'Private note' }],
  salesOrderLines: [], purchaseOrderLines: [], events: [], media: [], readinessAlerts: [] });

test('Wait for Transfer requires ETA, sends the date, and keeps the selection after saving', async () => {
  const { page, context, state } = await fixture({ records: [transferCase()] });
  try {
    await alert(page).click();
    await page.locator('.stock-request-card[data-id="1"]').click();
    const supply = page.locator('[name=supplyStatus]'), eta = page.locator('[name=availableDate]');
    await supply.selectOption('vendor_transfer');
    await expect(eta).toBeVisible();
    await expect(eta).toBeEnabled();
    assert.equal(await eta.evaluate(node => node.required && !node.validity.valid), true);
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    assert.equal(state.posts.length, 0);
    await eta.fill('2099-02-01');
    await supply.selectOption('in_stock');
    await expect(eta).toBeHidden();
    await expect(eta).toBeDisabled();
    await supply.selectOption('production');
    await expect(eta).toBeEnabled();
    await supply.selectOption('vendor_transfer');
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(1);
    assert.equal(state.posts[0].supplyStatus, 'vendor_transfer');
    assert.equal(state.posts[0].availableDate, '2099-02-01');
    assert.equal(state.posts[0].availabilityMode, 'dated');
    assert.equal(state.posts[0].salesVisibleNote, 'Sales reply');
    assert.equal(state.posts[0].scmInternalNote, 'Private note');
    await expect(supply).toHaveValue('vendor_transfer');
    await expect(eta).toHaveValue('2099-02-01');
    await page.reload();
    await page.locator('.stock-request-card[data-id="1"]').click();
    await expect(supply).toHaveValue('vendor_transfer');
    await expect(eta).toHaveValue('2099-02-01');
    await page.screenshot({ path: `${out}/wait-for-transfer.png` });
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('Sales sees the Wait for Transfer label and ETA on the saved case', async () => {
  const record = transferCase();
  Object.assign(record.lines[0], { supplyStatus: 'vendor_transfer', availableDate: '2099-02-01' });
  const { page, context, state } = await fixture({ role: 'sales', shell: true, records: [record] });
  try {
    await page.goto('http://localhost/sales/stock-requests?tab=special');
    await page.locator('.stock-request-card[data-id="1"]').click();
    await expect(page.getByText('Wait for Transfer', { exact: true })).toBeVisible();
    await expect(page.locator('.stock-request-detail')).toContainText('2099-02-01');
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('Special and Aggregate alerts coexist; the Special link opens the new and confirmed stage filters', async () => {
  const { page, context, state } = await fixture();
  try {
    await expect(alert(page)).toHaveAccessibleName('3 special requests: 2 new requests, 1 confirmed order');
    await expect(page.locator('.scm-aggregate-alert')).toHaveAccessibleName('1 aggregate request awaiting SCM confirmation');
    await alert(page).click();
    await expect(page.locator('[data-special-scm-stage][value="new_enquiry"]')).toBeChecked();
    await expect(page.locator('[data-special-scm-stage][value="confirmed"]')).toBeChecked();
    await expect.poll(() => state.queries.at(-1)).toBe('new_enquiry,confirmed');
    await expect(page.locator('[data-stock-request-tab="special"]')).toHaveAttribute('aria-selected', 'true');
    await expect(alert(page)).toHaveCount(1);
    await expect(page.locator('.scm-aggregate-alert')).toHaveCount(1);
    state.counts = { newRequests: 0, confirmedOrders: 1, total: 1 };
    await emit(page, 'special-stock-request.updated');
    await expect(alert(page)).toHaveAccessibleName('1 special request: 0 new requests, 1 confirmed order');
    state.counts = { newRequests: 0, confirmedOrders: 0, total: 0 };
    await emit(page, 'dispatch.orders.updated');
    await expect(alert(page)).toBeHidden();
    await expect(page.locator('.scm-aggregate-alert')).toBeVisible();
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('SCM role variants see alerts, while Sales, Dispatch, public users and logged-out users do not fetch counts', async () => {
  for (const options of [
    { role: 'admin', allowed: true }, { role: 'scm_staff', allowed: true },
    { role: 'operator', roles: ['operator','scm'], allowed: true },
    { role: 'sales' }, { role: 'dispatcher' }, { role: 'operator' },
    { role: 'scm', publicSales: true }, { token: '' }
  ]) {
    const { page, context, state } = await fixture({ ...options, shell: true });
    try {
      if (options.allowed) await expect(alert(page)).toBeVisible();
      else {
        await page.waitForLoadState('networkidle');
        assert.equal(state.calls, 0);
        await expect(alert(page)).toHaveCount(0);
      }
      assert.deepEqual(state.errors, []);
    } finally { await context.close(); }
  }
});

test('polling recovers missed events, preserves counts through outages, and hides disabled or revoked alerts', async () => {
  const { page, context, state } = await fixture({ shell: true, poll: true });
  try {
    await expect(alert(page)).toBeVisible();
    state.status = 503;
    await page.waitForResponse(response => response.url().endsWith('/special-stock-requests/alerts') && response.status() === 503);
    await expect(alert(page).locator('strong')).toHaveText('3');
    state.status = 200; state.counts = { newRequests: 4, confirmedOrders: 2, total: 6 };
    await expect(alert(page).locator('strong')).toHaveText('6');
    state.status = 404;
    await expect(alert(page)).toBeHidden();
    state.status = 200;
    await expect(alert(page).locator('strong')).toHaveText('6');
    await expect(alert(page)).toBeVisible();
    state.counts = { newRequests: -1, confirmedOrders: 0, total: -1 };
    await page.evaluate(() => window.MBBSScmSpecialAlert.refresh());
    await expect(alert(page).locator('strong')).toHaveText('6');
    state.status = 403;
    await expect(alert(page)).toHaveCount(0);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('logout removes the alert and a stale count response cannot restore it', async () => {
  const { page, context, state } = await fixture({ shell: true });
  let release;
  try {
    await expect(alert(page)).toBeVisible();
    state.hold = new Promise(resolve => { release = resolve; });
    const before = state.calls;
    await page.evaluate(() => { void window.MBBSScmSpecialAlert.refresh(); });
    await expect.poll(() => state.calls).toBeGreaterThan(before);
    await page.evaluate(() => { localStorage.clear(); window.dispatchEvent(new Event('mbbs-auth-operator-changed')); });
    await expect(alert(page)).toHaveCount(0);
    release(); state.hold = null;
    await page.waitForLoadState('networkidle');
    await expect(alert(page)).toHaveCount(0);
    assert.deepEqual(state.errors, []);
  } finally { release?.(); await context.close(); }
});

test('both alerts fit desktop and mobile top bars and update after language changes', async () => {
  const { page, context, state } = await fixture();
  try {
    for (const width of [1440,768,390,320]) {
      await page.setViewportSize({ width, height: 960 });
      await expect(alert(page)).toBeVisible();
      await expect(page.locator('.scm-aggregate-alert')).toBeVisible();
      for (const selector of ['.scm-special-alert','.scm-aggregate-alert']) {
        await expect.poll(() => page.locator(selector).evaluate(node => {
          const rect = node.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= window.innerWidth + 1 && rect.top >= 0
            && node.contains(document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2));
        })).toBe(true);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await page.screenshot({ path: `${out}/alerts-${width}.png` });
    }
    await page.locator('[data-language="zh-CN"]').click();
    await expect(alert(page)).toHaveAccessibleName('3 份特殊商品申请：2 份新申请，1 份已确认订单');
    await expect(alert(page)).toHaveCount(1);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});
