/* global window, document, localStorage, Event */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import test, { before, beforeEach, after } from 'node:test';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { closeDb, query } from '../../../src/db.js';
import { AGGREGATE_MATERIALS, aggregateDates } from '../../../src/aggregate-request-domain.js';

let browser, server, base;
const sessions = {};
const loads = Object.fromEntries(AGGREGATE_MATERIALS.map(material => [material.code, material.code === 'gravel' ? 2 : 0]));
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1', 'This suite requires an isolated test database.');
  await mkdir('test-artifacts/scm-aggregate-alert', { recursive: true });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ['sales', 'scm', 'multi', 'admin', 'dispatcher']) {
    const username = `aggregate-alert-${role}-${crypto.randomUUID()}`;
    const actor = await createOperator({ username, displayName: role, password: 'aggregate-alert-test',
      role: role === 'multi' ? 'operator' : role,
      roles: role === 'multi' ? ['operator', 'scm', 'field_sales'] : [role],
      operatorYardLocationIds: role === 'multi' ? [15] : [] });
    if (role === 'sales') {
      await query('UPDATE aggregate_request_yard_assignments SET operator_id=$1 WHERE yard_location_id IN (1,28)', [actor.id]);
    }
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'aggregate-alert-test' }) });
    assert.equal(response.status, 200);
    sessions[role] = await response.json();
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});
beforeEach(async () => {
  await query('DELETE FROM aggregate_request_events');
  await query('DELETE FROM aggregate_request_lines');
  await query('DELETE FROM aggregate_requests');
});
after(async () => {
  await browser?.close();
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});
async function command(path, role, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: {
    Authorization: `Bearer ${sessions[role].token}`, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
const submit = (yard = 1) => command('/api/aggregate-requests', 'sales', { yardLocationId: yard, serviceDate: aggregateDates().serviceDate, loads });
const change = (row, action) => command(`/api/scm/aggregate-requests/${row.id}/${action}`, 'scm', {
  expectedRevision: row.revision, loads, reason: 'Resolved in isolated browser test'
});
async function pageFor(role, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', timezoneId: 'Asia/Tokyo' });
  await context.addInitScript(token => localStorage.setItem('mbbs.staff.token', token), sessions[role].token);
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  return { page, context };
}
const alert = page => page.locator('.scm-aggregate-alert');

test('confirmation date is editable, survives refresh and translation, and reaches requester and history', async () => {
  const row = await submit();
  const { page, context } = await pageFor('scm');
  let requester;
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`${base}/scm/stock-requests?tab=aggregate`);
    await page.getByRole('button', { name: 'Confirm loads', exact: true }).click();
    const date = page.locator('[data-ag-service-date]');
    await expect(date).toHaveValue(row.serviceDate);
    await date.fill('');
    assert.equal(await date.evaluate(element => element.validity.valid), false);
    await date.fill('9999-12-31');
    assert.equal(await date.evaluate(element => element.validity.rangeOverflow), true);
    await expect(page.locator('[data-ag-report-due]')).toHaveText('—');
    await date.fill('2028-02-29');
    await expect(page.locator('[data-ag-report-due]')).toHaveText('2028-03-01');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(date).toHaveValue('2028-02-29');
    await page.locator('[data-language="zh-CN"]').click();
    await expect(date).toHaveValue('2028-02-29');
    await expect(date).toHaveAccessibleName('送货 / 清运日期');
    await page.locator('[data-language="en"]').click();
    await page.getByLabel('Gravel loads', { exact: true }).fill('7');
    await page.screenshot({ path: 'test-artifacts/scm-aggregate-alert/confirmation-date.png', fullPage: true });
    await page.getByRole('button', { name: 'Save confirmation', exact: true }).click();
    await expect(page.locator('[data-ag-detail]')).toContainText('2028-02-29');
    await expect(page.locator('[data-ag-detail]')).toContainText('2028-03-01');
    await expect(page.locator('[data-ag-detail] .aggregate-submitted-at time')).toHaveAttribute('datetime', row.createdAt);
    await page.getByText('Request history', { exact: true }).click();
    await expect(page.locator('[data-ag-date-change]')).toHaveText(`Delivery / collection: ${row.serviceDate} → 2028-02-29`);
    await page.reload();
    await page.getByRole('button', { name: 'Revise confirmation', exact: true }).click();
    await expect(date).toHaveValue('2028-02-29');
    requester = await pageFor('sales');
    await requester.page.goto(`${base}/aggregate-requests`);
    await expect(requester.page.getByRole('heading', { name: 'Report actual received / collected loads', exact: true })).toBeVisible();
    await expect(requester.page.locator('.aggregate-yard-card')).toContainText('2028-02-29');
    await expect(requester.page.locator('.aggregate-yard-card')).toContainText('2028-03-01');
    await expect(requester.page.locator('.aggregate-submitted-at time')).toHaveAttribute('datetime', row.createdAt);
  } finally {
    await writeFile('test-artifacts/aggregate-confirmation-date-browser.json', JSON.stringify(await page.coverage.stopJSCoverage()));
    await requester?.context.close(); await context.close();
  }
});

