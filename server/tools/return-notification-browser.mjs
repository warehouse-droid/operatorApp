/* global window, document */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

function extract(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}
const source = readFileSync('public/operator.js', 'utf8');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const results = [];
try {
  for (const width of [390, 1024]) {
    for (const kind of ['stock', 'pallet', 'combined']) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      await page.setContent(`<style>${readFileSync('public/operator.css', 'utf8')}\n${readFileSync('public/operator-phone.css', 'utf8')}</style><main id="app" class="tablet-shell"></main>`);
      await page.evaluate(phone => { if (phone) { document.documentElement.dataset.operatorPhone = 'true'; } }, width === 390);
      await page.evaluate(mode => {
        const record = { id: 8, batchId: 12, workflowVersion: 3, reference: 'SR1', status: 'accepted',
          netSuiteStage: 'credit_memo', netSuiteSyncStatus: 'succeeded', netSuiteTransactionId: 77, netSuiteTransactionRef: 'CMB0077' };
        Object.assign(window, {
          returnResult: { batchReference: 'RB1', stockReturn: mode === 'pallet' ? null : { ...record, recordType: 'stock' },
            palletReturn: mode === 'stock' ? null : { ...record, id: 9, reference: 'PR1', recordType: 'pallet' } },
          t: (_key, fallback) => fallback, localizeMessage: value => value,
          escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
          render: () => { document.getElementById('app').innerHTML = '<header class="topbar" style="flex:0 0 82px">Return confirmation</header>' + window.renderReturnSuccess(); },
          calls: [], api: async (url, options) => {
            window.calls.push({ url, body: JSON.parse(options.body) });
            const recipient = JSON.parse(options.body).recipient;
            return { status: 'sent', channel: recipient.includes('@') ? 'email' : 'sms', recipient };
          }
        });
      }, kind);
      await page.addScriptTag({ content: readFileSync('public/return-notifications.js', 'utf8') });
      await page.addScriptTag({ content: ['returnNetSuiteResultLabel', 'renderReturnSuccess'].map(name => extract(source, name)).join('\n') });
      await page.evaluate(() => {
        window.MBBSReturnNotifications.configure({ request: window.api, render: window.render, escapeHtml: window.escapeHtml });
        document.getElementById('app').addEventListener('input', event => {
          window.MBBSReturnNotifications.input(event.target.dataset.returnNotificationRecipient, event.target.value);
        });
        document.getElementById('app').addEventListener('click', event => {
          const button = event.target.closest('[data-action="return-notification-send"]');
          if (button) { window.MBBSReturnNotifications.send(button.dataset.notificationKey, button.dataset.record); }
        });
        window.render();
      });
      const form = page.locator('.return-customer-notification');
      assert.equal(await form.locator('input').count(), 1);
      await page.getByLabel('Email or mobile number').fill('(416) 555-0123');
      await form.getByRole('button', { name: 'Send', exact: true }).click();
      await form.getByRole('status').filter({ hasText: 'SMS sent successfully' }).waitFor();
      const calls = await page.evaluate(() => window.calls);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.recipient, '(416) 555-0123');
      const box = await form.locator('input').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, 'recipient input fits the viewport');
      assert.equal(await form.locator('input').inputValue(), '(416) 555-0123');
      await page.getByLabel('Email or mobile number').fill('customer@example.com');
      await form.getByRole('button', { name: 'Send', exact: true }).click();
      await form.getByRole('status').filter({ hasText: 'Email sent successfully' }).waitFor();
      await page.getByRole('button', { name: 'New Return', exact: true }).click({ timeout: 3000 });
      results.push({ width, kind, passed: true });
      await page.close();
    }
  }
  const page = await browser.newPage();
  await page.setContent(`<style>${readFileSync('public/control.css', 'utf8')}</style><main id="app"></main>`);
  await page.evaluate(() => Object.assign(window, {
    returnNotificationSettings: { hasApiKey: true, configured: true, fromNumber: '+14165550123', emailConfigured: true },
    escapeHtml: value => String(value)
  }));
  const control = readFileSync('public/control.js', 'utf8');
  await page.addScriptTag({ content: extract(control, 'renderReturnNotificationSettings') });
  await page.evaluate(() => { document.getElementById('app').innerHTML = window.renderReturnNotificationSettings(); });
  assert.equal(await page.getByLabel('Telnyx API key').getAttribute('type'), 'password');
  assert.equal(await page.getByLabel('Telnyx API key').inputValue(), '');
  assert.equal(await page.getByLabel('Telnyx sender number').inputValue(), '+14165550123');
  const start = control.indexOf('    if (["save-return-notifications", "remove-return-notification-key"].includes(button.dataset.action))');
  const end = control.indexOf('    if (button.dataset.action === "refresh-return-automation")', start);
  assert.ok(start > 0 && end > start);
  await page.evaluate(() => Object.assign(window, {
    app: document.getElementById('app'), messages: [], errors: [], settingsCalls: [],
    alert: value => window.messages.push(value),
    render: () => { window.app.innerHTML = window.renderReturnNotificationSettings(); },
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      window.settingsCalls.push(body);
      return { hasApiKey: !body.clearApiKey, configured: !body.clearApiKey, fromNumber: body.fromNumber || '', emailConfigured: true };
    }
  }));
  await page.addScriptTag({ content: `async function saveSettings(button) { ${control.slice(start, end)} }` });
  await page.getByLabel('Telnyx API key').fill('synthetic-browser-key');
  await page.evaluate(async () => {
    try { await window.saveSettings(window.app.querySelector('[data-action="save-return-notifications"]')); }
    catch (error) { window.errors.push(error.message); }
  });
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  assert.deepEqual(await page.evaluate(() => window.messages), ['Return notification settings saved.']);
  assert.equal(await page.getByLabel('Telnyx API key').inputValue(), '');
  assert.equal((await page.evaluate(() => window.settingsCalls))[0].apiKey, 'synthetic-browser-key');
  await page.evaluate(() => window.saveSettings(window.app.querySelector('[data-action="remove-return-notification-key"]')));
  assert.equal(await page.getByRole('button', { name: 'Remove Telnyx API key' }).count(), 0);
  results.push({ adminSettings: true, passed: true });
} finally { await browser.close(); }
console.log(JSON.stringify({ browser: 'Chromium', scenarios: results }, null, 2));
