const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(name, deps = {}, globals = {}) {
  let api;
  const filename = path.resolve(__dirname, `../${name}.js`);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    ...globals, define(names, factory) { api = factory(...names.map(key => deps[key])); }
  }, { filename, timeout: 1000 });
  return api;
}
const config = { ...load('ppa_config'), writerScript: 'customscript_ppa_rebuild',
  queueType: 'customrecord_pallet_refresh_queue', queueBatchSize: 50, queueRetryMinutes: 15,
  queueFields: { customer: 'custrecord_ppq_customer', retry: 'custrecord_ppq_retry_minute', error: 'custrecord_ppq_error' } };
function queueFixture() {
  const rows = new Map(); const calls = []; const logs = [];
  let next = 1; let minute = 30000000; let submitError; let writeError; let deleteError; let account = config.account;
  let deployment = config.writerDeployment; let taskId = 'task-1';
  const F = config.queueFields;
  function checkType(type) { assert.equal(type, config.queueType, 'queue may write only its own custom record type'); }
  const record = {
    create({ type }) {
      checkType(type); const data = { isinactive: false };
      return { setValue({ fieldId, value }) { data[fieldId] = value; }, save() {
        if (writeError) { throw writeError; } const id = String(next++); rows.set(id, data); calls.push(['save', id]); return id;
      } };
    },
    submitFields({ type, id, values }) {
      checkType(type); if (writeError) { throw writeError; } assert.ok(rows.has(String(id)));
      Object.assign(rows.get(String(id)), values); calls.push(['update', String(id)]);
    },
    delete({ type, id }) {
      checkType(type); if (deleteError) { const error = deleteError; deleteError = null; throw error; }
      assert.ok(rows.has(String(id))); rows.delete(String(id)); calls.push(['delete', String(id)]);
    }
  };
  function matches(row, id, f) {
    if (f[0] === 'isinactive') { return row.isinactive === false; }
    if (f[0] === F.retry) { return row[F.retry] <= Number(f[2]); }
    if (f[0] === F.customer) { return String(row[F.customer]) === String(f[2]); }
    if (f[0] === 'internalid') { return f[2].map(String).includes(id); }
    throw new Error(`Unmodelled filter: ${JSON.stringify(f)}`);
  }
  const search = { Sort: { ASC: 'ASC' }, createColumn(options) { return options; }, create(options) {
    checkType(options.type); calls.push(['search', options]);
    const filters = options.filters.filter(Array.isArray);
    assert.equal(options.columns[0].name, 'internalid'); assert.equal(options.columns[0].sort, 'ASC');
    return { run() { return { getRange({ start, end }) {
      assert.ok(end <= 1000);
      return [...rows.entries()].sort(([a], [b]) => Number(a) - Number(b))
        .filter(([id, row]) => filters.every(f => matches(row, id, f))).slice(start, end)
        .map(([id, row]) => ({ getValue({ name }) { return name === 'internalid' ? id : row[name]; } }));
    } }; } };
  } };
  const task = { TaskType: { MAP_REDUCE: 'MAPREDUCE' }, create(options) {
    calls.push(['submit', options]); return { submit() { if (submitError) { throw submitError; } return taskId; } };
  } };
  const runtime = { get accountId() { return account; }, getCurrentScript() { return { deploymentId: deployment }; } };
  const log = { audit(row) { logs.push({ level: 'audit', ...row }); }, error(row) { logs.push({ level: 'error', ...row }); } };
  class Clock extends Date { static now() { return minute * 60000; } }
  const deps = { 'N/record': record, 'N/search': search, 'N/task': task, 'N/runtime': runtime, 'N/log': log, './ppa_config': config };
  const api = load('ppa_refresh_queue', deps, { Date: Clock });
  return { api, rows, calls, logs, deps, config, minute: () => minute, advance(n) { minute += n; },
    failSubmit(error) { submitError = error; }, failWrite(error) { writeError = error; },
    failDeleteOnce() { deleteError = new Error('ACK_FAILED'); }, account(value) { account = value; },
    deployment(value) { deployment = value; }, taskId(value) { taskId = value; } };
}
function rec(type, id, fields = {}) {
  return { type, id: String(id), getValue({ fieldId }) { return fields[fieldId]; } };
}
function watchFixture() {
  const calls = []; const logs = []; const records = new Map(); let failed;
  const queue = { enqueue(customer, source) { if (failed === customer) { throw new Error('QUEUE_FAILED'); } calls.push(['enqueue', customer, source]); },
    kick() { calls.push(['kick']); } };
  const record = { load({ type, id }) { calls.push(['load', type, String(id)]); const found = records.get(`${type}:${id}`); assert.ok(found, `Unexpected load ${type}:${id}`); return found; } };
  const log = { error(row) { logs.push(row); } };
  const api = load('ppa_watch_ue', { 'N/record': record, 'N/log': log, './ppa_config': config, './ppa_refresh_queue': queue });
  return { api, calls, logs, records, fail(customer) { failed = customer; } };
}
module.exports = { load, config, queueFixture, watchFixture, rec };
