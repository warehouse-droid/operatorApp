import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'espree';
import fc from 'fast-check';

const filename = fileURLToPath(new URL('../../../public/dispatch.js', import.meta.url));
const source = readFileSync(filename, 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body;
const feed = [{ id: 'TOB01263', address: 'unplanned' }, { id: 'TOB01268', address: 'old' }];
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function subject() {
  const pending = [], merged = [], existing = new Map([['TOB01268', { ...feed[1] }]]);
  const ui = vm.createContext({ Map, Set, Promise, String, Array, AbortController, clearTimeout,
    dispatchGroupHydrationPromise: null, dispatchOrderRefreshEpoch: 0, dispatchOrderReadSequence: 0,
    dispatchOrderAppliedReads: new Map(), dispatchOrderReadRequests: new Map(),
    localPlanGeneration: 0, currentPlan: { id: '371' }, currentPlanDate: '2026-10-28', dispatchPlanLoadSequence: 0,
    orderSearchSequence: 1, searchText: 'TOB0126', orderSearchLoading: true, orderSearchError: '',
    orderSearchTimer: null, orderSearchAbortController: null, dispatchConfig: { plannerOrderPoolMode: 'on' },
    dispatchOrderSearchCache: new Map(), dispatchOrderPoolNextCursor: '', activeOrderType: 'SO',
    dispatchOrderPoolLoadPromise: null, dispatchOrderPoolLoadKey: '', dispatchOrderBrowseCursors: new Map(),
    dispatchOrderPoolLoaded: false, routeNotice: '',
    isDispatchHistoryEditMode: () => false, dispatchOrderRefKey: value => String(value).toUpperCase(),
    dispatchOrderFeedRequest: options => ({ url: JSON.stringify(options), headers: {} }),
    orderById: ref => existing.get(ref), refreshDispatchOrderRefs: async () => {},
    refreshOrderPoolForSearch: () => {}, applyDispatchOrderFeed: rows => merged.push(rows),
    mergeDispatchOrderSearchFeed: rows => { merged.push(rows); rows.forEach(row => existing.set(row.id, row)); },
    fetch: (url, options) => {
      const response = deferred(); pending.push({ url: JSON.parse(url), options, ...response }); return response.promise;
    }
  });
  for (const name of ['dispatchOrderPoolScope', 'dispatchOrderReadToken', 'dispatchOrderReadIsCurrent',
    'dispatchOrderFeedForRead', 'cancelDispatchOrderSearch', 'dispatchOrderSearchIsCurrent',
    'loadDispatchOrderSearch', 'loadDispatchOrders']) {
    const node = declarations.find(candidate => candidate.type === 'FunctionDeclaration' && candidate.id.name === name);
    // Baseline has no search-specific guard, but still runs its real old loader.
    if (!node && name === 'dispatchOrderSearchIsCurrent') continue;
    assert.ok(node, name);
    vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), ui, { filename });
  }
  const finish = (index = 0, rows = feed) => pending[index].resolve({ ok: true, json: async () => ({ orders: rows }) });
  return { ui, pending, merged, existing, finish };
}

test('TO search: existing queued read searches the active term instead of the browse tab', async () => {
  const { ui, pending, merged, finish } = subject();
  const first = ui.loadDispatchOrderSearch('TOB0126', 1);
  ui.dispatchOrderRefreshEpoch++;
  const second = ui.loadDispatchOrders();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].options.signal.aborted, true);
  assert.equal(pending[1].url.search, 'TOB0126');
  finish(0); await first;
  assert.equal(ui.orderSearchLoading, true, 'old completion cannot finish the replacement search');
  finish(1); assert.equal(await second, true);
  assert.equal(merged.length, 1);
  assert.deepEqual([...merged[0]].map(order => order.id), feed.map(order => order.id));
});

test('TO search: plan edits and targeted mutations preserve newer cards while discovering missing orders', async () => {
  for (const field of ['localPlanGeneration', 'dispatchOrderRefreshEpoch']) {
    const { ui, merged, existing, finish } = subject();
    const read = ui.loadDispatchOrderSearch('TOB0126', 1);
    ui[field]++;
    existing.get('TOB01268').address = 'new saved address';
    existing.get('TOB01268').assigned = true;
    finish(); assert.equal(await read, true);
    assert.deepEqual([...merged[0]].map(order => order.id), feed.map(order => order.id));
    assert.equal(existing.get('TOB01268').address, 'new saved address');
    assert.equal(existing.get('TOB01268').assigned, true);
  }
});

test('TO search: a newer detailed read wins even without a plan edit', async () => {
  const { ui, existing, finish } = subject();
  const read = ui.loadDispatchOrderSearch('TOB0126', 1);
  ui.dispatchOrderAppliedReads.set('TOB01268', 9);
  existing.set('TOB01268', { id: 'TOB01268', address: 'new detail' });
  finish(); await read;
  assert.equal(existing.get('TOB01268').address, 'new detail');
});

