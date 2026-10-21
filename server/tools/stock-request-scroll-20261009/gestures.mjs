/* global window, document, MutationObserver, performance, requestAnimationFrame */
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fixture, out, metrics } from './browser-fixture.mjs';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [];
try {
  for (const baseline of [true, false]) for (const audience of ['scm', 'sales']) for (const kind of ['special', 'regular']) for (const touch of [false, true]) {
    const viewport = touch ? { width: 390, height: 800 } : { width: 1440, height: 900 };
    const { page, context, state, detail } = await fixture(browser, { audience, kind, baseline, touch, ...viewport });
    try {
      await page.evaluate(() => {
        window.scrollTrace = { frames: [], calls: [], changes: [], mutations: 0, recording: false };
        const native = window.scrollTo.bind(window);
        window.scrollTo = (...args) => { window.scrollTrace.calls.push({ time: performance.now(), args }); return native(...args); };
        new MutationObserver(records => { window.scrollTrace.mutations += records.length; }).observe(document.querySelector('main'), { subtree: true, childList: true });
        for (const type of ['input', 'change']) document.addEventListener(type, event => window.scrollTrace.changes.push({ type, name: event.target.name, value: event.target.value }));
        const frame = () => {
          if (window.scrollTrace.recording) window.scrollTrace.frames.push({ time: performance.now(), top: window.scrollY,
            max: document.documentElement.scrollHeight - window.innerHeight, list: document.querySelector('.stock-request-list')?.scrollTop });
          requestAnimationFrame(frame);
        };
        frame();
      });
      const session = touch ? await context.newCDPSession(page) : null;
      const result = { baseline, audience, kind, touch, ref: detail.requestRef, journeys: [] };
      for (const area of ['detail', 'list']) {
        await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.stock-request-list').scrollTop = 0; });
        // On a phone the long queue is stacked above the detail. Begin the detail journey there.
        if (touch && area === 'detail') await page.locator('.stock-request-detail h2').scrollIntoViewIfNeeded();
        const box = await page.locator('.stock-request-' + area).boundingBox();
        const x = box.x + box.width / 2, y = Math.max(120, Math.min(viewport.height - 80, box.y + 150));
        await page.mouse.move(x, y);
        const start = await metrics(page);
        await page.evaluate(() => { window.scrollTrace.frames = []; window.scrollTrace.calls = []; window.scrollTrace.changes = []; window.scrollTrace.mutations = 0; window.scrollTrace.recording = true; });
        for (let step = 0; step < 18; step++) {
          if (touch) await session.send('Input.synthesizeScrollGesture', { x, y, yDistance: -400, speed: 1600, gestureSourceType: 'touch' });
          else { await page.mouse.wheel(0, 320); await page.waitForTimeout(60); }
        }
        await page.waitForTimeout(200);
        const trace = await page.evaluate(() => { window.scrollTrace.recording = false; return window.scrollTrace; });
        const reversals = trace.frames.filter((frame, i) => i && frame.top < trace.frames[i - 1].top - 2);
        result.journeys.push({ area, start, end: await metrics(page), reversals, trace });
      }
      assertReadOnly(state);
      results.push(result);
      console.log(JSON.stringify({ baseline, audience, kind, touch,
        journeys: result.journeys.map(journey => ({ area: journey.area, start: journey.start.top, end: journey.end.top,
          max: journey.end.max, reversals: journey.reversals.length, calls: journey.trace.calls.length, changes: journey.trace.changes.length, mutations: journey.trace.mutations })), errors: state.errors }));
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(out + '/gestures.json', JSON.stringify(results, null, 2));
}
function assertReadOnly(state) {
  if (state.writes.length || state.errors.length) throw Error(JSON.stringify(state));
}
