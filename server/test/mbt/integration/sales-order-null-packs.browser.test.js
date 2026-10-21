import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { specialLineFields } from '../../../public/special-stock-line-fields.js';

test('browser accepts blank optional packing controls and preserves positive decimal input', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form>${specialLineFields({ productName: 'Stone', quantity: 24, uom: 'SQFT', rate: 10, palletQty: 0, layerQty: null, sectionQty: '', pieceQty: 2.5 })}</form>`);
    for (const field of ['palletQty', 'layerQty', 'sectionQty']) {
      assert.equal(await page.locator(`[name=${field}]`).inputValue(), '');
      assert.equal(await page.locator(`[name=${field}]`).evaluate(el => el.required), false);
    }
    assert.equal(await page.locator('[name=pieceQty]').inputValue(), '2.5');
    assert.equal(await page.locator('form').evaluate(el => el.checkValidity()), true);
    await page.locator('[name=pieceQty]').fill('');
    assert.equal(await page.locator('form').evaluate(el => el.checkValidity()), true);
  } finally { await browser.close(); }
});
