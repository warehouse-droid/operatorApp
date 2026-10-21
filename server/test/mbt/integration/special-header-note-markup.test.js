import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { specialFulfillmentEditor } from '../../../public/special-stock-fulfillment.js';

test('blank lines and whitespace survive parsing the saved Note into the shared header textarea', async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    for (const note of ['\n全贴砖方案\n5,200 × 1.05 = 5,460\n', '\n\n44 Sherwood Ave\n\n', '\t 中文 <text> & symbols \n', '']) {
      await page.setContent(specialFulfillmentEditor({ closeStatus: 'active', status: 'submitted', stage: 'new_enquiry',
        fulfillmentMethod: 'yard_pickup', revision: 2, remarks: note }));
      assert.equal(await page.locator('[name=remarks]').inputValue(), note);
    }
  } finally { await browser.close(); }
});
