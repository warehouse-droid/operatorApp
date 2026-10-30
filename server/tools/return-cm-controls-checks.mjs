import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { MBT_ADMIN_GATE_DEFINITIONS } from '../src/mbt/feature-gate-catalog.js';

const files = JSON.parse(fs.readFileSync('tools/return-cm-controls-files.json', 'utf8'));
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const tests = ['test/mbt/unit/feature-gate-catalog.test.js', 'test/mbt/integration/feature-gate-admin-http.test.js',
  'test/mbt/unit/return-credit-memo.test.js', 'test/mbt/integration/return-credit-memo.test.js'];
const run = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=90000', '--test-concurrency=1', ...tests],
  { encoding: 'utf8', timeout: 180000, maxBuffer: 8e6 });
fs.writeFileSync('test-artifacts/return-cm-controls-tests.log', (run.stdout || '') + (run.stderr || ''));
assert.ifError(run.error);
assert.equal(run.status, 0, ((run.stdout || '') + (run.stderr || '')).slice(-10000));
const count = Number(run.stdout.match(/# tests (\d+)/)?.[1]);
console.log(`Gate and Credit Memo regressions: ${count} passed`);
for (const file of ['public/mbt-gates.js', 'public/control.js']) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
}
const gates = MBT_ADMIN_GATE_DEFINITIONS.filter(g => g.gateGroup === 'operator_netsuite_posting')
  .map(g => ({ ...g, configured: true, effective: true, environmentAllowed: true, revision: 1 }));
const inventory = { gates, netSuiteDirectAccessAllowed: true, environmentRootAllowed: true };
const writes = [];
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://gate-check.invalid/**', async route => {
    const url = new URL(route.request().url());
    let value = {};
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><main><section class="mbt-status"></section><input id="gateReason"><div id="operatorNetSuiteGateMatrix"></div><div id="gateList"></div></main><script>localStorage.setItem("mbbs.staff.token","synthetic-token")</script><script src="/mbt-gates.js"></script>' });
    }
    if (url.pathname === '/mbt-gates.js') { return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: fs.readFileSync('public/mbt-gates.js', 'utf8') }); }
    if (url.pathname === '/api/auth/me') { value = { operator: { role: 'admin' } }; }
    if (url.pathname === '/api/mbt/config/gates') { value = inventory; }
    if (route.request().method() === 'PUT') {
      const key = decodeURIComponent(url.pathname.split('/').at(-1));
      const gate = gates.find(g => g.flagKey === key);
      const body = route.request().postDataJSON();
      assert.ok(gate && /_return_cm_/.test(key));
      assert.equal(body.expectedRevision, gate.revision);
      assert.equal(body.reason, 'Verify CM-only controls');
      writes.push({ key, enabled: body.enabled });
      gate.configured = body.enabled; gate.effective = body.enabled; gate.revision++;
      value = { flag: gate };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto('https://gate-check.invalid/');
  const matrix = page.locator('#operatorNetSuiteGateMatrix');
  await expect(matrix.locator('thead th')).toHaveText(['Yard', 'Customer Pickup → IF', 'Receiving → IR', 'Delivery Prep → IF', 'Stock Return → CM', 'Pallet Return → CM', 'Stock exchange → IT']);
  await expect(matrix.locator('[data-gate-toggle*="_return_ra_"]')).toHaveCount(0);
  await expect(matrix.locator('[data-gate-toggle*="_return_cm_"]')).toHaveCount(8);
  await expect(matrix.locator('[data-gate-toggle*="_stock_exchange_it_"]')).toHaveCount(3);
  await expect(matrix.locator('[data-gate-toggle]')).toHaveCount(23);
  await page.locator('#gateReason').fill('Verify CM-only controls');
  for (const kind of ['stock', 'pallet']) {
    const button = matrix.locator(`[data-gate-toggle="operator_netsuite_${kind}_return_cm_3445"]`);
    await button.click(); await expect(button).toHaveText('Turn on');
    await expect(button.locator('..')).toContainText('Local only');
    await button.click(); await expect(button).toHaveText('Turn off');
    await expect(button.locator('..')).toContainText('Creates CM');
  }
  assert.equal(writes.length, 4);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
const report = { passed: true, tests: count, browser: 'CM-only controls for four yards; stock/pallet off/on updates correct gate and revision', sourceHashes };
fs.writeFileSync('test-artifacts/return-cm-controls-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
