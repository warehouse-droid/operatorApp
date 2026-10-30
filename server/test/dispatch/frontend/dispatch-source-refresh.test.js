import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';

const source = readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', range: true }).body;
function subject(overrides = {}) {
  const base = { id: 'SO1', items: [{ quantity: 10 }], pallets: 2, notes: 'saved' };
  const context = vm.createContext({
    structuredClone, console, Date, Set, Map, Promise, URLSearchParams,
    SALES_PLANNING_HOST: false, dispatchSessionId: 'test-session', currentPlan: { id: '1', revision: 37, digest: 'base' }, currentPlanDate: '2026-10-23',
    orders: [{ ...base, notes: 'my draft' }], orderCatalog: [base], trucks: [{ id: 'T1', loads: [{ id: 'L1', stops: [{ id: 'second' }, { id: 'first' }] }] }],
    localPlanDirty: true, localPlanGeneration: 4, saveQueued: false, saveInFlight: true, confirmInFlight: false,
    pendingPlanSaveAttempt: null, pendingDispatchPlanAction: null, blockedPlanSaveFence: null, blockedRemotePlanUpdate: false,
    lastAcknowledgedPlanState: { id: '1', revision: 37, orders: [base], trucks: [] },
    minimumPlanRevisionToApply: { planId: '1', revision: 37 }, lastServerSavedAt: '', routeNotice: '',
    executedOrderReviews: [], executedOrderReviewPlanId: '1', executedOrderReviewLoadedAt: 0, executedOrderReviewError: '', executedOrderReviewExpanded: new Set(),
    rememberAssignedOrderEvidence: () => {}, queueDispatchDraftJournal: () => {}, renderDispatchNoticePatch: () => {},
    pendingOperatorAlertRefs: new Set(), pendingTargetedOrderRefreshRefs: new Set(),
    shouldUseDispatchIncrementalSave: () => false, stablePlanHashPayload: () => 'hash', shortHash: value => value,
    autosaveDebug: () => {}, reportDispatchSaveError: () => {}, persistDispatchPendingRequest: async () => {},
    ...overrides
  });
  for (const name of ['dispatchFrozenSaveFetch', 'savePlanToServer', 'dispatchSourceValueEqual', 'mergeDispatchSourceRefreshOrders', 'applyVerifiedDispatchSourceRefresh', 'applyDispatchSourceDecisionResult', 'loadExecutedOrderReviews', 'recoverDispatchSourceDraft', 'handleDispatchDraftRecovery']) {
    const node = declarations.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    if (node) {vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), context, { filename: 'public/dispatch.js' });}
  }
  return context;
}
const response = () => ({ orders: [{ id: 'SO1', items: [{ quantity: 5 }], pallets: 1, notes: 'saved' }], orderRefs: ['SO1'], reviews: [],
  sourceBaseline: { revision: 37, digest: 'base', orders: [{ id: 'SO1', items: [{ quantity: 10 }], pallets: 2, notes: 'saved' }] },
  plan: { id: '1', revision: 38, digest: 'next', savedAt: '2026-10-22T23:10:49Z', safeToAdvanceRevision: true } });

test('source acknowledgement during save completion advances the fence without replacing the draft route', async () => {
  const s = subject({ fetch: async () => ({ ok: true, json: async () => response() }) });
  const route = s.trucks;
  await s.loadExecutedOrderReviews({ force: true });
  assert.equal(s.currentPlan.revision, 38);
  assert.equal(s.currentPlan.digest, 'next');
  assert.equal(s.orders[0].items[0].quantity, 5);
  assert.equal(s.orders[0].notes, 'my draft');
  assert.equal(s.trucks, route);
  assert.equal(s.localPlanDirty, true);
  assert.equal(s.localPlanGeneration, 4);
  assert.equal(s.lastAcknowledgedPlanState.orders[0].items[0].quantity, 5);
});

test('overlapping local source edits preserve the entire draft and its original fence', async () => {
  const s = subject({ saveInFlight: false, orders: [{ id: 'SO1', items: [{ quantity: 7 }], pallets: 2 }],
    fetch: async () => ({ ok: true, json: async () => response() }) });
  const before = JSON.stringify(s.orders);
  await s.loadExecutedOrderReviews({ force: true });
  assert.equal(JSON.stringify(s.orders), before);
  assert.equal(s.currentPlan.revision, 37);
  assert.equal(s.currentPlan.digest, 'base');
});

test('late source responses cannot roll back a newer saved revision', async () => {
  const s = subject({ saveInFlight: false, currentPlan: { id: '1', revision: 39, digest: 'newer' },
    fetch: async () => ({ ok: true, json: async () => response() }) });
  const before = JSON.stringify(s.orders);
  await s.loadExecutedOrderReviews({ force: true });
  assert.equal(s.currentPlan.revision, 39);
  assert.equal(s.currentPlan.digest, 'newer');
  assert.equal(JSON.stringify(s.orders), before);
});

