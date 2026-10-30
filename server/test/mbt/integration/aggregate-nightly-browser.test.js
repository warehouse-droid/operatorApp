import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { app } from '../../../src/server.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';
import { query, closeDb } from '../../../src/db.js';
after(closeDb);

test('U1 browser: Admin saves and reloads the visible aggregate schedule independently of the full nightly switch', async () => {
  const before = (await query('SELECT * FROM scm_reconciliation_settings')).rows[0];
  const username = `agg-browser-${crypto.randomUUID()}`; const password = crypto.randomUUID();
  await createOperator({ username, password, displayName: username, role: 'admin', roles: ['admin'] });
  const login = await loginOperator(username, password);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(token => {
      globalThis.localStorage.setItem('mbbs.staff.token', token); globalThis.localStorage.setItem('mbbs.control.token', token);
    }, login.token);
    await page.goto(`http://127.0.0.1:${server.address().port}/admin/reconciliation`);
    const form = page.locator('[data-form="aggregate-nightly-settings"]');
    await form.waitFor();
    await form.locator('[name="aggregateNightlyEnabled"]').check();
    await form.locator('[name="aggregateNightlyTime"]').fill('22:35');
    page.on('dialog', dialog => dialog.accept());
    const response = page.waitForResponse(r => r.url().endsWith('/api/control/scm-reconciliation/settings') && r.request().method() === 'PUT');
    await form.locator('button[type="submit"]').click();
    assert.equal((await response).status(), 200);
    await page.reload(); await form.locator('[name="aggregateNightlyEnabled"]:enabled').waitFor();
    assert.equal(await form.locator('[name="aggregateNightlyEnabled"]').isChecked(), true);
    assert.equal(await form.locator('[name="aggregateNightlyTime"]').inputValue(), '22:35');
    assert.match(await page.locator('[aria-label="Aggregate nightly reconciliation"]').innerText(), /Next run:|Last run:/);
    assert.equal((await query('SELECT nightly_enabled FROM scm_reconciliation_settings')).rows[0].nightly_enabled, before.nightly_enabled);
    await page.screenshot({ path: 'test-artifacts/aggregate-nightly-ui.png', fullPage: true });
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await query('UPDATE scm_reconciliation_settings SET aggregate_nightly_enabled=$1,aggregate_nightly_time=$2', [before.aggregate_nightly_enabled,before.aggregate_nightly_time]);
  }
});
