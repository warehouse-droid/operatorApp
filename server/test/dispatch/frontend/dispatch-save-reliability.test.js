import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';

const source = readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body;
function subject(names, overrides = {}) {
  const context = vm.createContext({
    console, setTimeout, clearTimeout, Promise, Date, Map, Set,
    currentPlan: { id: '1', planDate: '2027-05-01', revision: 4, digest: 'acknowledged' }, currentPlanDate: '2027-05-01',
    dispatchConfig: { plannerCommandMode: 'off' }, dispatchSessionId: 'session', planEditLeaseToken: 'test-lease',
    localPlanDirty: true, localPlanGeneration: 2, lastAcknowledgedPlanState: {},
    saveQueued: false, saveInFlight: false, routeNotice: '', confirmInFlight: false, blockedRemotePlanUpdate: false,
    pendingPlanSaveAttempt: null, blockedPlanSaveFence: null,
    dispatchPlanActionPromise: null, pendingDispatchPlanAction: null,
    queueDispatchDraftJournal: () => {},
    persistDispatchPendingRequest: async () => {},
    pendingOperatorAlertRefs: new Set(), pendingTargetedOrderRefreshRefs: new Set(),
    ensureDispatchPlanEditor: () => true, hasDispatchEditLeaseCredentials: () => true,
    render: () => {}, reportDispatchSaveError: () => {}, autosaveDebug: () => {}, shortHash: value => value,
    clearStoredDispatchEditLease: () => {}, leaveDispatchEditMode: () => {}, isDispatchHistoryEditMode: () => false,
    dispatchLeaseRequestPayload: () => ({}), dispatchPlannerSnapshotState: 'ready',
    shouldUseDispatchIncrementalSave: () => false, stablePlanHashPayload: () => 'hash', planSummary: () => ({}),
    ...overrides
  });
  for (const name of [...['dispatchFrozenSaveFetch'].filter(name => declarations.some(n => n.id?.name === name)), ...names]) {
    const node = declarations.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    assert.ok(node, `missing implementation: ${name}`);
    // Preserve character offsets as well as line numbers for precise V8 ranges.
    const prefix = source.slice(0, node.range[0]).replace(/[^\n]/g, ' ');
    vm.runInContext(prefix + source.slice(...node.range), context, { filename: 'public/dispatch.js' });
  }
  return context;
}

test('SAVE-UI-01: Save Now retains the revision fence with compact commands disabled', async () => {
  let options;
  const s = subject(['forceSaveCurrentPlan'], { saveCurrentPlanNow: async value => { options = value; return { saved: true }; } });
  await s.forceSaveCurrentPlan();
  assert.notEqual(options?.forceSave, true);
});

test('SAVE-UI-02: Exit Edit waits for the latest acknowledgement in every command mode', async () => {
  let finish, releases = 0;
  const saved = new Promise(resolve => { finish = resolve; });
  const s = subject(['releaseDispatchEditMode'], {
    saveCurrentPlanNow: () => saved,
    fetch: async () => { releases++; return { ok: true }; }
  });
  const leaving = s.releaseDispatchEditMode();
  await Promise.resolve();
  assert.equal(releases, 0);
  finish({ saved: true });
  await leaving;
  assert.equal(releases, 1);
});

test('SAVE-UI-03: rejection never adopts only the remote revision or blindly retries', async () => {
  const s = subject(['savePlanToServer'], {
    fetch: async () => ({ status: 409, json: async () => ({ code: 'STALE_DISPATCH_PLAN', conflictReason: 'persisted_content', currentRevision: 9, currentDigest: 'remote' }) })
  });
  const result = await s.savePlanToServer({ planId: '1', planDate: '2027-05-01', baseRevision: 4, baseDigest: 'acknowledged' });
  assert.equal(s.currentPlan.revision, 4);
  assert.equal(s.currentPlan.digest, 'acknowledged');
  assert.equal(result.blocked, true);
  assert.equal(s.saveQueued, false);
  assert.doesNotMatch(s.routeNotice, /another screen/);
});

test('SAVE-UI-04: a request freezes its digest and lease with the payload', async () => {
  let sent;
  const s = subject(['dispatchIncrementalSaveRequest'], { fetch: async (url, init) => { sent = { url, ...init, body: JSON.parse(init.body) }; return { ok: true }; } });
  await s.dispatchIncrementalSaveRequest('1', { planDate: '2027-05-01', baseRevision: 3, baseDigest: 'frozen', editLeaseToken: 'test-frozen-lease' }, {});
  assert.equal(sent.body.baseDigest, 'frozen');
  assert.equal(sent.headers['x-dispatch-edit-lease'], 'test-frozen-lease');
});

test('SAVE-UI-05: an uncertain retry sends the identical body while newer edits remain pending', async () => {
  const bodies = [];
  const s = subject(['savePlanToServer'], {
    fetch: async (url, init) => { bodies.push(init.body); throw new Error('response lost'); }
  });
  const payload = { planId: '1', planDate: '2027-05-01', baseRevision: 4, baseDigest: 'acknowledged', orders: [{ id: 'SO1', quantity: 0 }] };
  assert.equal((await s.savePlanToServer(payload)).failed, true);
  s.localPlanGeneration++;
  assert.equal((await s.savePlanToServer({ ...payload, orders: [{ id: 'SO1', quantity: 12 }] })).failed, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0]);
  assert.equal(s.localPlanDirty, true);
});

test('SAVE-UI-06: the same rejected fingerprint cannot be resubmitted by another save trigger', async () => {
  let requests = 0;
  const s = subject(['savePlanToServer'], { fetch: async () => {
    requests++;
    return { status: 409, json: async () => ({ code: 'STALE_DISPATCH_PLAN', conflictReason: 'persisted_content' }) };
  } });
  const payload = { planId: '1', planDate: '2027-05-01', baseRevision: 4, baseDigest: 'acknowledged' };
  assert.equal((await s.savePlanToServer(payload)).blocked, true);
  assert.equal((await s.savePlanToServer(payload)).blocked, true);
  assert.equal(requests, 1);
});

