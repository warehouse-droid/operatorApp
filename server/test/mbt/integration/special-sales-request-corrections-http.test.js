import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';
import { pdfText } from '../../field-sales/pdf-text.js';

const run = crypto.randomUUID().replaceAll('-', ''), users = {}, cases = [];
let server, base, flag, originalFetch, originalPriceTrigger, remoteCalls = 0;
const migration = () => readFileSync(new URL('../../../migrations/249_special_case_line_edits.sql', import.meta.url), 'utf8');
const item = (name = 'Old item') => ({ productName: name, color: 'Grey', size: '80mm', detailSpec: 'Smooth',
  quantity: 3, uom: 'PLT', rate: 12.25, discountPercent: 10, palletQty: 1, layerQty: 2, sectionQty: 3, pieceQty: 4,
  requiredDate: '2099-02-01', customerNote: 'Customer note' });
const context = () => ({ operatorId: users.sales.id, authorizedStoreLocationIds: [1] });
const editLine = (detail, patch = {}, index = 0) => ({ lineId: detail.lines[index].id,
  productName: detail.lines[index].productName, quantity: detail.lines[index].packageQuantity ?? detail.lines[index].quantity,
  rate: detail.lines[index].originalRate, ...patch });
async function call(id, body, role = 'sales') {
  const response = await fetch(`${base}/api/sales/special-stock-requests/${id}/case-lines`, { method: 'PUT',
    headers: { 'content-type': 'application/json', ...(users[role]?.token ? { authorization: 'Bearer ' + users[role].token } : {}) },
    body: JSON.stringify(body) });
  let payload; try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, payload };
}
const rows = async id => (await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY line_number', [id])).rows;
const orders = async id => (await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id', [id])).rows;
const audit = async id => (await query("SELECT * FROM sales_special_stock_events WHERE request_id=$1 AND event_type LIKE 'special_case_%edit%' ORDER BY id", [id])).rows;
async function snapshot(id) {
  return { rows: await rows(id), orders: await orders(id), events: await audit(id),
    header: (await query('SELECT to_jsonb(r) AS request,to_jsonb(c) AS special FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=$1', [id])).rows[0] };
}
async function newCase(count = 2) {
  const detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', expiresOn: '2099-03-01',
    customerName: 'TEST Customer', vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: 'mbt_delivery', deliveryAddress: 'TEST Delivery address', deliveryFeeRate: 235, palletTotal: 3, palletRate: 40,
    lines: Array.from({ length: count }, (_, index) => item('Old item ' + index)) }, context());
  cases.push(detail.id); return detail;
}
async function reviewedCase({ production = false, draft = true } = {}) {
  let detail = await newCase();
  await query("UPDATE sales_stock_requests SET status='active' WHERE id=$1", [detail.id]);
  await query(`UPDATE sales_special_stock_lines SET supply_status=$2,sales_decision='accepted',availability_mode='dated',available_date='2099-02-01',
    response_vendor_id=331,response_vendor_name='TEST Vendor',vendor_yard='West yard',vendor_reference='Vendor ref',
    sales_visible_note='Reviewed stock',scm_internal_note='Private stock check',unit_purchase_cost=8,purchase_currency='CAD',
    response_revision=3,decision_revision=3,stock_checked_at=now(),responded_at=now(),responded_by=$3,decided_at=now(),decided_by=$3,
    resolved_item_id=2055,resolved_item_name='MBBS-Special Order',resolved_description=product_name || ' Grey 80mm Smooth',
    sales_uom='PC',purchase_uom='PC',sales_quantity=requested_quantity*2,purchase_quantity=requested_quantity*2,
    sales_package_quantity=requested_quantity,pieces_per_unit=2,scm_reviewed_quantity=requested_quantity,scm_reviewed_pieces_per_unit=2
    WHERE request_id=$1`, [detail.id, production ? 'production' : 'in_stock', users.sales.id]);
  if (draft) {
    await query(`INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,item_name,description,quantity,uom,unit_rate,native_discount_percent)
      SELECT request_id,id,'sales_order',2055,'MBBS-Special Order',resolved_description,sales_quantity,'PC',original_unit_rate/2,discount_percent
      FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY line_number`, [detail.id]);
    await query(`INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,item_name,description,quantity,uom,unit_purchase_cost)
      SELECT request_id,id,'purchase_order',2055,'MBBS-Special Order',resolved_description,purchase_quantity,'PC',8
      FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY line_number`, [detail.id]);
    await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate)
      VALUES($1,'sales_order',true,1784,'PALLET','PALLET',3,'EACH',40)`, [detail.id]);
  }
  detail = await repo.getSpecialStockCase(detail.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
  return detail;
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1'); assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
  originalPriceTrigger = (await query("SELECT pg_get_functiondef('preserve_special_original_price()'::regprocedure) AS definition")).rows[0].definition;
  await query(migration());
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()),(1987,'Delivery Charge',NULL,'{}',now()) ON CONFLICT DO NOTHING");
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { if (String(url).startsWith(base + '/')) return originalFetch(url, options);
    remoteCalls++; throw new Error('Case edits must not call NetSuite or other external services'); };
  for (const [name, role, yards] of [['sales', 'sales', [1]], ['outside', 'sales', [28]], ['scm', 'scm', []]]) {
    const username = 'case-edit-' + name + '-' + run, password = crypto.randomUUID();
    const user = await createOperator({ username, displayName: 'TEST ' + name, password, role, roles: [role], yardLocationIds: yards }); users[name] = user;
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); user.token = (await response.json()).token;
  }
});
after(async () => {
  try {
    assert.equal(remoteCalls, 0); if (originalFetch) globalThis.fetch = originalFetch;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [cases]);
    for (const user of Object.values(users)) { await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1', [user.id]); await query('DELETE FROM operators WHERE id=$1', [user.id]); }
    if (flag !== undefined) await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [flag]);
    if (originalPriceTrigger) await query(originalPriceTrigger);
  } finally { await closeDb(); }
});


test('single Sales edit saves PALLET and delivery fee atomically without changing reviewed materials, decisions, PO or stage', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  const response = await call(detail.id, { expectedRevision: detail.revision, pallet: { quantity: 5, rate: 45 }, deliveryFeeRate: 125.50 });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  const changed = response.payload;
  assert.equal(changed.deliveryFeeRate, 125.5); assert.equal(changed.palletTotal, 5); assert.equal(changed.palletRate, 45);
  assert.equal(changed.stage, detail.stage); assert.equal(changed.status, detail.status); assert.equal(changed.revision, detail.revision + 1);
  assert.deepEqual(await rows(detail.id), before.rows);
  assert.deepEqual((await orders(detail.id)).filter(l => !l.ancillary), before.orders.filter(l => !l.ancillary));
  const fees = changed.salesOrderLines.filter(l => l.itemId === 1987);
  assert.equal(fees.length, 1); assert.equal(fees[0].quantity, 1); assert.equal(fees[0].rate, 125.5); assert.equal(fees[0].uom, null);
  assert.equal((await audit(detail.id)).length, 1);
  const quote = buildSpecialQuote(changed, { name: 'TEST MBBS', taxBps: 1300 });
  assert.equal(quote.snapshot.lines.filter(l => l.description === 'Delivery Charge').length, 1);
  assert.equal(quote.snapshot.subtotalMinor, 41664);
  const noOp = await snapshot(detail.id);
  assert.equal((await call(detail.id, { expectedRevision: changed.revision, deliveryFeeRate: '125.500000' })).status, 200);
  assert.deepEqual(await snapshot(detail.id), noOp);
  const free = await call(detail.id, { expectedRevision: changed.revision, deliveryFeeRate: 0 });
  assert.equal(free.status, 200); assert.equal(free.payload.deliveryFeeRate, 0);
  assert.equal(free.payload.salesOrderLines.filter(l => l.itemId === 1987).length, 1);
  assert.equal(free.payload.salesOrderLines.find(l => l.itemId === 1987).rate, 0);
});

test('quote PDF omits declined stale-draft lines, keeps saved notes readable, and uses edited charges', async () => {
  const detail = await reviewedCase();
  await query("UPDATE sales_special_stock_lines SET sales_decision='declined',sales_decision_reason='need full skid',sales_customer_note='Saved decision note' WHERE id=$1", [detail.lines[1].id]);
  const changed = await call(detail.id, { expectedRevision: detail.revision, deliveryFeeRate: 25, pallet: { quantity: 1, rate: 40 } });
  assert.equal(changed.status, 200); assert.equal(changed.payload.lines[1].customerNote, 'Customer note');
  assert.equal(changed.payload.lines[1].salesCustomerNote, 'Saved decision note'); assert.equal(changed.payload.lines[1].salesDecisionReason, 'need full skid');
  const q = buildSpecialQuote(changed.payload, { name: 'TEST MBBS', taxBps: 1300 });
  assert.equal(q.snapshot.subtotalMinor, 9807); assert.equal(q.snapshot.totalMinor, 11082);
  const response = await fetch(`${base}/api/sales/special-stock-requests/${detail.id}/quote.pdf`, { headers: { authorization: 'Bearer ' + users.sales.token } });
  assert.equal(response.status, 200); const text = pdfText(Buffer.from(await response.arrayBuffer()));
  assert.match(text, /Old item 0 Grey 80mm Smooth/); assert.doesNotMatch(text, /Old item 1|Saved decision note|need full skid|Customer note/);
  assert.match(text, /Delivery Charge/); assert.match(text, /\$25\.00/);
  await query("UPDATE sales_special_stock_lines SET sales_decision='declined' WHERE request_id=$1", [detail.id]);
  const empty = await fetch(`${base}/api/sales/special-stock-requests/${detail.id}/quote.pdf`, { headers: { authorization: 'Bearer ' + users.sales.token } });
  assert.equal(empty.status, 400);
});

test('new requests store a fee without creating ancillary-only drafts, and material restarts preserve the new fee', async () => {
  const detail = await newCase();
  const changed = await call(detail.id, { expectedRevision: detail.revision, deliveryFeeRate: 0 });
  assert.equal(changed.status, 200); assert.equal(changed.payload.deliveryFeeRate, 0); assert.deepEqual(await orders(detail.id), []);
  const reviewed = await reviewedCase();
  const restarted = await call(reviewed.id, { expectedRevision: reviewed.revision, deliveryFeeRate: 50,
    lines: [editLine(reviewed, { quantity: 4 })], pallet: { quantity: 0, rate: null } });
  assert.equal(restarted.status, 200); assert.equal(restarted.payload.stage, 'new_enquiry'); assert.equal(restarted.payload.deliveryFeeRate, 50);
  assert.deepEqual(await orders(reviewed.id), []);
});

test('fee-only edits preserve authentication, yard, revision and closed/issued locks, and invalid combined edits write nothing', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  const body = { expectedRevision: detail.revision, deliveryFeeRate: 5 };
  for (const [role, status] of [['none', 401], ['scm', 403], ['outside', 403]]) assert.equal((await call(detail.id, body, role)).status, status);
  assert.equal((await call(detail.id, { ...body, expectedRevision: detail.revision + 1 })).status, 409);
  for (const deliveryFeeRate of [-1, '', null, true, .1234567, 1e9 + 1]) assert.equal((await call(detail.id, { ...body, deliveryFeeRate, pallet: { quantity: 7, rate: 40 } })).status, 400);
  assert.deepEqual(await snapshot(detail.id), before);
  for (const assignment of ["close_status='closed'", "sales_order_netsuite_id=42,sales_order_ref='TEST-SOB42'"]) {
    const locked = await newCase(); await query('UPDATE sales_special_stock_cases SET ' + assignment + ' WHERE request_id=$1', [locked.id]);
    const original = await snapshot(locked.id);
    assert.equal((await call(locked.id, { expectedRevision: locked.revision, deliveryFeeRate: 5 })).status, 409);
    assert.deepEqual(await snapshot(locked.id), original);
  }
  const pickup = await newCase(); await query("UPDATE sales_special_stock_cases SET fulfillment_method='yard_pickup',delivery_fee_rate=NULL WHERE request_id=$1", [pickup.id]);
  assert.equal((await call(pickup.id, { expectedRevision: pickup.revision, fulfillmentMethod: 'mbt_delivery', deliveryFeeRate: 5 })).status, 400);
});

test('fee update failure rolls back PALLET, canonical fee, draft lines, revision and audit together', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id), name = 'test_fee_failure_' + run;
  await query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id=${detail.id} AND NEW.item_id=1987 THEN RAISE EXCEPTION 'TEST fee failure'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON sales_special_stock_order_lines FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    const response = await call(detail.id, { expectedRevision: detail.revision, deliveryFeeRate: 99, pallet: { quantity: 5, rate: 45 } });
    assert.equal(response.status, 500); assert.deepEqual(await snapshot(detail.id), before);
  } finally { await query(`DROP TRIGGER ${name} ON sales_special_stock_order_lines`); await query(`DROP FUNCTION ${name}()`); }
});

test('editing a legacy delivery charge consolidates duplicate unissued fees into one canonical SO charge', async () => {
  const detail = await reviewedCase();
  await query('UPDATE sales_special_stock_cases SET delivery_fee_rate=NULL WHERE request_id=$1', [detail.id]);
  await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate)
    VALUES($1,'sales_order',true,1987,'Delivery Charge','Legacy delivery',2,'EACH',25),
    ($1,'sales_order',true,1987,'Delivery Charge','Another fee',1,'EACH',10)`, [detail.id]);
  const materialRows = await rows(detail.id);
  const response = await call(detail.id, { expectedRevision: detail.revision, deliveryFeeRate: 55 });
  assert.equal(response.status, 200); assert.equal(response.payload.deliveryFeeRate, 55);
  const fees = response.payload.salesOrderLines.filter(l => l.itemId === 1987);
  assert.equal(fees.length, 1); assert.equal(fees[0].quantity, 1); assert.equal(fees[0].rate, 55); assert.equal(fees[0].uom, null);
  assert.equal(fees[0].description, 'Delivery Charge'); assert.deepEqual(await rows(detail.id), materialRows);
});

test('a missing delivery item aborts the complete edit when adding a saved SO charge', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  const saved = (await query('SELECT to_jsonb(i) AS data FROM inventory_items i WHERE item_id=1987')).rows[0].data;
  // Release references from this suite's earlier completed fixtures before simulating an absent master item.
  await query('DELETE FROM sales_special_stock_order_lines WHERE item_id=1987 AND request_id=ANY($1::bigint[])', [cases]);
  await query('DELETE FROM inventory_items WHERE item_id=1987');
  try {
    const response = await call(detail.id, { expectedRevision: detail.revision, deliveryFeeRate: 99, pallet: { quantity: 5, rate: 45 } });
    assert.equal(response.status, 409); assert.equal(response.payload.code, 'SPECIAL_SO_ITEM_NOT_FOUND');
    assert.deepEqual(await snapshot(detail.id), before);
  } finally { await query('INSERT INTO inventory_items SELECT * FROM jsonb_populate_record(NULL::inventory_items,$1::jsonb)', [JSON.stringify(saved)]); }
});
