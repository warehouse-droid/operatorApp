import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(process.env.DISPATCH_OPEN_RECOVERY_SOURCE_PATH
  || new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
const start = source.indexOf('async function createPlanForDate(');
const end = source.indexOf('\nfunction resetPlanningBoard(', start);
assert.ok(start > 0 && end > start);

function subject(plan, overrides = {}) {
  const events = [];
  const context = vm.createContext({
    currentPlan: null, currentPlanDate: '2026-10-08', localPlanDirty: false, localPlanGeneration: 4,
    dispatchSessionId: 'test-session', planEditLeaseToken: 'test-lease',
    DISPATCH_PLAN_DATE_KEY: 'plan-date', trucks: [], orders: [],
    ensureDispatchPlanEditor: () => true, dispatchEditModeMessage: () => 'Read only',
    compactCurrentPlan: value => ({ id: value.id, planDate: value.planDate, revision: value.revision, digest: value.digest }),
    dispatchStorageSet: (...args) => events.push(['storage', ...args]),
    loadPlanHistory: async () => events.push(['history']),
    resetUndoHistory: () => events.push(['undo']),
    blockedPlanSaveFence: null, pendingPlanSaveAttempt: null,
    queueDispatchDraftJournal: () => events.push(['draft']),
    reportDispatchSaveError: () => {}, render: () => {}, routeNotice: '',
    fetch: async () => ({ ok: true, json: async () => structuredClone(plan) }),
    applyDispatchPlanSnapshotResult: snapshot => {
      const p = snapshot.plan;
      context.trucks = structuredClone(p.trucks);
      context.orders = structuredClone(p.assignedOrderSnapshots || p.orders);
      context.lastAcknowledgedPlanState = structuredClone(p);
      context.currentPlan = context.compactCurrentPlan(p);
      events.push(['snapshot']);
      return { loaded: true };
    },
    ...overrides
  });
  vm.runInContext(source.slice(0, start).replace(/[^\n]/g, ' ') + source.slice(start, end),
    context, { filename: 'public/dispatch.js' });
  return { context, events };
}
function savedPlan(overrides = {}) {
  return { id: 'plan', planDate: '2026-10-08', revision: 61, digest: 'saved-digest',
    orders: [{ id: 'ORDER-1', quantity: 4 }],
    trucks: [{ id: 'TRUCK-1', loads: [{ id: 'LOAD-1', stops: [{ id: 'STOP-1', orderId: 'ORDER-1' }] }] }],
    ...overrides };
}
function state(context) {
  return JSON.stringify({ plan: context.currentPlan, date: context.currentPlanDate,
    trucks: context.trucks, orders: context.orders, dirty: context.localPlanDirty });
}

test('OPEN-01: an existing plan is hydrated with its saved loads and acknowledgement baseline', async () => {
  const plan = savedPlan();
  const { context: s, events } = subject(plan);
  await s.createPlanForDate();
  assert.deepEqual(s.trucks, plan.trucks);
  assert.deepEqual(s.orders, plan.orders);
  assert.deepEqual(s.lastAcknowledgedPlanState.trucks, plan.trucks);
  assert.equal(s.currentPlan.revision, 61);
  assert.ok(events.some(event => event[0] === 'undo'));
});
test('OPEN-02: an existing plan never overwrites an unsaved local draft or adopts its fence', async () => {
  const { context: s } = subject(savedPlan(), { localPlanDirty: true, trucks: [{ id: 'DRAFT' }] });
  const before = state(s);
  await assert.rejects(s.createPlanForDate(), /saved plan already exists.*draft.*retained/i);
  assert.equal(state(s), before);
});
test('OPEN-03: a truly new empty plan retains the first local draft', async () => {
  const { context: s, events } = subject(savedPlan({ revision: 0, orders: [], trucks: [] }),
    { localPlanDirty: true, trucks: [{ id: 'DRAFT' }] });
  await s.createPlanForDate();
  assert.equal(s.trucks[0].id, 'DRAFT');
  assert.equal(s.currentPlan.revision, 0);
  assert.equal(s.localPlanDirty, true);
  assert.ok(!events.some(event => event[0] === 'snapshot'));
});
for (const [name, overrides] of [
  ['wrong date', { planDate: '2026-10-09' }], ['missing identity', { id: null }],
  ['malformed routes', { trucks: null }], ['missing orders', { orders: null }]
]) test(`OPEN-04: ${name} leaves the board and revision intact`, async () => {
  const { context: s } = subject(savedPlan(overrides));
  const before = state(s);
  await assert.rejects(s.createPlanForDate(), /valid.*plan|selected.*date/i);
  assert.equal(state(s), before);
});
for (const change of ['date', 'edit']) test(`OPEN-05: a ${change} during creation invalidates the response`, async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { context: s } = subject(savedPlan(), { fetch: async () => pending });
  const request = s.createPlanForDate();
  if (change === 'date') s.currentPlanDate = '2026-10-09';
  else { s.localPlanGeneration++; s.localPlanDirty = true; s.trucks = [{ id: 'NEW-EDIT' }]; }
  const before = state(s);
  resolve({ ok: true, json: async () => savedPlan() });
  await assert.rejects(request, /changed.*draft.*retained/i);
  assert.equal(state(s), before);
});
test('OPEN-06: an existing zero-load plan is hydrated, including its retained orders', async () => {
  const plan = savedPlan({ trucks: [] });
  const { context: s } = subject(plan);
  await s.createPlanForDate();
  assert.deepEqual(s.orders, plan.orders);
  assert.equal(s.lastAcknowledgedPlanState.revision, 61);
});
test('OPEN-07: HTTP failures preserve local state', async () => {
  const { context: s } = subject(savedPlan(), { fetch: async () => ({ ok: false, text: async () => 'Unavailable' }) });
  const before = state(s);
  await assert.rejects(s.createPlanForDate(), /Unavailable/);
  assert.equal(state(s), before);
});
test('OPEN-09: a first save cannot send a replacement when create returns an existing plan', async () => {
  const requests = [];
  const { context: s } = subject(savedPlan(), { localPlanDirty: true, trucks: [{ id: 'DRAFT' }],
    fetch: async (url, init) => {
      requests.push([url, init.method]);
      return { ok: true, json: async () => savedPlan() };
    } });
  const saveStart = source.indexOf('async function savePlanToServer(');
  const saveEnd = source.indexOf('\nfunction queueServerSave(', saveStart);
  vm.runInContext(source.slice(saveStart, saveEnd), s);
  const before = state(s);
  const result = await s.savePlanToServer({ planDate: s.currentPlanDate, trucks: s.trucks, orders: [] });
  assert.equal(result.failed, true);
  assert.match(result.error.message, /saved plan already exists/);
  assert.deepEqual(requests, [['/api/dispatch/plans', 'POST']]);
  assert.equal(state(s), before);
});
test('OPEN-10: revision-zero stored routes are still loaded; read-only users make no request', async () => {
  const plan = savedPlan({ revision: 0 });
  const { context: s } = subject(plan);
  await s.createPlanForDate();
  assert.deepEqual(s.trucks, plan.trucks);
  const denied = subject(plan, { ensureDispatchPlanEditor: () => false,
    fetch: async () => assert.fail('Read-only mode sent a request') }).context;
  await assert.rejects(denied.createPlanForDate(), /Read only/);
});
test('OPEN-08 property: saved route identities and order rows survive generated route shapes', async () => {
  for (let count = 0; count < 40; count++) {
    const plan = savedPlan({ revision: count + 1,
      orders: Array.from({ length: count }, (_, i) => ({ id: `ORDER-${i}`, quantity: i })),
      trucks: Array.from({ length: count % 7 }, (_, i) => ({ id: `TRUCK-${i}`,
        loads: Array.from({ length: count % 5 }, (_, j) => ({ id: `LOAD-${i}-${j}`, stops: [] })) })) });
    const { context: s } = subject(plan);
    await s.createPlanForDate();
    assert.deepEqual(s.trucks, plan.trucks);
    assert.deepEqual(s.orders, plan.orders);
    assert.equal(s.currentPlan.revision, plan.revision);
    const dirty = subject(plan, { localPlanDirty: true, trucks: [{ id: 'LOCAL' }] }).context;
    const before = state(dirty);
    await assert.rejects(dirty.createPlanForDate());
    assert.equal(state(dirty), before);
    const fresh = subject(savedPlan({ revision: 0, orders: [], trucks: [] }),
      { localPlanDirty: true, trucks: plan.trucks }).context;
    await fresh.createPlanForDate();
    assert.deepEqual(fresh.trucks, plan.trucks);
    assert.equal(fresh.currentPlan.revision, 0);
    const invalid = subject({ ...plan, planDate: '2026-10-09' }).context;
    const invalidBefore = state(invalid);
    await assert.rejects(invalid.createPlanForDate());
    assert.equal(state(invalid), invalidBefore);
    let release;
    const waiting = new Promise(done => { release = done; });
    const late = subject(plan, { fetch: async () => waiting }).context;
    const pending = late.createPlanForDate();
    if (count % 2) late.currentPlanDate = '2026-10-10';
    else late.localPlanGeneration++;
    const lateBefore = state(late);
    release({ ok: true, json: async () => plan });
    await assert.rejects(pending);
    assert.equal(state(late), lateBefore);
  }
});
