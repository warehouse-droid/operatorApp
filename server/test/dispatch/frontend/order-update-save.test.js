import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';

const source = readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body;
function subject(names, overrides = {}) {
  const context = vm.createContext({
    console, Date, Promise, Map, Set, URLSearchParams, setTimeout, clearTimeout,
    currentPlan: { id: '1', planDate: '2028-03-01', revision: 63, digest: 'old' }, currentPlanDate: '2028-03-01',
    localPlanGeneration: 1, localPlanDirty: false, lastServerSavedAt: '2028-03-01T12:00:00Z',
    pendingPlanSaveAttempt: null, pendingDispatchPlanAction: null, blockedRemotePlanUpdate: false,
    isApplyingRemotePlan: false, minimumPlanRevisionToApply: { planId: '1', revision: 63 },
    dispatchRecoveredDraft: null, dispatchDraftBackupError: '', routeNotice: '', lastLocalPlanEditAt: '',
    blockedDispatchSetupUpdate: false, queueDispatchDraftJournal: () => {},
    renderDispatchNoticePatch: () => {}, render: () => {},
    loadDriverJobStatuses: async () => {}, loadDispatchForecast: async () => {},
    compactCurrentPlan: plan => plan, resetUndoHistory: () => {},
    ...overrides
  });
  for (const name of names) {
    const node = declarations.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === name);
    assert.ok(node, name);
    vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), context, { filename: 'public/dispatch.js' });
  }
  return context;
}

