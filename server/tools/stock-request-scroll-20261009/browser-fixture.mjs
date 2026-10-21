/* global localStorage, window, EventTarget, structuredClone, getComputedStyle */
import { readFile, mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';

export const out = 'test-artifacts/stock-request-scroll-20261009';
const live = process.env.SCROLL_TEST_MODE === 'live';
export const records = JSON.parse(await readFile(out + (live ? '/requests-after.json' : '/requests.json')));

export async function fixture(browser, { audience = 'scm', kind = 'special', width = 1440, height = 900, baseline = true, touch = false, fontOffset = 0 } = {}) {
  await mkdir(out, { recursive: true });
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', hasTouch: touch, isMobile: touch });
  await context.addInitScript(offset => {
    localStorage.setItem('mbbs.staff.token', 'test-request-scroll');
    localStorage.setItem('mbbs.special-stock.detail-font-offset.viewer', String(offset));
    window.scrollTestStreams = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 1; window.scrollTestStreams.push(this); }
      close() { this.closed = true; }
    };
  }, fontOffset);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const state = { errors: [], writes: [], acknowledgements: [], calls: [] };
  page.on('pageerror', error => state.errors.push(error.message));
  const detail = structuredClone(kind === 'special' ? records[audience === 'scm' ? 'special' : 'specialSales'] : records[audience === 'scm' ? 'regular' : 'regularSales']);
  const queue = structuredClone(records[kind === 'special' ? 'specialQueue' : 'regularQueue']);
  const index = queue.findIndex(row => row.id === detail.id);
  if (index >= 0) queue[index] = detail; else queue.unshift(detail);
  const prefix = `/api/${audience}/${kind === 'special' ? 'special-stock-requests' : 'stock-requests'}`;
  await page.route('**/*', async route => {
    const { pathname: path, hostname } = new URL(route.request().url());
    if (hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      state.calls.push(path);
      if (route.request().method() !== 'GET') {
        if (path.endsWith('/decisions/read')) {
          state.acknowledgements.push(path);
          return route.fulfill({ json: { ok: true } });
        }
        state.writes.push({ path, method: route.request().method() });
        return route.fulfill({ status: 409, json: { error: 'Read-only scrolling fixture.' } });
      }
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'viewer', display_name: 'TEST Viewer', role: audience, roles: [audience], yardLocationIds: [1, 28, detail.storeLocationId, detail.destinationLocationId].filter(Boolean) } } });
      if (path === '/api/navigation/menu-order') return route.fulfill({ json: { revision: 1, orders: {} } });
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true, revision: 1 } });
      if (path === prefix) return route.fulfill({ json: { requests: queue, yards: [], vendors: [], filterOptions: { vendors: [], sourceYards: [], destinationYards: [] } } });
      if (path === prefix + '/' + detail.id) return route.fulfill({ json: detail });
      const row = queue.find(value => path === prefix + '/' + value.id);
      if (row) return route.fulfill({ json: row });
      return route.fulfill({ json: { requests: [], yards: [], total: 0, count: 0, unread: 0, orders: [], salesReps: [] } });
    }
    const file = ({ '/sales/stock-requests': '/sales-stock-requests.html', '/scm/stock-requests': '/scm-stock-requests.html' })[path] || path;
    const overrides = ['/stock-requests.css', '/scm-stock-requests.html', '/sales-stock-requests.html', '/scm-stock-requests.js', '/sales-stock-requests.js', '/stock-request-view.js', '/special-stock-form-state.js'];
    const root = live ? out + '/live-public-after' : !baseline && overrides.includes(file) ? 'public' : out + '/live-public';
    try {
      return route.fulfill({ body: await readFile(root + file), contentType: ({ js: 'application/javascript', css: 'text/css', html: 'text/html' })[file.split('.').at(-1)] || 'application/octet-stream' });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=${kind}`);
  await page.locator('.stock-request-card').first().waitFor();
  if (!await page.locator('.stock-request-detail h2').allTextContents().then(values => values.includes(detail.requestRef))) {
    await page.locator(`.stock-request-card[data-id="${detail.id}"]`).evaluate(button => button.click());
  }
  await expect(page.locator('.stock-request-detail h2')).toHaveText(detail.requestRef);
  await page.waitForLoadState('networkidle');
  return { page, context, state, detail, queue };
}

export async function metrics(page) {
  return page.evaluate(() => ({
    top: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight,
    width: window.innerWidth, horizontal: document.documentElement.scrollWidth,
    nodes: ['html', 'body', 'main', '.stock-request-page', '.stock-request-workspace', '.stock-request-list', '.stock-request-detail'].map(selector => {
      const el = document.querySelector(selector), style = getComputedStyle(el), box = el.getBoundingClientRect();
      return { selector, top: box.top, height: box.height, scrollTop: el.scrollTop, clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight, overflowX: style.overflowX, overflowY: style.overflowY, position: style.position,
        overscroll: style.overscrollBehaviorY, rows: style.gridTemplateRows };
    })
  }));
}
