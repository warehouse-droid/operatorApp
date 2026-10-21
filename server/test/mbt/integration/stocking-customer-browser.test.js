/* global localStorage, scmStockState */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { app } from '../../../src/server.js';
import { query, closeDb } from '../../../src/db.js';
import { createOperator } from '../../../src/auth-repository.js';
import { submitRegularStockRequest } from '../../../src/regular-stock-request-service.js';
const actors = {}, tokens = {}, users = [], cases = [], run = randomUUID(), password = randomUUID();
const out = process.env.STOCKING_CUSTOMER_BROWSER_OUTPUT || 'test-artifacts/special-workflow-review/stock-updates-20261002/stocking-browser', itemId = 9800000000721;
let browser, server, base;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/mbt_test(?:_file_[a-f0-9]{12}_[a-z0-9]+)?$/);
  await mkdir(out, { recursive: true });
  if (!(await query("SELECT to_regclass('regular_waitlist_pools') AS name")).rows[0].name) await query(await readFile('migrations/254_regular_waitlist.sql', 'utf8'));
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'TEST customer display material','EA',1,100) ON CONFLICT DO NOTHING", [itemId]);
  await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=1000,synced_at=now()", [itemId]);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ['sales', 'scm']) {
    const username = `stocking-customer-${role}-${run}`; users.push(username);
    await createOperator({ username, displayName: `TEST ${role}`, password, role, roles: [role], yardLocationIds: role === 'sales' ? [28] : [] });
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); const data = await response.json(); tokens[role] = data.token; actors[role] = data.operator.id;
  }
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
});
after(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  await query('DELETE FROM sales_stock_transfers WHERE request_id=ANY($1::bigint[])', [cases]);
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [cases]);
  await query('DELETE FROM operators WHERE username=ANY($1::text[])', [users]); await closeDb();
});
async function draft(type, customerName) {
  const record = await submitRegularStockRequest({ destinationLocationId: 28, deliveryMethod: 'stocking', stockingType: type, customerName,
    lines: [{ itemId, ...(type === 'transfer' ? { sourceLocationId: 1 } : {}), pieces: 20 }] },
  { operatorId: actors.sales, authorizedDestinationLocationIds: [28], allowOverAvailability: true },
  { refreshAvailability: async () => {}, loadPolicies: async () => [], loadPurchaseStock: async () => ({ onHand: 1000, available: 1000, preferredStock: 1000 }) });
  cases.push(record.id); return record;
}
test('Entered stocking customer persists and appears in Sales and SCM cards and details for Transfer and Purchase', async () => {
  for (const type of ['transfer', 'purchase']) {
    const name = `Stocking ${type} Customer <North>`, record = await draft(type, name);
    assert.equal(record.regular.customerName, name);
    for (const role of ['sales', 'scm']) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
      try {
        await context.addInitScript(token => { localStorage.setItem('mbbs.staff.token', token); localStorage.setItem('mbbs.scm.stockRequests.queue', 'request'); }, tokens[role]);
        const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
        await page.goto(`${base}/${role}/stock-requests?tab=regular`);
        const card = page.locator(`[data-${role}-stock-action=select][data-id="${record.id}"]`);
        await expect(card).toContainText(name); await card.click();
        await expect(page.locator('.stock-request-detail')).toContainText(name);
        await expect(page.locator('.stock-request-detail north')).toHaveCount(0);
        if (type === 'transfer' && role === 'scm') {
          await query("INSERT INTO sales_stock_transfers(request_id,source_location_id,source_name,destination_location_id,destination_name,created_by) VALUES($1,1,'3445',28,'TEST destination',$2)", [record.id, actors.scm]);
          await page.locator('[data-yard-filter="queue"] summary').click();
          await page.locator('[data-yard-filter="queue"] [data-yard-filter-clear="queue"]').click();
          await expect.poll(()=>page.evaluate(()=>scmStockState.loading)).toBe(false);
          const queue=page.locator('[data-yard-filter="queue"]');
          if(!await queue.evaluate(element=>element.open))await queue.locator('summary').click();
          await page.locator('[name="queue"][value="pending_to"]').check();
          await expect.poll(()=>page.evaluate(()=>scmStockState.loading)).toBe(false);
          if(await queue.evaluate(element=>element.open))await queue.locator('summary').click();
          await card.click();
          await expect(page.locator('.stock-request-detail')).toContainText(name);
          await expect(page.locator('.stock-request-detail h2')).toContainText('STTO-');
        }
        await page.screenshot({ path: `${out}/${role}-${type}.png` });
        await writeFile(`${out}/coverage-${role}-${type}.json`, JSON.stringify(await page.coverage.stopJSCoverage()));
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  }
  assert.equal((await draft('purchase', '')).regular.customerName, '');
});
