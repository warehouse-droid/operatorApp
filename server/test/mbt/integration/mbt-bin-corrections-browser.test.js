/* global localStorage, sessionStorage, dispatchPlannerSnapshotState, mbtBinDispatchLoading,
  isDispatchPlanEditor, saveCurrentPlanNow, localPlanDirty, routeNotice */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { app } from '../../../src/server.js';
import { config } from '../../../src/config.js';
import { query, closeDb } from '../../../src/db.js';
import { createOperator, updateOperatorPassword, loginOperator } from '../../../src/auth-repository.js';
import { planningFixture } from '../support/bin-planning-fixtures.js';
import { createFrontdeskQuote, issueFrontdeskQuote, acceptFrontdeskQuote, convertFrontdeskQuote } from '../../../src/mbt/frontdesk-service.js';
import { createFrontdeskPrerequisites, frontdeskCommand, quoteCommand, frontdeskDistanceResolver,
  frontdeskTaxResolver } from '../support/frontdesk-fixtures.js';
import { writeFile } from 'node:fs/promises';

after(closeDb);

test('browser: register BINtest, select it in an existing shared plan, and save a BIN load', { timeout: 120000 }, async () => {
  const f = await planningFixture(2400);
  const password = 'synthetic-bin-corrections-browser-password';
  await updateOperatorPassword(f.actor.operatorId, password);
  const token = (await loginOperator(f.actor.operatorId, password)).token;
  config.mbt.enabled = true;
  config.mbtPhase3.masterDataEnabled = true;
  config.mbtPhase3.binDispatchEnabled = true;
  config.dispatch.driverOrientedPlanning = true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_master_data','mbt_bin_dispatch')");
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(({ token: value, date, editLease }) => {
      localStorage.setItem('mbbs.staff.token', value);
      localStorage.setItem('mbbs.dispatch.planDate', date);
      sessionStorage.setItem('mbbs.dispatch.sessionId', editLease.sessionId);
      sessionStorage.setItem('mbbs.dispatch.editLease.v1', JSON.stringify({ planDate: date,
        sessionId: editLease.sessionId, editLeaseToken: editLease.token,
        expiresAt: new Date(Date.now() + 600000).toISOString() }));
    }, { token, date: f.planDate, editLease: f.editLease });
    const page = await context.newPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/dispatch/setup`);
    await page.locator('[data-tab="trucks"]').click();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const form = page.locator('[data-form="truck"]');
    await form.locator('[name="plate"]').fill('BINtest');
    await form.locator('[name="truckType"]').selectOption('bin');
    await form.locator('[name="baseYard"]').selectOption('3445');
    await form.locator('[name="supportedBinTypeCodes"][value="14YD"]').check();
    await form.locator('[name="capabilityReason"]').fill('Register BINtest for BIN deliveries');
    await form.getByRole('button', { name: 'Register Truck', exact: true }).click();
    await expect(page.locator('.setup-notice')).toHaveText('Truck setup saved.');
    const row = (await query("SELECT id::text,truck_type,bin_service_enabled FROM dispatch_trucks WHERE plate='BINTEST'")).rows[0];
    assert.ok(row);
    assert.equal(row.truck_type, 'bin');
    assert.equal(row.bin_service_enabled, true);
    await page.screenshot({ path: 'test-artifacts/mbt-bin-corrections-20261015/registered-truck.png', fullPage: true });
    await page.route('**/api/dispatch/setup', async route => {
      const response = await route.fetch(); const body = await response.json();
      body.trucks = body.trucks.filter(truck => truck.plate !== 'BINTEST');
      await route.fulfill({ response, json: body });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/planning?planDate=${f.planDate}`);
    await expect.poll(() => page.evaluate(() => dispatchPlannerSnapshotState)).toBe('ready');
    await expect.poll(() => page.evaluate(() => mbtBinDispatchLoading)).toBe(false);
    await expect.poll(() => page.evaluate(() => isDispatchPlanEditor())).toBe(true);
    const lane = page.locator(`[data-driver-lane="${f.driverLogin}"]`);
    const choices = lane.locator('[data-driver-new-truck]');
    await expect(choices.locator(`option[value="${row.id}"]`)).toHaveText('BINTEST');
    await choices.selectOption(row.id);
    await lane.getByRole('button', { name: '+ Load', exact: true }).click();
    const saved = await page.evaluate(async () => { await saveCurrentPlanNow(); return { dirty: localPlanDirty, notice: routeNotice }; });
    assert.equal(saved.dirty, false, saved.notice);
    assert.ok((await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [f.planId])).rows[0].trucks
      .find(truck => truck.plate === 'BINTEST')?.loads.some(load => load.mbtPlanning));
    await page.screenshot({ path: 'test-artifacts/mbt-bin-corrections-20261015/truck-selection.png', fullPage: true });
    const planningCoverage = await page.coverage.stopJSCoverage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.route('**/api/mbt/planning?*', async route => {
      const response = await route.fetch(); const body = await response.json(); body.trucks = [];
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => isDispatchPlanEditor())).toBe(true);
    await expect(page.locator('[data-dispatch-order-pool] a[href="/dispatch/setup"]')).toBeVisible();
    planningCoverage.push(...await page.coverage.stopJSCoverage());
    await writeFile('test-artifacts/planning-browser-coverage.json', JSON.stringify(planningCoverage));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('browser: new BIN fee defaults to MBT and undelivered bin actions remain disabled', { timeout: 90000 }, async () => {
  const f = await createFrontdeskPrerequisites({ label: 'bin-ui-corrections' });
  for (const code of ['DELIVERY_CHARGE_MBBS', 'DELIVERY_CHARGE_MBT']) {
    await query(`INSERT INTO mbt_local_item_settings
      SELECT (jsonb_populate_record(NULL::mbt_local_item_settings, to_jsonb(item) ||
        jsonb_build_object('item_code',$1::text,'display_name',$1::text,'system_owned',false,'netsuite_mapping_local_key',NULL))).*
      FROM mbt_local_item_settings item WHERE item_code='DELIVERY_CROSS_CHARGE' ON CONFLICT (item_code) DO NOTHING`, [code]);
  }
  const actor = { operatorId: 'bin-ui-corrections-admin', roles: ['admin'] };
  const password = 'synthetic-bin-ui-corrections-password';
  await createOperator({ username: actor.operatorId, displayName: 'BIN UI admin', password, role: 'admin' });
  const token = (await loginOperator(actor.operatorId, password)).token;
  const created = await createFrontdeskQuote({ ...quoteCommand(f, { actor, identity: f.runId }),
    serviceLines: [1, 2].map(() => ({ binTypeId: f.binTypeId,
      proposedDeliveryAt: f.proposedDeliveryAt, proposedReturnAt: f.proposedReturnAt })) },
  { resolveDistance: frontdeskDistanceResolver(f), resolveTaxPolicy: frontdeskTaxResolver });
  const quoteId = created.body.quote.quoteId;
  await issueFrontdeskQuote(frontdeskCommand('ui-issue', actor, { quoteId, expectedRevision: 1, validUntil: '2037-08-04T12:00:00Z' }));
  await acceptFrontdeskQuote(frontdeskCommand('ui-accept', actor, { quoteId, expectedRevision: 2, acceptedAt: '2037-08-03T10:00:00Z' }));
  const converted = await convertFrontdeskQuote(frontdeskCommand('ui-convert', actor, { quoteId, expectedRevision: 3 }));
  config.mbt.enabled = true;
  config.mbtPhase3.frontdeskOperationsEnabled = true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_frontdesk_operations')");
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.addInitScript(value => localStorage.setItem('mbbs.staff.token', value), token);
    const page = await context.newPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/frontdesk`);
    await expect(page.locator('#frontdeskMessage')).toContainText('Front Desk is ready.');
    await page.locator('#customerSearch').fill(f.marker);
    await page.locator(`[data-customer-id="${f.customerNetsuiteId}"]`).click();
    await page.getByRole('button', { name: new RegExp(converted.body.contract.contractNumber) }).click();
    const cards = page.locator('.mbt-service-line-card');
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) {
      await expect(card.getByRole('button', { name: 'Exchange bin', exact: true })).toBeDisabled();
      await expect(card.getByRole('button', { name: 'Collect bin', exact: true })).toBeDisabled();
    }
    await cards.first().getByRole('button', { name: 'Exchange bin', exact: true }).dispatchEvent('click');
    await expect(page.locator('#frontdeskMessage')).toContainText('complete this bin');
    await page.locator('#openNewContractOrder').click();
    await page.locator('#orderKind').selectOption('bin');
    await page.locator('#createQuoteButton').click();
    await expect(page.locator('#customerChargeDialog')).toBeVisible();
    await expect(page.locator('#chargeDeliveryItemCode')).toHaveValue('DELIVERY_CHARGE_MBT');
    await expect(page.locator('#chargeOrderFrom150')).not.toBeChecked();
    await expect(page.locator('#chargeOrderFrom150')).toBeEnabled();
    await page.screenshot({ path: 'test-artifacts/mbt-bin-corrections-20261015/bin-fee-default.png', fullPage: true });
    await page.locator('#closeCustomerCharge').click();
    await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_line_id=$1 AND service_action='delivery'", [converted.body.serviceLines[0].serviceLineId]);
    await page.getByRole('button', { name: new RegExp(converted.body.contract.contractNumber) }).click();
    await expect(cards.first().getByRole('button', { name: 'Exchange bin', exact: true })).toBeEnabled();
    await expect(cards.last().getByRole('button', { name: 'Collect bin', exact: true })).toBeDisabled();
    await cards.first().getByRole('button', { name: 'Exchange bin', exact: true }).click();
    await expect(page.locator('#customerChargeDialog')).toBeVisible();
    await expect(page.locator('#chargeDeliveryItemCode')).toHaveValue(f.deliveryItemCode);
    await page.locator('#closeCustomerCharge').click();
    await query("UPDATE mbt_contract_service_lines SET status='cancelled' WHERE service_line_id=$1", [converted.body.serviceLines[1].serviceLineId]);
    await page.getByRole('button', { name: new RegExp(converted.body.contract.contractNumber) }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first().getByRole('heading')).toContainText('Line 1');
    await writeFile('test-artifacts/frontdesk-browser-coverage.json', JSON.stringify(await page.coverage.stopJSCoverage()));
  } finally {
    await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
