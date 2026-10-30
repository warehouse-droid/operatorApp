// Run through `docker exec -i ... node --input-type=module - <mode>`.
// This is an operator-authorized maintenance operation, never a test fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '/app/src/config.js';
import { getNetSuiteM2mAccessToken, isNetSuiteM2mActive } from '/app/src/netsuite-m2m-runtime.js';
import { fetchPickingTicketFromNetSuite } from '/app/src/netsuite.js';
import { closeDb } from '/app/src/db.js';

const auditDir = '/app/data/operational-audit/sob123453-null-packs-20261026';
const fields = ['custcol_plt', 'custcol_sec', 'custcol_lyr', 'custcol_pcs'];
const path = '/record/v1/salesOrder/1091569';
const write = (name, value) => fs.writeFileSync(`${auditDir}/${name}.json`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const read = name => JSON.parse(fs.readFileSync(`${auditDir}/${name}.json`, 'utf8'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => k !== 'links').map(k => [k, plain(value[k])]));
  return value;
}
function invariants(record) {
  const headers = ['id', 'tranId', 'externalId', 'entity', 'subsidiary', 'currency', 'exchangeRate', 'status', 'orderStatus',
    'subtotal', 'total', 'taxTotal', 'tax2Total', 'shippingCost', 'handlingCost', 'discountItem', 'discountRate', 'discountTotal',
    'memo', 'location', 'salesRep', 'shippingAddress', 'billingAddress'];
  return plain({ header: Object.fromEntries(headers.filter(k => Object.hasOwn(record, k)).map(k => [k, record[k]])),
    lines: record.item.items.map(line => Object.fromEntries(Object.entries(line).filter(([k]) => !fields.includes(k)))) });
}
function identity(record) {
  assert.equal(String(record.id), '1091569');
  assert.equal(record.tranId, 'SOB123453');
  assert.equal(record.externalId, 'MBBS-SPECIAL-SO:348');
  assert.equal(record.item.items.length, 8);
}
async function request(method = 'GET', body) {
  assert.equal(await isNetSuiteM2mActive(), true);
  const base = new URL(config.netsuite.restBaseUrl);
  assert.equal(base.protocol, 'https:');
  assert.equal(base.hostname, '6518947.suitetalk.api.netsuite.com');
  const response = await fetch(config.netsuite.restBaseUrl + path + (method === 'GET' ? '?expandSubResources=true' : ''), {
    method, signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${await getNetSuiteM2mAccessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  assert.ok(response.ok, `NetSuite ${method} failed (${response.status}): ${text}`);
  return { status: response.status, record: text ? JSON.parse(text) : null };
}
function checkPacks(before, after) {
  for (const line of before.item.items) {
    const next = after.item.items.find(l => l.line === line.line);
    for (const field of fields) {
      if (line[field] != null && Number(line[field]) === 0) assert.equal(next[field] ?? null, null, `${line.line}.${field} must be blank`);
      else assert.deepEqual(next[field], line[field], `${line.line}.${field} changed`);
    }
  }
}

try {
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const mode = process.argv[2];
  if (mode === 'prepare') {
    const { record } = await request(); identity(record);
    const items = record.item.items.map(line => ({ line: line.line,
      ...Object.fromEntries(fields.filter(f => line[f] != null && Number(line[f]) === 0).map(f => [f, null]))
    })).filter(line => Object.keys(line).length > 1);
    const count = items.reduce((n, line) => n + Object.keys(line).length - 1, 0);
    assert.equal(count, 16); assert.equal(items.length, 5);
    assert.deepEqual(record.item.items.filter(l => l.custcol_plt > 0 || l.custcol_lyr > 0)
      .map(l => [l.line, l.custcol_plt, l.custcol_lyr]), [[1, 0, 4], [2, 1, 0], [3, 2, 0], [4, 1, 0]]);
    write('before', record); write('patch', { item: { items } });
    console.log(JSON.stringify({ prepared: true, order: record.tranId, zeroFields: count, lines: items.length, total: record.total, auditDir }));
  } else if (mode === 'apply') {
    assert.ok(!fs.existsSync(`${auditDir}/attempt.json`), 'A write was already attempted; inspect before considering any retry.');
    const before = read('before'), patch = read('patch'), { record: current } = await request();
    identity(current); assert.deepEqual(plain(current), plain(before), 'Order changed since preparation; stop and reconcile.');
    write('attempt', { at: new Date().toISOString(), path, method: 'PATCH', patchHash: digest(JSON.stringify(patch)) });
    let result;
    try { result = await request('PATCH', patch); }
    catch (error) { write('write-error', { at: new Date().toISOString(), message: error.message }); throw error; }
    write('response', { status: result.status, at: new Date().toISOString() });
    const { record: after } = await request(); identity(after); write('after', after);
    assert.deepEqual(invariants(after), invariants(before)); checkPacks(before, after);
    const summary = { verified: true, order: after.tranId, clearedFields: 16, lines: 5, allLineDetailsAndFinancialsPreserved: true,
      totalBefore: before.total, totalAfter: after.total, at: new Date().toISOString() };
    write('verification', summary); console.log(JSON.stringify(summary));
  } else if (mode === 'pdf') {
    const { record } = await request(); identity(record);
    const ticket = await fetchPickingTicketFromNetSuite(1091569, { filenamePrefix: 'SOB123453' });
    process.stdout.write(ticket.buffer);
  } else if (mode === 'verify') {
    const before = read('before'), { record: after } = await request(); identity(after);
    assert.deepEqual(invariants(after), invariants(before)); checkPacks(before, after);
    console.log(JSON.stringify({ verified: true, total: after.total, remainingZeroPackFields: 0,
      positivePacks: after.item.items.filter(l => fields.some(f => l[f] > 0)).map(l => ({ line: l.line, ...Object.fromEntries(fields.map(f => [f, l[f] ?? null])) })) }));
  } else throw Error('Expected prepare, apply, verify, or pdf');
} finally { await closeDb(); }
