import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fixture, out, metrics } from './browser-fixture.mjs';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  for (const audience of ['scm', 'sales']) for (const kind of ['special', 'regular']) for (const viewport of [
    { width: 1440, height: 900 }, { width: 1024, height: 600 }, { width: 390, height: 800 }
  ]) {
    const { page, context, detail, state } = await fixture(browser, { audience, kind, ...viewport });
    try {
      await page.evaluate(() => window.scrollTo(0, 0));
      const result = { audience, kind, ...viewport, ref: detail.requestRef, initial: await metrics(page), wheels: [], errors: state.errors };
      await page.screenshot({ path: `${out}/${audience}-${kind}-${viewport.width}-top.png` });
      for (const area of ['margin', 'detail', 'list']) {
        await page.evaluate(() => window.scrollTo(0, 0));
        if (area === 'margin') await page.mouse.move(viewport.width - 5, viewport.height / 2);
        else {
          const box = await page.locator('.stock-request-' + area).boundingBox();
          await page.mouse.move(box.x + box.width / 2, Math.min(viewport.height - 30, box.y + 150));
        }
        for (let step = 0; step < 30; step++) {
          const before = await metrics(page);
          await page.mouse.wheel(0, 1400);
          await page.waitForTimeout(80);
          const after = await metrics(page);
          result.wheels.push({ area, step, before: before.top, after: after.top, max: after.max,
            listBefore: before.nodes.find(n => n.selector === '.stock-request-list').scrollTop,
            listAfter: after.nodes.find(n => n.selector === '.stock-request-list').scrollTop });
          if (Math.abs(after.top - before.top) < 1 && Math.abs(result.wheels.at(-1).listAfter - result.wheels.at(-1).listBefore) < 1) break;
        }
      }
      await page.mouse.move(viewport.width - 5, viewport.height / 2);
      await page.mouse.wheel(0, 1000000); await page.waitForTimeout(100);
      result.bottom = await metrics(page);
      await page.screenshot({ path: `${out}/${audience}-${kind}-${viewport.width}-bottom.png` });
      await page.mouse.wheel(0, -1000000); await page.waitForTimeout(100);
      result.returned = await metrics(page);
      results.push(result);
      console.log(JSON.stringify({ audience, kind, width: viewport.width, ref: detail.requestRef,
        initial: result.initial.top, max: result.initial.max, bottom: result.bottom.top, returned: result.returned.top,
        blocked: result.wheels.filter(w => w.after === w.before && w.listAfter === w.listBefore && w.after < w.max - 2).map(w => w.area), errors: state.errors }));
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(out + '/probe.json', JSON.stringify(results, null, 2));
}