for (const change of ['edit', 'acknowledgement', 'date']) {
  test(`MAINT-UI: a delayed order refresh cannot overwrite a newer ${change}`, async () => {
    let resume;
    let waiting;
    const reached = new Promise(resolve => { waiting = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    let applied = 0;
    const s = subject(['restoreServerPlan'], {
      fetch: async () => ({ ok: true, json: async () => ({ id: '1', planDate: '2028-03-01', revision: 64, digest: 'remote',
        orders: [], trucks: [], savedAt: '2028-03-01T12:01:00Z' }) }),
      refreshPlannedAssignments: async () => { waiting(); await gate; },
      applySavedPlan: () => { applied++; return true; }
    });
    const refresh = s.restoreServerPlan();
    await reached;
    if (change === 'edit') { s.localPlanDirty = true; s.localPlanGeneration++; }
    if (change === 'acknowledgement') { s.currentPlan.revision = 65; s.currentPlan.digest = 'saved'; }
    if (change === 'date') { s.currentPlanDate = '2028-03-02'; s.currentPlan = { id: '2', revision: 1 }; }
    resume();
    assert.equal(await refresh, false);
    assert.equal(applied, 0);
    assert.equal(s.currentPlanDate, change === 'date' ? '2028-03-02' : '2028-03-01');
  });
}

test('MAINT-UI: a recovery read started before an acknowledgement cannot revive an obsolete warning', async () => {
  let resume;
  let readStarted;
  const reached = new Promise(resolve => { readStarted = resolve; });
  const read = new Promise(resolve => { resume = resolve; });
  let recover;
  const s = subject(['scheduleDispatchDraftRecovery'], {
    window: {}, setTimeout: fn => { recover = fn; },
    dispatchDraftStorage: async () => ({ key: 'draft', journal: { read: () => { readStarted(); return read; } } })
  });
  s.scheduleDispatchDraftRecovery();
  const pending = recover();
  await reached;
  s.localPlanGeneration++;
  s.currentPlan.revision = 64;
  s.currentPlan.digest = 'saved';
  resume({ version: 1, planId: '1', generation: 1, baseline: { revision: 63, digest: 'old' } });
  await pending;
  assert.equal(s.dispatchRecoveredDraft, null);
});

test('MAINT-UI: Edit Mode verifies the snapshot after acquiring its lease and before allowing moves', async () => {
  const requests = [];
  let applied = false;
  const s = subject(['enterDispatchEditMode'], {
    dispatchPlannerSnapshotState: 'ready', dispatchSessionId: 's', planEditMode: false,
    planEditLease: null, planEditLeaseToken: '', hasDispatchEditLeaseCredentials: () => true,
    refreshPlannedAssignments: async () => {}, persistStoredDispatchEditLease: () => {},
    startDispatchEditHeartbeat: () => {}, isDispatchHistoryEditMode: () => false,
    fetch: async url => {
      requests.push(url);
      if (url.includes('bootstrap')) assert.equal(s.planEditMode, false);
      return { ok: true, json: async () => url.includes('acquire')
        ? { lease: { planDate: '2028-03-01' }, editLeaseToken: 'test-new' }
        : { exists: true, plan: { id: '1', planDate: '2028-03-01', revision: 64, digest: 'fresh', trucks: [], assignedOrderSnapshots: [] } } };
    },
    applyDispatchPlanSnapshotResult: payload => { applied = true; s.currentPlan = payload.plan; return { loaded: true }; }
  });
  await s.enterDispatchEditMode();
  assert.equal(requests.length, 2);
  assert.match(requests[0], /acquire/);
  assert.match(requests[1], /bootstrap/);
  assert.equal(applied, true);
  assert.equal(s.planEditMode, true);
  assert.equal(s.currentPlan.revision, 64);
});

test('MAINT-UI: acknowledging the exact recovered draft clears only its matching warning', () => {
  const payload = { planId: '1', planDate: '2028-03-01', trucks: [{ id: 'T1' }], orders: [], summary: { note: 'keep' } };
  const s = subject(['acknowledgeDispatchRecoveredSave'], {
    dispatchRecoveredDraft: { planId: '1', generation: 2, pendingPayload: structuredClone(payload) },
    routeNotice: 'The saved plan has changed since this draft. Download the draft and review its changes against the current plan.'
  });
  s.acknowledgeDispatchRecoveredSave({ saveGeneration: 2, payload });
  assert.equal(s.dispatchRecoveredDraft, null);
  assert.equal(s.routeNotice, '');
});

test('MAINT-UI: acknowledgement preserves a different or newer recovered draft and its warning', () => {
  const payload = { planId: '1', planDate: '2028-03-01', trucks: [], orders: [], summary: { note: 'saved' } };
  for (const record of [
    { planId: '1', generation: 3, pendingPayload: payload },
    { planId: '1', generation: 2, pendingPayload: { ...payload, summary: { note: 'unsaved' } } },
    { planId: '2', generation: 2, pendingPayload: payload },
    { planId: '1', generation: 2, pendingPayload: payload, action: { kind: 'confirm' } }
  ]) {
    const s = subject(['acknowledgeDispatchRecoveredSave'], { dispatchRecoveredDraft: record, routeNotice: 'Keep this warning' });
    s.acknowledgeDispatchRecoveredSave({ saveGeneration: 2, payload });
    assert.equal(s.dispatchRecoveredDraft, record);
    assert.equal(s.routeNotice, 'Keep this warning');
  }
});

test('MAINT-UI: a refresh with no intervening edit applies once and restores future autosave', async () => {
  let applications = 0;
  let resets = 0;
  const s = subject(['restoreServerPlan'], {
    refreshPlannedAssignments: async () => {},
    fetch: async () => ({ ok: true, json: async () => ({ id: '1', planDate: '2028-03-01', revision: 64,
      orders: [], trucks: [], savedAt: '2028-03-01T12:01:00Z' }) }),
    applySavedPlan: () => { assert.equal(s.isApplyingRemotePlan, true); applications++; return true; },
    resetUndoHistory: () => { resets++; },
    loadDispatchForecast: async () => { assert.equal(s.isApplyingRemotePlan, false); }
  });
  assert.equal(await s.restoreServerPlan(), true);
  assert.equal(s.currentPlan.revision, 64);
  assert.equal(applications, 1);
  assert.equal(resets, 1);
  assert.equal(s.isApplyingRemotePlan, false);
});

for (const stale of ['generation', 'identity']) {
  test(`MAINT-UI: Edit Mode retains the draft when snapshot verification changes ${stale}`, async () => {
    const draft = { id: '1', planDate: '2028-03-01', revision: 63, digest: 'old' };
    const s = subject(['enterDispatchEditMode'], {
      currentPlan: draft, dispatchPlannerSnapshotState: 'ready', dispatchSessionId: 's', planEditMode: false,
      planEditLease: null, planEditLeaseToken: '', hasDispatchEditLeaseCredentials: () => true,
      refreshPlannedAssignments: async () => {}, persistStoredDispatchEditLease: () => {},
      startDispatchEditHeartbeat: () => {}, isDispatchHistoryEditMode: () => false,
      fetch: async url => ({ ok: true, json: async () => {
        if (url.includes('acquire')) return { lease: { planDate: draft.planDate }, editLeaseToken: 'test-token' };
        if (stale === 'generation') { s.localPlanGeneration++; s.localPlanDirty = true; }
        return { exists: true, plan: { ...draft, id: stale === 'identity' ? '2' : '1', revision: 64 } };
      } }),
      applyDispatchPlanSnapshotResult: () => assert.fail('unverified snapshot overwrote the draft')
    });
    await assert.rejects(s.enterDispatchEditMode(), stale === 'generation' ? /draft has been retained/ : /did not verify/);
    assert.equal(s.currentPlan, draft);
    assert.equal(s.planEditMode, false);
  });
}
