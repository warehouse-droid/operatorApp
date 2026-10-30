const assert = require('node:assert/strict');
const fc = require('/artifacts/toolchain/node_modules/fast-check');
const { queueFixture, load, config } = require('./refresh-fixture.cjs');
const core = load('ppa_core');
fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 20 }),
  fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 20 }),
  fc.integer({ min: 1, max: 3 }), (initial, newer, customer) => {
    const f = queueFixture();
    for (const owner of initial) { f.api.enqueue(String(owner), 'invoice:100:edit'); }
    const captured = Array.from(f.api.due(), row => row.token);
    for (const owner of newer) { f.api.enqueue(String(owner), 'customerrefund:400:create'); }
    const expected = [...f.rows.keys()].filter(id => Number(id) > initial.length || initial[Number(id) - 1] !== customer);
    f.api.defer(String(customer), captured, new Error('SOURCE_CHANGED'));
    assert.deepEqual(Array.from(f.api.due(), row => row.token), expected, 'only captured failed customer tokens are delayed');
    f.advance(config.queueRetryMinutes - 1); assert.deepEqual(Array.from(f.api.due(), row => row.token), expected);
    f.advance(1); assert.equal(f.api.due().length, initial.length + newer.length);
    f.api.acknowledge(String(customer), captured); f.api.acknowledge(String(customer), captured);
    assert.deepEqual([...f.rows.keys()], expected, 'later changes and other customers are neither lost nor duplicated');
  }), { seed: 20261024, numRuns: 400 });
fc.assert(fc.property(fc.integer({ min: 1, max: 250 }), qty => {
  const scope = { customer: '1', currency: '1', subsidiary: '1', date: '2026-01-01' };
  const input = { customer: '1', invoices: [{ ...scope, id: '100', so: '90', lines: [{ line: '1001', qty, net: 4000, gross: 4520 }] }],
    payments: [{ ...scope, id: '201', source: '201', invoice: '100', method: '1', memo: '', amount: qty * 4000 }],
    credits: [{ ...scope, id: '300', date: '2026-02-01', qty, net: 4000, gross: 4520, mixed: false,
      refunds: [{ id: '400', method: '1', memo: '', amount: qty * 4520, posted: true }] }], manual: [], physical: 0, issues: [] };
  const result = core.build(input);
  assert.equal(result.verified, true); assert.equal(result.allocations[0].refunded, qty);
  assert.equal(result.allocations[0].available, 0); assert.equal(result.events[0].amount, qty * 4000);
  assert.deepEqual(JSON.stringify(core.build(input)), JSON.stringify(result));
  input.credits[0].refunds[0].amount -= 1;
  const partial = core.build(input); assert.equal(partial.verified, false); assert.equal(partial.events.length, 0);
}), { seed: 20261025, numRuns: 400 });
console.log('Automation property checks: 800 generated cases passed, fixed seeds 20261024 and 20261025.');
