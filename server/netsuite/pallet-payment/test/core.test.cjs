const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load() {
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ppa_core.js'), 'utf8'), {
    define(_deps, factory) { api = factory(); }
  }, { filename: path.resolve(__dirname, '../ppa_core.js'), timeout: 1000 });
  return api;
}
const plain = value => JSON.parse(JSON.stringify(value));
const core = load();
const invoice = () => ({ id: '100', customer: '1', subsidiary: '1', currency: '1', date: '2026-01-01',
  so: '90', lines: [{ line: '1001', qty: 6, net: 4000, gross: 4520 }] });
const payment = (id, method, amount, memo = '') => ({ id, source: id, invoice: '100',
  customer: '1', subsidiary: '1', currency: '1', date: '2026-01-01', method, amount, memo });
function sample(cash = 22000) {
  return { customer: '1', invoices: [invoice()], payments: [payment('201', '1', cash),
    payment('202', '5', 80000, 'SOB123456 / 0070')], credits: [], manual: [], physical: 6, issues: [] };
}
function credit(overrides = {}) {
  return { id: '300', customer: '1', currency: '1', subsidiary: '1', date: '2026-02-01',
    qty: 1, net: 4000, gross: 4520, mixed: false, refunds: [], ...overrides };
}
function refund(overrides = {}) {
  return { id: '400', method: '5', memo: 'CMB123456(0070)', amount: 4520, posted: true, ...overrides };
}
test('money rejects unsafe/non-decimal values and preserves cents', () => {
  assert.equal(core.money('45.20'), 4520);
  assert.equal(core.money(40), 4000);
  for (const input of ['', null, true, '1e4', '1.001', '-1', Infinity, '999999999999999']) {
    assert.throws(() => core.money(input));
  }
});
test('observed historical card formats preserve leading zeros', () => {
  for (const memo of ['SOB123456(0070)', 'SOB123456 / 0070', 'sob123456（0070）',
    'SOB123456 + 0070', 'SOB123456 、 0070', 'CMB123456 #0070', 'Deposit / 0070', 'VISA ****0070']) {
    assert.equal(core.card('5', memo).last4, '0070', memo);
    assert.equal(core.card('5', memo).ok, true, memo);
  }
});
test('ambiguous numbers are never guessed as cards', () => {
  for (const memo of ['', 'SOB4570', '2026/10/21', '4570', 'Call 416-555-4570',
    'SOB123456 / 45.70', 'SOB123456 (2026-10-21)', 'SOB123456 / 12345',
    'SOB123456 (4570) / 7890', 'SOB123456 / 2026/10/21', 'SOB123456 / 4570.00']) {
    assert.equal(core.card('5', memo).ok, false, memo);
  }
  assert.equal(core.card('1', 'SOB123456 / 4570').last4, '');
});
test('cash is floored at net cost; other methods include tax', () => {
  for (const cash of [20000, 22000]) {
    const result = core.build(sample(cash));
    assert.deepEqual(plain(result.allocations.map(a => [a.method, a.qty, a.rate])), [['1', 5, 4000], ['5', 1, 4520]]);
    assert.equal(result.verified, true);
    assert.deepEqual(plain(result.allocations.map(a => a.sources)), [['201'], ['202']]);
  }
});
test('same-method receipts combine only within the invoice', () => {
  const s = sample(2000);
  s.payments.push(payment('203', '1', 2000), { ...payment('204', '1', 200000), invoice: '999' });
  const r = core.build(s);
  assert.deepEqual(plain(r.allocations.map(a => [a.method, a.qty])), [['1', 1], ['5', 5]]);
  assert.deepEqual(plain(r.allocations[0].sources), ['201', '203']);
});
test('pure pallet refund deducts the matching card exactly once across reruns', () => {
  const s = sample(); s.credits = [credit({ refunds: [refund()] })]; s.physical = 5;
  const r = core.build(s);
  assert.equal(r.verified, true);
  assert.equal(r.allocations.find(a => a.method === '5').refunded, 1);
  assert.equal(r.allocations.find(a => a.method === '1').refunded, 0);
  assert.equal(r.events.length, 1);
  assert.deepEqual(plain(core.build(s)), plain(r));
});
test('pending becomes completed without double subtraction', () => {
  const s = sample(); const key = core.build(s).allocations.find(a => a.method === '5').key;
  s.credits = [credit()]; s.physical = 5;
  s.manual = [{ id: '500', allocation: key, credit: '300', refund: '', returnRef: 'R-1', qty: 1, amount: 4520, status: 'PENDING' }];
  const pending = core.build(s);
  assert.equal(pending.verified, true);
  assert.deepEqual(plain(pending.allocations.filter(a => a.method === '5').map(a => [a.pending, a.refunded, a.available])), [[1, 0, 0]]);
  s.manual[0].status = 'COMPLETED'; s.manual[0].refund = '400'; s.credits[0].refunds = [refund()];
  const completed = core.build(s);
  assert.equal(completed.verified, true);
  assert.deepEqual(plain(completed.allocations.filter(a => a.method === '5').map(a => [a.pending, a.refunded, a.available])), [[0, 1, 0]]);
  assert.equal(completed.events.length, 0, 'manual completion must suppress auto double-count');
});
function historicalCashCredit(qty = 10) {
  const s = sample(qty * 4000);
  s.invoices[0].lines[0].qty = qty;
  s.credits = [credit({ id: '188388', qty, refunds: [refund({ id: '188630', method: '1', memo: '', amount: qty * 4520 })] })];
  s.physical = 0;
  return s;
}
test('full historical cash refund 452 settles ten 40-dollar pallets without treating tax as extra pallets', () => {
  for (const qty of [10, 100]) {
    const s = historicalCashCredit(qty); const r = core.build(s);
    assert.equal(r.verified, true, JSON.stringify(r.issues));
    assert.equal(r.allocations[0].refunded, qty); assert.equal(r.allocations[0].available, 0); assert.equal(r.allocations[0].rate, 4000);
    assert.equal(r.events[0].amount, qty * 4000, 'cash principal remains net even when the historical refund included tax');
    assert.match(r.events[0].returnRef, /FULL-CREDIT-TAX-INCLUDED/);
    assert.deepEqual(plain(core.build(s)), plain(r), 'rerunning cannot deduct the same return again');
  }
});
test('historical gross-cash inference requires a fully posted pure credit with one leg and sufficient original cash capacity', () => {
  assert.equal(core.build(historicalCashCredit()).verified, true);
  for (const change of [
    s => { s.credits[0].refunds[0].amount -= 1; },
    s => { s.credits[0].refunds[0].posted = false; },
    s => { s.credits[0].mixed = true; },
    s => { s.credits[0].onAccount = 1; },
    s => { s.credits[0].refunds.push(refund({ id: '401', method: '1', amount: 1 })); },
    s => { s.payments[0].amount = 20000; }
  ]) {
    const s = historicalCashCredit(); change(s); const r = core.build(s);
    assert.equal(r.verified, false); assert.equal(r.events.length, 0);
  }
  const s = historicalCashCredit(); s.credits[0].refunds[0].amount = 40000;
  const r = core.build(s); assert.equal(r.verified, true); assert.equal(r.allocations[0].refunded, 10);
  assert.doesNotMatch(r.events[0].returnRef, /TAX-INCLUDED/);
});
test('mixed credit needs explicit matching manual pallet amount', () => {
  const s = sample(); s.credits = [credit({ mixed: true, refunds: [refund({ amount: 10000 })] })]; s.physical = 5;
  assert.equal(core.build(s).verified, false);
  const key = core.build(sample()).allocations.find(a => a.method === '5').key;
  s.manual = [{ id: '500', allocation: key, credit: '300', refund: '400', returnRef: 'R-1', qty: 1, amount: 4520, status: 'COMPLETED' }];
  assert.equal(core.build(s).verified, true);
});
test('review blocks unknown card, wrong card, unmatched credit and physical mismatch', () => {
  const cases = [s => { s.payments[1].memo = 'SOB123456'; },
    s => { s.credits = [credit({ refunds: [refund({ memo: 'CMB123456 / 9999' })] })]; s.physical = 5; },
    s => { s.credits = [credit()]; s.physical = 5; }, s => { s.physical = 7; }];
  for (const change of cases) { const s = sample(); change(s); const r = core.build(s); assert.equal(r.verified, false); assert.ok(r.issues.length); }
});
test('duplicate manual reference and excess reservation cannot publish', () => {
  const s = sample(); const key = core.build(s).allocations.find(a => a.method === '5').key;
  const row = { id: '500', allocation: key, credit: '', refund: '', returnRef: 'R-1', qty: 1, amount: 4520, status: 'PENDING' };
  s.manual = [row, { ...row, id: '501' }];
  assert.equal(core.build(s).verified, false);
  s.manual = [{ ...row, qty: 2, amount: 9040 }];
  assert.equal(core.build(s).verified, false);
});
test('property: integer cash flooring and full funding hold for every tested cash amount', () => {
  for (let amount = 0; amount <= 28000; amount += 137) {
    const r = core.build(sample(amount));
    const cash = r.allocations.filter(a => a.method === '1').reduce((v, a) => v + a.qty, 0);
    assert.equal(cash, Math.min(6, Math.floor(amount / 4000)));
    assert.equal(r.allocations.reduce((v, a) => v + a.qty, 0), 6);
    assert.equal(r.verified, true);
  }
});
test('property: card punctuation normalization is idempotent for all zero-prefixed card tails', () => {
  for (let i = 0; i < 1000; i += 7) {
    const digits = String(i).padStart(4, '0');
    const parsed = core.card('5', `SOB123456 / ${digits}`);
    assert.equal(parsed.last4, digits);
    assert.equal(core.card('5', parsed.normalized).last4, digits);
  }
});
test('an actual refund cannot silently remain classified as an unrelated pending method', () => {
  const s = sample(); const key = core.build(s).allocations.find(a => a.method === '1').key;
  s.credits = [credit({ refunds: [refund()] })]; s.physical = 5;
  s.manual = [{ id: '500', allocation: key, credit: '300', refund: '', returnRef: 'R-1', qty: 1, amount: 4000, status: 'PENDING' }];
  const r = core.build(s);
  assert.equal(r.verified, false);
  assert.ok(r.issues.some(value => value.startsWith('PENDING_REFUND_REQUIRES_COMPLETION')));
});
test('duplicate credit-to-refund application rows are rejected', () => {
  const s = sample(); s.credits = [credit({ refunds: [refund(), refund()] })]; s.physical = 5;
  assert.equal(core.build(s).verified, false);
});
test('source scope cannot mix customers, subsidiaries or currencies', () => {
  for (const field of ['customer', 'subsidiary', 'currency']) {
    const s = sample(); s.payments[0][field] = '2';
    assert.equal(core.build(s).verified, false);
  }
});
test('reversed reservation releases its prior allocation', () => {
  const s = sample(); const key = core.build(s).allocations[0].key;
  s.manual = [{ id: '500', allocation: key, status: 'REVERSED', qty: 5, amount: 20000, returnRef: 'R-1' }];
  const r = core.build(s); assert.equal(r.verified, true); assert.equal(r.allocations[0].available, 5);
});
test('a later receipt cannot finance an earlier historical pallet refund', () => {
  const s = sample(); s.payments[1].date = '2026-03-01';
  s.credits = [credit({ refunds: [refund()] })]; s.physical = 5;
  assert.equal(core.build(s).verified, false);
});
test('reviewed on-account credits consume pallets once without creating a refund', () => {
  const s = sample(); const key = core.build(s).allocations[0].key;
  s.credits = [credit({ onAccount: 4520 })]; s.physical = 5;
  s.manual = [{ id: '500', allocation: key, credit: '300', refund: '', returnRef: 'AR-CM300', qty: 1, amount: 4000, status: 'APPLIED' }];
  const r = core.build(s);
  assert.equal(r.verified, true); assert.equal(r.allocations[0].refunded, 1); assert.equal(r.events.length, 0);
  s.credits[0].onAccount = 3999;
  assert.equal(core.build(s).verified, false, 'actual AR application must cover the selected pallet value');
});
test('one completed and one pending method on the same credit retain a valid split', () => {
  const s = sample(); const lots = core.build(s).allocations;
  s.credits = [credit({ qty: 2, refunds: [refund()] })]; s.physical = 4;
  s.manual = [
    { id: '500', allocation: lots[0].key, credit: '300', refund: '', returnRef: 'R-1', qty: 1, amount: 4000, status: 'PENDING' },
    { id: '501', allocation: lots[1].key, credit: '300', refund: '400', returnRef: 'R-1', qty: 1, amount: 4520, status: 'COMPLETED' }
  ];
  const r = core.build(s); assert.equal(r.verified, true); assert.equal(r.allocations[0].pending, 1);
  assert.equal(r.allocations[1].refunded, 1);
});
