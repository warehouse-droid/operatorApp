/* global window, document, MessageEvent, requestAnimationFrame */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { fixture, metrics, out } from '../../../tools/stock-request-scroll-20261009/browser-fixture.mjs';

let browser;
const baseline = process.env.SCROLL_TEST_MODE === 'red';
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});
after(async () => browser?.close());

async function pointAtList(page, height) {
  const box = await page.locator('.stock-request-list').boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + Math.min(30, box.width / 2), Math.max(20, Math.min(height - 30, box.y + 90)));
}

async function swipe(page, session, x, from, to) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
  for (let i = 1; i <= 15; i++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * i / 15 }] });
    await page.waitForTimeout(16);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
}

for (const audience of ['scm', 'sales']) for (const kind of ['special', 'regular']) {
  test(`${audience} ${kind}: real touch gestures continue past the queue and scroll the request steadily`, async () => {
    const { page, context, state } = await fixture(browser, { audience, kind, baseline, width: 390, height: 800, touch: true });
    try {
      const session = await context.newCDPSession(page);
      const list = page.locator('.stock-request-list');
      await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
      const box = await list.boundingBox();
      const y = Math.min(740, box.y + box.height - 30);
      await swipe(page, session, box.x + box.width / 2, y, Math.max(80, y - 250));
      await expect.poll(async () => {
        const top = await page.evaluate(() => window.scrollY);
        // As with wheels, the compositor can consume a final fractional pixel
        // inside the queue. Another gesture at its edge must reach the page.
        if (top <= 100) await swipe(page, session, box.x + box.width / 2, y, Math.max(80, y - 250));
        return top;
      }, { timeout: 2000 }).toBeGreaterThan(100);
      const fields = await page.locator('.stock-request-detail input, .stock-request-detail select, .stock-request-detail textarea').evaluateAll(nodes => nodes.map(node => node.value));
      await page.evaluate(() => {
        window.touchScrollTrace = [];
        window.touchScrollRecording = true;
        const frame = () => {
          if (window.touchScrollRecording) window.touchScrollTrace.push(window.scrollY);
          requestAnimationFrame(frame);
        };
        frame();
      });
      const before = await metrics(page);
      for (let i = 0; i < 5; i++) await swipe(page, session, 380, 700, 180);
      const after = await metrics(page);
      const trace = await page.evaluate(() => { window.touchScrollRecording = false; return window.touchScrollTrace; });
      assert.ok(after.top > before.top + 100);
      assert.equal(after.max, before.max);
      assert.ok(trace.every((top, i) => !i || top >= trace[i - 1] - 2), 'Downward swipes must not reset the page upward.');
      await swipe(page, session, 380, 150, 700);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(after.top - 100);
      assert.deepEqual(await page.locator('.stock-request-detail input, .stock-request-detail select, .stock-request-detail textarea').evaluateAll(nodes => nodes.map(node => node.value)), fields);
      assert.deepEqual(state.errors, []);
      assert.deepEqual(state.writes, []);
      await writeFile(`${out}/${audience}-${kind}-touch.json`, JSON.stringify({ before, after, trace, returned: await metrics(page) }));
    } finally { await context.close(); }
  });
}

for (const audience of ['scm', 'sales']) for (const kind of ['special', 'regular']) {
  test(`${audience} ${kind}: a background update holds the visible request text in place`, async () => {
    const { page, context, state } = await fixture(browser, { audience, kind, baseline, width: 1440, height: 900 });
    try {
      await page.mouse.move(1400, 450);
      await page.mouse.wheel(0, 1600);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1500);
      const before = await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('.stock-request-detail p, .stock-request-detail h3, .stock-request-detail label, .stock-request-event')];
        const anchor = candidates.find(el => { const box = el.getBoundingClientRect(); return box.top > 80 && box.bottom < 820; });
        if (!anchor) throw Error('No visible request text to track');
        window.scrollTestAnchor = anchor;
        return { top: window.scrollY, y: anchor.getBoundingClientRect().top };
      });
      await page.evaluate(type => {
        for (const source of window.scrollTestStreams.filter(source => !source.closed)) {
          source.dispatchEvent(new MessageEvent('app-event', { data: JSON.stringify({ type, payload: { requestId: 162 } }) }));
        }
      }, kind === 'special' ? 'special-stock-request.updated' : 'stock-request.updated');
      await expect(page.locator('[data-stock-background-update]')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollTestAnchor.getBoundingClientRect().top)).toBeGreaterThanOrEqual(before.y - 2);
      await expect.poll(() => page.evaluate(() => window.scrollTestAnchor.getBoundingClientRect().top)).toBeLessThanOrEqual(before.y + 2);
      assert.equal(await page.evaluate(() => window.scrollTestAnchor.isConnected), true);
      assert.deepEqual(state.writes, []);
      assert.deepEqual(state.errors, []);
      await writeFile(`${out}/${audience}-${kind}-background.json`, JSON.stringify({ before, after: await page.evaluate(() => ({ top: window.scrollY, y: window.scrollTestAnchor.getBoundingClientRect().top })) }));
    } finally { await context.close(); }
  });
}

