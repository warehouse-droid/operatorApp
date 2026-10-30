const assert = require('node:assert/strict');
const test = require('node:test');
const { load, config, queueFixture, watchFixture, rec } = require('./refresh-fixture.cjs');
const tokens = f => Array.from(f.api.due(), row => row.token);
test('capture is durable before dispatch and submission uses the single writer with explicit live queue parameters', () => {
  const f = queueFixture(); assert.deepEqual(tokens(f), []); assert.equal(f.api.kick(), false);
  f.api.enqueue('5240', 'customerpayment:201:edit'); assert.equal(f.rows.size, 1);
  assert.equal(f.api.kick(), true); assert.equal(f.rows.size, 1);
  const submission = f.calls.find(c => c[0] === 'submit')[1];
  assert.equal(submission.taskType, 'MAPREDUCE'); assert.equal(submission.scriptId, 'customscript_ppa_rebuild');
  assert.equal(submission.deploymentId, 'customdeploy_ppa_rebuild');
  assert.equal(submission.params.custscript_ppa_dry_run, false);
  assert.equal(submission.params.custscript_ppa_queue_only, true);
  assert.equal(submission.params.custscript_ppa_customer, '');
  assert.ok(f.calls.findIndex(c => c[0] === 'save') < f.calls.findIndex(c => c[0] === 'submit'));
});
test('acknowledgement removes only captured customer tokens; newer events and other customers survive and retry is idempotent', () => {
  const f = queueFixture(); f.api.enqueue('1', 'invoice:100:edit'); f.api.enqueue('2', 'invoice:101:edit');
  const batch = tokens(f); f.api.enqueue('1', 'customerrefund:400:create');
  f.api.acknowledge('1', batch); assert.deepEqual([...f.rows.keys()], ['2', '3']);
  f.api.acknowledge('1', batch); assert.deepEqual([...f.rows.keys()], ['2', '3']);
  f.api.acknowledge('1', []); assert.equal(f.rows.size, 2);
});
test('failure keeps events pending until retry delay and does not defer a newer event or another customer', () => {
  const f = queueFixture(); f.api.enqueue('1', 'invoice:100:edit'); f.api.enqueue('2', 'invoice:101:edit');
  const batch = tokens(f); f.api.enqueue('1', 'creditmemo:300:create');
  f.api.defer('1', batch, new Error('INVALID_FLD_VALUE'));
  assert.deepEqual(tokens(f), ['2', '3']); assert.equal(f.rows.size, 3);
  assert.match(f.rows.get('1')[config.queueFields.error], /INVALID_FLD_VALUE/);
  f.advance(14); assert.deepEqual(tokens(f), ['2', '3']); f.advance(1); assert.deepEqual(tokens(f), ['1', '2', '3']);
});
test('busy and denied submissions never clear the queue and report the appropriate dispatch state', () => {
  const f = queueFixture(); f.api.enqueue('1', 'salesorder:90:edit');
  f.failSubmit(Object.assign(new Error('already running'), { name: 'MAP_REDUCE_ALREADY_RUNNING' }));
  assert.equal(f.api.kick(), false); assert.equal(f.rows.size, 1);
  assert.ok(f.logs.some(row => row.title === 'PALLET REFRESH WAITING'));
  f.failSubmit(new Error('PERMISSION_VIOLATION')); assert.equal(f.api.kick(), false); assert.equal(f.rows.size, 1);
  assert.ok(f.logs.some(row => row.title === 'PALLET REFRESH DISPATCH FAILED' && row.level === 'error'));
});
test('bounded queue batches, valid IDs, wrong-account refusal and partial acknowledgement protect the queue', () => {
  const f = queueFixture();
  for (let i = 0; i < 53; i++) { f.api.enqueue('1', 'invoice:100:edit'); }
  assert.equal(tokens(f).length, 50); f.failDeleteOnce(); assert.throws(() => f.api.acknowledge('1', tokens(f)), /ACK_FAILED/);
  assert.equal(f.rows.size, 53); f.api.acknowledge('1', tokens(f)); assert.deepEqual(tokens(f), ['51', '52', '53']);
  assert.throws(() => f.api.enqueue('1 OR 1=1', 'x'), /INVALID_INTERNAL_ID/);
  assert.throws(() => f.api.acknowledge('1', ['bad']), /INVALID_INTERNAL_ID/);
  f.account('999'); assert.throws(() => f.api.enqueue('1', 'x'), /WRONG_NETSUITE_ACCOUNT/);
  assert.throws(() => f.api.acknowledge('1', ['51']), /WRONG_NETSUITE_ACCOUNT/); assert.equal(f.rows.size, 3);
});
test('queue write failure is visible and cannot submit a task without a captured event', () => {
  const f = queueFixture(); f.failWrite(new Error('NO_QUEUE_PERMISSION'));
  assert.throws(() => f.api.enqueue('1', 'invoice:100:edit'), /NO_QUEUE_PERMISSION/);
  assert.equal(f.rows.size, 0); assert.equal(f.calls.filter(c => c[0] === 'submit').length, 0);
});
test('queue rejects another writer and oversized acknowledgement; self-resubmission can legitimately return no task ID', () => {
  const f = queueFixture(); f.api.enqueue('1', 'invoice:100:edit');
  assert.throws(() => f.api.acknowledge('1', Array.from({ length: 51 }, (_, i) => String(i + 1))), /QUEUE_BATCH_LIMIT/);
  f.deployment('customdeploy_other'); assert.throws(() => f.api.acknowledge('1', ['1']), /USE_SINGLE_DESIGNATED_DEPLOYMENT/);
  assert.throws(() => f.api.defer('1', ['1'], new Error('x')), /USE_SINGLE_DESIGNATED_DEPLOYMENT/); assert.equal(f.rows.size, 1);
  f.deployment(config.writerDeployment); f.taskId(undefined); assert.equal(f.api.kick(), true);
  assert.ok(f.logs.some(row => String(row.details).includes('Continuation')));
});
for (const [type, customerField] of Object.entries({ salesorder: 'entity', invoice: 'entity', creditmemo: 'entity',
  customerpayment: 'customer', customerrefund: 'customer', customerdeposit: 'customer', depositapplication: 'customer' })) {
  test(`User Event captures create/edit for ${type} and queues before kicking`, () => {
    const f = watchFixture(); const source = rec(type, '100', { [customerField]: '5240' });
    f.api.afterSubmit({ type: 'create', newRecord: source });
    assert.deepEqual(f.calls.map(c => c[0]), ['enqueue', 'kick']); assert.equal(f.calls[0][1], '5240');
    f.calls.length = 0; f.api.afterSubmit({ type: 'edit', oldRecord: source, newRecord: source });
    assert.deepEqual(f.calls.map(c => c[0]), ['enqueue', 'kick']);
  });
}
test('customer reassignment refreshes both owners; partial xedit loads current values and delete uses oldRecord', () => {
  const f = watchFixture();
  f.api.afterSubmit({ type: 'edit', oldRecord: rec('salesorder', '90', { entity: '1' }), newRecord: rec('salesorder', '90', { entity: '2' }) });
  assert.deepEqual(f.calls.filter(c => c[0] === 'enqueue').map(c => c[1]).sort(), ['1', '2']);
  f.calls.length = 0; f.records.set('customerpayment:201', rec('customerpayment', '201', { customer: '2' }));
  f.api.afterSubmit({ type: 'xedit', newRecord: rec('customerpayment', '201', { memo: 'SOB11111 / 1234' }) });
  assert.deepEqual(f.calls.map(c => c[0]), ['load', 'enqueue', 'kick']); assert.equal(f.calls[1][1], '2');
  f.calls.length = 0; f.api.afterSubmit({ type: 'delete', oldRecord: rec('customerrefund', '400', { customer: '2' }) });
  assert.deepEqual(f.calls.map(c => c[0]), ['enqueue', 'kick']);
});
test('native xedit empty-string omissions are distinguished from present fields using getFields', () => {
  const f = watchFixture(); f.records.set('customerpayment:201', rec('customerpayment', '201', { customer: '1' }));
  const partial = { type: 'customerpayment', id: '201', getFields() { return ['memo']; }, getValue() { return ''; } };
  f.api.afterSubmit({ type: 'xedit', newRecord: partial });
  assert.deepEqual(f.calls.map(c => c[0]), ['load', 'enqueue', 'kick']);
  assert.equal(f.calls[1][1], '1'); assert.equal(f.logs.length, 0);
});
test('manual allocation changes refresh old and new customers while generated refund rows never recurse', () => {
  const f = watchFixture(); const R = config.refundFields; const A = config.allocationFields;
  f.records.set(`${config.allocationType}:700`, rec(config.allocationType, '700', { [A.customer]: '1' }));
  f.records.set(`${config.allocationType}:701`, rec(config.allocationType, '701', { [A.customer]: '2' }));
  f.api.afterSubmit({ type: 'edit', oldRecord: rec(config.refundType, '800', { externalid: '', [R.allocationId]: '700' }),
    newRecord: rec(config.refundType, '800', { externalid: '', [R.allocationId]: '701' }) });
  assert.deepEqual(f.calls.filter(c => c[0] === 'enqueue').map(c => c[1]).sort(), ['1', '2']);
  f.calls.length = 0;
  f.api.afterSubmit({ type: 'create', newRecord: rec(config.refundType, '801', { externalid: 'PRA1-auto', [R.allocationId]: '700' }) });
  assert.deepEqual(f.calls, []);
  f.records.set(`${config.refundType}:801`, rec(config.refundType, '801', { externalid: 'PRA1-auto', [R.allocationId]: '700' }));
  f.api.afterSubmit({ type: 'xedit', newRecord: rec(config.refundType, '801', { [R.status]: 'REVERSED' }) });
  assert.equal(f.calls.filter(c => c[0] === 'enqueue').length, 0);
});
test('manual allocation xedit can include externalid but omit its allocation link and still refresh the linked customer', () => {
  const f = watchFixture(); const R = config.refundFields; const A = config.allocationFields;
  f.records.set(`${config.refundType}:800`, rec(config.refundType, '800', { externalid: 'manual-reference', [R.allocationId]: '700' }));
  f.records.set(`${config.allocationType}:700`, rec(config.allocationType, '700', { [A.customer]: '1' }));
  const partial = rec(config.refundType, '800', { externalid: 'manual-reference' });
  partial.getFields = () => ['externalid'];
  f.api.afterSubmit({ type: 'xedit', newRecord: partial });
  assert.deepEqual(f.calls.filter(c => c[0] === 'enqueue').map(c => c[1]), ['1']); assert.equal(f.logs.length, 0);
});
test('a manual allocation whose original lot has no customer is reported as a capture failure', () => {
  const f = watchFixture(); f.records.set(`${config.allocationType}:700`, rec(config.allocationType, '700', {}));
  f.api.afterSubmit({ type: 'delete', oldRecord: rec(config.refundType, '800', { externalid: '', [config.refundFields.allocationId]: '700' }) });
  assert.equal(f.calls.filter(c => c[0] === 'enqueue').length, 0);
  assert.ok(f.logs.some(row => String(row.details).includes('ALLOCATION_CUSTOMER_MISSING')));
});
test('capture failures log record identity, keep transaction committed and do not prevent another affected customer capture', () => {
  const f = watchFixture(); f.fail('1');
  assert.doesNotThrow(() => f.api.afterSubmit({ type: 'edit', oldRecord: rec('invoice', '100', { entity: '1' }),
    newRecord: rec('invoice', '100', { entity: '2' }) }));
  assert.deepEqual(f.calls.filter(c => c[0] === 'enqueue').map(c => c[1]), ['2']);
  assert.ok(f.logs.some(row => row.title === 'PALLET REFRESH CAPTURE FAILED' && String(row.details).includes('100')));
  f.calls.length = 0;
  assert.doesNotThrow(() => f.api.afterSubmit({ type: 'delete', oldRecord: rec('invoice', '101', {}) }));
  assert.equal(f.calls.length, 0); assert.ok(f.logs.length >= 2);
});
test('unrelated records and events are ignored; approvals/cancellation trigger a refresh', () => {
  const f = watchFixture(); f.api.afterSubmit({ type: 'view', newRecord: rec('invoice', '100', { entity: '1' }) });
  f.api.afterSubmit({ type: 'edit', newRecord: rec('vendorbill', '100', { entity: '1' }) });
  assert.deepEqual(f.calls, []);
  for (const type of ['approve', 'cancel', 'reject']) { f.api.afterSubmit({ type, newRecord: rec('salesorder', '90', { entity: '1' }) }); }
  assert.equal(f.calls.filter(c => c[0] === 'enqueue').length, 3);
});
test('capture logs missing manual links and unexpected dispatch errors without throwing after a saved transaction', () => {
  const f = watchFixture(); f.api.afterSubmit({ type: 'create' });
  f.api.afterSubmit({ type: 'delete', oldRecord: rec(config.refundType, '800', { externalid: '' }) });
  assert.ok(f.logs.some(row => String(row.details).includes('MANUAL_ALLOCATION_LINK_MISSING')));
  const logs = []; const api = load('ppa_watch_ue', { 'N/record': {}, 'N/log': { error(row) { logs.push(row); } },
    './ppa_config': config, './ppa_refresh_queue': { enqueue() {}, kick() { throw new Error('QUEUE_SEARCH_DENIED'); } } });
  assert.doesNotThrow(() => api.afterSubmit({ type: 'edit', newRecord: rec('invoice', '100', { entity: '1' }) }));
  assert.ok(logs.some(row => String(row.details).includes('QUEUE_SEARCH_DENIED')));
});
test('scheduled dispatcher retries durable work and exposes failures', () => {
  let calls = 0; let fail = false; const logs = [];
  const api = load('ppa_dispatch_ss', { './ppa_refresh_queue': { kick() { calls++; if (fail) { throw new Error('QUEUE_UNAVAILABLE'); } } },
    'N/log': { error(row) { logs.push(row); } } });
  api.execute(); assert.equal(calls, 1); fail = true; assert.throws(() => api.execute(), /QUEUE_UNAVAILABLE/);
  assert.match(logs[0].title, /DISPATCH FAILED/);
});
function mrFixture() {
  const calls = []; const logs = []; const parameters = { custscript_ppa_queue_only: true, custscript_ppa_dry_run: false };
  let fail = false; let deferFail = false;
  const queue = { due() { return [{ customer: '1', token: '10' }, { customer: '1', token: '11' }]; },
    acknowledge(customer, values) { calls.push(['ack', customer, Array.from(values)]); },
    defer(customer, values, error) { calls.push(['defer', customer, Array.from(values), error.message]); if (deferFail) { throw new Error('DEFER_FAILED'); } },
    kick() { calls.push(['kick']); } };
  const io = { customers() { throw new Error('QUEUE_MUST_NOT_SCAN_ALL_CUSTOMERS'); } };
  const service = { refresh(_io, customer, dry) { calls.push(['refresh', customer, dry]); if (fail) { throw new Error('REBUILD_FAILED'); }
    return { verified: false, issued: 6, credited: 0, physical: 6, allocations: [], events: [], issues: ['REVIEW'] }; } };
  const runtime = { getCurrentScript() { return { getParameter({ name }) { return parameters[name]; } }; } };
  const log = { audit(row) { logs.push({ level: 'audit', ...row }); }, error(row) { logs.push({ level: 'error', ...row }); } };
  const api = load('ppa_rebuild_mr', { 'N/runtime': runtime, 'N/log': log, './ppa_netsuite': io, './ppa_service': service, './ppa_refresh_queue': queue });
  return { api, calls, logs, parameters, fail() { fail = true; }, deferFail() { deferFail = true; },
    kickFail() { queue.kick = () => { throw new Error('QUEUE_LOOKUP_FAILED'); }; } };
}
test('queue MR groups captured tokens and acknowledges REVIEW only after a persistent rebuild', () => {
  const f = mrFixture(); assert.equal(f.api.getInputData().length, 2); const writes = [];
  for (const row of f.api.getInputData()) { f.api.map({ value: JSON.stringify(row), write(value) { writes.push(value); } }); }
  assert.deepEqual(writes.map(row => row.key), ['1', '1']);
  f.api.reduce({ key: '1', values: writes.map(row => row.value), write(value) { writes.push(value); } });
  assert.deepEqual(f.calls, [['refresh', '1', false], ['ack', '1', ['10', '11']]]);
  assert.equal(writes.at(-1).value, 'REVIEW');
});
test('failed queue rebuild defers captured tokens; preview does not mutate queue; defer errors preserve original failure', () => {
  const f = mrFixture(); f.fail();
  assert.throws(() => f.api.reduce({ key: '1', values: ['10'], write() {} }), /REBUILD_FAILED/);
  assert.deepEqual(f.calls[1], ['defer', '1', ['10'], 'REBUILD_FAILED']); assert.ok(!f.calls.some(c => c[0] === 'ack'));
  const g = mrFixture(); g.parameters.custscript_ppa_dry_run = true;
  g.api.reduce({ key: '1', values: ['10'], write() {} }); assert.deepEqual(g.calls, [['refresh', '1', true]]);
  g.fail(); assert.throws(() => g.api.reduce({ key: '1', values: ['10'], write() {} }), /REBUILD_FAILED/);
  assert.ok(!g.calls.some(c => ['ack', 'defer'].includes(c[0])));
  const h = mrFixture(); h.fail(); h.deferFail(); assert.throws(() => h.api.reduce({ key: '1', values: ['10'], write() {} }), /REBUILD_FAILED/);
  assert.ok(h.logs.some(row => row.title === 'PALLET QUEUE RETRY FAILED'));
});
function summary(error) {
  const stage = { errors: { iterator() { return { each(callback) { if (error) { callback('5240', 'INVALID_FLD_VALUE'); } } }; } } };
  return { inputSummary: {}, mapSummary: stage, reduceSummary: stage,
    output: { iterator() { return { each(callback) { callback('1', 'VERIFIED'); callback('2', 'REVIEW'); } }; } } };
}
test('summary distinguishes errors from completed customers and checks pending work only after a live successful queue pass', () => {
  const f = mrFixture(); f.api.summarize(summary(true));
  assert.ok(f.logs.some(row => row.level === 'error' && row.title === 'Pallet rebuild finished with errors'));
  assert.ok(!f.logs.some(row => row.title === 'Pallet rebuild finished'));
  assert.ok(!f.calls.some(c => c[0] === 'kick'));
  const g = mrFixture(); g.api.summarize(summary(false)); assert.deepEqual(g.calls, [['kick']]);
  const data = JSON.parse(g.logs.find(row => row.title === 'Pallet rebuild finished').details);
  assert.equal(data.verified, 1); assert.equal(data.review, 1); assert.equal(data.errors, 0);
  const h = mrFixture(); h.parameters.custscript_ppa_dry_run = true; h.api.summarize(summary(false)); assert.deepEqual(h.calls, []);
  const i = mrFixture(); i.kickFail(); i.api.summarize(summary(false));
  assert.ok(i.logs.some(row => row.title === 'PALLET REFRESH DISPATCH FAILED' && row.level === 'error'));
});