test('SAVE-UI-07: draft journaling defers storage work and stores only the compact pending plan', async () => {
  const scheduled = [], writes = [];
  const payload = { planId: '1', planDate: '2027-05-01', orders: [{ id: 'SO-S2', raw: { zero: 0 } }], trucks: [] };
  const s = subject(['queueDispatchDraftJournal'], {
    setTimeout: fn => { scheduled.push(fn); return 1; }, clearTimeout: () => {}, window: {},
    dispatchDraftJournalTimer: null, dispatchRecoveredDraft: null, dispatchDraftBackupError: '',
    dispatchDraftStorage: async () => ({ key: 'own:date', journal: { write: async (key, value) => { writes.push({ key, value }); } } }),
    planPayload: () => payload, renderDispatchNoticePatch: () => {},
    orderCatalog: [{ id: 'UNASSIGNED-CATALOG-MUST-NOT-BE-STORED' }]
  });
  s.queueDispatchDraftJournal(payload);
  assert.equal(writes.length, 0, 'storage is outside the caller/event frame');
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.equal(writes.length, 1);
  assert.equal(JSON.stringify(writes[0]).includes('UNASSIGNED-CATALOG'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].value.pendingPayload)), payload);
});

test('SAVE-UI-08: confirmation and dependency actions wait for the preceding plan action', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const s = subject(['serializeDispatchPlanAction'], { dispatchPlanActionPromise: null });
  const first = s.serializeDispatchPlanAction(async () => { calls.push('confirm'); await gate; calls.push('confirmed'); return 1; });
  const second = s.serializeDispatchPlanAction(async () => { calls.push('dependency'); return 2; });
  await Promise.resolve();
  assert.deepEqual(calls, ['confirm']);
  finish();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(calls, ['confirm', 'confirmed', 'dependency']);
});

test('SAVE-UI-09: a lost lifecycle acknowledgement recovers its exact request after reload', async () => {
  const action = { kind: 'confirm', planId: '1', planDate: '2027-05-01', payload: { editLeaseToken: 'test-lease' }, generation: 2,
    request: { url: '/confirm', init: { body: '{"commandId":"original"}' } } };
  const record = { version: 1, planId: '1', planDate: '2027-05-01', generation: 2,
    baseline: { revision: 3, digest: 'before-confirm', state: {} }, action, pendingPayload: { orders: [], trucks: [] } };
  const s = subject(['handleDispatchDraftRecovery'], {
    dispatchRecoveredDraft: record, localPlanDirty: false, isApplyingRemotePlan: false,
    dispatchDraftStorage: async () => ({ journal: {}, key: 'key' }),
    applySavedPlan: () => {}, resetUndoHistory: () => {}, queueServerSave: () => {},
    retryPendingDispatchPlanAction: async () => {},
  });
  await s.handleDispatchDraftRecovery('recover-dispatch-draft');
  assert.equal(s.pendingDispatchPlanAction.request.init.body, action.request.init.body);
  assert.equal(s.localPlanDirty, true);
});

test('SAVE-UI-10: confirm retries never change request identity after newer edits', async () => {
  const bodies = [];
  const s = subject(['dispatchPlanActionRequest'], { fetch: async (url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) throw new Error('lost acknowledgement');
    return { ok: true, json: async () => ({ id: '1', revision: 5 }) };
  } });
  await assert.rejects(s.dispatchPlanActionRequest('confirm', '/confirm', { commandId: 'original', baseRevision: 4 }), /lost acknowledgement/);
  s.localPlanGeneration++;
  const ack = await s.dispatchPlanActionRequest('confirm', '/confirm', { commandId: 'new', baseRevision: 5 });
  assert.equal(bodies[1], bodies[0]);
  assert.equal(ack.generation, 2);
  assert.equal(s.pendingDispatchPlanAction, null);
});

test('SAVE-UI-11: the immutable request reaches durable backup before it can commit remotely', async () => {
  let finish, requests = 0;
  const durable = new Promise(resolve => { finish = resolve; });
  const s = subject([], { persistDispatchPendingRequest: () => durable,
    fetch: async () => { requests++; return { ok: true }; } });
  const saving = s.dispatchFrozenSaveFetch('/save', { body: 'immutable' }, { payload: {}, saveGeneration: 2 });
  await Promise.resolve();
  assert.equal(requests, 0, 'a fast server cannot commit before the retry identity is journaled');
  finish();
  await saving;
  assert.equal(requests, 1);
});

test('SAVE-UI-12: dependency preflight rejects either changed fence without adopting it', async () => {
  for (const remote of [{ id: '2', revision: 4, digest: 'acknowledged' },
    { id: '1', revision: 5, digest: 'acknowledged' }, { id: '1', revision: 4, digest: 'different' }]) {
    const s = subject(['refreshDispatchDependencyPlanFence'], {
      fetch: async () => ({ ok: true, json: async () => remote })
    });
    await assert.rejects(s.refreshDispatchDependencyPlanFence(), /changed/);
    assert.equal(s.currentPlan.revision, 4);
    assert.equal(s.currentPlan.digest, 'acknowledged');
  }
  const s = subject(['refreshDispatchDependencyPlanFence'], {
    fetch: async () => ({ ok: true, json: async () => ({ id: '1', revision: 4, digest: 'acknowledged' }) })
  });
  await s.refreshDispatchDependencyPlanFence();
  assert.equal(s.minimumPlanRevisionToApply.revision, 4);
});

