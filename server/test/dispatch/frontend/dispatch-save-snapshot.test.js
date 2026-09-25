import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';

const source = readFileSync(new URL('../../../public/dispatch-snapshot.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body;
function subject(names, overrides = {}) {
  const context = vm.createContext({
    pendingSnapshotRestore: null, selectedSnapshot: { id: 'archive-1', planId: '1', planDate: '2027-06-01' },
    snapshotSessionId: 'session', snapshotLeaseToken: 'test-lease', snapshotLoading: false, snapshotNotice: '', selectedSnapshotId: '',
    confirm: () => true, renderSnapshotApp: () => {}, loadSnapshots: async () => {},
    ...overrides
  });
  for (const name of names) {
    const node = declarations.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    assert.ok(node);
    vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), context, { filename: 'public/dispatch-snapshot.js' });
  }
  return context;
}
test('SAVE-SNAPSHOT-01: a definitive rejection clears the pending request for explicit review', async () => {
  const s = subject(['restoreSelectedSnapshot'], { snapshotApi: async (url, options) => {
    if (!options) return { revision: 2, digest: 'digest' };
    throw Object.assign(new Error('Current snapshot is stale'), { status: 409 });
  } });
  await s.restoreSelectedSnapshot();
  assert.equal(s.pendingSnapshotRestore, null);
  assert.match(s.snapshotNotice, /stale/);
});
test('SAVE-SNAPSHOT-02: a lost restore response retries the identical body', async () => {
  const bodies = [];
  const s = subject(['restoreSelectedSnapshot'], { snapshotApi: async (url, options) => {
    if (!options) return { revision: 2, digest: 'digest' };
    bodies.push(options.body);
    if (bodies.length === 1) throw new Error('response lost');
    return { plan: { id: '1' } };
  } });
  await s.restoreSelectedSnapshot();
  assert.ok(s.pendingSnapshotRestore);
  await s.restoreSelectedSnapshot();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(s.pendingSnapshotRestore, null);
});
