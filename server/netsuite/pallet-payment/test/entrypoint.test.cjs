const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture() {
  let api; const calls = []; const logs = []; let parameter = undefined;
  const runtime = { getCurrentScript() { return { getParameter({ name }) { return name === 'custscript_ppa_customer' ? '1' : parameter; } }; } };
  const io = { customers(value) { calls.push(['customers', value]); return [value]; } };
  const service = { refresh(receivedIo, customer, dryRun) { assert.equal(receivedIo, io); calls.push(['refresh', customer, dryRun]);
    return { verified: true, issued: 6, credited: 0, physical: 6, events: [], issues: [], allocations: [
      { invoice: '100', method: '5', last4: '0070', rate: 4520, qty: 6, pending: 0, refunded: 0, available: 6 }] }; } };
  const log = { audit(row) { logs.push(row); }, error(row) { logs.push(row); } };
  const filename = path.resolve(__dirname, '../ppa_rebuild_mr.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { define(_names, factory) { api = factory(runtime, log, io, service); } }, { filename });
  return { api, calls, logs, parameter(value) { parameter = value; } };
}
test('Map/Reduce groups one customer key and defaults to preview when configuration is absent', () => {
  const f = fixture(); assert.deepEqual(Array.from(f.api.getInputData()), ['1']);
  const writes = []; f.api.map({ value: '"1"', write(value) { writes.push(value); } });
  assert.equal(writes[0].key, '1');
  f.api.reduce({ key: '1', write(value) { writes.push(value); } });
  assert.deepEqual(f.calls[1], ['refresh', '1', true]);
  const data = JSON.parse(f.logs[0].details); assert.equal(data.preview[0].rate, 45.2);
  assert.equal(writes[1].value, 'VERIFIED');
});
test('only an explicitly unchecked preview flag enables ledger writes; summaries expose customer failures', () => {
  const f = fixture(); f.parameter(false); f.api.reduce({ key: '1', write() {} });
  assert.deepEqual(f.calls[0], ['refresh', '1', false]);
  const errors = { iterator() { return { each(callback) { assert.equal(callback('1', 'ERROR'), true); } }; } };
  f.api.summarize({ inputSummary: { error: 'INPUT_FAILED' }, mapSummary: { errors }, reduceSummary: { errors } });
  assert.ok(f.logs.some(row => row.title === 'PALLET INPUT FAILED'));
  assert.equal(f.logs.filter(row => row.title === 'PALLET CUSTOMER 1 FAILED').length, 2);
});
