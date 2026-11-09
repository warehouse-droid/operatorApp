// 2026-11-06: /admin/sync took 20-30 s to show. Every Admin tab loaded the data of all tabs at once,
// including an Audit Log search remembered in the browser (order SOA11033) that hit the 30 s audit
// timeout. Each tab now loads only its own data when it is opened, and the Audit Log searches only
// when Apply (or Refresh) is clicked.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import { createOperator, loginOperator } from '../../src/auth-repository.js';
import { closeDb } from '../../src/db.js';
import { app } from '../../src/server.js';
import { closeSystemAudit } from '../../src/system-audit.js';

const RUN = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
let server;
let browser;
let baseUrl;
let admin;

// Data endpoints of each Admin tab (alert badges, session and menu requests are not tab data).
const TAB_DATA = {
  sync: ['/api/control/sync-settings', '/api/admin/netsuite-m2m', '/api/control/env-settings', '/api/admin/netsuite-mirror'],
  operators: ['/api/operators', '/api/admin/aggregate-request-access', '/api/admin/public-sales'],
  dashboard: ['/api/operators', '/api/control/sync-settings', '/api/admin/photo-archive', '/api/admin/maps-usage', '/api/admin/return-settings']
};
const ALL_TAB_DATA = [...new Set([...Object.values(TAB_DATA).flat(), '/api/admin/return-notifications',
  '/api/control/scm-reconciliation/settings', '/api/control/scm-reconciliation/runs', '/api/admin/performance'])];
const isAudit = (path) => path.startsWith('/api/delivery/audit');

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const user = await createOperator({ username: `admin_lazy_${RUN}`, password: 'AdminLazy123!', role: 'admin' });
  admin = await loginOperator(user.username, 'AdminLazy123!');
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

after(async () => {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await closeSystemAudit();
  await closeDb();
});

async function openAdmin(path) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(({ token }) => {
    localStorage.setItem('mbbs.staff.token', token);
    // The remembered Audit Log filter that made every Admin tab wait on 2026-11-06.
    localStorage.setItem('mbbs.control.audit.tranid', 'SOA11033');
  }, { token: admin.token });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, search: url.search, method: request.method() });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${baseUrl}${path}`);
  return { context, page, requests, errors };
}

const settle = (page) => page.waitForTimeout(1500);
const dataPaths = (requests) => [...new Set(requests.filter((r) => r.method === 'GET' && (ALL_TAB_DATA.includes(r.path) || isAudit(r.path))).map((r) => r.path))].sort();

test('/admin/sync loads only the sync tab data and never the Audit Log', async () => {
  const { context, page, requests, errors } = await openAdmin('/admin/sync');
  try {
    await page.locator('[data-action="save-sync-settings"]').waitFor({ timeout: 15_000 });
    await settle(page);
    assert.deepEqual(dataPaths(requests), [...TAB_DATA.sync].sort());
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('another Admin tab loads its own data when it is clicked', async () => {
  const { context, page, requests, errors } = await openAdmin('/admin');
  try {
    await page.locator('.dashboard-grid [data-section="operators"]').waitFor({ timeout: 15_000 });
    await settle(page);
    assert.deepEqual(dataPaths(requests), [...TAB_DATA.dashboard].sort(), 'the dashboard loads its summary cards only');
    const before = requests.length;
    const accessLoaded = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/admin/aggregate-request-access');
    await page.locator('.dashboard-grid [data-section="operators"]').click();
    await accessLoaded;
    await settle(page);
    assert.deepEqual(dataPaths(requests.slice(before)), [...TAB_DATA.operators].sort(), 'Accounts loads when it is opened');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('the Audit Log searches only when Apply is clicked', async () => {
  const { context, page, requests, errors } = await openAdmin('/admin/audit');
  try {
    const apply = page.locator('[data-action=apply-audit-filters]');
    await apply.waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('[data-audit-filter=tranid]').inputValue(), 'SOA11033', 'the remembered filter is kept');
    await settle(page);
    assert.deepEqual(requests.filter((r) => isAudit(r.path)), [], 'opening the Audit Log runs no search');
    assert.match(await page.locator('.audit-not-loaded').textContent(), /click Apply/u);
    const searched = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/delivery/audit');
    await apply.click();
    const search = new URL((await searched).url());
    assert.equal(search.searchParams.get('tranid'), 'SOA11033');
    await page.locator('.audit-table').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('.audit-not-loaded').count(), 0);
    assert.ok(requests.some((r) => r.path === '/api/delivery/audit/options'), 'filter choices load with the search');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
