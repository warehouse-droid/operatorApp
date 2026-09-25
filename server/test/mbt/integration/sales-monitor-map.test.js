/* global localStorage, window */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import fc from 'fast-check';
import { chromium, expect } from '@playwright/test';
import { app } from '../../../src/server.js';
import { config } from '../../../src/config.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';
import { closeDb, query } from '../../../src/db.js';

let server, base, browser;
const actors = {}, sessions = {};
const originalMaps = { ...config.googleMaps };
const request = async (role, path = '/maps/browser-session', { method = 'POST', body = {}, headers = {} } = {}) => {
  const response = await fetch(`${base}/api/dispatch${path}`, { method,
    headers: { 'content-type': 'application/json', ...(sessions[role] ? { authorization: `Bearer ${sessions[role].token}` } : {}), ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ sessionId: crypto.randomUUID(), ...body }) }) });
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
};

before(async () => {
  config.googleMaps = { ...originalMaps, mode: 'normal', browserApiKey: 'sales-map-browser-test', serverApiKey: 'sales-map-server-test' };
  await query('DELETE FROM google_maps_usage_ledger');
  await query('UPDATE sales_portal_settings SET public_access_enabled=false WHERE id=1');
  for (const role of ['sales', 'dispatcher', 'admin', 'operator', 'scm', 'yard_manager']) {
    const username = `monitor-${role}-${crypto.randomUUID()}`;
    actors[role] = await createOperator({ username, displayName: role, role, password: 'isolated-monitor-test-password' });
    sessions[role] = await loginOperator(username, 'isolated-monitor-test-password');
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  config.googleMaps = originalMaps;
  await browser?.close();
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});

test('Sales map admission succeeds through the real authenticated endpoint and normal usage ledger', async () => {
  const result = await request('sales');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.available, true);
  assert.equal(result.body.googleMapsApiKey, 'sales-map-browser-test');
  assert.ok(!JSON.stringify(result.body).includes('sales-map-server-test'));
  assert.match(result.headers.get('cache-control'), /no-store/);
  const ledger = (await query('SELECT actor_id,subsystem,admitted,admitted_units FROM google_maps_usage_ledger WHERE id=$1', [result.body.ledgerId])).rows[0];
  assert.equal(ledger.actor_id, crypto.createHash('sha256').update(actors.sales.id).digest('hex'));
  assert.equal(ledger.subsystem, 'dynamic_map');
  assert.equal(ledger.admitted, true);
  assert.equal(ledger.admitted_units, 1);
});

test('Sales map policy still denies disabled, conserve and unavailable-key cases', async () => {
  try {
    for (const mode of ['disabled', 'conserve']) {
      config.googleMaps.mode = mode;
      const result = await request('sales');
      assert.equal(result.status, 200);
      assert.equal(result.body.available, false);
      assert.equal(result.body.reason, mode === 'disabled' ? 'disabled' : 'automatic_disabled');
      assert.equal(result.body.googleMapsApiKey, undefined);
    }
    config.googleMaps.mode = 'normal';
    config.googleMaps.browserApiKey = '';
    assert.equal((await request('sales')).body.reason, 'not_configured');
  } finally {
    config.googleMaps.mode = 'normal';
    config.googleMaps.browserApiKey = 'sales-map-browser-test';
  }
});

test('property: the Sales exception admits only the map session and preserves Dispatch and staff boundaries', async () => {
  const forbidden = ['/plans', '/plans/1/commands', '/plan-edit-lease/acquire', '/maps/route-estimate', '/maps/monitor-eta', '/scm/orders', '/order-completions', '/maps/browser-session/extra', '/maps/browser-sessionx', '/maps//browser-session', '/maps/browser-session%2fextra'];
  await fc.assert(fc.asyncProperty(fc.constantFrom(...forbidden), fc.constantFrom('POST', 'PUT', 'PATCH', 'DELETE'), async (path, method) => {
    assert.equal((await request('sales', path, { method })).status, 403, `${method} ${path}`);
    assert.equal((await request('sales')).status, 200, 'The permitted counterpart must work too.');
  }), { seed: 20260922, numRuns: 40 });
  for (const method of ['PUT', 'PATCH', 'DELETE']) { assert.equal((await request('sales', '/maps/browser-session', { method })).status, 403); }
  for (const role of ['operator', 'scm', 'yard_manager']) { assert.equal((await request(role)).status, 403, role); }
  for (const role of ['dispatcher', 'admin']) { assert.equal((await request(role)).status, 200, role); }
  for (const headers of [{}, { 'x-mbbs-sales-public': '1' }, { authorization: 'Bearer invalid' }]) {
    assert.equal((await request(null, '/maps/browser-session', { headers })).status, 401);
  }
  assert.equal((await request('sales', '/config', { method: 'GET' })).status, 200);
});

test('Sales Truck Monitor renders map and truck markers and refreshes without a second admission', async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(token => localStorage.setItem('mbbs.staff.token', token), sessions.sales.token);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let admissions = 0;
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/dispatch/maps/browser-session') { admissions += 1; } });
  await page.route('**/api/dispatch/monitor', route => route.fulfill({ json: { refreshSeconds: 60, trucks: [
    { plate: 'TEST-TRUCK', latitude: 43.82, longitude: -79.45, locationTime: new Date().toISOString(), formattedLocation: 'Test yard' }
  ], trails: {}, yards: [], plannedOrders: [] } }));
  await page.route('https://maps.googleapis.com/**', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.mapTest = { maps: 0, markers: 0 };
    window.google = { maps: {
      Map: class { constructor(canvas) { this.canvas = canvas; window.mapTest.maps++; canvas.dataset.rendered = 'true'; } getDiv() { return this.canvas; } fitBounds() {} panTo() {} getZoom() { return 13; } },
      Marker: class { constructor(options) { Object.assign(this, options); window.mapTest.markers++; } getPosition() { return this.position; } setMap() {} addListener() {} },
      InfoWindow: class { addListener() {} close() {} setContent() {} open() {} },
      LatLngBounds: class { constructor() { this.points = []; } extend(point) { this.points.push(point); } isEmpty() { return !this.points.length; } },
      Size: class {}, Point: class {}
    } };
  ` }));
  try {
    await page.goto(`${base}/sales/monitor`);
    await expect(page.locator('#monitorMap')).toHaveAttribute('data-rendered', 'true', { timeout: 7000 });
    await expect(page.locator('[data-truck-plate="TEST-TRUCK"]')).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.mapTest), { maps: 1, markers: 1 });
    assert.equal(admissions, 1);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/dispatch/monitor');
    await page.locator('[data-action="refresh-monitor"]').click();
    await response;
    await expect.poll(() => page.evaluate(() => window.mapTest.markers)).toBe(2);
    assert.equal(await page.evaluate(() => window.mapTest.maps), 1);
    assert.equal(admissions, 1);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'test-artifacts/sales-monitor-map.png', fullPage: true });
  } finally { await context.close(); }
});