test('TO search: scope, date, plan and navigation changes reject late results', async () => {
  for (const change of [ui => { ui.currentPlan.id = '372'; }, ui => { ui.currentPlanDate = '2026-10-29'; },
    ui => { ui.dispatchPlanLoadSequence += 2; }, ui => { ui.isDispatchHistoryEditMode = () => true; },
    ui => { ui.searchText = 'SOM'; }]) {
    const { ui, merged, finish } = subject();
    const read = ui.loadDispatchOrderSearch('TOB0126', 1); change(ui); finish(); await read;
    assert.equal(merged.length, 0);
  }
});

test('TO search: superseded work waiting for group hydration never starts a request', async () => {
  const { ui, pending, finish } = subject(), hydration = deferred();
  ui.dispatchGroupHydrationPromise = hydration.promise;
  const read = ui.loadDispatchOrderSearch('TOB0126', 1);
  ui.orderSearchSequence++;
  hydration.resolve(); await new Promise(resolve => setImmediate(resolve));
  // The old implementation incorrectly starts this request. Resolve it so the
  // baseline fails the assertion instead of cancelling subsequent test cases.
  if (pending.length) finish();
  await read;
  assert.equal(pending.length, 0);
});

test('TO search: response waits for group hydration and rechecks navigation afterwards', async () => {
  for (const navigate of [false, true]) {
    const { ui, merged, finish } = subject(), hydration = deferred();
    const read = ui.loadDispatchOrderSearch('TOB0126', 1);
    ui.dispatchGroupHydrationPromise = hydration.promise;
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(merged.length, 0);
    if (navigate) ui.dispatchPlanLoadSequence++;
    else ui.dispatchOrderRefreshEpoch++;
    ui.dispatchGroupHydrationPromise = null; hydration.resolve(); await read;
    assert.equal(merged.length, navigate ? 0 : 1);
  }
});

test('TO search: superseding a read during detail verification cannot apply it', async () => {
  const { ui, existing, merged, finish } = subject(), hydration = deferred();
  existing.get('TOB01268').catalogHydrated = true;
  existing.get('TOB01268').catalogDetailSignature = 'old';
  ui.refreshDispatchOrderRefs = () => hydration.promise;
  const read = ui.loadDispatchOrderSearch('TOB0126', 1);
  finish(0, [{ ...feed[1], catalogHydrated: false, catalogDetailSignature: 'changed' }]);
  await new Promise(resolve => setImmediate(resolve));
  ui.orderSearchSequence++; hydration.resolve(); await read;
  assert.equal(merged.length, 0);
  assert.equal(ui.orderSearchLoading, true);
});

test('TO search: errors are visible, aborts are neutral, empty and legacy results complete', async () => {
  for (const kind of ['error', 'empty', 'abort', 'legacy', 'obsolete-error']) {
    const { ui, pending, finish } = subject();
    if (kind === 'legacy') ui.dispatchConfig.plannerOrderPoolMode = 'off';
    const read = ui.loadDispatchOrderSearch('TOB0126', 1);
    if (kind === 'error' || kind === 'obsolete-error') {
      if (kind === 'obsolete-error') ui.orderSearchSequence++;
      pending[0].resolve({ ok: false, text: async () => 'unavailable' });
    } else if (kind === 'abort') {
      pending[0].resolve({ ok: true, json: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
    } else if (kind === 'legacy') pending[0].resolve({ ok: true, json: async () => feed });
    else finish(0, []);
    assert.equal(await read, kind !== 'error');
    assert.equal(ui.orderSearchError, kind === 'error' ? 'unavailable' : '');
    assert.equal(ui.orderSearchLoading, kind === 'obsolete-error');
  }
});

test('TO search: single-character browse and explicit sync retain their original request paths', async () => {
  for (const options of [{}, { sync: true }, { append: true }]) {
    const { ui, pending, finish } = subject();
    if (!options.sync && !options.append) ui.searchText = 'T';
    const read = ui.loadDispatchOrders(options);
    assert.equal(pending[0].url.search, undefined);
    assert.equal(pending[0].url.type, 'SO');
    finish(); assert.equal(await read, true);
  }
});

test('TO search properties: unrelated update timing never loses discoveries or overwrites newer existing data', async () => {
  await fc.assert(fc.asyncProperty(fc.nat({ max: 8 }), fc.nat({ max: 8 }), fc.boolean(), async (edits, updates, navigate) => {
    const { ui, existing, merged, finish } = subject();
    const read = ui.loadDispatchOrderSearch('TOB0126', 1);
    ui.localPlanGeneration += edits; ui.dispatchOrderRefreshEpoch += updates;
    if (edits || updates) existing.get('TOB01268').address = 'newer';
    if (navigate) ui.dispatchPlanLoadSequence++;
    finish(); await read;
    assert.equal(merged.length, navigate ? 0 : 1);
    if (!navigate) {
      assert.ok(existing.has('TOB01263'));
      assert.equal(existing.get('TOB01268').address, edits || updates ? 'newer' : 'old');
    }
  }), { seed: 20261028, numRuns: 100 });
});