test('SAVE-UI-13: dependency acknowledgement for an old generation advances its fence without replacing newer edits', () => {
  let applied = 0;
  const s = subject(['applyAtomicDependencyMutationPayload'], {
    dispatchPlanWireState: value => value, compactCurrentPlan: value => value,
    applySavedPlan: () => { applied++; }
  });
  const plan = { id: '1', planDate: '2027-05-01', revision: 5, digest: 'next' };
  assert.equal(s.applyAtomicDependencyMutationPayload({ plan }, { planId: '1', planDate: '2027-05-01', generation: 1 }), true);
  assert.equal(applied, 0);
  assert.equal(s.currentPlan.digest, 'next');
  assert.equal(s.localPlanDirty, true);
  assert.equal(s.saveQueued, true);
  assert.equal(s.applyAtomicDependencyMutationPayload({ plan: { ...plan, revision: 9 } }, { planId: 'other', planDate: '2027-05-01' }), false);
  assert.equal(s.currentPlan.revision, 5);
});

test('SAVE-UI-14: dependency saves precede validation and uncertain retries retain their original mutation', async () => {
  const calls = [], requests = [];
  const s = subject(['performDispatchDependencyMutation'], {
    saveCurrentPlanNow: async () => calls.push('save'),
    refreshDispatchDependencyPlanFence: async () => calls.push('validate'),
    dispatchLeaseRequestPayload: value => value, newDependencyRequestId: () => 'test-request',
    dispatchPlanActionRequest: async (...args) => { requests.push(args); return { result: { pending: true } }; },
    applyAtomicDependencyMutationPayload: () => false, queueServerSave: () => calls.push('queued')
  });
  const first = await s.performDispatchDependencyMutation({ url: '/dependency', payload: () => ({ quantity: 0.125 }) });
  assert.deepEqual(calls, ['save', 'validate', 'queued']);
  assert.equal(first.applied, false);
  assert.equal(requests[0][2].quantity, 0.125);
  s.pendingDispatchPlanAction = { kind: 'dependency', payload: { requestId: 'original', quantity: 0 } };
  calls.length = 0;
  await s.performDispatchDependencyMutation({ url: '/dependency', payload: { quantity: 5 } });
  assert.deepEqual(calls, ['queued']);
  assert.equal(requests[1][2].quantity, 0);
  assert.equal(requests[1][2].requestId, 'original');
  assert.equal(s.confirmInFlight, false);
});

test('SAVE-UI-15: a definitive lifecycle conflict is blocked and cannot leave an uncertain request to retry', async () => {
  const s = subject(['dispatchPlanActionRequest'], {
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ code: 'STALE_DISPATCH_PLAN', error: 'Review saved plan' }) })
  });
  await assert.rejects(s.dispatchPlanActionRequest('confirm', '/confirm', { commandId: 'test-confirm' }), /Review saved plan/);
  assert.equal(s.pendingDispatchPlanAction, null);
  assert.equal(s.blockedPlanSaveFence.planId, '1');
});

test('SAVE-UI-16: failed local storage is visible while retaining the immutable retry request', async () => {
  let rendered = 0;
  const attempt = { request: { body: 'original' } };
  const s = subject(['persistDispatchPendingRequest'], {
    pendingPlanSaveAttempt: attempt,
    dispatchDraftStorage: async () => { throw new Error('quota exceeded'); },
    renderDispatchNoticePatch: () => { rendered++; }
  });
  await s.persistDispatchPendingRequest({ orders: [] });
  assert.match(s.dispatchDraftBackupError, /quota exceeded/);
  assert.equal(s.pendingPlanSaveAttempt.request.body, 'original');
  assert.equal(rendered, 1);
});

test('SAVE-UI-17: recovery never replaces a different saved revision without an exact owned retry', async () => {
  let applied = 0;
  const s = subject(['handleDispatchDraftRecovery'], {
    dispatchRecoveredDraft: { planId: '1', planDate: '2027-05-01', baseline: { revision: 3, digest: 'old' }, pendingPayload: {} },
    localPlanDirty: false, dispatchDraftStorage: async () => ({ journal: {}, key: 'test-key' }),
    applySavedPlan: () => { applied++; }
  });
  await assert.rejects(s.handleDispatchDraftRecovery('recover-dispatch-draft'), /saved plan has changed/);
  assert.equal(applied, 0);
  assert.ok(s.dispatchRecoveredDraft);
  s.localPlanDirty = true;
  await assert.rejects(s.handleDispatchDraftRecovery('recover-dispatch-draft'), /current draft/);
  assert.equal(applied, 0);
});

test('SAVE-UI-18: draft export excludes lease credentials and discard removes only the selected record', async () => {
  let blob, removed, clicked = false;
  const record = { planDate: '2027-05-01', pendingPayload: { editLeaseToken: 'test-private-lease', orders: [{ quantity: 0.125 }] } };
  const s = subject(['handleDispatchDraftRecovery'], {
    dispatchRecoveredDraft: record, Blob,
    URL: { createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL: () => {} },
    document: { createElement: () => ({ click: () => { clicked = true; } }) },
    setTimeout: () => {}, renderDispatchNoticePatch: () => {},
    dispatchDraftStorage: async () => ({ journal: { remove: async key => { removed = key; } }, key: 'test-owner:date' })
  });
  await s.handleDispatchDraftRecovery('download-dispatch-draft');
  assert.equal(clicked, true);
  assert.deepEqual(JSON.parse(await blob.text()), { orders: [{ quantity: 0.125 }] });
  await s.handleDispatchDraftRecovery('discard-dispatch-draft');
  assert.equal(removed, 'test-owner:date');
  assert.equal(s.dispatchRecoveredDraft, null);
});

