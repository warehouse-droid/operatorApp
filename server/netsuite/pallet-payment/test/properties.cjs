const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fc = require('/artifacts/toolchain/node_modules/fast-check');
let core;
vm.runInNewContext(fs.readFileSync('ppa_core.js', 'utf8'), { define(_deps, factory) { core = factory(); } }, { filename: 'ppa_core.js' });
fc.assert(fc.property(fc.integer({ min: 0, max: 1000000 }), fc.integer({ min: 1, max: 100 }),
  fc.integer({ min: 1, max: 99999 }), (cash, qty, net) => {
    const gross = Math.round(net * 1.13);
    const scope = { customer: '1', currency: '1', subsidiary: '1', date: '2026-01-01' };
    const input = { customer: '1', invoices: [{ ...scope, id: '100', so: '90', lines: [{ line: '1001', qty, net, gross }] }],
      payments: [{ ...scope, id: '201', source: '201', invoice: '100', method: '1', memo: '', amount: cash },
        { ...scope, id: '202', source: '202', invoice: '100', method: '5', memo: 'SOB123456 / 0070', amount: qty * gross }],
      credits: [], manual: [], physical: qty, issues: [] };
    const result = core.build(input);
    assert.equal(result.verified, true);
    assert.equal(result.allocations.reduce((v, a) => v + a.qty, 0), qty);
    assert.equal(result.allocations.filter(a => a.method === '1').reduce((v, a) => v + a.qty, 0), Math.min(qty, Math.floor(cash / net)));
    for (const allocation of result.allocations) {
      assert.equal(allocation.available, allocation.qty);
      assert.ok(Number.isSafeInteger(allocation.rate * allocation.qty));
    }
  }), { seed: 20261021, numRuns: 1500 });
fc.assert(fc.property(fc.integer({ min: 0, max: 9999 }), fc.constantFrom('/', '+', '、', '#'), (tail, delimiter) => {
  const last4 = String(tail).padStart(4, '0');
  assert.equal(core.card('5', `SOB123456 ${delimiter} ${last4}`).last4, last4);
  assert.equal(core.card('5', `SOB123456 ${delimiter} ${last4}.00`).ok, false);
  assert.equal(core.card('5', `SOB123456 (${last4}) / 8888`).ok, false);
}), { seed: 20261022, numRuns: 1500 });
fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 9999 }), (qty, tail) => {
  const last4 = String(tail).padStart(4, '0');
  const returned = 1 + tail % qty;
  const scope = { customer: '1', currency: '1', subsidiary: '1', date: '2026-01-01' };
  const input = { customer: '1', invoices: [{ ...scope, id: '100', so: '90', lines: [{ line: '1001', qty, net: 4000, gross: 4520 }] }],
    payments: [{ ...scope, id: '201', source: '201', invoice: '100', method: '5', memo: `SOB123456 / ${last4}`, amount: qty * 4520 }],
    credits: [{ ...scope, id: '300', date: '2026-02-01', qty: returned, net: 4000, gross: 4520, mixed: false,
      refunds: [{ id: '400', method: '5', memo: `CMB123456 / ${last4}`, amount: returned * 4520, posted: true }] }],
    manual: [], physical: qty - returned, issues: [] };
  const result = core.build(input);
  assert.equal(result.verified, true);
  assert.equal(result.allocations[0].available, qty - returned);
  assert.equal(result.allocations[0].refunded, returned);
  input.credits[0].refunds[0].memo = `CMB123456 / ${String((tail + 1) % 10000).padStart(4, '0')}`;
  assert.equal(core.build(input).verified, false);
}), { seed: 20261023, numRuns: 1000 });
console.log('Property checks: 4000 generated cases passed, fixed seeds 20261021, 20261022 and 20261023.');
require('./automation-properties.cjs');
