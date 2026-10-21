/* global window, document, MutationObserver, requestAnimationFrame */
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fixture, out, metrics } from './browser-fixture.mjs';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  for (const audience of ['scm', 'sales']) for (const width of [1440, 390]) {
    const { page, context, state } = await fixture(browser, { audience, width, height: 900, fontOffset: 8 });
    try {
      const offset = await page.locator('[data-special-detail-display] output').textContent();
      await page.evaluate(() => {
        window.fontTrace = { frames: [], mutations: 0, running: true };
        new MutationObserver(records => { window.fontTrace.mutations += records.length; }).observe(document.querySelector('main'), { childList: true, subtree: true });
        const frame = () => {
          if (window.fontTrace.running) window.fontTrace.frames.push({ top: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight });
          requestAnimationFrame(frame);
        };
        frame();
      });
      await page.mouse.move(width - 5, 450);
      await page.mouse.wheel(0, 1000000);
      await page.waitForTimeout(300);
      const before = await metrics(page);
      for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(60); }
      const after = await metrics(page);
      const trace = await page.evaluate(() => { window.fontTrace.running = false; return window.fontTrace; });
      const reversals = trace.frames.filter((frame, i) => i && frame.top < trace.frames[i - 1].top - 2);
      const result = { audience, width, offset, before, after, trace, reversals, errors: state.errors };
      results.push(result);
      console.log(JSON.stringify({ audience, width, offset, before: before.top, after: after.top, max: after.max, reversals: reversals.length, mutations: trace.mutations, errors: state.errors }));
    } finally { await context.close(); }
  }
  const { page, context } = await fixture(browser, { width: 390, height: 800, touch: true, baseline: false });
  try {
    const session = await context.newCDPSession(page);
    const before = await metrics(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 380, y: 700 }] });
    for (let y = 675; y >= 100; y -= 25) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 380, y }] });
      await page.waitForTimeout(16);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
    const after = await metrics(page);
    console.log(JSON.stringify({ touchCalibration: true, before: before.top, after: after.top }));
    results.push({ touchCalibration: true, before, after });
  } finally { await context.close(); }
} finally {
  await browser.close();
  await writeFile(out + '/font-probe.json', JSON.stringify(results, null, 2));
}