test('SAVE-UI-19: pending actions retry the matching serialized operation only', async () => {
  const calls = [];
  const s = subject(['retryPendingDispatchPlanAction'], {
    confirmCurrentPlanAtomic: async () => calls.push('confirm'),
    reopenCurrentDispatchPlan: async () => calls.push('reopen'),
    runAtomicDispatchDependencyMutation: async options => calls.push(options)
  });
  for (const kind of ['confirm', 'reopen', 'dependency']) {
    s.pendingDispatchPlanAction = { kind, url: '/dependency', payload: { quantity: 0 }, request: { init: { method: 'DELETE' } } };
    await s.retryPendingDispatchPlanAction();
  }
  assert.equal(calls[0], 'confirm');
  assert.equal(calls[1], 'reopen');
  assert.equal(calls[2].method, 'DELETE');
  assert.equal(calls[2].payload.quantity, 0);
});

test('SAVE-UI-20: reopen flushes edits before the request and clears its busy state after acknowledgement', async () => {
  const calls = [];
  const s = subject(['reopenCurrentDispatchPlan', 'serializeDispatchPlanAction'], {
    saveCurrentPlanNow: async () => calls.push('saved'),
    dispatchLeaseRequestPayload: value => value,
    dispatchPlanActionRequest: async (kind, url, body) => { calls.push(kind); assert.equal(body.baseDigest, 'acknowledged'); return { result: { revision: 5 } }; },
    applyAtomicDependencyMutationPayload: () => calls.push('applied'),
    loadPlanHistory: async () => calls.push('history'), queueServerSave: () => calls.push('queued')
  });
  assert.equal((await s.reopenCurrentDispatchPlan()).revision, 5);
  assert.deepEqual(calls, ['saved', 'reopen', 'applied', 'history', 'queued']);
  assert.equal(s.confirmInFlight, false);
});

test('SAVE-UI-21: pending lifecycle operations block different actions and newer saves', async () => {
  let requests = 0;
  const s = subject(['dispatchPlanActionRequest', 'saveCurrentPlanNow'], {
    saveTimer: null, pendingDispatchPlanAction: { kind: 'confirm', url: '/confirm', request: { body: 'original' } },
    fetch: async () => { requests++; }
  });
  await assert.rejects(s.dispatchPlanActionRequest('reopen', '/reopen', {}), /pending plan action/);
  await assert.rejects(s.saveCurrentPlanNow(), /pending plan action/);
  assert.equal(requests, 0);
  assert.equal(s.pendingDispatchPlanAction.request.body, 'original');
  assert.equal(s.localPlanDirty, true);
});

test('SAVE-UI-22: the first save of a new date uses the created plan revision and digest together', async () => {
  let sent;
  const s = subject(['savePlanToServer'], {
    createPlanForDate: async date => ({ id: 'new-plan', planDate: date, revision: 0, digest: 'created-fence' }),
    fetch: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; throw new Error('response lost'); }
  });
  assert.equal((await s.savePlanToServer({ planDate: '2027-05-02', orders: [], trucks: [] })).failed, true);
  assert.equal(sent.url, '/api/dispatch/plans/new-plan');
  assert.equal(sent.body.baseRevision, 0);
  assert.equal(sent.body.baseDigest, 'created-fence');
  assert.equal(s.pendingPlanSaveAttempt.payload.planId, 'new-plan');
});

test('SAVE-UI-23: definitive HTTP failures and recovery-only backups never become successful saves', async () => {
  for (const status of [422, 503]) {
    const s = subject(['savePlanToServer'], {
      fetch: async () => ({ ok: false, status, text: async () => 'Save could not be applied' })
    });
    const result = await s.savePlanToServer({ planId: '1', baseRevision: 4, baseDigest: 'acknowledged' });
    assert.equal(result.failed, true);
    assert.equal(Boolean(s.pendingPlanSaveAttempt), status >= 500);
    assert.equal(s.localPlanDirty, true);
    assert.equal(s.currentPlan.revision, 4);
  }
  const s = subject(['savePlanToServer'], { fetch: async () => ({ ok: true, status: 200,
    json: async () => ({ applied: false, recoveryDraft: { id: 'backup' }, validationIssues: [{ message: 'Driver assignment required' }] }) }) });
  const result = await s.savePlanToServer({ planId: '1', baseRevision: 4, baseDigest: 'acknowledged' });
  assert.equal(result.recoverySaved, true);
  assert.equal(result.blocked, true);
  assert.equal(s.pendingPlanSaveAttempt, null);
  assert.equal(s.currentPlan.revision, 4);
  assert.equal(s.localPlanDirty, true);
  assert.match(s.routeNotice, /not applied.*Driver assignment/);
});

test('SAVE-UI-24: idle draft writes and deferred recovery expose storage errors without blocking edits', async () => {
  for (const name of ['queueDispatchDraftJournal', 'scheduleDispatchDraftRecovery']) {
    const scheduled = [];
    const s = subject([name], {
      setTimeout: fn => { scheduled.push(fn); }, clearTimeout: () => {}, window: {},
      dispatchDraftJournalTimer: null, dispatchRecoveredDraft: null, dispatchDraftBackupError: '',
      dispatchDraftStorage: async () => { throw new Error('storage disabled'); }, renderDispatchNoticePatch: () => {}
    });
    s[name]({ orders: [], trucks: [] });
    assert.equal(s.dispatchDraftBackupError, '');
    await scheduled[0]();
    assert.match(s.dispatchDraftBackupError, /storage disabled.*Server saving is still available/);
    assert.equal(s.localPlanDirty, true);
    assert.equal(s.currentPlan.revision, 4);
  }
});

