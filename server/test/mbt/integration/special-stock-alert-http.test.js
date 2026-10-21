import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb } from '../../../src/db.js';
import { getSpecialStockAlertCounts } from '../../../src/special-stock-alerts.js';
import { pdfText } from '../../field-sales/pdf-text.js';
import { specialSalesReps } from '../../../src/special-stock-sales-reps.js';

const originalRepSelection=specialSalesReps.select;
const sessions = {}, users = [], cases = [], run = crypto.randomUUID();
const endpoint = '/api/scm/special-stock-requests/alerts';
const draft = () => ({ salesRepId:123, storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Alert Quote Customer',
  vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
  lines: [{ productName: 'TEST slab', quantity: 2, uom: 'PLT', rate: 10, requiredDate: '2099-02-01',palletQty:2,layerQty:3.5,sectionQty:4,pieceQty:6 }] });
let server, base, originalFlag;
const request = (path, role, body) => fetch(base + path, {
  method: body ? 'POST' : 'GET',
  headers: { ...(role ? { Authorization: `Bearer ${sessions[role].token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined
});
before(async () => {
  specialSalesReps.select=async id=>{assert.equal(Number(id),123);return {id:123,name:'TEST Selected Rep'};};
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
  originalFlag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name,role] of [['requester','sales'],['viewer','sales'],['scm','scm'],['admin','admin'],['dispatcher','dispatcher']]) {
    const username = `special-alert-${name}-${run}`;
    await createOperator({ username, displayName: `TEST ${name} Rep`, password: 'test-special-alert-isolated-only', role, roles: [role], yardLocationIds: role === 'sales' ? [1] : [] });
    users.push(username);
    const response = await request('/api/auth/login', null, { username, password: 'test-special-alert-isolated-only' });
    assert.equal(response.status, 200);
    sessions[name] = await response.json();
  }
});
after(async () => {
  specialSalesReps.select=originalRepSelection;
  if (server) await new Promise(resolve => server.close(resolve));
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [cases]);
  await query('DELETE FROM operators WHERE username=ANY($1::text[])', [users]);
  if (originalFlag !== undefined) await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [originalFlag]);
  await closeDb();
});

test('alert counts use the existing SCM read permissions and return only uncached counts', async () => {
  assert.equal((await request(endpoint)).status, 401);
  assert.equal((await request(endpoint, 'requester')).status, 403);
  for (const role of ['scm','admin','dispatcher']) {
    const response = await request(endpoint, role);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), await getSpecialStockAlertCounts());
  }
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  try { assert.equal((await request(endpoint, 'scm')).status, 404); }
  finally { await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'"); }
});

test('Sales Rep directory route requires Sales access and returns live directory choices without caching', async () => {
  const original = specialSalesReps.list;
  const path = '/api/sales/special-stock-requests/sales-reps';
  let lookups = 0;
  specialSalesReps.list = async () => { lookups++; return [{id:123,name:'TEST NetSuite rep'}]; };
  try {
    assert.equal((await request(path)).status,401);
    assert.equal((await request(path,'scm')).status,403);
    assert.equal(lookups,0);
    const response=await request(path,'requester');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(await response.json(),{salesReps:[{id:123,name:'TEST NetSuite rep'}]});
    assert.equal(lookups,1);
  } finally { specialSalesReps.list = original; }
});

test('new submissions update counts and saved PDFs credit the selected Sales Rep through Sales and SCM routes', async () => {
  const initial = await getSpecialStockAlertCounts();
  const response = await request('/api/sales/special-stock-requests', 'requester', draft());
  assert.equal(response.status, 201);
  const detail = await response.json(); cases.push(detail.id);
  const counts = await (await request(endpoint, 'scm')).json();
  assert.deepEqual(counts, { newRequests: initial.newRequests + 1, confirmedOrders: initial.confirmedOrders, total: initial.total + 1 });
  for (const [audience,role] of [['sales','viewer'],['scm','scm']]) {
    const pdf = await request(`/api/${audience}/special-stock-requests/${detail.id}/quote.pdf`, role);
    assert.equal(pdf.status, 200);
    const text = pdfText(Buffer.from(await pdf.arrayBuffer()));
    assert.match(text, /TEST Selected Rep/);
    assert(text.includes('AmountPLTSECLYRPCS'));assert(text.includes('20.00243.56'));
    assert.doesNotMatch(text, /TEST viewer Rep|TEST scm Rep/);
  }
  const creator = (await query('SELECT requested_by FROM sales_stock_requests WHERE id=$1', [detail.id])).rows[0].requested_by;
  assert.equal(creator, sessions.requester.operator.id);
  const preview = await request('/api/sales/special-stock-requests/quote-preview', 'viewer', { ...draft(), requestedByName: 'Spoofed rep' });
  assert.equal(preview.status, 200);
  const text = pdfText(Buffer.from(await preview.arrayBuffer()));
  assert.match(text, /TEST Selected Rep/);
  assert(text.includes('AmountPLTSECLYRPCS'));assert(text.includes('20.00243.56'));
  assert.doesNotMatch(text, /Spoofed rep/);
});


test('batch routes enforce roles, save once, and reject one of two concurrent writes', async () => {
  const input=draft();input.lines.push({...input.lines[0],productName:'TEST second product'});
  let response=await request('/api/sales/special-stock-requests','requester',input);
  assert.equal(response.status,201);const d=await response.json();cases.push(d.id);
  const path=`/api/scm/special-stock-requests/${d.id}/stock-check`;
  const body={expectedRevision:d.revision,lines:d.lines.map(line=>({lineId:line.id,kind:'response',supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:8899200,vendorName:'TEST Vendor',vendorYard:'TEST yard'}))};
  assert.equal((await request(path,null,body)).status,401);
  assert.equal((await request(path,'requester',body)).status,403);
  const attempts=await Promise.all([request(path,'scm',body),request(path,'scm',body)]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  const saved=await attempts.find(r=>r.status===200).json();assert.equal(saved.revision,d.revision+1);
  assert.deepEqual(saved.lines.map(l=>l.supplyStatus),['in_stock','in_stock']);
  response=await request(`/api/sales/special-stock-requests/${d.id}/customer-decisions`,'requester',{expectedRevision:saved.revision,lines:saved.lines.map(line=>({lineId:line.id,decision:'accepted'}))});
  assert.equal(response.status,200);const decided=await response.json();assert.equal(decided.revision,d.revision+2);
  assert.deepEqual(decided.lines.map(l=>l.salesDecision),['accepted','accepted']);
});
