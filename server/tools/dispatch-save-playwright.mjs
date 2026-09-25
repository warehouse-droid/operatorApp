/* global currentPlan, dispatchPlannerSnapshotState, localPlanDirty, saveInFlight, saveQueued,
   pendingPlanSaveAttempt, dispatchRecoveredDraft, forceSaveCurrentPlan, routeNotice */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium, webkit, expect } from '@playwright/test';
import { query } from '../src/db.js';
import { createDispatchV2Fixture, dispatchOrder } from '../test/dispatch/support/dispatch-v2-fixture.js';

const fixture = await createDispatchV2Fixture();
const startedAt = new Date().toISOString();
const checkFiles = Object.keys(JSON.parse(await readFile('test-artifacts/dispatch-save-reliability/checks.json', 'utf8')).sources);
const sourceFiles = [...new Set([...checkFiles, 'src/scm-dependency-plan-reconciler.js', 'src/dispatch-delivery-group-repository.js'])];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const sources = await sourceHashes();
const reports = [];
const truck = (await query("INSERT INTO dispatch_trucks (plate) VALUES ('DP-V2-TEST') RETURNING id::text,plate")).rows[0];
const driver = (await query("INSERT INTO dispatch_drivers (name,login) VALUES ('Save Browser Driver','save-browser-driver') RETURNING id::text,name,login")).rows[0];
function barrier() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
try {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const date = engine === 'chromium' ? '2027-06-02' : '2027-06-03';
    const refs = [`SO-${engine}-A`, `SO-${engine}-B`];
    const seeded = await fixture.seedPlan({ date, refs });
    const browser = await type.launch({ args: engine === 'chromium' ? ['--no-sandbox'] : [] });
    try {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
      await context.addInitScript(({ token, date }) => {
        localStorage.setItem('mbbs.staff.token', token); localStorage.setItem('mbbs.dispatch.token', token);
        localStorage.setItem('mbbs.staff.role', 'dispatcher'); localStorage.setItem('mbbs.staff.roles', '["dispatcher"]');
        localStorage.setItem('mbbs.dispatch.planDate', date);
      }, { token: fixture.session.token, date });
      const page = await context.newPage();
      if (engine === 'chromium') await page.coverage.startJSCoverage({ resetOnNavigation: false });
      const boundaries = {
        '/api/dispatch/config': { driverOrientedPlanning: false, googleMapsEnabled: false, plannerCommandMode: 'off', plannerOrderPoolMode: 'off' },
        '/api/dispatch/setup': { drivers: [driver], trucks: [{ ...truck, capacityLbs: 48000 }], ownYards: [], planning: {} },
        '/api/dispatch/orders': refs.map(dispatchOrder), '/api/dispatch/vendor-yards': [],
        '/api/dispatch/planned-assignments': [], '/api/dispatch/driver-job-statuses': [], '/api/dispatch/offline-review/count': { count: 0 },
        '/api/dispatch/driver-truck-switches/attention': [], '/api/dispatch/forecast': { loads: [], stops: [] },
        '/api/mbt/status': { capabilities: { binDispatch: { enabled: false } } }
      };
      const healthyUpdateMs = [], bodies = [], actionMs = [];
      let held = null, lost = false;
      await page.route('**/api/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        if (request.method() === 'GET' && Object.hasOwn(boundaries, pathname)) return route.fulfill({ json: boundaries[pathname] });
        if (request.method() === 'POST' && pathname.endsWith('/commands')) {
          const gate = held; held = null;
          const drop = lost; lost = false;
          bodies.push(request.postData());
          const start = performance.now();
          const response = await route.fetch();
          if (response.status() !== 200) throw new Error(`Unexpected browser save ${response.status()}: ${await response.text()}`);
          if (!gate && !drop) healthyUpdateMs.push(performance.now() - start);
          if (gate) { gate.committed.release(); await gate.release.promise; }
          if (drop) return route.abort('failed');
          return route.fulfill({ response });
        }
        return route.continue();
      });
      await page.goto(`${fixture.baseUrl}/dispatch/planning`);
      await page.waitForFunction(() => dispatchPlannerSnapshotState === 'ready');
      await page.getByRole('button', { name: 'Enter Edit Mode' }).click();
      await expect(page.getByRole('button', { name: 'Exit Edit' })).toBeVisible();
      await page.locator('select[data-truck-driver]').first().selectOption(driver.login);
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
      const parking = page.locator('input[data-truck-parking]').first();
      async function changeParking(value) { await parking.fill(value); await parking.dispatchEvent('change'); }
      async function responsiveAction(action, run) {
        const started = performance.now();
        await run();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const milliseconds = performance.now() - started;
        actionMs.push({ action, milliseconds });
        assert.ok(milliseconds <= 500, `${engine}: ${action} blocked feedback for ${milliseconds.toFixed(1)}ms`);
      }

      // Real event -> Autosave, followed by a simultaneous Save Now and newer edit.
      const gate = { committed: barrier(), release: barrier() }; held = gate;
      await changeParking('A1');
      await gate.committed.promise;
      const heldAt = performance.now();
      const frameProbe = page.evaluate(() => new Promise(resolve => {
        const started = performance.now(), gaps = [];
        let previous = started;
        function tick(now) {
          gaps.push(now - previous); previous = now;
          if (now - started >= 1500) resolve(gaps);
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      }));
      await responsiveAction('Save Now while autosave awaits its response', () => page.locator('[data-action="save-plan-now"]').click());
      await responsiveAction('Edit parking while save awaits its response', () => changeParking('B2'));
      const frameGaps = await frameProbe;
      const backgroundSaveHeldMs = performance.now() - heldAt;
      assert.ok(backgroundSaveHeldMs >= 1500);
      assert.ok(Math.max(...frameGaps) <= 500, `${engine}: background save blocked rendering`);
      assert.equal(await parking.inputValue(), 'B2', 'new edits must remain usable before the save response arrives');
      gate.release.release();
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
      let saved = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}`);
      assert.equal(saved.payload.plan.trucks[0].parkingSpot, 'B2', 'late acknowledgement must retain the newer edit');
      await page.locator('[data-action="undo-plan"]').click();
      await expect(parking).toHaveValue('A1');
      await page.locator('[data-action="redo-plan"]').click();
      await expect(parking).toHaveValue('B2');
      await page.locator('[data-action="save-plan-now"]').click();
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);

      // Commit the real HTTP request, then destroy the response before the browser
      // can acknowledge it. Reload recovery must reuse that command identity.
      const beforeLost = bodies.length;
      lost = true;
      await changeParking('C3');
      await page.waitForFunction(() => pendingPlanSaveAttempt?.request && !saveInFlight);
      await page.waitForFunction(async () => {
        const { journal, key } = await dispatchDraftStorage();
        return Boolean((await journal.read(key))?.inFlight?.request);
      });
      // Drain unrelated shell reads before navigation; no artificial sleep.
      await page.waitForLoadState('networkidle');
      await page.reload();
      await page.waitForFunction(() => dispatchPlannerSnapshotState === 'ready' && Boolean(dispatchRecoveredDraft));
      await expect(page.getByRole('button', { name: 'Exit Edit' })).toBeVisible();
      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download draft', exact: true }).click();
      const exported = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
      assert.equal(Object.hasOwn(exported, 'editLeaseToken'), false, 'draft exports must not contain authority credentials');
      assert.equal(exported.trucks[0].parkingSpot, 'C3');
      await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
      try {
        await page.waitForFunction(() => !dispatchRecoveredDraft && !localPlanDirty && !saveInFlight && !saveQueued);
      } catch (error) {
        console.log(JSON.stringify({ engine, recoveryFailure: await page.evaluate(() => ({
          notice: routeNotice, dirty: localPlanDirty, inFlight: saveInFlight, queued: saveQueued,
          generation: localPlanGeneration, pending: Boolean(pendingPlanSaveAttempt),
          recovered: Boolean(dispatchRecoveredDraft), hasLease: Boolean(planEditLeaseToken),
          draftInFlight: Boolean(dispatchRecoveredDraft?.inFlight), draftHasToken: Boolean(dispatchRecoveredDraft?.inFlight?.payload?.editLeaseToken),
          sameHeaderLease: dispatchRecoveredDraft?.inFlight?.request?.init?.headers?.['x-dispatch-edit-lease'] === planEditLeaseToken,
          storedSameLease: readStoredDispatchEditLease()?.editLeaseToken === planEditLeaseToken,
          sameLease: dispatchRecoveredDraft?.inFlight?.payload?.editLeaseToken === planEditLeaseToken,
          revision: currentPlan.revision, digest: currentPlan.digest,
          draftRevision: dispatchRecoveredDraft?.baseline?.revision, draftDigest: dispatchRecoveredDraft?.baseline?.digest
        })) }));
        throw error;
      }
      assert.equal(bodies[beforeLost + 1], bodies[beforeLost], 'recovery must replay the exact immutable request');
      saved = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}`);
      assert.equal(saved.payload.plan.trucks[0].parkingSpot, 'C3');

      await page.locator('[data-action="save-plan-now"]').click();
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued);
      const confirmationBodies = [], confirmationRevisions = [];
      let dropConfirmation = true;
      await page.route('**/api/dispatch/plans/*/confirm', async route => {
        confirmationBodies.push(route.request().postData());
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        confirmationRevisions.push((await response.json()).revision);
        if (dropConfirmation) { dropConfirmation = false; return route.abort('failed'); }
        return route.fulfill({ response });
      });
      await page.locator('[data-action="confirm-plan"]').click();
      await page.getByRole('button', { name: 'Retry pending action', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Retry pending action', exact: true }).click();
      await page.waitForFunction(() => currentPlan?.status === 'confirmed', { timeout: 30000 });
      assert.equal(confirmationBodies.length, 2);
      assert.equal(confirmationBodies[0], confirmationBodies[1], 'lost confirmation retries the original request');
      // Existing confirmation may save normalized assignments and then advance
      // status in the same transaction. The retry must repeat neither write.
      assert.equal(confirmationRevisions[1], confirmationRevisions[0]);
      const confirmRequest = JSON.parse(confirmationBodies[0]);
      const confirmReceipts = (await query(`SELECT base_revision,applied_revision FROM dispatch_plan_commands
        WHERE plan_id=$1 AND command_id=$2`, [seeded.id, confirmRequest.commandId])).rows;
      assert.equal(confirmReceipts.length, 1);
      assert.equal(Number(confirmReceipts[0].base_revision), confirmRequest.baseRevision);
      assert.equal(Number(confirmReceipts[0].applied_revision), confirmationRevisions[0]);
      assert.equal((await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}`)).payload.plan.revision, confirmationRevisions[0]);
      await page.getByRole('button', { name: 'Exit Edit' }).click();
      await expect(page.getByRole('button', { name: 'Enter Edit Mode' })).toBeVisible();
      const maximum = Math.max(...healthyUpdateMs);
      await page.screenshot({ path: `test-artifacts/dispatch-save-reliability/playwright-${engine}.png`, fullPage: true });
      if (engine === 'chromium') await writeFile('test-artifacts/dispatch-save-reliability/browser-v8.json', JSON.stringify(await page.coverage.stopJSCoverage()));
      reports.push({ engine, realHttp: true, flow: 'Edit → change → Autosave → Save → Confirm → View',
        lateAckPreserved: true, lostResponseRecovered: true, exactReplay: true, confirmationRetriedOnce: true,
        draftExportExcludesLease: true, healthyUpdateMs, maximum, actionMs,
        maximumActionMs: Math.max(...actionMs.map(row => row.milliseconds)),
        maximumFrameGapMs: Math.max(...frameGaps), backgroundSaveHeldMs });
      await context.close();
    } finally { await browser.close(); }
  }
  await writeFile('test-artifacts/dispatch-save-reliability/playwright.json', JSON.stringify(reports, null, 2));
  assert.deepEqual(await sourceHashes(), sources, 'Runtime changed during Playwright checks');
  await writeFile('test-artifacts/dispatch-save-reliability/playwright-source.json', JSON.stringify({ sources, startedAt, completedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify(reports));
} finally { await fixture.close(); }
