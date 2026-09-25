/* global selectedSnapshot, snapshotLoading, pendingSnapshotRestore, snapshotDate, snapshotNotice */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { createDispatchV2Fixture } from '../test/dispatch/support/dispatch-v2-fixture.js';
import { query } from '../src/db.js';

const fixture = await createDispatchV2Fixture();
const reports = [];
try {
  for (const [engine, type, date] of [['chromium', chromium, '2027-08-20'], ['webkit', webkit, '2027-08-21']]) {
    const seeded = await fixture.seedPlan({ date, refs: [] });
    await query("UPDATE dispatch_plan_snapshots SET trucks='[]'::jsonb WHERE plan_id=$1", [seeded.id]);
    const archive = (await query(`INSERT INTO dispatch_plan_snapshot_history
      (plan_id,plan_date,revision,orders,trucks,summary,archive_reason)
      VALUES ($1,$2,0,'[]'::jsonb,'[]'::jsonb,'{"marker":"restored","quantity":0.125,"zero":0}'::jsonb,'save_browser_fixture') RETURNING id`,
    [seeded.id, date])).rows[0];
    const list = await fixture.request(`/api/dispatch/plan-snapshots?date=${date}`);
    const snapshotId = list.payload.snapshots.find(row => !row.current).id;
    const browser = await type.launch({ args: engine === 'chromium' ? ['--no-sandbox'] : [] });
    try {
      const context = await browser.newContext();
      await context.addInitScript(token => {
        localStorage.setItem('mbbs.staff.token', token);
        localStorage.setItem('mbbs.dispatch.token', token);
        localStorage.setItem('mbbs.staff.role', 'dispatcher');
        localStorage.setItem('mbbs.staff.roles', '["dispatcher"]');
      }, fixture.session.token);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      if (engine === 'chromium') await page.coverage.startJSCoverage({ resetOnNavigation: false });
      const bodies = [];
      await page.route('**/api/dispatch/plan-snapshots/*/restore', async route => {
        bodies.push(route.request().postData());
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        if (bodies.length === 1) return route.abort('failed');
        return route.fulfill({ response });
      });
      await page.goto(`${fixture.baseUrl}/dispatch/snapshot`);
      await page.waitForFunction(() => typeof snapshotLoading !== 'undefined' && !snapshotLoading && Boolean(snapshotOperator));
      await page.locator('#snapshotDate').fill(date);
      await page.locator('[data-action="load-snapshots"]').click();
      await page.waitForFunction(date => snapshotDate === date && !snapshotLoading, date);
      await page.locator(`[data-action="select-snapshot"][data-id="${snapshotId}"]`).click();
      await page.waitForFunction(id => String(selectedSnapshot?.id) === String(id) && !snapshotLoading, snapshotId);
      await page.locator('[data-action="enter-edit-mode"]').click();
      await expect(page.locator('[data-action="restore-snapshot"]')).toBeEnabled();
      await page.locator('[data-action="restore-snapshot"]').click();
      await page.waitForFunction(() => pendingSnapshotRestore && !snapshotLoading);
      await page.locator('[data-action="exit-edit-mode"]').click();
      await page.waitForFunction(() => snapshotNotice.includes('pending restore'));
      await page.locator('#snapshotDate').fill('2027-08-22');
      await page.locator('[data-action="load-snapshots"]').click();
      await page.waitForFunction(date => snapshotDate === date && snapshotNotice.includes('pending restore'), date);
      await page.locator('[data-action="restore-snapshot"]').click();
      await page.waitForFunction(() => !pendingSnapshotRestore && !snapshotLoading && selectedSnapshot?.current);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], bodies[1]);
      const saved = (await query(`SELECT p.revision,s.summary FROM dispatch_plans p
        JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [seeded.id])).rows[0];
      assert.equal(Number(saved.revision), 1);
      assert.equal(saved.summary.marker, 'restored');
      assert.equal(saved.summary.quantity, 0.125);
      assert.equal(saved.summary.zero, 0);
      await page.locator('[data-action="exit-edit-mode"]').click();
      await expect(page.locator('[data-action="enter-edit-mode"]')).toBeVisible();
      // Retention can remove an archive after it was listed. The page must show
      // an actionable preview error rather than silently restoring another row.
      await query('DELETE FROM dispatch_plan_snapshot_history WHERE id=$1', [archive.id]);
      await page.locator(`[data-action="select-snapshot"][data-id="${snapshotId}"]`).click();
      await page.waitForFunction(() => snapshotNotice.includes('Snapshot preview failed'));
      await page.locator('#snapshotDate').fill('2027-08-22');
      await page.locator('[data-action="load-snapshots"]').click();
      await page.waitForFunction(() => snapshotDate === '2027-08-22' && !snapshotLoading);
      assert.deepEqual(errors, []);
      if (engine === 'chromium') await writeFile('test-artifacts/dispatch-save-reliability/snapshot-v8.json', JSON.stringify(await page.coverage.stopJSCoverage()));
      reports.push({ engine, exactRestoreRetry: true, oneCommit: true, pendingRestoreBlocksExitAndDate: true, missingArchiveReported: true });
      await context.close();
    } finally { await browser.close(); }
  }
  await writeFile('test-artifacts/dispatch-save-reliability/snapshot-browser.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
} finally { await fixture.close(); }