test('a definitive stale save queues one rebuilt retry only after source proof', async () => {
  const requests = [];
  const s = subject({ fetch: async (url, init) => {
    requests.push({ url, body: init?.body });
    return url.includes('executed-order-reviews') ? { ok: true, json: async () => response() }
      : { status: 409, json: async () => ({ code: 'STALE_DISPATCH_PLAN', conflictReason: 'revision' }) };
  } });
  const result = await s.savePlanToServer({ planId: '1', planDate: '2026-10-23', baseRevision: 37, baseDigest: 'base', orders: s.orders, trucks: s.trucks });
  assert.equal(result.staleRetryQueued, true, JSON.stringify(result, (_key, value) => value instanceof Error ? value.message : value));
  assert.equal(s.saveQueued, true);
  assert.equal(s.currentPlan.revision, 38);
  assert.equal(s.pendingPlanSaveAttempt, null);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /baseDigest=base/);
  const again = await s.savePlanToServer({ planId: '1', planDate: '2026-10-23', baseRevision: 38, baseDigest: 'next' }, { retryOnStale: false });
  assert.equal(again.fenceConflict, true);
  assert.equal(s.saveQueued, false);
  assert.equal(requests.length, 3, 'the second conflict never starts an unbounded recovery loop');
});

test('uncertain requests and plan actions cannot have their fence changed by a source read', async () => {
  for (const pending of [{ pendingPlanSaveAttempt: { request: { body: 'frozen' } } }, { pendingDispatchPlanAction: { kind: 'confirm' } }, { confirmInFlight: true }]) {
    const s = subject({ ...pending, fetch: async () => ({ ok: true, json: async () => response() }) });
    const before = JSON.stringify(s.orders);
    await s.loadExecutedOrderReviews({ force: true });
    assert.equal(s.currentPlan.revision, 37);
    assert.equal(JSON.stringify(s.orders), before);
  }
});

test('navigation during the source read cannot patch a different plan', async () => {
  const s = subject({ fetch: async () => {
    s.currentPlan = { id: '2', revision: 37, digest: 'base' };
    return { ok: true, json: async () => response() };
  } });
  const before = JSON.stringify(s.orders);
  await s.loadExecutedOrderReviews({ force: true });
  assert.equal(s.currentPlan.id, '2');
  assert.equal(s.currentPlan.revision, 37);
  assert.equal(JSON.stringify(s.orders), before);
});

test('a journal from the old conflicted browser restores safely after a source-only revision', async () => {
  const draft = { planId: '1', planDate: '2026-10-23', orders: [{ id: 'SO1', items: [{ quantity: 10 }], pallets: 2, notes: 'my saved draft' }], trucks: [{ id: 'T1', loads: [] }] };
  let applied;
  const s = subject({ currentPlan: { id: '1', revision: 38, digest: 'next' }, localPlanDirty: false, saveInFlight: false,
    dispatchRecoveredDraft: { version: 1, planId: '1', planDate: '2026-10-23', generation: 5,
      baseline: { revision: 37, digest: 'base' }, pendingPayload: draft },
    dispatchDraftStorage: async () => ({ journal: {}, key: 'draft' }), ensureDispatchPlanEditor: () => true,
    planEditLeaseToken: 'current-lease', isApplyingRemotePlan: false,
    applySavedPlan: plan => { applied = plan; }, resetUndoHistory: () => {}, queueServerSave: () => {}, render: () => {},
    fetch: async () => ({ ok: true, json: async () => response() }) });
  await s.handleDispatchDraftRecovery('recover-dispatch-draft');
  assert.equal(applied.orders[0].items[0].quantity, 5);
  assert.equal(applied.orders[0].notes, 'my saved draft');
  assert.deepEqual(applied.trucks, draft.trucks);
  assert.equal(s.currentPlan.revision, 38);
  assert.equal(s.localPlanDirty, true);
  assert.equal(s.pendingPlanSaveAttempt, null);
});

test('proven refresh clears only the recovered block and journals the updated baseline', async () => {
  let writes = 0;
  const s = subject({ blockedPlanSaveFence: { planId: '1', message: 'stale' }, blockedRemotePlanUpdate: true,
    routeNotice: 'Remote update available', queueDispatchDraftJournal: () => { writes++; },
    orderCatalog: [{ id: 'SO1', items: [{ quantity: 99 }] }],
    fetch: async () => ({ ok: true, json: async () => response() }) });
  assert.equal(await s.loadExecutedOrderReviews({ force: true }), true);
  assert.equal(s.blockedPlanSaveFence, null);
  assert.equal(s.blockedRemotePlanUpdate, false);
  assert.equal(s.routeNotice, '');
  assert.equal(s.minimumPlanRevisionToApply.revision, 38);
  assert.equal(s.orderCatalog[0].items[0].quantity, 99, 'a newer catalog edit remains intact');
  assert.equal(writes, 1);
});

test('journal recovery fails closed for missing proof, overlapping edits, read failures and navigation', async () => {
  const record = { planId: '1', planDate: '2026-10-23', baseline: { revision: 37, digest: 'base' },
    pendingPayload: { orders: [{ id: 'SO1', items: [{ quantity: 7 }], pallets: 2 }], trucks: [] } };
  for (const mode of ['conflict', 'no-proof', 'http-failure', 'navigation', 'pending']) {
    const s = subject({ currentPlan: { id: '1', revision: 38, digest: 'next' }, localPlanDirty: false,
      fetch: async () => {
        if (mode === 'navigation') {s.currentPlan = { id: '2', revision: 38, digest: 'next' };}
        return { ok: mode !== 'http-failure', json: async () => mode === 'no-proof' ? {} : response() };
      } });
    const original = JSON.stringify(record);
    assert.equal(await s.recoverDispatchSourceDraft({ ...record, ...(mode === 'pending' ? { inFlight: { request: 'frozen' } } : {}) }), null);
    assert.equal(JSON.stringify(record), original);
  }
});