test('a new submission alerts SCM on other pages and opens the pending queue with exact timestamps', async () => {
  const { page, context } = await pageFor('scm');
  try {
    await page.goto(`${base}/scm`);
    await expect(page.getByRole('heading', { name: 'SCM Menu', exact: true })).toBeVisible();
    await expect(alert(page)).toBeHidden();
    const row = await submit();
    await expect(alert(page)).toBeVisible();
    await expect(alert(page)).toHaveAccessibleName('1 aggregate request awaiting SCM confirmation');
    for (const path of ['/scm/vendors', '/scm/POTOschedule', '/scm/smart', '/scm/stock-requests']) {
      await page.goto(`${base}${path}`);
      await expect(page.locator('.dispatch-topbar .scm-aggregate-alert')).toBeVisible();
      await expect(alert(page)).toHaveCount(1);
    }
    await page.getByRole('tab', { name: 'Special', exact: true }).click();
    await expect(alert(page)).toBeVisible();
    await alert(page).click();
    await expect(page.locator('[data-ag-queue="pending"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-ag-detail] h2')).toContainText(row.requestRef);
    for (const selector of ['.aggregate-card', '[data-ag-detail]']) {
      const time = page.locator(`${selector} .aggregate-submitted-at time`).first();
      await expect(time).toHaveAttribute('datetime', row.createdAt);
      await expect(time).toContainText('Toronto');
      assert.match(await time.textContent(), /\d{4}.*\d{2}:\d{2}:\d{2}/);
    }
    await page.screenshot({ path: 'test-artifacts/scm-aggregate-alert/scm-desktop.png', fullPage: true });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    assert.ok((await alert(page).boundingBox()).y < 80, 'The alert stays at the top while scrolling a request');
    const originalTime = await page.locator('[data-ag-detail] .aggregate-submitted-at time').textContent();
    await command(`/api/aggregate-requests/${row.id}/edit`, 'sales', { expectedRevision: row.revision, loads, remarks: 'Edited later' });
    await expect(page.locator('[data-ag-detail]')).toContainText('Edited later');
    await expect(page.locator('[data-ag-detail] .aggregate-submitted-at time')).toHaveText(originalTime);
    await page.getByRole('button', { name: 'Confirm loads', exact: true }).click();
    await expect(page.locator('[data-ag-form] .aggregate-submitted-at time')).toHaveAttribute('datetime', row.createdAt);
    await page.locator('[data-language="zh-CN"]').click();
    await expect(alert(page)).toHaveAccessibleName('1 份砂石料申请等待供应链确认');
    await expect(page.locator('[data-ag-form] .aggregate-submitted-at')).toContainText('提交时间');
    await expect(page.locator('[data-ag-form] .aggregate-submitted-at time')).toContainText('多伦多');
  } finally { await context.close(); }
});

test('existing pending alerts survive reloads and clear live after confirmation or rejection', async () => {
  const first = await submit(), second = await submit(28);
  const { page, context } = await pageFor('multi');
  try {
    await page.goto(`${base}/scm/vendors`);
    await expect(alert(page)).toHaveAccessibleName('2 aggregate requests awaiting SCM confirmation');
    await page.reload();
    await expect(alert(page)).toHaveAccessibleName('2 aggregate requests awaiting SCM confirmation');
    for (const path of ['/operator', '/field-sales/']) {
      await page.goto(`${base}${path}`);
      await expect(page.locator('.topbar .scm-aggregate-alert')).toBeVisible();
    }
    await change(first, 'confirm');
    await expect(alert(page)).toHaveAccessibleName('1 aggregate request awaiting SCM confirmation');
    await change(second, 'reject');
    await expect(alert(page)).toBeHidden();
    await page.reload();
    await expect(alert(page)).toBeHidden();
  } finally { await context.close(); }
});

test('polling recovers missed events and temporary errors without clearing the last known alert', async () => {
  const row = await submit();
  const { page, context } = await pageFor('scm');
  try {
    await context.addInitScript(() => {
      delete window.EventSource;
      const interval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => interval(callback, delay === 30000 ? 150 : delay, ...args);
    });
    let failed = false;
    await page.route('**/api/scm/aggregate-requests?queue=pending', async route => {
      if (failed) { await route.fulfill({ status: 503, json: { error: 'Temporary test failure' } }); }
      else { await route.continue(); }
    });
    await page.goto(`${base}/scm`);
    await expect(alert(page)).toBeVisible();
    failed = true;
    await change(row, 'confirm');
    await page.waitForResponse(response => response.url().includes('queue=pending') && response.status() === 503);
    await expect(alert(page)).toHaveAccessibleName('1 aggregate request awaiting SCM confirmation');
    failed = false;
    await expect(alert(page)).toBeHidden();
  } finally { await context.close(); }
});

