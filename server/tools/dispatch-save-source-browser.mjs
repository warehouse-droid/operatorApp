/* global dispatchPlannerSnapshotState, localPlanDirty, saveInFlight, saveQueued, currentPlan, routeNotice */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, webkit } from '@playwright/test';
import { query } from '../src/db.js';
import { getDispatchPlan } from '../src/dispatch-plan-repository.js';
import { syncDispatchDeliveryGroupsFromPlan } from '../src/dispatch-delivery-group-repository.js';
import { simulateDispatchSourceEvent } from '../test/support/dispatch-save-source-events.mjs';
import { createDispatchV2Fixture } from '../test/dispatch/support/dispatch-v2-fixture.js';

const fixture = await createDispatchV2Fixture(), reports = [];
const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const driver = (await query("INSERT INTO dispatch_drivers (name,login) VALUES ('Source Event Driver','source-event-driver') RETURNING *")).rows[0];
const truck = (await query("INSERT INTO dispatch_trucks (plate) VALUES ('DP-V2-TEST') RETURNING *")).rows[0];
try {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const date = engine === 'chromium' ? '2027-07-01' : '2027-07-02';
    const ref = `SO-SOURCE-${engine}-S2`;
    const seeded = await fixture.seedPlan({ date, refs: [ref] });
    await query(`UPDATE dispatch_plan_snapshots SET orders=jsonb_set(orders,'{0}',orders->0 || $2::jsonb) WHERE plan_id=$1`,
      [seeded.id, JSON.stringify({ originalOrderId: ref.replace(/-S2$/, ''), isSplit: true, planOwned: true,
        raw: { source_table: 'sales_orders', zero: 0, fraction: 0.125 } })]);
    const initial = await getDispatchPlan(seeded.id);
    await syncDispatchDeliveryGroupsFromPlan(initial);
    const browser = await type.launch({ args: engine === 'chromium' ? ['--no-sandbox'] : [] });
    try {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
      await context.addInitScript(({ token, date }) => {
        for (const key of ['mbbs.staff.token', 'mbbs.dispatch.token']) localStorage.setItem(key, token);
        localStorage.setItem('mbbs.staff.role', 'dispatcher'); localStorage.setItem('mbbs.staff.roles', '["dispatcher"]');
        localStorage.setItem('mbbs.dispatch.planDate', date);
      }, { token: fixture.session.token, date });
      const page = await context.newPage();
      const catalog = initial.orders;
      const boundaries = {
        '/api/dispatch/config': { driverOrientedPlanning: false, googleMapsEnabled: false, plannerCommandMode: 'off', plannerOrderPoolMode: 'off' },
        '/api/dispatch/setup': { drivers: [driver], trucks: [truck], ownYards: [], planning: {} },
        '/api/dispatch/orders': catalog, '/api/dispatch/vendor-yards': [], '/api/dispatch/planned-assignments': [],
        '/api/dispatch/driver-job-statuses': [], '/api/dispatch/offline-review/count': { count: 0 },
        '/api/dispatch/driver-truck-switches/attention': [], '/api/dispatch/forecast': { loads: [], stops: [] },
        '/api/mbt/status': { capabilities: { binDispatch: { enabled: false } } }
      };
      let pending = null;
      const saves = [], actions = [], failures = [];
      await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().method() === 'GET' && Object.hasOwn(boundaries, pathname)) return route.fulfill({ json: boundaries[pathname] });
        if (route.request().method() === 'POST' && pathname.endsWith('/commands')) {
          const gate = pending; pending = null;
          if (gate?.stage === 'before') { gate.reached.release(); await gate.proceed.promise; }
          const response = await route.fetch();
          const result = await response.json();
          saves.push({ status: response.status(), revision: result.plan?.revision, code: result.code });
          if (response.status() !== 200) failures.push(result);
          if (gate?.stage === 'after') { gate.reached.release(); await gate.proceed.promise; }
          return route.fulfill({ response });
        }
        return route.continue();
      });
      await page.goto(`${fixture.baseUrl}/dispatch/planning`);
      await page.waitForFunction(() => dispatchPlannerSnapshotState === 'ready');
      await page.getByRole('button', { name: 'Enter Edit Mode' }).click();
      await page.getByRole('button', { name: 'Exit Edit' }).waitFor();
      await page.locator('select[data-truck-driver]').first().selectOption(driver.login);
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
      const parking = page.locator('input[data-truck-parking]').first();
      async function edit(value) {
        const start = performance.now();
        await parking.fill(value); await parking.dispatchEvent('change');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const milliseconds = performance.now() - start;
        actions.push(milliseconds);
        assert.ok(milliseconds <= 500, `${engine}: edit blocked ${milliseconds}ms`);
      }
      for (const stage of ['idle', 'before', 'after']) {
        const original = await getDispatchPlan(seeded.id);
        let event;
        if (stage === 'idle') event = await simulateDispatchSourceEvent(original, `${engine}-${stage}`);
        const gate = stage === 'idle' ? null : { stage, reached: barrier(), proceed: barrier() };
        pending = gate;
        await edit(stage);
        if (gate) {
          await gate.reached.promise;
          const storedBeforeEvent = await getDispatchPlan(seeded.id);
          event = await simulateDispatchSourceEvent(storedBeforeEvent, `${engine}-${stage}`);
          const fresh = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}`);
          assert.equal(fresh.payload.plan.digest, storedBeforeEvent.digest);
          assert.ok(JSON.stringify(fresh.payload.plan.assignedOrderSnapshots).includes(event.marker));
          if (stage === 'after') await edit(`${stage}-newer`);
          gate.proceed.release();
        }
        assert.equal(event.simulated, true);
        await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
        const saved = await getDispatchPlan(seeded.id);
        assert.equal(saved.trucks[0].parkingSpot, stage === 'after' ? 'after-newer' : stage);
        assert.equal(saved.orders.find(order => order.id === ref).instructions, event.marker);
        assert.doesNotMatch(await page.evaluate(() => routeNotice), /another screen|changed on|save failed/i);
      }
      assert.deepEqual(failures, []);
      reports.push({ engine, sourceEvents: 3, schedules: ['before edit', 'request waiting before commit', 'committed response delayed'],
        sourceDataVisible: true, newerEditPreserved: true, falseConflicts: 0, maximumActionMs: Math.max(...actions), saves });
      await context.close();
    } finally { await browser.close(); }
  }
  await writeFile('test-artifacts/dispatch-save-reliability/source-browser.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
} finally { await fixture.close(); }
