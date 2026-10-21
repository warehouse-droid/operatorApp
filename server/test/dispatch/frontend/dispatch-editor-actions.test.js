import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';

function subject(file, names, state) {
  const source = readFileSync(new URL('../../../public/' + file, import.meta.url), 'utf8');
  const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body;
  const context = vm.createContext({ Date, JSON, Boolean, Number, String, ...state });
  for (const name of names) {
    const declaration = declarations.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    assert.ok(declaration, name);
    vm.runInContext(source.slice(0, declaration.range[0]).replace(/[^\n]/g, ' ') + source.slice(...declaration.range),
      context, { filename: '/app/public/' + file });
  }
  return context;
}

test('ACTION-01: cancelling Dispatch confirmation sends no request', async () => {
  let requests = 0, popup = '';
  const context = subject('dispatch.js', ['kickDispatchPlanEditorFromScreen'], {
    planEditLease: { active: true, planDate: '2026-10-15', operatorName: 'dispatch' }, SALES_PLANNING_HOST: false,
    window: { confirm: text => { popup = text; return false; } }, fetch: async () => { requests++; return { ok: true }; },
    refreshDispatchPlanEditLease: async () => {}, render: () => {}
  });
  await context.kickDispatchPlanEditorFromScreen();
  assert.equal(requests, 0); assert.match(popup, /dispatch.*2026-10-15/);
});
test('ACTION-02: a heartbeat response arriving after kick cannot restore editing', async () => {
  let finish, persisted = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const context = subject('dispatch.js', ['heartbeatDispatchEditLease'], {
    hasDispatchEditLeaseCredentials: () => true, planEditHeartbeatInFlight: false,
    dispatchEditActivity: { isIdle: () => false }, planEditLeaseToken: 'old-token', currentPlanDate: '2026-10-15',
    planEditMode: false, planEditLease: null, renewDispatchEditLease: () => pending,
    persistStoredDispatchEditLease: () => { persisted++; }, render: () => {}
  });
  const renewal = context.heartbeatDispatchEditLease(); context.planEditLeaseToken = '';
  finish({ active: true }); await renewal;
  assert.equal(context.planEditMode, false); assert.equal(context.planEditLease, null); assert.equal(persisted, 0);
});
test('ACTION-03: timeout locks editing and preserves the local draft without forcing a save', async () => {
  let journaled = 0, saved = 0, stopped = 0;
  const requests = [];
  const context = subject('dispatch.js', ['clearPlanEditHeartbeat', 'leaveDispatchEditMode', 'expireDispatchEditMode'], {
    currentPlanDate: '2026-10-15', dispatchSessionId: 'browser', planEditLeaseToken: 'old-token',
    planEditLease: { active: true }, planEditMode: true, planEditHeartbeatInFlight: false, planEditHeartbeatTimer: 1,
    localPlanDirty: true, queueDispatchDraftJournal: () => { journaled++; },
    saveCurrentPlanNow: () => { saved++; }, render: () => {}, clearStoredDispatchEditLease: () => {},
    dispatchEditActivity: { stop: () => { stopped++; } }, window: { clearInterval: () => {} },
    fetch: async (url, options) => { requests.push({ url, options }); }
  });
  context.expireDispatchEditMode();
  assert.equal(context.planEditMode, false); assert.equal(context.planEditLeaseToken, ''); assert.equal(context.localPlanDirty, true);
  assert.equal(journaled, 1); assert.equal(saved, 0); assert.equal(stopped, 1);
  assert.equal(JSON.parse(requests[0].options.body).editLeaseToken, 'old-token');
});
test('ACTION-04: snapshot renewal arriving after release cannot revive its credentials', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const context = subject('dispatch-snapshot.js', ['heartbeatSnapshotEditLease'], {
    snapshotLeaseToken: 'old', snapshotLeaseHeartbeatInFlight: false, snapshotDate: '2026-10-15', snapshotSessionId: 'browser',
    snapshotLease: null, snapshotEditActivity: { isIdle: () => false, ageMs: () => 5 }, snapshotApi: () => pending
  });
  const renewal = context.heartbeatSnapshotEditLease(); context.snapshotLeaseToken = '';
  finish({ lease: { active: true } }); await renewal;
  assert.equal(context.snapshotLeaseToken, ''); assert.equal(context.snapshotLease, null);
});
test('ACTION-05: a revoked snapshot editor immediately clears the old owner from its screen', async () => {
  let stopped = 0;
  const context = subject('dispatch-snapshot.js', ['heartbeatSnapshotEditLease'], {
    snapshotLeaseToken: 'revoked', snapshotLeaseHeartbeatInFlight: false, snapshotDate: '2026-10-15', snapshotSessionId: 'browser',
    snapshotLease: { active: true }, snapshotEditActivity: { isIdle: () => false, ageMs: () => 5, stop: () => { stopped++; } },
    snapshotApi: async () => {throw Object.assign(new Error('Revoked'), { status: 409 });},
    window: { clearInterval: () => {} }, snapshotLeaseHeartbeatTimer: 1, renderSnapshotApp: () => {}
  });
  await context.heartbeatSnapshotEditLease();
  assert.equal(context.snapshotLeaseToken, ''); assert.equal(context.snapshotLease, null); assert.equal(stopped, 1);
});
