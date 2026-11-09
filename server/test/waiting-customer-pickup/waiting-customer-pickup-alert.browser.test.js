/* global localStorage, window */
// Release waiting-customer-pickup (2026-11-09): the Sales "My special requests" badge counts and
// describes requests waiting for customer pickup, and still rejects totals that do not add up.
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => browser?.close());

async function fixture() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'pickup-user'));
  const page = await context.newPage();
  const state = { counts: { awaitCustomerConfirmation: 1, dispatchArrangement: 2, waitForProduction: 3, total: 6 } };
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test', role: 'sales', roles: ['sales'], publicSales: false } } });
    if (path.endsWith('/alerts')) return route.fulfill({ json: { ...state.counts } }).catch(() => {});
    if (path === '/sales-special-alert.js') return route.fulfill({ body: await readFile('public/sales-special-alert.js'), contentType: 'application/javascript' });
    if (path === '/preview') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="UTF-8"></head><body><header class="topbar"><div class="topbar-actions"></div></header><script src="/sales-special-alert.js"></script></body></html>' });
    return route.fulfill({ json: {} });
  });
  await page.goto('http://localhost/preview');
  return { page, state, close: () => context.close() };
}
const refresh = page => page.evaluate(() => window.MBBSSalesSpecialAlert.refresh());

test('the Sales badge counts requests waiting for customer pickup and rejects totals that omit them', async () => {
  const { page, state, close } = await fixture();
  try {
    const alert = page.locator('.sales-special-alert');
    await expect(alert).toHaveAccessibleName('6 special requests: 1 await customer confirmation, 2 dispatch arrangement, 3 wait for production / Transfer');
    state.counts = { awaitCustomerConfirmation: 1, dispatchArrangement: 2, waitingCustomerPickup: 4, waitForProduction: 3, pendingUpdate: 0, total: 10 };
    await refresh(page);
    await expect(alert).toHaveAccessibleName('10 special requests: 1 await customer confirmation, 2 dispatch arrangement, 3 wait for production / Transfer, 4 waiting customer pickup');
    // A total that does not match its parts is ignored; the last valid count stays.
    state.counts = { ...state.counts, waitingCustomerPickup: 5 };
    await refresh(page);
    await expect(alert).toContainText('10');
    // An older server without the new count still adds up.
    state.counts = { awaitCustomerConfirmation: 1, dispatchArrangement: 2, waitForProduction: 3, pendingUpdate: 0, total: 6 };
    await refresh(page);
    await expect(alert).toHaveAccessibleName('6 special requests: 1 await customer confirmation, 2 dispatch arrangement, 3 wait for production / Transfer');
  } finally {
    await close();
  }
});