test('SCM alerts fit phone and desktop top bars and follow language changes', async () => {
  await submit();
  const { page, context } = await pageFor('scm');
  try {
    for (const width of [320, 390, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/scm`);
      await expect(alert(page)).toBeVisible();
      const rect = await alert(page).boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1, `Alert fits at ${width}px`);
      assert.ok(rect.y >= 0 && rect.y + rect.height < 180, 'Alert stays in the top bar');
      await expect.poll(() => alert(page).evaluate(element => {
        const box = element.getBoundingClientRect();
        return [box.left + 2, box.right - 2].every(x => element.contains(document.elementFromPoint(x, box.top + box.height / 2)));
      }), { message: 'The sidebar must not cover either side of the alert after its slide animation' }).toBe(true);
      await page.locator('[data-language="zh-CN"]').click();
      await expect(alert(page)).toHaveAccessibleName('1 份砂石料申请等待供应链确认');
      await expect(alert(page)).toHaveCount(1);
      if (width === 390) { await page.screenshot({ path: 'test-artifacts/scm-aggregate-alert/scm-mobile.png', fullPage: true }); }
      await page.locator('[data-language="en"]').click();
    }
    const a11y = await new AxeBuilder({ page }).include('.scm-aggregate-alert').analyze();
    assert.deepEqual(a11y.violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => item.id), []);
  } finally { await context.close(); }
});

test('admin sees the alert outside SCM while non-SCM staff never fetch the pending queue', async () => {
  await submit();
  for (const [role, path, visible] of [['admin', '/control', true], ['dispatcher', '/dispatch', false], ['sales', '/sales', false]]) {
    const { page, context } = await pageFor(role);
    try {
      const pendingCalls = [];
      page.on('request', request => { if (request.url().includes('/api/scm/aggregate-requests')) { pendingCalls.push(request.url()); } });
      await page.goto(`${base}${path}`);
      await expect(page.locator('.dispatch-topbar, .topbar').first()).toBeVisible();
      if (visible) { await expect(alert(page)).toBeVisible(); }
      else {
        await page.evaluate(() => window.MBBSScmAggregateAlert?.refresh());
        await expect(alert(page)).toHaveCount(0);
        assert.deepEqual(pendingCalls, []);
      }
    } finally { await context.close(); }
  }
});

test('revoked SCM access removes the last known alert', async () => {
  await submit();
  const { page, context } = await pageFor('scm');
  try {
    await page.goto(`${base}/scm`);
    await expect(alert(page)).toBeVisible();
    await page.route('**/api/scm/aggregate-requests?queue=pending', route => route.fulfill({ status: 403, json: { error: 'Access revoked' } }));
    await page.evaluate(() => window.MBBSScmAggregateAlert.refresh());
    await expect(alert(page)).toHaveCount(0);
  } finally { await context.close(); }
});

test('a delayed response cannot restore the alert after logout', async () => {
  await submit();
  const { page, context } = await pageFor('scm');
  try {
    await page.goto(`${base}/scm`);
    await expect(alert(page)).toBeVisible();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const intercepted = new Promise(resolve => { entered = resolve; });
    await page.route('**/api/scm/aggregate-requests?queue=pending', async route => {
      const response = await route.fetch();
      entered();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.evaluate(() => { void window.MBBSScmAggregateAlert.refresh(); });
    await intercepted;
    await page.evaluate(() => {
      for (const key of ['mbbs.staff.token', 'mbbs.dispatch.token', 'mbbs.control.token', 'mbbs.operator.token']) { localStorage.removeItem(key); }
      window.dispatchEvent(new Event('mbbs-auth-operator-changed'));
    });
    await expect(alert(page)).toHaveCount(0);
    release();
    await expect(alert(page)).toHaveCount(0);
  } finally { await context.close(); }
});

test('requesters see their original submission timestamp when editing and reporting actuals', async () => {
  const row = await submit();
  const { page, context } = await pageFor('sales', { width: 390, height: 844 });
  try {
    await page.goto(`${base}/aggregate-requests`);
    await expect(page.getByRole('heading', { name: 'Edit submitted request', exact: true })).toBeVisible();
    await expect(page.locator('.aggregate-submitted-at time')).toHaveAttribute('datetime', row.createdAt);
    await expect(page.locator('.aggregate-submitted-at time')).toContainText('Toronto');
    await expect(alert(page)).toHaveCount(0);
    await change(row, 'confirm');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Report actual received / collected loads', exact: true })).toBeVisible();
    await expect(page.locator('.aggregate-submitted-at time')).toHaveAttribute('datetime', row.createdAt);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  } finally { await context.close(); }
});
