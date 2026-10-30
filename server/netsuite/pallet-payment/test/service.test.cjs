const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function moduleFor(name, deps = {}) {
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../${name}.js`), 'utf8'), {
    define(names, factory) { api = factory(...names.map(key => deps[key])); }
  }, { filename: path.resolve(__dirname, `../${name}.js`), timeout: 1000 });
  return api;
}
const core = moduleFor('ppa_core');
const service = moduleFor('ppa_service', { './ppa_core': core });
function fixture() {
  const calls = [];
  const allocations = new Map();
  const events = new Map();
  const input = { customer: '1', invoices: [{ id: '100', so: '90', customer: '1', currency: '1', subsidiary: '1',
    date: '2026-01-01', lines: [{ line: '1001', qty: 6, net: 4000, gross: 4520 }] }],
    payments: [{ id: '201', source: '201', invoice: '100', customer: '1', currency: '1', subsidiary: '1', date: '2026-01-01',
      method: '1', memo: '', amount: 24000 }], credits: [], manual: [], physical: 6, issues: [], stamp: 'A' };
  let version = 'A';
  let fail = '';
  const io = {
    ensureWriter() { calls.push('writer'); },
    existing() { return { allocations: [...allocations.values()], events: [...events.values()] }; },
    invalidate() { calls.push('invalidate'); for (const row of allocations.values()) { row.verified = false; } },
    snapshot() { return structuredClone(input); },
    version() { return version; },
    budget() { calls.push('budget'); },
    putAllocation(row, verified) {
      calls.push('allocation'); if (fail === 'allocation') { throw new Error('WRITE_FAILED'); }
      allocations.set(row.key, { ...row, id: '700', verified }); return '700';
    },
    putEvent(row) { calls.push('event'); events.set(row.key, row); },
    retireAllocation(row) { calls.push('retire'); allocations.get(row.key).retired = true; },
    reverseEvent(row) { calls.push('reverse'); events.get(row.key).status = 'REVERSED'; },
    publish(row) {
      calls.push('publish'); allocations.get(row.key).verified = true;
      if (fail === 'publish') { throw new Error('WRITE_FAILED'); }
    }
  };
  return { io, input, calls, allocations, events, stale() { version = 'B'; }, fail(stage) { fail = stage; } };
}
test('dry run calculates without custom record writes', () => {
  const f = fixture(); const r = service.refresh(f.io, '1', true);
  assert.equal(r.verified, true); assert.equal(r.allocations[0].qty, 6);
  assert.deepEqual(f.calls, []); assert.equal(f.allocations.size, 0);
});
test('retry upserts stable keys and publishes only after source recheck', () => {
  const f = fixture();
  service.refresh(f.io, '1', false); service.refresh(f.io, '1', false);
  assert.equal(f.allocations.size, 1); assert.equal([...f.allocations.values()][0].verified, true);
  assert.ok(f.calls.indexOf('invalidate') < f.calls.indexOf('allocation'));
  assert.ok(f.calls.indexOf('allocation') < f.calls.indexOf('publish'));
});
test('stale snapshot never publishes and failed publication invalidates all rows', () => {
  const f = fixture(); service.refresh(f.io, '1', false); f.stale();
  assert.throws(() => service.refresh(f.io, '1', false), /SOURCE_CHANGED/);
  assert.equal([...f.allocations.values()][0].verified, false);
  const g = fixture(); g.fail('publish');
  assert.throws(() => service.refresh(g.io, '1', false), /WRITE_FAILED/);
  assert.equal([...g.allocations.values()][0].verified, false);
});
test('changed consumed funding preserves original provenance and stays unverified', () => {
  const f = fixture(); service.refresh(f.io, '1', false);
  const old = [...f.allocations.values()][0]; old.refunded = 1;
  f.input.payments[0].source = '999';
  assert.throws(() => service.refresh(f.io, '1', false), /CONSUMED_SOURCE_CHANGED/);
  assert.equal(old.verified, false); assert.equal(old.sources[0], '201');
});
test('review results are stored visibly but excluded from the verified search', () => {
  const f = fixture(); f.input.physical = 5;
  const r = service.refresh(f.io, '1', false);
  assert.equal(r.verified, false); assert.equal(f.allocations.size, 1);
  assert.equal([...f.allocations.values()][0].verified, false);
  assert.ok(!f.calls.includes('publish'));
});
test('obsolete generated rows are reversed and unused lots are retired without deleting history', () => {
  const f = fixture(); f.events.set('old-event', { key: 'old-event', status: 'COMPLETED' });
  f.allocations.set('old-lot', { key: 'old-lot', pending: 0, refunded: 0, verified: true });
  service.refresh(f.io, '1', false);
  assert.equal(f.events.get('old-event').status, 'REVERSED');
  assert.equal(f.allocations.get('old-lot').retired, true);
  assert.equal(f.allocations.get('old-lot').verified, false);
});
