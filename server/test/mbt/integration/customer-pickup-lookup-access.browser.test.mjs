/* global localStorage, locationId, currentModule */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { chromium } from 'playwright';
import { app } from '../../../src/server.js';
import { query, closeDb } from '../../../src/db.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';
import { seedOperatorPickup } from '../../support/operator-ui-enhancements-fixture.mjs';

const artifact = 'test-artifacts/customer-pickup-lookup-access';
let server, browser, base, session;
const orders = [];
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  await mkdir(artifact, { recursive: true });
  const username = `qin-grants-${randomUUID()}`, password = randomUUID();
  await createOperator({ username, password, displayName: 'Qin permissions fixture', role: 'operator',
    operatorYardLocationIds: [1, 15] });
  session = await loginOperator(username, password);
  for (const [ref, item] of [['SOA10099', 'UNI-WIN60S-1530-GN'], ['SOA10159', 'BWS-DC-GREY']]) {
    const f = await seedOperatorPickup({ quantity: 7 });
    await query("UPDATE sales_orders SET tranid=$2,order_location_id=28,order_location='2967' WHERE netsuite_id=$1", [f.orderId, ref]);
    await query('UPDATE sales_order_lines SET item_name=$2,sku=$2 WHERE id=$1', [f.lineId, item]);
    const other = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,
      quantity,unit,location_id,location,piece_qty,to_pcs,packed_piece_qty,netsuite_active)
      VALUES($1,2,889202,'2967-PRIVATE-ITEM','2967-PRIVATE-ITEM','InvtPart',1,'PC',28,'2967',1,1,0,true)
      RETURNING id::text`, [f.orderId])).rows[0];
    orders.push({ ...f, ref, item, otherLineId: other.id });
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});
after(async () => {
  await browser?.close();
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});

async function draft(orderId) {
  return (await query(`SELECT id::text,packed_pallet_qty,packed_layer_qty,packed_section_qty,
    packed_piece_qty,loaded_qty,confirmed,confirmed_at FROM sales_order_lines
    WHERE sales_order_id=$1 ORDER BY sales_order_lines.id`, [orderId])).rows;
}

for (const ref of ['SOA10099', 'SOA10159']) {
  for (const action of ['Enter', 'Find Order']) {
    test(`L1 L2 ${ref} lookup by ${action} preserves Qin's 3445 yard and shows its line only`, async () => {
      const order = orders.find(value => value.ref === ref), original = await draft(order.orderId);
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
      const page = await context.newPage(), errors = [], responses = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/') && response.status() >= 400) {
          responses.push({ path: url.pathname, status: response.status() });
        }
      });
      await page.addInitScript(token => {
        localStorage.setItem('mbbs.staff.token', token);
        localStorage.setItem('mbbs.ui.language', 'en');
      }, session.token);
      try {
        await page.goto(`${base}/operator`);
        await page.locator('#locationSelect').waitFor({ timeout: 8000 });
        await page.selectOption('#locationSelect', '1');
        await page.locator('[data-action="save-location"]').click();
        await page.locator('[data-action="open-module"][data-module="customer-pickup"]').click();
        await page.locator('#customerPickupScan').fill(ref);
        const result = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customer-pickup/lookup');
        if (action === 'Enter') { await page.locator('#customerPickupScan').press('Enter'); }
        else { await page.locator('[data-action="lookup-customer-pickup"]').click(); }
        const response = await result;
        // The old denial reloads the page and discards Chromium's response body.
        // Preserve its status and observed navigation without masking the assertion.
        const detail = response.status() === 200 ? await response.json() : {};
        let resetToYard = false;
        if (response.status() !== 200) {
          try { await page.locator('#locationSelect').waitFor({ timeout: 5000 }); resetToYard = true; }
          catch { /* Preserve the original HTTP status even if the reset is slow. */ }
        }
        await writeFile(`${artifact}/${process.env.PICKUP_LOOKUP_RUN || 'current'}-${ref}-${action.replace(' ', '-')}.json`,
          JSON.stringify({ status: response.status(), ref, placement: detail.order_location_id,
            pickupYard: detail.pickup_location_id, lines: detail.lines?.map(line => line.id), resetToYard, errors, responses }, null, 2));
        assert.equal(response.status(), 200, JSON.stringify(detail));
        assert.deepEqual(detail.lines.map(line => String(line.id)), [order.lineId]);
        assert.equal(Number(detail.order_location_id), 28);
        assert.equal(detail.pickup_location_id, 1);
        await page.locator('[data-action="customer-pickup-back"]').waitFor({ timeout: 8000 });
        assert.match(await page.locator('.detail-panel').innerText(), new RegExp(order.item, 'u'));
        assert.equal((await page.locator('.detail-panel').innerText()).includes('2967-PRIVATE-ITEM'), false);
        assert.equal(await page.locator('#locationSelect').count(), 0);
        assert.match(await page.locator('.topbar-location').innerText(), /3445/u);
        assert.deepEqual(await page.evaluate(() => ({ yard: locationId, module: currentModule })),
          { yard: 1, module: 'customer-pickup' });
        assert.deepEqual(await draft(order.orderId), original);
        assert.deepEqual(errors, []);
        assert.equal(responses.some(value => value.status === 403), false, JSON.stringify(responses));
        await page.screenshot({ path: `${artifact}/${ref}-${action.replace(' ', '-')}.png`, fullPage: true });
      } finally { await context.close(); }
    });
  }
}

test('L3 Qin grants cannot look up the other yard or mutate its line', async () => {
  for (const order of orders) {
    const original = await draft(order.orderId);
    for (const [pathname, body] of [
      ['/api/customer-pickup/lookup', { code: order.ref, locationId: 28 }],
      [`/api/customer-pickup/orders/${order.orderId}/lines/${order.otherLineId}/confirm`, { locationId: 1, pieces: 1 }]
    ]) {
      const response = await fetch(`${base}${pathname}`, { method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body) });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'OPERATOR_YARD_FORBIDDEN');
    }
    assert.deepEqual(await draft(order.orderId), original);
  }
});
