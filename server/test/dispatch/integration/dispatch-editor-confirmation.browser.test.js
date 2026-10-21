import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { getDispatchPlanEditLease } from '../../../src/dispatch-plan-lease-repository.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';

test('CONFIRM-01: Admin and Dispatch both confirm; cancelling preserves the editor and accepting releases it', async () => {
  const fixture = await createDispatchV2Fixture({ role: 'admin' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext();
    await context.addInitScript(token => {
      localStorage.setItem('mbbs.control.token', token);
      localStorage.setItem('mbbs.dispatch.token', token);
      localStorage.setItem('mbbs.staff.token', token);
    }, fixture.session.token);
    const admin = await context.newPage();
    await fixture.acquireLease({ planDate: '2027-11-20', sessionId: 'editor-to-kick' });
    await admin.goto(fixture.baseUrl + '/admin');
    const row = admin.locator('[data-admin-dispatch-editors] tr').filter({ hasText: '2027-11-20' });
    await row.getByRole('button', { name: 'Kick out', exact: true }).waitFor({ timeout: 30000 });
    admin.once('dialog', async dialog => { assert.match(dialog.message(), /2027-11-20/); await dialog.dismiss(); });
    await row.getByRole('button', { name: 'Kick out', exact: true }).click();
    assert.equal((await getDispatchPlanEditLease('2027-11-20')).active, true);
    admin.once('dialog', async dialog => { assert.match(dialog.message(), /Dispatch V2 admin/); await dialog.accept(); });
    await row.getByRole('button', { name: 'Kick out', exact: true }).click();
    await admin.getByText('has been kicked out of Edit Mode.', { exact: false }).waitFor();
    assert.equal(await getDispatchPlanEditLease('2027-11-20'), null);
    await admin.screenshot({ path: 'test-artifacts/admin-editor-controls.png', fullPage: true });

    const account = await createOperator({ username: 'editor-confirm-dispatch', displayName: 'Dispatch confirmation', password: 'IsolatedPassword123', role: 'dispatcher' });
    const login = await loginOperator(account.username, 'IsolatedPassword123');
    await fixture.seedPlan({ date: '2027-11-21', refs: [] });
    await fixture.acquireLease({ planDate: '2027-11-21', sessionId: 'other-editor' });
    const dispatchContext = await browser.newContext();
    await dispatchContext.addInitScript(token => {
      localStorage.setItem('mbbs.dispatch.token', token); localStorage.setItem('mbbs.staff.token', token);
    }, login.token);
    const page = await dispatchContext.newPage();
    await page.goto(fixture.baseUrl + '/dispatch/planning?planDate=2027-11-21');
    const button = page.getByRole('button', { name: /Kick out Dispatch V2 admin/ });
    await button.waitFor({ timeout: 30000 });
    page.once('dialog', async dialog => { assert.match(dialog.message(), /2027-11-21/); await dialog.dismiss(); });
    await button.click();
    assert.equal((await getDispatchPlanEditLease('2027-11-21')).sessionId, 'other-editor');
    await page.screenshot({ path: 'test-artifacts/dispatch-editor-controls.png', fullPage: true });
    page.once('dialog', async dialog => { assert.match(dialog.message(), /Kick .* out of Edit Mode/); await dialog.accept(); });
    await button.click();
    await page.getByText('has been kicked out of Edit Mode.', { exact: false }).waitFor();
    assert.equal(await getDispatchPlanEditLease('2027-11-21'), null);
  } finally {await browser?.close(); await fixture.close();}
});
