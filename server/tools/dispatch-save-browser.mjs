/* global currentPlan, currentPlanDate, dispatchPlannerSnapshotState, trucks, commitPlanMutation,
   localPlanDirty, saveInFlight, saveQueued, routeNotice, orders, forceSaveCurrentPlan,
   releaseDispatchEditMode, confirmCurrentPlanAtomic */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium, webkit } from '@playwright/test';
import { createDispatchV2Fixture, dispatchOrder } from '../test/dispatch/support/dispatch-v2-fixture.js';
import { query } from '../src/db.js';

const mode = process.argv[2] || 'candidate';
const startupTrace = process.argv.includes('--startup-trace');
const startedAt = new Date().toISOString();
const sourceFiles = ['public/dispatch.js', 'public/dispatch.css', 'public/dispatch.html',
  'public/dispatch-save-journal.js', 'src/dispatch-planner-performance.js', 'src/dispatch-planner-v2-repository.js', 'src/scm-dependency-plan-reconciler.js', 'src/dispatch-delivery-group-repository.js', 'src/server.js'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, await readFile(file).then(value => createHash('sha256').update(value).digest('hex')).catch(() => null)])));
const sources = await sourceHashes();
const fixture = await createDispatchV2Fixture();
const reports = [];
const date = '2027-06-01';
await fixture.seedPlan({ date, refs: Array.from({ length: 20 }, (_, i) => `SO-BROWSER-${i}`) });
await query("INSERT INTO dispatch_trucks (plate) VALUES ('DP-V2-TEST') ON CONFLICT DO NOTHING");
const pool = Array.from({ length: 1000 }, (_, i) => dispatchOrder(`SO-POOL-${i}`, i));
try {
  for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await browserType.launch({ args: engine === 'chromium' ? ['--no-sandbox'] : [] });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(({ token, date }) => {
        localStorage.setItem('mbbs.staff.token', token);
        localStorage.setItem('mbbs.staff.role', 'dispatcher');
        localStorage.setItem('mbbs.staff.roles', '["dispatcher"]');
        localStorage.setItem('mbbs.dispatch.token', token);
        localStorage.setItem('mbbs.dispatch.planDate', date);
      }, { token: fixture.session.token, date });
      const errors = [];
      // Deterministic catalog/maps/forecast boundaries; save, bootstrap, lease,
      // lifecycle and revision requests reach the real isolated HTTP server.
      const responses = {
        '/api/dispatch/config': { driverOrientedPlanning: false, plannerCommandMode: 'off', plannerOrderPoolMode: 'off' },
        '/api/dispatch/setup': { drivers: [], trucks: [{ id: 'DP-V2-TEST', plate: 'DP-V2-TEST', capacityLbs: 48000 }], ownYards: [], planning: {} },
        '/api/dispatch/vendor-yards': [], '/api/dispatch/orders': pool,
        '/api/dispatch/planned-assignments': [], '/api/dispatch/driver-job-statuses': [],
        '/api/dispatch/offline-review/count': { count: 0 },
        '/api/dispatch/driver-truck-switches/attention': [], '/api/dispatch/forecast': { loads: [], stops: [] },
        '/api/mbt/status': { capabilities: { binDispatch: { enabled: false } } }
      };
      await context.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().method() === 'GET' && Object.hasOwn(responses, pathname)) {
          return route.fulfill({ json: responses[pathname] });
        }
        if (/google|samsara/.test(pathname)) return route.fulfill({ json: {} });
        return route.continue();
      });
      const startup = [], edits = [], saves = [], requestCounts = [], startupTimelines = [];
      for (let run = 0; run < (startupTrace ? 1 : 8); run++) {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        let requests = 0;
        const count = () => { requests++; };
        page.on('request', count);
        await page.goto(`${fixture.baseUrl}/dispatch/planning`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof dispatchPlannerSnapshotState !== 'undefined' && dispatchPlannerSnapshotState === 'ready');
        await page.getByRole('button', { name: 'Enter Edit Mode' }).waitFor();
        startup.push(await page.evaluate(() => performance.now()));
        requestCounts.push(requests);
        startupTimelines.push(await page.evaluate(() => ({
          readyAt: performance.now(),
          paint: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, start: entry.startTime })),
          requests: performance.getEntriesByType('resource').filter(entry => /dispatch(?:-save-journal)?\.js|bootstrap|forecast/.test(entry.name))
            .map(entry => ({ path: new URL(entry.name).pathname, start: entry.startTime, end: entry.responseEnd, duration: entry.duration }))
        })));
        page.off('request', count);
        await page.getByRole('button', { name: 'Enter Edit Mode' }).dispatchEvent('click');
        await page.getByRole('button', { name: 'Exit Edit' }).waitFor();
        for (let edit = 0; edit < (startupTrace ? 0 : 10); edit++) {
          edits.push(await page.evaluate(({ run, edit }) => {
            const start = performance.now();
            commitPlanMutation('dispatch_plan_note', () => { trucks[0].loads[0].name = `Run ${run} Edit ${edit}`; });
            return performance.now() - start;
          }, { run, edit }));
        }
        const savedAt = performance.now();
        await page.evaluate(() => forceSaveCurrentPlan());
        saves.push(performance.now() - savedAt);
        assert.equal(await page.evaluate(() => localPlanDirty || saveQueued || saveInFlight), false, await page.evaluate(() => routeNotice));
        await page.evaluate(() => releaseDispatchEditMode());
        await page.waitForLoadState('networkidle');
        // Closing a page aborts background shell polling. Do not measure that
        // teardown as a runtime exception in the following navigation.
        page.removeAllListeners('pageerror');
        await page.close();
      }
      assert.deepEqual(errors, []);
      reports.push({ engine, startupMs: startup, editMs: edits, saveMs: saves, requestCounts, startupTimelines });
      await context.close();
    } finally { await browser.close(); }
  }
  assert.deepEqual(await sourceHashes(), sources, 'Browser benchmark source changed during execution');
  await writeFile(`test-artifacts/dispatch-save-reliability/browser-${mode}${startupTrace ? '-trace' : ''}.json`, JSON.stringify({ mode, reports, startedAt, completedAt: new Date().toISOString(), sources }, null, 2));
  console.log(JSON.stringify({ mode, reports }));
} finally { await fixture.close(); }