test('SAVE-UI-25: loading another saved plan waits for the current edit lease to be released', async () => {
  let finish, reads = 0;
  const released = new Promise(resolve => { finish = resolve; });
  const s = subject(['loadPlanById'], {
    isDispatchPlanEditor: () => true, releaseDispatchEditMode: () => released,
    fetch: async () => { reads++; return { ok: false, text: async () => 'Plan unavailable' }; }
  });
  const loading = s.loadPlanById('another');
  await Promise.resolve();
  assert.equal(reads, 0);
  finish();
  await assert.rejects(loading, /Plan unavailable/);
  assert.equal(reads, 1);
  assert.equal(s.currentPlan.id, '1');
});


test('SAVE-UI-26: delayed confirmation acknowledges only its generation and preserves newer edits', async () => {
  let applied = 0, queued = 0;
  const next = { id: '1', planDate: '2027-05-01', revision: 5, digest: 'confirmed' };
  const s = subject(['performDispatchPlanConfirmation'], {
    saveTimer: null, pendingDispatchPlanAction: { kind: 'confirm', generation: 1, payload: {
      planId: '1', planDate: '2027-05-01', baseRevision: 4, baseDigest: 'acknowledged'
    } },
    dispatchPlanActionRequest: async () => ({ result: next }),
    dispatchPlanWireState: value => value, compactCurrentPlan: value => value,
    applySavedPlan: () => { applied++; }, queueServerSave: () => { queued++; }
  });
  assert.equal((await s.performDispatchPlanConfirmation()).revision, 5);
  assert.equal(applied, 0, 'the old snapshot must never replace newer local edits');
  assert.equal(s.currentPlan.digest, 'confirmed');
  assert.equal(s.minimumPlanRevisionToApply.revision, 5);
  assert.equal(s.localPlanDirty, true);
  assert.equal(s.saveQueued, true);
  assert.equal(s.confirmInFlight, false);
  assert.equal(queued, 1);
});

test('SAVE-UI-27: dependency actions wait behind an existing lifecycle request', async () => {
  let finish, requests = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const s = subject(['runAtomicDispatchDependencyMutation', 'serializeDispatchPlanAction', 'performDispatchDependencyMutation'], {
    dispatchPlanActionPromise: pending, saveCurrentPlanNow: async () => {},
    refreshDispatchDependencyPlanFence: async () => {}, dispatchLeaseRequestPayload: value => value,
    newDependencyRequestId: () => 'dependency-27', queueServerSave: () => {},
    dispatchPlanActionRequest: async (kind, url, payload) => { requests++; assert.equal(payload.quantity, 0.125); return { result: {} }; },
    applyAtomicDependencyMutationPayload: () => false
  });
  const action = s.runAtomicDispatchDependencyMutation({ url: '/dependency', payload: { quantity: 0.125 } });
  await Promise.resolve();
  assert.equal(requests, 0);
  finish();
  await action;
  assert.equal(requests, 1);
  assert.equal(s.dispatchPlanActionPromise, null);
});

