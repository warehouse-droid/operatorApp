/* global dispatchPlannerSnapshotState, localPlanDirty, saveInFlight, saveQueued,
  blockedPlanSaveFence, dispatchRecoveredDraft, planEditMode, currentPlan,
  localPlanGeneration, undoStack, redoStack, saveCurrentPlanNow */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { query } from '../src/db.js';
import { createDispatchV2Fixture } from '../test/dispatch/support/dispatch-v2-fixture.js';
import { seedMaintenanceIncident, stored } from '../test/support/order-update-save-fixture.mjs';

const fixture = await createDispatchV2Fixture();
const truck = (await query("INSERT INTO dispatch_trucks(plate,active) VALUES('DP-V2-TEST',true) RETURNING id::text,plate")).rows[0];
const driver = (await query("INSERT INTO dispatch_drivers(name,login,active) VALUES('Maintenance Driver','maintenance-browser',true) RETURNING id::text,name,login")).rows[0];
const reports = [];
function barrier() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const f = await seedMaintenanceIncident(fixture, { edit: false });
    const browser = await engine.launch({ args: name === 'chromium' ? ['--no-sandbox'] : [] });
    try {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
      await context.addInitScript(({ token, date }) => {
        localStorage.setItem('mbbs.staff.token', token);
        localStorage.setItem('mbbs.dispatch.token', token);
        localStorage.setItem('mbbs.staff.role', 'dispatcher');
        localStorage.setItem('mbbs.staff.roles', '["dispatcher"]');
        localStorage.setItem('mbbs.dispatch.planDate', date);
      }, { token: fixture.session.token, date: f.plan_date });
      const page = await context.newPage();
      if (name === 'chromium') await page.coverage.startJSCoverage({ resetOnNavigation: false });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const boundaries = {
        '/api/dispatch/config': { driverOrientedPlanning: false, googleMapsEnabled: false, plannerCommandMode: 'off', plannerOrderPoolMode: 'off' },
        '/api/dispatch/setup': { drivers: [driver], trucks: [{ ...truck, capacityLbs: 48000 }], ownYards: [], planning: {} },
        '/api/dispatch/orders': f.baseline.orders, '/api/dispatch/vendor-yards': [],
        '/api/dispatch/planned-assignments': [], '/api/dispatch/driver-job-statuses': [], '/api/dispatch/offline-review/count': { count: 0 },
        '/api/dispatch/driver-truck-switches/attention': [], '/api/dispatch/forecast': { loads: [], stops: [] },
        '/api/mbt/status': { capabilities: { binDispatch: { enabled: false } } }
      };
      const saves = [];
      let gate = null;
      let lose = false;
      await page.route('**/api/**', async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === 'GET' && Object.hasOwn(boundaries, pathname)) return route.fulfill({ json: boundaries[pathname] });
        if (request.method() === 'POST' && pathname.endsWith('/commands')) {
          const held = gate; gate = null;
          const drop = lose; lose = false;
          const start = performance.now();
          const response = await route.fetch();
          const body = await response.json();
          saves.push({ status: response.status(), revision: body.acknowledgement?.revision, durationMs: performance.now() - start });
          assert.equal(response.status(), 200, JSON.stringify(body));
          if (held) { held.committed.resolve(); await held.release.promise; }
          if (drop) return route.abort('failed');
          return route.fulfill({ response });
        }
        return route.continue();
      });
      const navigationStart = performance.now();
      await page.goto(`${fixture.baseUrl}/dispatch/planning`);
      await page.waitForFunction(() => dispatchPlannerSnapshotState === 'ready');
      const startupMs = performance.now() - navigationStart;
      await page.getByRole('button', { name: 'Enter Edit Mode' }).click();
      await page.waitForFunction(() => planEditMode);
      await f.cleanup();
      assert.equal((await stored(f.id)).revision, 63);
      assert.ok((await query('SELECT 1 FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0]);
      await page.locator('select[data-truck-driver]').first().selectOption(driver.login);
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
      const parking = page.locator('input[data-truck-parking]').first();
      const before = await stored(f.id);
      await f.cleanup();
      assert.equal((await stored(f.id)).revision, before.revision);
      const held = { committed: barrier(), release: barrier() }; gate = held;
      const feedback = [];
      async function move(value) {
        const start = performance.now();
        await parking.fill(value);
        await parking.dispatchEvent('change');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        feedback.push(performance.now() - start);
      }
      await move('FIRST');
      await held.committed.promise;
      await move('SECOND');
      const generation = await page.evaluate(() => localPlanGeneration);
      held.release.resolve();
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
      assert.equal(await page.evaluate(() => localPlanGeneration), generation);
      assert.equal((await stored(f.id)).trucks[0].parkingSpot, 'SECOND');
      assert.equal((await stored(f.id)).orders.some(order => f.obsolete.includes(order.id)), false);
      for (let i = 0; i < 8; i++) { await f.cleanup(); await move(`MOVE-${i}`); }
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
      assert.equal((await stored(f.id)).trucks[0].parkingSpot, 'MOVE-7');
      const undoDepth = await page.evaluate(() => undoStack.length);
      assert.ok(undoDepth > 0);
      lose = true;
      await move('RETRY');
      await page.waitForFunction(() => localPlanDirty && !saveInFlight && !saveQueued);
      const committedRevision = (await stored(f.id)).revision;
      await page.evaluate(() => saveCurrentPlanNow());
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
      assert.equal((await stored(f.id)).revision, committedRevision);
      assert.equal((await stored(f.id)).trucks[0].parkingSpot, 'RETRY');
      assert.equal(await page.evaluate(() => blockedPlanSaveFence), null);
      assert.equal(await page.evaluate(() => dispatchRecoveredDraft), null);
      await expect(page.getByText('The saved plan has changed since this draft.', { exact: false })).toHaveCount(0);
      assert.deepEqual(pageErrors, []);
      assert.ok(Math.max(...feedback) <= 500, `${name} feedback exceeded 500 ms: ${Math.max(...feedback)}`);
      if (name === 'chromium') await writeFile('test-artifacts/order-update-save/browser-v8.json', JSON.stringify(await page.coverage.stopJSCoverage()));
      reports.push({ engine: name, startupMs, feedbackMs: feedback, saves, finalRevision: committedRevision, undoDepth });
      await context.close();
    } finally { await browser.close(); }
  }
  await writeFile('test-artifacts/order-update-save/browser.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
} finally { await fixture.close(); }
