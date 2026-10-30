import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { app } from '../../../src/server.js';
import { config } from '../../../src/config.js';
import { query, closeDb } from '../../../src/db.js';
import { updateOperatorPassword, loginOperator } from '../../../src/auth-repository.js';
import { finalCollectionFixture, completeRentalPart } from '../support/bin-final-collection-fixtures.js';

after(closeDb);

test('UAT ER09: populated Collection cards contain their content at all five tester-pack widths, before and after unlocking', { timeout: 120000 }, async () => {
  const fixtures = [];
  for (let i = 0; i < 7; i++) fixtures.push(await finalCollectionFixture());
  const f = fixtures[0];
  await updateOperatorPassword(f.actor.operatorId, 'uat-layout-synthetic-password');
  const token = (await loginOperator(f.actor.operatorId, 'uat-layout-synthetic-password')).token;
  config.mbt.enabled = true;
  config.mbtPhase3.binDispatchEnabled = true;
  config.dispatch.driverOrientedPlanning = true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_bin_dispatch')");
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    context.setDefaultTimeout(10000);
    await context.addInitScript(({ token, f }) => {
      localStorage.setItem('mbbs.staff.token', token);
      localStorage.setItem('mbbs.dispatch.planDate', f.planDate);
      sessionStorage.setItem('mbbs.dispatch.sessionId', f.editLease.sessionId);
      sessionStorage.setItem('mbbs.dispatch.editLease.v1', JSON.stringify({ planDate: f.planDate,
        sessionId: f.editLease.sessionId, editLeaseToken: f.editLease.token, expiresAt: new Date(Date.now() + 600000).toISOString() }));
    }, { token, f });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/planning?planDate=${f.planDate}`);
    await expect.poll(() => page.evaluate(() => isDispatchPlanEditor())).toBe(true);
    await page.locator('.order-type-tabs').getByRole('button', { name: 'Collection', exact: true }).click();
    const cards = page.locator('[data-dispatch-order-pool] .order-card');
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(7);
    const card = page.locator(`.order-card[data-order="${f.final.reference}"]`);
    await expect(card).toHaveAttribute('draggable', 'false');
    async function verifyWidths() {
      for (const [width, height] of [[1500, 1000], [1200, 800], [900, 700], [480, 800], [375, 800]]) {
        await page.setViewportSize({ width, height });
        const measurements = await cards.evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect();
          const descendants = [...element.querySelectorAll('*')].filter(child => child.getClientRects().length);
          const boxes = descendants.map(child => child.getBoundingClientRect());
          return { reference: element.dataset.order,
            horizontal: Math.max(element.scrollWidth - element.clientWidth, ...boxes.map(box => box.right - rect.right)),
            vertical: Math.max(element.scrollHeight - element.clientHeight, ...boxes.map(box => box.bottom - rect.bottom)) };
        }));
        assert.ok(measurements.length, `No visible cards at ${width}px`);
        assert.deepEqual(measurements.filter(row => row.horizontal > 1 || row.vertical > 1), [], `Card overflow at ${width}px`);
      }
    }
    await verifyWidths();
    await completeRentalPart(f, f.delivery);
    await completeRentalPart(f, f.collection);
    await page.getByRole('textbox', { name: 'Search orders', exact: true }).fill(f.final.reference);
    await expect(card).toHaveAttribute('draggable', 'true');
    await expect(cards).toHaveCount(1);
    await verifyWidths();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