function clickSubject(overrides) {
  let click;
  const s = subject([], { isApplyingRemotePlan: false, DISPATCH_VIEW_MUTATION_ACTIONS: new Set(['reopen-plan']), app: { addEventListener: (kind, handler) => { assert.equal(kind, 'click'); click = handler; } }, ...overrides });
  const node = declarations.find(n => n.type === 'ExpressionStatement' && n.expression.callee?.object?.name === 'app'
    && n.expression.callee?.property?.name === 'addEventListener' && n.expression.arguments[0]?.value === 'click');
  assert.ok(node);
  vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), s, { filename: 'public/dispatch.js' });
  return { s, click: async action => {
    const button = { dataset: { action }, closest: () => null };
    await click({ target: { dataset: {}, closest: selector => selector === 'button' ? button : null } });
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('SAVE-UI-28: recovery, retry, and reopen button failures remain visible without discarding the draft', async () => {
  for (const action of ['recover-dispatch-draft', 'retry-dispatch-plan-action', 'reopen-plan']) {
    let rendered = 0;
    const fail = async () => { throw new Error('server unavailable'); };
    const { s, click } = clickSubject({ handleDispatchDraftRecovery: fail, retryPendingDispatchPlanAction: fail,
      reopenCurrentDispatchPlan: fail, render: () => { rendered++; }, renderDispatchNoticePatch: () => { rendered++; } });
    await click(action);
    assert.match(s.routeNotice, /server unavailable/);
    assert.equal(rendered, 1);
    assert.equal(s.localPlanDirty, true);
    assert.equal(s.currentPlan.revision, 4);
  }
  const { s, click } = clickSubject({ reopenCurrentDispatchPlan: async () => {}, displayDate: value => value });
  await click('reopen-plan');
  assert.match(s.routeNotice, /2027-05-01 opened for editing/);
});

test('SAVE-UI-29: a definitive rejected generation does not strand a newer corrected draft', async () => {
  const sent = [];
  const s = subject(['flushPlanSaveQueue', 'savePlanToServer'], {
    saveTimer: null, saveQueued: true, isApplyingRemotePlan: false, isDispatchPlanEditor: () => true,
    forceNextPlanSave: false, payloadRequiresSave: () => true,
    planPayload: () => ({ planId: '1', planDate: '2027-05-01', baseRevision: 4, baseDigest: 'acknowledged', note: `edit-${s.localPlanGeneration}` }),
    fetch: async (url, init) => {
      sent.push(JSON.parse(init.body));
      if (sent.length === 1) { s.localPlanGeneration++; s.saveQueued = true; }
      return { ok: false, status: 422, text: async () => 'Invalid assignment' };
    }
  });
  const result = await s.flushPlanSaveQueue();
  assert.equal(result.failed, true);
  assert.deepEqual(sent.map(body => body.note), ['edit-2', 'edit-3']);
  assert.equal(s.currentPlan.revision, 4);
  assert.equal(s.localPlanDirty, true);
  assert.equal(s.pendingPlanSaveAttempt, null);
  assert.equal(s.saveInFlight, false);
});

test('SAVE-UI-30: a draft backup captures unsaved values without recalculating the live plan or routes', () => {
  let normalizations = 0, timingCalculations = 0, summaryCalculations = 0;
  const s = subject(['planPayload'], {
    normalizePlanBeforeSave: () => { normalizations++; },
    trucksWithTimingMetadata: () => { timingCalculations++; return []; },
    planSummary: () => { summaryCalculations++; return {}; },
    trucks: [{ plate: 'T', parkingSpot: 'unsaved', loads: [] }],
    orders: [{ id: 'SO1', items: [{ quantity: 0 }, { quantity: 0.125 }] }, { id: 'CATALOG' }],
    withoutAuthoritativelyRetiredStops: value => value, withoutAuthoritativelyRetiredOrders: value => value,
    assignedOrderIdsForTrucks: () => new Set(['SO1']), isDispatchPlanOwnedOrder: () => false,
    groupedChildOrderIds: () => [], splitParentOrderIds: () => [], dispatchOrderRefKey: value => value,
    nextPlanSaveMode: '', pendingPlanMutationAction: 'parking', pendingGlobalOrderRetireRefs: new Set(),
    pendingGlobalOrderReactivateRefs: new Set(), nextSaveNeedsOrderPoolRefresh: false
  });
  const draft = s.planPayload(new Date(), { draftOnly: true });
  assert.equal(normalizations, 0);
  assert.equal(timingCalculations, 0);
  assert.equal(summaryCalculations, 0);
  assert.equal(draft.trucks[0].parkingSpot, 'unsaved');
  assert.equal(draft.orders.length, 1);
  assert.equal(draft.orders[0].items[0].quantity, 0);
  assert.equal(draft.orders[0].items[1].quantity, 0.125);
  assert.equal(draft.baseDigest, 'acknowledged');
  s.planPayload();
  assert.equal(normalizations, 1, 'actual server saves still normalize and validate');
  assert.equal(timingCalculations, 1);
  assert.equal(summaryCalculations, 1);
});

test('SAVE-UI-31: recovery module work waits until the newly rendered board has painted', async () => {
  const frames = [], timers = [];
  let reads = 0;
  const s = subject(['scheduleDispatchDraftRecovery'], {
    window: { requestAnimationFrame: callback => frames.push(callback) }, setTimeout: callback => timers.push(callback),
    dispatchRecoveredDraft: null, dispatchDraftBackupError: '',
    dispatchDraftStorage: async () => { reads++; return { journal: { read: async () => null }, key: 'owner:date' }; }
  });
  s.scheduleDispatchDraftRecovery();
  assert.equal(timers.length, 0, 'storage work cannot be scheduled ahead of the initial paint');
  assert.equal(reads, 0);
  frames.shift()();
  assert.equal(timers.length, 0);
  frames.shift()();
  await timers.shift()();
  assert.equal(reads, 1);
  assert.equal(s.dispatchDraftBackupError, '');
});

test('SAVE-UI-32: company-date formatting reuses its formatter without caching yesterday across midnight', () => {
  let constructed = 0;
  const s = subject(['dispatchCompanyLocalDate'], {
    Intl: { DateTimeFormat: function (...args) { constructed++; return new Intl.DateTimeFormat(...args); } }
  });
  for (const [instant, expected] of [
    ['2026-01-01T04:59:59Z', '2025-12-31'], ['2026-01-01T05:00:00Z', '2026-01-01'],
    ['2026-07-01T03:59:59Z', '2026-06-30'], ['2026-07-01T04:00:00Z', '2026-07-01']
  ]) assert.equal(s.dispatchCompanyLocalDate(new Date(instant)), expected);
  assert.equal(constructed, 1, 'repeated renders must not rebuild the same timezone formatter');
});

test('SAVE-UI-33: one render assignment index preserves legacy first-match relationships and observes the next render', () => {
  let lookups = 0;
  const records = new Map([
    ['SPLIT', { id: 'SPLIT', originalOrderId: 'PARENT', childOrders: ['CHILD', 7, null],
      childOrderDetails: [{ id: 'NESTED', originalOrderId: 'ORIGINAL' }] }],
    ['SECOND', { id: 'SECOND', originalOrderId: 'PARENT', childOrders: ['OTHER'] }]
  ]);
  const first = { plate: 'FIRST', loads: [{ name: 'A', stops: [{ orderId: 'SPLIT' }, { orderId: 'MISSING' }] }] };
  const second = { plate: 'SECOND', loads: [{ name: 'B', stops: [{ orderId: 'SECOND' }, {}] }] };
  const s = subject(['orderAssignment', 'dispatchOrderAssignmentIndex'], {
    trucks: [first, second], orderById: id => { lookups++; return records.get(id); }
  });
  for (const truckOrder of [[first, second], [second, first]]) {
    s.trucks = truckOrder;
    lookups = 0;
    const index = s.dispatchOrderAssignmentIndex();
    assert.equal(lookups, 4, 'resolve each stop once, independent of catalog size');
    for (const ref of ['SPLIT', 'PARENT', 'CHILD', '7', 'null', 'NESTED', 'ORIGINAL', 'SECOND', 'OTHER', 'MISSING', '', 0, 'UNKNOWN']) {
      const actual = index.get(String(ref || '')) || {};
      const expected = s.orderAssignment(ref);
      assert.equal(actual.truck, expected.truck, `truck for ${ref}`);
      assert.equal(actual.load, expected.load, `load for ${ref}`);
      assert.equal(actual.orderId, expected.orderId, `stop identity for ${ref}`);
    }
  }
  second.loads[0].stops = [];
  first.loads[0].stops = [];
  assert.equal(s.dispatchOrderAssignmentIndex().size, 0, 'an index cannot survive into a changed plan');
});

test('SAVE-UI-34: rendering a large catalog shares one assignment index among all cards', () => {
  let builds = 0, cards = 0;
  const assignments = new Map([['FIRST', { orderId: 'FIRST' }]]);
  const s = subject(['renderOrderList'], {
    activeOrderType: 'SO', dispatchOrderPoolNextCursor: '',
    openOrders: () => Array.from({ length: 1000 }, (_, id) => ({ id: String(id) })),
    dispatchOrderAssignmentIndex: () => { builds++; return assignments; },
    renderOrderCard: (_order, index) => { assert.equal(index, assignments); cards++; return 'card'; }
  });
  assert.equal(s.renderOrderList().length, 4000);
  assert.equal(builds, 1);
  assert.equal(cards, 1000);
  s.openOrders = () => [];
  assert.match(s.renderOrderList(), /No open orders/);
  assert.equal(builds, 1, 'an empty board needs no assignment index');
});

test('SAVE-UI-35: background catalog hydration waits for the authoritative board to paint', async () => {
  const frames = [], timers = [], events = [];
  const s = subject(['initDispatch'], {
    window: { requestAnimationFrame: callback => frames.push(callback), setTimeout: callback => timers.push(callback) },
    render: () => events.push('render'), loadDispatchConfig: async () => {}, loadDispatchSetup: async () => {},
    loadDispatchVendorYards: async () => {}, loadPlanForDate: async (_date, { setupReady }) => { await setupReady; events.push('snapshot'); },
    connectEvents: () => events.push('connected'), loadMbtBinDispatchCapability: async () => false,
    scheduleDispatchForecastPolling: () => {}, setInterval: () => {}, pollServerPlan: () => {},
    loadDispatchOrders: async () => events.push('catalog'), loadPlanHistory: async () => {},
    renderDispatchOrderPoolPatch: () => {}, renderDispatchPlannerPatch: () => {}
  });
  await s.initDispatch();
  assert.deepEqual(events, ['render', 'snapshot', 'render', 'connected']);
  assert.equal(timers.length, 0, 'large catalog work must not be queued before the first board paint');
  frames.shift()();
  assert.equal(timers.length, 0);
  frames.shift()();
  timers.shift()();
  await Promise.resolve();
  assert.ok(events.includes('catalog'));
});

test('SAVE-UI-36: indexed cards preserve planned and dependency-parent badges without repeated assignment scans', () => {
  const empty = () => '';
  const sales = { id: 'SO-PARENT', type: 'SO', customer: 'Parent' };
  const dependent = { id: 'CO-DEPENDENT', type: 'CO', customer: 'Dependent', dependencyHidden: true, dependentSalesOrderRef: sales.id };
  const missingParent = { ...dependent, id: 'CO-MISSING', dependentSalesOrderRef: 'ABSENT' };
  const truck = { plate: 'TRUCK-A', loads: [{ name: 'MORNING', stops: [{ orderId: sales.id }] }] };
  const s = subject(['renderOrderCard', 'orderAssignment', 'dispatchOrderAssignmentIndex'], {
    trucks: [truck], orderById: id => id === sales.id ? sales : undefined,
    shortageQty: () => 0, hasUsableDispatchAddress: () => true, transitBlockMessage: empty,
    isOrderPlannedOutsideCurrentPlan: () => false, isScmReconciliationBlocked: () => false,
    isDispatchPlanningRestricted: () => false, isReviewOnlyOrder: () => false,
    packedUnitText: empty, orderExecutionStatus: () => 'pending', orderPlannedElsewhereText: empty,
    poSourceReferenceText: empty, selectedOrderIds: new Set(), escapeHtml: value => String(value || ''),
    movementText: empty, orderPickupText: empty, orderUnitText: empty, orderFootprintPallets: () => 1,
    formatLbs: empty, orderWeightLbs: () => 1, isSalesOrderReattempt: () => false, canConsolidatePick: () => false
  });
  const legacy = s.orderAssignment;
  for (const planned of [true, false]) {
    truck.loads[0].stops = planned ? [{ orderId: sales.id }] : [];
    s.orderAssignment = legacy;
    const cards = [sales, dependent, missingParent, { id: 'UNPLANNED', type: 'SO' }];
    const expected = cards.map(order => s.renderOrderCard(order));
    const index = s.dispatchOrderAssignmentIndex();
    s.orderAssignment = () => assert.fail('Indexed cards must not repeat assignment scans');
    const actual = cards.map(order => s.renderOrderCard(order, index));
    assert.deepEqual(actual, expected, 'The optimization must preserve complete card output');
    assert.match(actual[0], new RegExp(`data-planned="${planned}"`));
    if (planned) {
      assert.match(actual[0], /TRUCK-A MORNING/);
      assert.match(actual[1], /dependency-parent-planned/);
    } else {
      assert.doesNotMatch(actual[1], /dependency-parent-planned/);
      assert.match(actual[1], /dependency-linked/);
    }
    assert.match(actual[1], /draggable="false"/);
    assert.doesNotMatch(actual[2], /dependency-parent-planned/);
    assert.match(actual[3], /draggable="true"/);
  }
});

test('SAVE-UI-37: startup requests the saved plan while setup is pending and waits for both before rendering it', async () => {
  let finishSetup, requested = false;
  const setup = new Promise(resolve => { finishSetup = resolve; });
  const events = [];
  const s = subject(['initDispatch'], {
    window: { requestAnimationFrame: () => {}, setTimeout: () => {} },
    render: () => events.push('render'), connectEvents: () => events.push('connected'),
    loadDispatchConfig: () => setup, loadDispatchSetup: async () => {}, loadDispatchVendorYards: async () => {},
    loadPlanForDate: async (_date, options) => { requested = true; await options.setupReady; events.push('snapshot'); },
    loadMbtBinDispatchCapability: async () => false, scheduleDispatchForecastPolling: () => {},
    setInterval: () => {}, pollServerPlan: () => {}
  });
  const loading = s.initDispatch();
  await Promise.resolve();
  try {
    assert.equal(requested, true, 'The independent plan read must not wait for setup network requests');
    assert.deepEqual(events, ['render'], 'No ready board or event handlers before setup completes');
  } finally {
    finishSetup();
    await loading;
  }
  assert.deepEqual(events, ['render', 'snapshot', 'render', 'connected']);
});

function startupLoadSubject(fetch, events, overrides = {}, names = ['loadPlanForDate']) {
  return subject(names, {
    URLSearchParams, fetch, trucks: [], DISPATCH_PLAN_DATE_KEY: 'date',
    compactCurrentPlan: value => value, dispatchStorageSet: () => events.push('date'),
    loadDriverJobStatuses: async () => events.push('driver'), refreshPlannedAssignments: async () => events.push('assignments'),
    applyDispatchPlanSnapshotResult: () => { events.push('apply'); return { loaded: true }; },
    refreshDispatchPlanEditLease: async () => {}, resetUndoHistory: () => {}, resetLocalPlanDirty: () => {},
    loadDispatchForecast: async () => {}, scheduleDispatchDraftRecovery: () => {}, clearDispatchForecast: () => {},
    ...overrides
  });
}

test('SAVE-UI-38: setup and bootstrap may finish in either order without exposing a partially initialized plan', async () => {
  for (const networkFirst of [true, false]) {
    let finishSetup, finishFetch;
    const setupReady = new Promise(resolve => { finishSetup = resolve; });
    const response = new Promise(resolve => { finishFetch = resolve; });
    const events = [];
    const s = startupLoadSubject(() => { events.push('bootstrap'); return response; }, events);
    const prior = s.currentPlan;
    const loading = s.loadPlanForDate('2027-05-01', { createIfMissing: false, setupReady });
    const received = { ok: true, json: async () => ({ exists: true, plan: { id: '1', planDate: '2027-05-01', revision: 5 } }) };
    (networkFirst ? () => finishFetch(received) : finishSetup)();
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.deepEqual(events, ['bootstrap']);
      assert.equal(s.currentPlan, prior, 'Neither the plan nor its fence may be adopted before both reads finish');
      assert.equal(s.dispatchPlannerSnapshotState, 'loading');
    } finally {
      (networkFirst ? finishSetup : () => finishFetch(received))();
      await loading;
    }
    assert.deepEqual(events, ['bootstrap', 'date', 'driver', 'assignments', 'apply']);
    assert.equal(s.currentPlan.revision, 5);
  }
});

test('SAVE-UI-39: failed startup setup cannot adopt a concurrently fetched plan or its fence', async () => {
  let failSetup;
  const setupReady = new Promise((_resolve, reject) => { failSetup = reject; });
  setupReady.catch(() => {});
  const events = [];
  const s = startupLoadSubject(async () => ({ ok: true, json: async () => ({ exists: true, plan: { id: '1', revision: 8 } }) }), events);
  const prior = s.currentPlan;
  const loading = s.loadPlanForDate('2027-05-01', { createIfMissing: false, setupReady });
  failSetup(new Error('setup unavailable'));
  await assert.rejects(loading, /setup unavailable/);
  assert.equal(s.currentPlan, prior);
  assert.deepEqual(events, []);
  assert.equal(s.dispatchPlannerSnapshotState, 'failed');
});

test('SAVE-UI-40: startup network reads begin before the initial loading render and still finish before the ready board', async () => {
  const events = [];
  const s = subject(['initDispatch'], {
    window: { requestAnimationFrame: () => {}, setTimeout: () => {} },
    render: () => events.push('render'), connectEvents: () => events.push('connected'),
    loadDispatchConfig: async () => events.push('config'), loadDispatchSetup: async () => events.push('setup'),
    loadDispatchVendorYards: async () => events.push('yards'),
    loadPlanForDate: async (_date, { setupReady }) => { events.push('bootstrap'); await setupReady; events.push('snapshot'); },
    loadMbtBinDispatchCapability: async () => false, scheduleDispatchForecastPolling: () => {},
    setInterval: () => {}, pollServerPlan: () => {}
  });
  await s.initDispatch();
  assert.deepEqual(events, ['config', 'setup', 'yards', 'bootstrap', 'render', 'snapshot', 'render', 'connected']);
});

test('SAVE-UI-41: a failed loading render is handled without adopting the concurrently fetched snapshot', async () => {
  const events = [];
  let renders = 0;
  const s = startupLoadSubject(async () => ({ ok: true, json: async () => ({ exists: true, plan: { id: '1', revision: 8 } }) }), events, {
    window: { requestAnimationFrame: () => {}, setTimeout: () => {} }, console: { error: () => {} },
    render: () => { if (++renders === 1) throw new Error('loading render failed'); }, connectEvents: () => {},
    loadDispatchConfig: async () => {}, loadDispatchSetup: async () => {}, loadDispatchVendorYards: async () => {},
    loadMbtBinDispatchCapability: async () => false, scheduleDispatchForecastPolling: () => {}, setInterval: () => {}, pollServerPlan: () => {}
  }, ['loadPlanForDate', 'initDispatch']);
  const prior = s.currentPlan;
  await s.initDispatch();
  assert.equal(s.currentPlan, prior);
  assert.deepEqual(events, []);
  assert.equal(s.dispatchPlannerSnapshotState, 'failed');
  assert.match(s.routeNotice, /loading render failed/);
  assert.equal(renders, 2, 'The fallback view must render after the startup failure');
});
