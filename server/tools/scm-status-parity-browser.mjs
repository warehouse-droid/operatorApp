import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {chromium} from '@playwright/test';

let status = 'Queued';
const order = () => ({id: 'SN1401822', type: 'PO', originalPoRef: 'POB03973', dispatchRef: 'SN1401822',
  customer: 'Parity test vendor', destinationYard: '3445', destinationLocationId: '1', items: [],
  dispatchPlanned: status === 'Planned', scm: {status, method: 'MBT', etaDate: '2026-10-01',
    notes: 'Existing supplier note', updatedAt: '2026-10-01T13:20:18.825092Z'}});
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/dispatch-scm.js' || path === '/dispatch.css') {
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(readFileSync('public' + path));
  } else if (path.startsWith('/api/dispatch/scm/v2/purchase-orders')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(path.endsWith('SN1401822') ? {order: order()} : {orders: [order()], ready: true}));
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><link rel="stylesheet" href="/dispatch.css"><main id="dispatchScmApp"></main>'
      + '<script>function requireDispatchLogin(options){options.onReady({role:"scm",roles:["scm"]})}</script>'
      + '<script src="/dispatch-scm.js"></script>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const expected of ['Queued', 'Hold', 'Planned', 'Partially Done', 'Cancelled', 'Completed']) {
    status = expected;
    await page.goto(`http://127.0.0.1:${server.address().port}/?order=SN1401822`);
    await page.locator('.scm-planned-badge').waitFor();
    assert.equal(await page.locator('.scm-planned-badge').textContent(), expected);
    const field = page.locator('[data-scm-field="status"]');
    if (await field.count()) assert.equal(await field.inputValue(), expected);
    else assert.equal(await page.locator('.scm-mini-status-field input').inputValue(), expected);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({browser: true, statusCases: 6, errors: []}));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
