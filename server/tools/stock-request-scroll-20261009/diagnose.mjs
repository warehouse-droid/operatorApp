import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fixture, metrics, out } from './browser-fixture.mjs';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  for (const audience of ['sales', 'scm']) for (const kind of ['special', 'regular']) {
    const { page, context, state } = await fixture(browser, { audience, kind, width: 390, height: 800, baseline: false });
    try {
      const result = { audience, kind, wheels: [], refresh: [], errors: state.errors };
      for (let round = 0; round < 3; round++) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.locator('.stock-request-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
        const before = await metrics(page), box = await page.locator('.stock-request-list').boundingBox();
        await page.mouse.move(box.x + 30, Math.min(770, box.y + 90));
        const target = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 300), { x: box.x + 30, y: Math.min(770, box.y + 90) });
        await page.mouse.wheel(0, 360); await page.waitForTimeout(250);
        result.wheels.push({ round, target, before, after: await metrics(page) });
        await page.mouse.wheel(0, -1000000); await page.waitForTimeout(250);
      }
      await page.mouse.move(385, 400); await page.mouse.wheel(0, 1000000); await page.waitForTimeout(250);
      result.refresh.push({ label: 'before', ...(await metrics(page)) });
      await page.locator('[data-special-sales-action=refresh], [data-special-scm-action=refresh], [data-sales-stock-action=refresh], [data-scm-stock-action=refresh]').first().evaluate(button => button.click());
      for (let step = 0; step < 12; step++) { await page.waitForTimeout(50); result.refresh.push({ step, ...(await metrics(page)) }); }
      results.push(result);
      console.log(JSON.stringify({ audience, kind, wheels: result.wheels.map(r => [r.before.top, r.after.top]),
        refresh: result.refresh.map(r => [r.top, r.max]), writes: state.writes, errors: state.errors }));
    } finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(out + '/diagnose.json', JSON.stringify(results, null, 2)); }
