/* global window */
import { webkit } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fixture, metrics, out } from './browser-fixture.mjs';

const browser = await webkit.launch({ headless: true });
const results = [];
try {
  for (const baseline of [true, false]) for (const audience of ['scm', 'sales']) for (const kind of ['special', 'regular']) for (const width of [1440, 390]) {
    const { page, context, state } = await fixture(browser, { audience, kind, width, height: 800, baseline });
    try {
      const result = { baseline, audience, kind, width, engine: 'webkit', initial: await metrics(page), steps: [], errors: state.errors };
      await page.mouse.move(width - 5, 400);
      for (let i = 0; i < 35; i++) {
        const before = await metrics(page);
        await page.mouse.wheel(0, 450);
        await page.waitForTimeout(60);
        const after = await metrics(page);
        result.steps.push({ before: before.top, after: after.top, max: after.max });
        if (after.max - after.top < 2) break;
      }
      result.reversals = result.steps.filter(step => step.after < step.before - 2);
      await page.evaluate(() => { window.scrollTo(0, 0); const list = document.querySelector('.stock-request-list'); list.scrollTop = list.scrollHeight; });
      const box = await page.locator('.stock-request-list').boundingBox();
      await page.mouse.move(box.x + 25, Math.min(700, box.y + 100));
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(70); }
      result.boundary = await metrics(page);
      console.log(JSON.stringify({ baseline, audience, kind, width, engine: 'webkit', reversals: result.reversals.length, boundary: result.boundary.top, errors: state.errors }));
      results.push(result);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(out + '/webkit-probe.json', JSON.stringify(results, null, 2));
}
