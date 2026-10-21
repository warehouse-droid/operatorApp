import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

test('split dialog retains mixed NetSuite destinations by default and supports a yard override', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/dispatch-scm.js' || path === '/dispatch.css') {
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(`../../../public${path}`, import.meta.url)));
    } else if (path === '/api/dispatch/scm/purchase-order-splits') {
      let body = '';
      for await (const part of req) body += part;
      requests.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ created: { split: { splitPoRef: requests.at(-1).newPoRef } } }));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><head><link rel="stylesheet" href="/dispatch.css"></head><body><main id="dispatchScmApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-scm.js"></script></body></html>');
    }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      scmOrders = [{ id: 'POB04006', type: 'PO', originalPoRef: 'POB04006', catalogHydrated: true,
        destinationLocationId: 1, destinationYard: '3445',
        items: [
          { lineRowId: 1, sku: 'STORM', quantity: 20, pallets: 2, toPlt: 10, destinationYard: '3445', netsuiteDestinationYard: '2967' },
          { lineRowId: 2, sku: 'DUNE', quantity: 20, pallets: 2, toPlt: 10, destinationYard: '3445', netsuiteDestinationYard: '3445' }
        ], scm: { status: 'Queued' } }];
      selectedScmOrderId = 'POB04006';
      scmLineInputs = { '1': { pallets: 1 }, '2': { pallets: 1 } };
      refreshScmOrder = async () => {};
      renderScm();
    });
    await page.locator('[data-action="create-split"]').click();
    const destination = page.locator('[data-action="split-destination-yard"]');
    await expect(destination).toHaveValue('netsuite');
    await expect(page.locator('.scm-summary-lines')).toContainText('Destination Yard: 2967');
    await expect(page.locator('.scm-summary-lines')).toContainText('Destination Yard: 3445');
    await page.locator('.scm-summary-modal [data-action="new-ref"]').fill('SN1402278-TEST');
    await page.locator('[data-action="split-remark"]').fill('Keep supplier destinations');
    await page.locator('[data-action="split-initial-status"]').selectOption('Queued');
    await destination.selectOption('15');
    await expect(page.locator('.scm-summary-lines')).not.toContainText('Destination Yard: 2967');
    await expect(page.locator('.scm-summary-lines')).toContainText('Destination Yard: 12441');
    await expect(page.locator('[data-action="split-remark"]')).toHaveValue('Keep supplier destinations');
    await expect(page.locator('[data-action="split-initial-status"]')).toHaveValue('Queued');
    await destination.selectOption('netsuite');
    await page.screenshot({ path: 'test-artifacts/scm-split-retain-destination-20261015/retain-dialog.png', fullPage: true });
    await page.locator('[data-action="confirm-create-split"]').click();
    await expect.poll(() => requests.length).toBe(1);
    assert.equal(requests[0].retainNetSuiteDestination, true);
    assert.equal(requests[0].destinationLocationId, null);
    assert.equal(requests[0].remarkOverride, 'Keep supplier destinations');
    await expect(page.locator('.scm-summary-modal')).toHaveCount(0);
    await page.evaluate(() => { scmLineInputs = { '1': { pallets: 1 }, '2': { pallets: 1 } }; renderScm(); });
    await page.locator('[data-action="create-split"]').click();
    await expect(destination).toHaveValue('netsuite');
    await destination.selectOption('1');
    await page.locator('.scm-summary-modal [data-action="new-ref"]').fill('SN1402278-OVERRIDE-TEST');
    await page.locator('[data-action="confirm-create-split"]').click();
    await expect.poll(() => requests.length).toBe(2);
    assert.equal(requests[1].retainNetSuiteDestination, false);
    assert.equal(requests[1].destinationLocationId, '1');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