for (const audience of ['scm', 'sales']) for (const kind of ['special', 'regular']) for (const viewport of [
  { width: 1440, height: 900 }, { width: 1024, height: 600 }, { width: 390, height: 800 }
]) {
  test(`${audience} ${kind} ${viewport.width}: wheel hands off at both request-list edges and details stay reachable`, async () => {
    const { page, context, state, detail } = await fixture(browser, { audience, kind, baseline, ...viewport });
    try {
      const list = page.locator('.stock-request-list');
      await page.evaluate(() => window.scrollTo(0, 0));
      const initial = await metrics(page);
      assert.ok(initial.max > 500, 'Use the real long request layout.');
      assert.equal(initial.horizontal <= viewport.width, true);
      const fieldsBefore = await page.locator('.stock-request-detail input, .stock-request-detail select, .stock-request-detail textarea').evaluateAll(fields => fields.map(field => field.value));

      // Scroll the actual pool to its lower edge while the page is at the top.
      // A wheel over a queue card must then continue into the containing page.
      await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await pointAtList(page, viewport.height);
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, 360);
      await expect.poll(async () => {
        const top = await page.evaluate(() => window.scrollY);
        // Fractional card heights can consume the first wheel's final pixel.
        // Subsequent wheel input at the boundary must still reach the page.
        if (top <= before + 100) await page.mouse.wheel(0, 360);
        return top;
      }, { timeout: 1500 }).toBeGreaterThan(before + 100);

      // At the opposite edge, the same gesture must return toward the header.
      await list.evaluate(el => { el.scrollTop = 0; });
      await pointAtList(page, viewport.height);
      const down = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, -300);
      await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 1500 }).toBeLessThan(down - 100);

      // Wheel over the outer workspace through the complete SPREQ-000063 or
      // captured Regular request, then refresh without losing the position.
      await page.mouse.move(viewport.width - 5, viewport.height / 2);
      await page.mouse.wheel(0, 1000000);
      await expect.poll(async () => { const m = await metrics(page); return m.max - m.top; }).toBeLessThanOrEqual(2);
      const bottom = await metrics(page);
      const box = await page.locator('.stock-request-detail').boundingBox();
      assert.ok(box && box.y + box.height >= 0 && box.y + box.height <= viewport.height, JSON.stringify(box));
      await page.locator('[data-special-sales-action=refresh], [data-special-scm-action=refresh], [data-sales-stock-action=refresh], [data-scm-stock-action=refresh]').first().evaluate(button => button.click());
      await page.waitForLoadState('networkidle');
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(bottom.top - 2);
      await page.screenshot({ path: `${out}/${audience}-${kind}-${viewport.width}-fixed-bottom.png` });
      await page.mouse.move(viewport.width - 5, viewport.height / 2);
      await page.mouse.wheel(0, -1000000);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(2);
      assert.deepEqual(await page.locator('.stock-request-detail input, .stock-request-detail select, .stock-request-detail textarea').evaluateAll(fields => fields.map(field => field.value)), fieldsBefore);
      assert.deepEqual(state.writes, []);
      assert.deepEqual(state.errors, []);
      await writeFile(`${out}/${audience}-${kind}-${viewport.width}-result.json`, JSON.stringify({ ref: detail.requestRef, initial, bottom, returned: await metrics(page), writes: state.writes, errors: state.errors }, null, 2));
    } finally { await context.close(); }
  });
}
