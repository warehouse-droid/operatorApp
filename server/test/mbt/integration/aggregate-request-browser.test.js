/* global localStorage, window, Event, document, getComputedStyle */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { closeDb, query } from '../../../src/db.js';
import { aggregateDates, AGGREGATE_MATERIALS } from '../../../src/aggregate-request-domain.js';
import { createAggregateRequest } from '../../../src/aggregate-request-repository.js';

let browser;
let server;
let base;
let pending;
const sessions = {};
const browserCoverage = [];
const loads = n => Object.fromEntries(AGGREGATE_MATERIALS.map(m => [m.code, m.code === 'gravel' ? n : 0]));
before(async () => {
  await query('DELETE FROM aggregate_request_events');
  await query('DELETE FROM aggregate_request_lines');
  await query('DELETE FROM aggregate_requests');
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=NULL');
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['sales', 'scm', 'operator', 'workflow', 'admin', 'empty']) {
    const role = ['workflow', 'empty'].includes(name) ? 'operator' : name;
    const username = `aggregate-browser-${name}-${crypto.randomUUID()}`;
    const actor = await createOperator({ username, displayName: `Aggregate ${role}`, password: 'aggregate-browser-test', role,
      yardLocationIds: role === 'sales' ? [1, 28] : [], operatorYardLocationIds: name === 'operator' ? [15] : name === 'empty' ? [28] : name === 'workflow' ? [26] : [] });
    const granted = name === 'sales' ? [1, 28] : name === 'operator' ? [15] : name === 'workflow' ? [26] : [];
    actor.aggregateRequestYardLocationIds = granted;
    await query('UPDATE aggregate_request_yard_assignments SET operator_id=$1 WHERE yard_location_id=ANY($2::int[])', [actor.id, granted]);
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'aggregate-browser-test' }) });
    sessions[name] = { actor, ...(await response.json()) };
  }
  const now = new Date(Date.now() - 3 * 86400000);
  pending = await createAggregateRequest({ yardLocationId: 28, serviceDate: aggregateDates(now).serviceDate, loads: loads(3), operationId: crypto.randomUUID() }, sessions.sales.actor, { now });
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});
after(async () => {
  await writeFile('test-artifacts/aggregate-browser-coverage.json', JSON.stringify(browserCoverage));
  await browser?.close();
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});
async function pageFor(role, viewport = { width: 1280, height: 900 }) {
  // PWA installation deliberately reloads Operator on first control. These
  // online workflow checks use real HTTP; cache behavior has its own tests.
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.addInitScript(({ token }) => localStorage.setItem('mbbs.staff.token', token), sessions[role]);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  return { context, page };
}
async function capture(page, name) {
  await page.screenshot({ path: `test-artifacts/aggregate-${name}.png`, fullPage: true });
  browserCoverage.push(...await page.coverage.stopJSCoverage());
}
async function checkActualCards(page) {
  const cards = await page.locator('[data-ag-material]').evaluateAll(elements => elements.map(element => {
    const label = element.querySelector('label').getBoundingClientRect();
    const badge = element.querySelector('.aggregate-confirmed-loads').getBoundingClientRect();
    return { label: { right: label.right, top: label.top, bottom: label.bottom },
      badge: { left: badge.left, top: badge.top, bottom: badge.bottom, width: badge.width, height: badge.height },
      background: getComputedStyle(element).backgroundColor };
  }));
  assert.equal(cards.length, 7);
  for (const { label, badge, background } of cards) {
    assert.ok(badge.left > label.right, 'SCM quantity is to the right of the material label.');
    assert.ok(Math.abs((badge.top + badge.bottom) - (label.top + label.bottom)) < 2, 'Label and badge share one row.');
    assert.equal(badge.width, badge.height, 'SCM quantity badge is square.');
    assert.notEqual(background, 'rgb(255, 255, 255)', 'Actual-report cards have a distinct background.');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
}
test('requester submission becomes an edit form and SCM confirmation immediately allows an actual report', async () => {
  const { page, context } = await pageFor('workflow');
  await page.goto(`${base}/aggregate-requests`);
  await page.getByRole('button', { name: 'Increase Gravel loads', exact: true }).click();
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit submitted request', exact: true })).toBeVisible();
  await expect(page.locator('[data-ag-request-card]')).toHaveCount(8);
  await expect(page.locator('.aggregate-filters, .aggregate-request-history, .aggregate-table, [data-ag-action="new"]')).toHaveCount(0);
  await expect(page.getByLabel('Gravel loads', { exact: true })).toHaveValue('1');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Edit submitted request', exact: true })).toBeVisible();
  const request = (await query('SELECT id, revision FROM aggregate_requests WHERE yard_location_id=26 AND service_date=$1', [aggregateDates().serviceDate])).rows[0];
  await page.getByLabel('Gravel loads', { exact: true }).fill('9');
  const confirmation = await fetch(`${base}/api/scm/aggregate-requests/${request.id}/confirm`, {
    method: 'POST', headers: { authorization: `Bearer ${sessions.scm.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: request.revision, loads: loads(2), operationId: crypto.randomUUID() })
  });
  assert.equal(confirmation.status, 200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Report actual received / collected loads', exact: true })).toBeVisible();
  for (const material of AGGREGATE_MATERIALS) { await expect(page.getByLabel(`${material.label} loads`, { exact: true })).toHaveValue('0'); }
  await expect(page.getByRole('note', { name: 'SCM confirmed: 2 loads', exact: true })).toBeVisible();
  await checkActualCards(page);
  await expect(page.getByRole('button', { name: 'Submit actual report', exact: true })).toBeEnabled();
  await capture(page, 'actuals-desktop-en');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Report actual received / collected loads', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Increase Gravel loads', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkActualCards(page);
  await capture(page, 'actuals-mobile-en');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.locator('[data-language="zh-CN"]').click();
  await expect(page.getByRole('heading', { name: '填报实际收到 / 清运的车数', exact: true })).toBeVisible();
  await expect(page.getByRole('note', { name: '供应链已确认：2 车', exact: true })).toBeVisible();
  await expect(page.getByLabel('石子车数', { exact: true })).toHaveValue('1');
  await checkActualCards(page);
  const accessibility = await new AxeBuilder({ page }).include('[data-aggregate-root]').analyze();
  assert.deepEqual(accessibility.violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => v.id), []);
  await capture(page, 'confirmed-actuals');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.getByRole('button', { name: '提交实际车数', exact: true }).click();
  await expect(page.getByRole('heading', { name: '申请明日车数', exact: true })).toBeVisible();
  const report = (await query('SELECT status, revision, needs_review, report_due_date::text FROM aggregate_requests WHERE id=$1', [request.id])).rows[0];
  assert.equal(report.status, 'reported');
  assert.equal(report.needs_review, true);
  assert.ok(report.report_due_date > aggregateDates().today, 'Submission succeeds before the report due date.');
  const acknowledged = await fetch(`${base}/api/scm/aggregate-requests/${request.id}/acknowledge`, {
    method: 'POST', headers: { authorization: `Bearer ${sessions.scm.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: report.revision, operationId: crypto.randomUUID() })
  });
  assert.equal(acknowledged.status, 200);
  await page.reload();
  await expect(page.getByRole('heading', { name: '申请明日车数', exact: true })).toBeVisible();
  await expect(page.locator('[data-ag-load]')).toHaveCount(7);
  assert.deepEqual(await page.locator('[data-ag-load]').evaluateAll(inputs => inputs.map(input => input.value)), Array(7).fill('0'));
  await page.getByLabel('石子车数', { exact: true }).fill('3');
  await page.getByRole('button', { name: '提交申请', exact: true }).click();
  await expect(page.getByRole('heading', { name: '修改已提交的申请', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('石子车数', { exact: true })).toHaveValue('3');
  const requests = (await query('SELECT id, status, needs_review FROM aggregate_requests WHERE yard_location_id=26 AND service_date=$1 ORDER BY id', [aggregateDates().serviceDate])).rows;
  assert.equal(requests.length, 2);
  assert.equal(Number(requests[0].id), Number(request.id));
  assert.equal(requests[0].status, 'reported');
  assert.equal(requests[0].needs_review, false);
  assert.equal(requests[1].status, 'submitted');
  assert.notEqual(requests[1].id, requests[0].id);
  await capture(page, 'actuals-immediate-complete');
  await context.close();
});
test('mobile standalone submission uses loads and preserves form during live updates', async () => {
  const { page, context } = await pageFor('sales', { width: 390, height: 844 });
  await page.goto(`${base}/aggregate-requests`);
  await expect(page.getByRole('heading', { name: 'Aggregate Requests', exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByLabel('Assigned yard', { exact: true }).selectOption('1');
  await expect(page.getByRole('heading', { name: "Request tomorrow's loads", exact: true })).toBeVisible();
  await expect(page.locator('[data-ag-request-card]')).toHaveCount(8);
  await expect(page.locator('#appSidebar, aside')).toHaveCount(0);
  for (let count = 0; count < 3; count += 1) { await page.getByRole('button', { name: 'Increase Gravel loads', exact: true }).click(); }
  await page.getByLabel('Dump Soil loads', { exact: true }).fill('2');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Gravel loads', { exact: true })).toHaveValue('3');
  await capture(page, 'request-mobile');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit submitted request', exact: true })).toBeVisible();
  await expect(page.getByLabel('Dump Soil loads', { exact: true })).toHaveValue('2');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  const accessibility = await new AxeBuilder({ page }).include('[data-aggregate-root]').analyze();
  assert.deepEqual(accessibility.violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => v.id), []);
  await capture(page, 'mobile');
  await context.close();
});

test('request cards use only Admin-assigned yards and plus/minus controls keep whole nonnegative loads', async () => {
  const { page, context } = await pageFor('operator');
  await page.goto(`${base}/aggregate-requests`);
  await expect(page.locator('[data-ag-request-card]')).toHaveCount(8);
  await expect(page.locator('#appSidebar, aside')).toHaveCount(0);
  await expect(page.getByLabel('Assigned yard', { exact: true })).toHaveValue('15');
  await expect(page.getByLabel('Assigned yard', { exact: true })).toBeDisabled();
  assert.deepEqual(await page.locator('[data-ag-form-yard] option').evaluateAll(options => options.map(option => option.value)), ['15']);
  await expect(page.getByRole('button', { name: 'Decrease Gravel loads', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Increase Gravel loads', exact: true }).click();
  await page.getByRole('button', { name: 'Increase Gravel loads', exact: true }).click();
  await page.getByRole('button', { name: 'Decrease Gravel loads', exact: true }).click();
  await expect(page.getByLabel('Gravel loads', { exact: true })).toHaveValue('1');
  await page.getByLabel('Gravel loads', { exact: true }).fill('0');
  await expect(page.getByRole('button', { name: 'Decrease Gravel loads', exact: true })).toBeDisabled();
  const denied = await fetch(`${base}/api/aggregate-requests`, {
    method: 'POST', headers: { authorization: `Bearer ${sessions.operator.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ yardLocationId: 1, serviceDate: aggregateDates().serviceDate, loads: loads(2), operationId: crypto.randomUUID() })
  });
  assert.equal(denied.status, 403, 'Changing the submitted yard cannot bypass Admin allocation.');
  const accessibility = await new AxeBuilder({ page }).include('[data-aggregate-root]').analyze();
  assert.deepEqual(accessibility.violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => v.id), []);
  await capture(page, 'request-desktop');
  await context.close();
});

test('English and Chinese switching preserves quantities, yard and remarks and translates validation', async () => {
  const { page, context } = await pageFor('operator', { width: 390, height: 844 });
  await page.goto(`${base}/aggregate-requests`);
  await expect(page.locator('[data-ag-request-card]')).toHaveCount(8);
  await page.getByLabel('Remarks (optional)', { exact: true }).fill('Keep this note 原文');
  await page.locator('[data-language="zh-CN"]').click();
  await expect(page.getByRole('heading', { name: '砂石料申请', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '申请明日车数', exact: true })).toBeVisible();
  await expect(page.getByLabel('已授权堆场', { exact: true })).toHaveValue('15');
  await page.getByRole('button', { name: '提交申请', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请至少申请一车。');
  await page.getByRole('button', { name: '石子车数加一', exact: true }).click();
  await page.getByRole('button', { name: '废土车数加一', exact: true }).click();
  await expect(page.getByLabel('石子车数', { exact: true })).toHaveValue('1');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('备注（选填）', { exact: true })).toHaveValue('Keep this note 原文');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await capture(page, 'request-chinese');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.locator('[data-language="en"]').click();
  await expect(page.getByLabel('Gravel loads', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Dump Soil loads', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Remarks (optional)', { exact: true })).toHaveValue('Keep this note 原文');
  await expect(page.getByLabel('Assigned yard', { exact: true })).toHaveValue('15');
  await capture(page, 'request-language-return');
  await context.close();
});
test('Operator Inventory groups the four entries, retains Cycle Count and returns from Aggregate Requests', async () => {
  const { page, context } = await pageFor('operator');
  await page.goto(`${base}/operator`);
  await expect(page.getByRole('heading', { name: 'Operator Menu', exact: true })).toBeVisible();
  await expect(page.locator('[data-action="toggle-location-dropdown"]')).toContainText('12441');
  await expect(page.locator('.module-menu .module-tile')).toHaveCount(6);
  await expect(page.locator('.module-menu a[href="/aggregate-requests"]')).toHaveCount(0);
  await expect(page.locator('.module-menu [data-module="cycle-count"]')).toHaveCount(0);
  await page.locator('.module-menu [data-module="inventory"]').click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await expect(page.locator('.module-menu .module-tile')).toHaveCount(4);
  await expect(page.locator('.module-menu strong')).toHaveText(['Aggregate Requests', 'Damage', 'Cycle Count', 'Count Sheet']);
  await expect(page.locator('.module-menu [data-module="damage"]')).toBeEnabled();
  await expect(page.locator('.module-menu [data-module="count-sheets"]')).toBeEnabled();
  await page.locator('.module-menu [data-module="damage"]').click();
  await expect(page.getByRole('heading', { name: 'Damage stock', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.locator('.module-menu [data-module="count-sheets"]').click();
  await expect(page.getByRole('heading', { name: 'Count sheets', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await page.locator('[data-language="zh-CN"]').click();
  await expect(page.locator('.module-menu strong')).toHaveText(['砂石料申请', '报损', '循环盘点', '盘点表']);
  await page.locator('[data-language="en"]').click();
  await capture(page, 'inventory-menu');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.locator('.module-menu [data-module="cycle-count"]').click();
  await expect(page.getByRole('heading', { name: 'Cycle Count', exact: true })).toBeVisible();
  await expect(page.getByLabel('Search SKU', { exact: true })).toBeVisible();
  await page.locator('[data-action="cycle-back"]').click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await page.locator('.module-menu [data-module="cycle-count"]').click();
  await expect(page.getByRole('heading', { name: 'Cycle Count', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inventory', exact: true }).click();
  await page.getByRole('link', { name: /^Aggregate Requests/ }).click();
  await expect(page.locator('[data-ag-request-card]')).toHaveCount(8);
  await expect(page.getByLabel('Assigned yard', { exact: true })).toHaveValue('15');
  await page.getByRole('link', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await capture(page, 'inventory-return');
  await context.close();
});

test('SCM confirms, reports on behalf, acknowledges shortfall and retains the Aggregate tab', async () => {
  const { page, context } = await pageFor('scm');
  await page.goto(`${base}/scm/stock-requests?tab=aggregate`);
  await expect(page.getByRole('tab', { name: 'Aggregate', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 3000 });
  await expect(page.locator('[data-ag-detail]')).toBeVisible();
  let releaseSelection;
  const selectionGate = new Promise(resolve => { releaseSelection = resolve; });
  await page.route(`**/api/scm/aggregate-requests/${pending.id}`, async route => { await selectionGate; await route.continue(); }, { times: 1 });
  await page.locator(`[data-ag-select="${pending.id}"]`).click();
  try { await expect(page.getByRole('button', { name: 'Confirm loads', exact: true })).toHaveCount(0); }
  finally { releaseSelection(); }
  await expect(page.locator('[data-ag-detail] h2')).toContainText(pending.requestRef);
  await page.getByRole('button', { name: 'Edit material memos', exact: true }).click();
  await expect(page.locator('[data-ag-memo]')).toHaveCount(7);
  const memo = 'Morning delivery 上午送货\n<script>window.aggregateMemoInjected=true</script>';
  await page.getByLabel('Gravel SCM memo', { exact: true }).fill(memo);
  await page.getByLabel('Dump Soil SCM memo', { exact: true }).fill('Call before collection');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Gravel SCM memo', { exact: true })).toHaveValue(memo);
  await page.locator('[data-language="zh-CN"]').click();
  await expect(page.getByLabel('石子供应链备注', { exact: true })).toHaveValue(memo);
  await page.getByRole('button', { name: '保存物料备注', exact: true }).click();
  await expect(page.locator('[data-ag-detail]')).toBeVisible();
  await page.locator('[data-language="en"]').click();
  await page.reload();
  await page.locator(`[data-ag-select="${pending.id}"]`).click();
  await expect(page.locator('[data-ag-memo-value="gravel"]')).toHaveText(memo);
  await expect(page.locator('[data-ag-memo-value="dump_soil"]')).toHaveText('Call before collection');
  assert.equal(await page.evaluate(() => window.aggregateMemoInjected), undefined);
  await capture(page, 'scm-material-memos');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.getByRole('button', { name: 'Confirm loads', exact: true }).click();
  await page.getByRole('button', { name: 'Save confirmation', exact: true }).click();
  await page.getByRole('button', { name: 'Report actual loads', exact: true }).click();
  for (const material of AGGREGATE_MATERIALS) {
    await page.getByLabel(`${material.label} loads`, { exact: true }).fill(material.code === 'gravel' ? '2' : '0');
  }
  await page.getByRole('button', { name: 'Submit actual report', exact: true }).click();
  await expect(page.locator('[data-ag-detail]')).toContainText('1 short');
  await expect(page.getByRole('button', { name: 'Needs Review (1)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Acknowledge difference', exact: true }).click();
  await expect(page.locator('[data-ag-detail]')).toContainText('Difference acknowledged');
  const approved = (await query('SELECT status,needs_review FROM aggregate_requests WHERE id=$1', [pending.id])).rows[0];
  assert.equal(approved.status, 'reported');
  assert.equal(approved.needs_review, false);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Aggregate', exact: true })).toHaveAttribute('aria-selected', 'true');
  await capture(page, 'scm');
  await page.evaluate(() => window.dispatchEvent(new Event('mbbs-language-changed')));
  await expect(page.getByRole('tab', { name: 'Aggregate', exact: true })).toHaveAttribute('aria-selected', 'true');
  await context.close();
});
test('switching from a delayed Regular response cannot repaint the Aggregate tab', async () => {
  const { page, context } = await pageFor('scm');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  await page.route('**/api/scm/stock-requests?**', async route => { requested(); await gate; await route.continue(); });
  await page.goto(`${base}/scm/stock-requests`);
  await started;
  await page.getByRole('tab', { name: 'Aggregate', exact: true }).click();
  release();
  await expect(page.locator('[data-aggregate-root]')).toBeVisible({ timeout: 3000 });
  await page.getByRole('tab', { name: 'Special', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Aggregate', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Aggregate', exact: true }).click();
  await expect(page.locator('[data-aggregate-root]')).toBeVisible();
  await page.getByRole('tab', { name: 'Aggregate', exact: true }).press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Special', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Special', exact: true }).press('Home');
  await expect(page.getByRole('tab', { name: 'Regular', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Regular', exact: true }).press('End');
  await expect(page.getByRole('tab', { name: 'Aggregate', exact: true })).toHaveAttribute('aria-selected', 'true');
  await capture(page, 'tabs');
  await context.close();
});

test('requester reports actuals in the cards, starts the next request and edits it without history', async () => {
  const earlier = new Date(Date.now() - 6 * 86400000);
  const old = await createAggregateRequest({ yardLocationId: 15, serviceDate: aggregateDates(earlier).serviceDate, loads: loads(3), operationId: crypto.randomUUID() }, sessions.operator.actor, { now: earlier });
  const confirmed = await fetch(`${base}/api/scm/aggregate-requests/${old.id}/confirm`, {
    method: 'POST', headers: { authorization: `Bearer ${sessions.scm.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: old.revision, loads: loads(3), operationId: crypto.randomUUID() })
  });
  assert.equal(confirmed.status, 200);
  const { page, context } = await pageFor('operator');
  await page.goto(`${base}/aggregate-requests`);
  await expect(page.getByRole('heading', { name: 'Report actual received / collected loads', exact: true })).toBeVisible();
  await expect(page.locator('.aggregate-filters, .aggregate-request-history, .aggregate-table')).toHaveCount(0);
  await expect(page.locator('[data-ag-request-card]')).toHaveCount(8);
  await expect(page.getByRole('note', { name: 'SCM confirmed: 3 loads', exact: true })).toBeVisible();
  for (const material of AGGREGATE_MATERIALS) { await expect(page.getByLabel(`${material.label} loads`, { exact: true })).toHaveValue('0'); }
  await page.getByLabel('Gravel loads', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Submit actual report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Report actual received / collected loads', exact: true })).toBeVisible();
  await page.getByLabel('Gravel loads', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Submit actual report', exact: true }).click();
  await expect(page.getByRole('heading', { name: "Request tomorrow's loads", exact: true })).toBeVisible();
  const stored = (await query('SELECT status, needs_review FROM aggregate_requests WHERE id=$1', [old.id])).rows[0];
  assert.equal(stored.status, 'reported');
  assert.equal(stored.needs_review, true);
  await page.getByLabel('Gravel loads', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit submitted request', exact: true })).toBeVisible();
  const duplicate = await fetch(`${base}/api/aggregate-requests`, { method: 'POST',
    headers: { authorization: `Bearer ${sessions.operator.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ yardLocationId: 15, serviceDate: aggregateDates().serviceDate, loads: loads(2), operationId: crypto.randomUUID() }) });
  assert.equal(duplicate.status, 409);
  await page.getByLabel('Gravel loads', { exact: true }).fill('5');
  await page.getByLabel('Remarks (optional)', { exact: true }).fill('<script>window.aggregateInjected=true</script>');
  await page.getByRole('button', { name: 'Save requested loads', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save requested loads', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Gravel loads', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('Remarks (optional)', { exact: true })).toHaveValue('<script>window.aggregateInjected=true</script>');
  assert.equal(await page.evaluate(() => window.aggregateInjected), undefined);
  await capture(page, 'requester-report');
  await context.close();
});

test('a failed Regular queue refresh after switching tabs shows a recoverable error', async () => {
  const { page, context } = await pageFor('scm');
  await page.goto(`${base}/scm/stock-requests?tab=aggregate`);
  await expect(page.locator('[data-aggregate-root]')).toBeVisible();
  await page.route('**/api/scm/stock-requests?**', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Regular queue temporarily unavailable' })
  }));
  await page.getByRole('tab', { name: 'Regular', exact: true }).click();
  await expect(page.getByText('Regular queue temporarily unavailable', { exact: true })).toBeVisible({ timeout: 2000 });
  await page.getByRole('tab', { name: 'Aggregate', exact: true }).click();
  await expect(page.locator('[data-aggregate-root]')).toBeVisible();
  await capture(page, 'network-recovery');
  await context.close();
});

test('keyboard tab focus survives a background queue refresh', async () => {
  const { page, context } = await pageFor('scm');
  await page.goto(`${base}/scm/stock-requests?tab=aggregate`);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Aggregate', exact: true }).focus();
  const refreshed = page.waitForResponse(response => /\/api\/scm\/aggregate-requests\/\d+$/.test(response.url()));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'Aggregate', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Special', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Special', exact: true })).toBeFocused();
  await capture(page, 'keyboard-refresh');
  await context.close();
});

test('requester rejects delayed yard snapshots, recovers from network loss and retries a committed submission once', async t => {
  const { page, context } = await pageFor('sales');
  await page.goto(`${base}/aggregate-requests`);
  await expect(page.getByRole('heading', { name: 'Edit submitted request', exact: true })).toBeVisible();
  let release;
  t.after(async () => { release?.(); await context.close(); });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/aggregate-requests/workspace?yardLocationId=1', async route => {
    const response = await route.fetch(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  const started = page.waitForRequest('**/api/aggregate-requests/workspace?yardLocationId=1');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await started;
  await page.getByLabel('Assigned yard', { exact: true }).selectOption('28');
  await expect(page.getByRole('heading', { name: "Request tomorrow's loads", exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse(response => response.url().endsWith('workspace?yardLocationId=1'));
  release(); await oldResponse;
  await expect(page.getByLabel('Assigned yard', { exact: true })).toHaveValue('28');
  await page.getByLabel('Gravel loads', { exact: true }).fill('4');
  await page.route('**/api/aggregate-requests/workspace?yardLocationId=28', route => route.abort(), { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('Failed to fetch');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Gravel loads', { exact: true })).toHaveValue('4');
  await page.route('**/api/aggregate-requests', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort();
  }, { times: 1 });
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Failed to fetch');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit submitted request', exact: true })).toBeVisible();
  await expect(page.getByLabel('Gravel loads', { exact: true })).toHaveValue('4');
  const stored = (await query(`SELECT count(*)::int AS n FROM aggregate_request_events e JOIN aggregate_requests r ON r.id=e.request_id
    WHERE r.yard_location_id=28 AND r.service_date=$1 AND e.action='submit'`, [aggregateDates().serviceDate])).rows[0];
  assert.equal(stored.n, 1);
  await page.getByLabel('Gravel loads', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Reload saved loads', exact: true }).click();
  await expect(page.getByLabel('Gravel loads', { exact: true })).toHaveValue('4');
  await capture(page, 'requester-recovery');
  await context.close();
});

test('Admin assigns and revokes Aggregate independently; live requester controls follow the grant', async () => {
  const requester = await pageFor('empty');
  await requester.page.goto(`${base}/operator`);
  await requester.page.locator('.module-menu [data-module="inventory"]').click();
  await expect(requester.page.getByRole('button', { name: /Aggregate Requests Ask Admin/ })).toBeDisabled();
  await requester.page.goto(`${base}/aggregate-requests`);
  await expect(requester.page.getByRole('alert')).toContainText('Aggregate request access is required');
  await expect(requester.page.locator('[data-ag-request-card]')).toHaveCount(0);
  const { page, context } = await pageFor('admin');
  await page.goto(`${base}/admin/accounts`);
  await page.locator(`[data-action="select-account"][data-id="${sessions.empty.actor.id}"]`).click();
  const access = page.locator('[data-aggregate-access]');
  await expect(access.getByRole('heading', { name: 'Aggregate request access', exact: true })).toBeVisible();
  await expect(page.locator('[data-account-operator-yard][value="28"]')).toBeChecked();
  await expect(page.locator('[data-account-operator-yard][value="1"]')).not.toBeChecked();
  await access.getByLabel('3445', { exact: true }).check();
  page.on('dialog', dialog => dialog.accept());
  await access.getByRole('button', { name: 'Save Aggregate access', exact: true }).click();
  await expect(access.getByLabel('3445', { exact: true })).toBeChecked();
  await requester.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // The prior submitter's operational request remains intact and read-only.
  await expect(requester.page.getByRole('heading', { name: 'Request awaiting SCM', exact: true })).toBeVisible();
  await expect(requester.page.getByLabel('Assigned yard', { exact: true })).toHaveValue('1');
  await expect(requester.page.getByLabel('Gravel loads', { exact: true })).toBeDisabled();
  const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${sessions.empty.token}` } });
  const actor = (await me.json()).operator;
  assert.deepEqual(actor.aggregateRequestYardLocationIds, [1]);
  assert.deepEqual(actor.operatorYardLocationIds, [28]);
  assert.equal(actor.role, 'operator');
  await page.locator('[data-language="zh-CN"]').click();
  await expect(access.getByRole('heading', { name: '砂石料申请权限', exact: true })).toBeVisible();
  await expect(access).toContainText('当前申请人');
  await capture(page, 'admin-access-chinese');
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await access.getByLabel('3445', { exact: true }).uncheck();
  await access.getByRole('button', { name: '保存砂石料申请权限', exact: true }).click();
  await expect(access.getByLabel('3445', { exact: true })).not.toBeChecked();
  await requester.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(requester.page.getByRole('alert')).toContainText('Aggregate request access is required');
  await expect(requester.page.locator('[data-ag-request-card]')).toHaveCount(0);
  await capture(requester.page, 'revoked-access');
  await capture(page, 'admin-revoked-access');
  await context.close(); await requester.context.close();
});
