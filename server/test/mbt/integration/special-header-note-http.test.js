import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';
import { copySpecialRequestDraft } from '../../../public/special-stock-request-actions.js';

const run = crypto.randomUUID().replaceAll('-', ''), users = {}, cases = [];
let server, base, flag, originalFetch, remoteCalls = 0;
const item = (name = 'Old item') => ({ productName: name, color: 'Grey', size: '80mm', detailSpec: 'Smooth',
  quantity: 3, uom: 'PLT', rate: 12.25, discountPercent: 10, palletQty: 1, layerQty: 2, sectionQty: 3, pieceQty: 4,
  requiredDate: '2099-02-01', customerNote: 'Customer note' });
const context = () => ({ operatorId: users.sales.id, authorizedStoreLocationIds: [1] });
async function call(id, body, role = 'sales') {
  const response = await fetch(`${base}/api/sales/special-stock-requests/${id}/header`, { method: 'PUT',
    headers: { 'content-type': 'application/json', ...(users[role]?.token ? { authorization: 'Bearer ' + users[role].token } : {}) },
    body: JSON.stringify(body) });
  let payload; try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, payload };
}
const rows = async id => (await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY line_number', [id])).rows;
const orders = async id => (await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id', [id])).rows;
const audit = async id => (await query("SELECT * FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_case_header_updated' ORDER BY id", [id])).rows;
async function snapshot(id) {
  return { rows: await rows(id), orders: await orders(id), events: await audit(id),
    header: (await query('SELECT to_jsonb(r) AS request,to_jsonb(c) AS special FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=$1', [id])).rows[0] };
}
async function newCase(count = 2) {
  const detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', expiresOn: '2099-03-01',
    customerName: 'TEST Customer', vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup', palletTotal: 3, palletRate: 40,
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
  assert.equal(process.env.MBT_TEST_ISOLATED, '1'); assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()),(1987,'Delivery Charge',NULL,'{}',now()) ON CONFLICT DO NOTHING");
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { if (String(url).startsWith(base + '/')) return originalFetch(url, options);
    remoteCalls++; throw new Error('Header editing must not call NetSuite or other external services'); };
  for (const [name, role, yards] of [['sales', 'sales', [1]], ['outside', 'sales', [28]], ['scm', 'scm', []]]) {
    const username = 'header-note-' + name + '-' + run, password = crypto.randomUUID();
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
  } finally { await closeDb(); }
});

const note = '44 Sherwood Ave, Scarborough, ON M1R 1N5\n\n全贴砖方案\n墙砖净面积估算： 约 5,200 sqft\n含 5% 损耗总面积： 5,200 × 1.05 = 5,460 sqft';
test('Note-only header saves preserve new and reviewed status, every material, PALLET, draft and unrelated header value', async () => {
  for (const mode of ['new', 'reviewed', 'production']) {
    const detail = mode === 'new' ? await newCase() : await reviewedCase({ production: mode === 'production' });
    const before = await snapshot(detail.id), response = await call(detail.id, { expectedRevision: detail.revision, remarks: note });
    assert.equal(response.status, 200, JSON.stringify(response.payload));
    assert.equal(response.payload.remarks, note); assert.equal(response.payload.status, detail.status); assert.equal(response.payload.stage, detail.stage);
    const current = await snapshot(detail.id); assert.deepEqual(current.rows, before.rows); assert.deepEqual(current.orders, before.orders);
    assert.deepEqual(current.header.special, before.header.special);
    const omit = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['remarks','revision','updated_at'].includes(key)));
    assert.deepEqual(omit(current.header.request), omit(before.header.request));
    assert.equal(response.payload.revision, detail.revision + 1); assert.equal(current.events.length, 1);
    assert.equal(current.events[0].actor_id, users.sales.id); assert.equal(current.events[0].audience, 'all');
    assert.equal(current.events[0].details.before.remarks, ''); assert.equal(current.events[0].details.after.remarks, note);
    const scm = await repo.getSpecialStockCase(detail.id, { audience: 'scm' }); assert.equal(scm.remarks, note);
    const quote = buildSpecialQuote(response.payload, { name: 'TEST MBBS', taxBps: 1300 }); assert.equal(quote.snapshot.note, note);
    assert.equal(copySpecialRequestDraft(response.payload).remarks, note);
  }
});
test('one header save commits delivery fields and Note together without resetting reviewed lines or creating a remote journal', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  const fields = { remarks: note, fulfillmentMethod: 'mbt_delivery', deliveryAddress: '44 Sherwood Ave', deliveryContactName: '客户 王',
    deliveryContactPhone: '416-555-0100', deliveryDate: '2099-02-01', windowStart: '09:00', windowEnd: '12:00', deliveryInstructions: 'Side entrance\n侧门' };
  const response = await call(detail.id, { expectedRevision: detail.revision, ...fields }); assert.equal(response.status, 200, JSON.stringify(response.payload));
  for (const [field, value] of Object.entries(fields)) assert.equal(response.payload[field], value, field);
  assert.equal(response.payload.status, detail.status); assert.equal(response.payload.stage, detail.stage); assert.equal(response.payload.revision, detail.revision + 1);
  assert.equal(response.payload.fulfillmentChange, null);
  const current = await snapshot(detail.id); assert.deepEqual(current.rows, before.rows); assert.deepEqual(current.orders, before.orders);
  assert.equal(current.events.length, 1); assert.equal(current.events[0].details.after.deliveryContactName, fields.deliveryContactName);
});
test('identical header saves are complete no-ops and clearing a Note leaves quote and copied header empty', async () => {
  let detail = await newCase(), before = await snapshot(detail.id);
  let response = await call(detail.id, { expectedRevision: detail.revision, remarks: '', fulfillmentMethod: 'yard_pickup' });
  assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.deepEqual(await snapshot(detail.id), before);
  response = await call(detail.id, { expectedRevision: detail.revision, remarks: note }); assert.equal(response.status, 200);
  detail = response.payload; before = await snapshot(detail.id);
  response = await call(detail.id, { expectedRevision: detail.revision, remarks: note.replaceAll('\n', '\r\n') });
  assert.equal(response.status, 200); assert.deepEqual(await snapshot(detail.id), before);
  response = await call(detail.id, { expectedRevision: detail.revision, remarks: '' }); assert.equal(response.status, 200);
  assert.equal(response.payload.remarks, ''); assert.equal(response.payload.status, 'submitted');
  assert.equal(buildSpecialQuote(response.payload, { name: 'TEST MBBS', taxBps: 1300 }).snapshot.note, '');
  assert.equal(copySpecialRequestDraft(response.payload).remarks, '');
});
test('invalid Note, delivery and revision inputs reject the entire header and injected client fields cannot change case ownership or prices', async () => {
  const detail = await newCase(), before = await snapshot(detail.id);
  for (const patch of [{ remarks: null }, { remarks: 2 }, { remarks: {} }, { remarks: [] }, { remarks: 'x'.repeat(8001) }, { remarks: 'nul\0' },
    { fulfillmentMethod: 'invalid' }, { fulfillmentMethod: 'mbt_delivery', deliveryAddress: '' },
    { fulfillmentMethod: 'mbt_delivery', deliveryAddress: 'Address', deliveryDate: '2099-02-01', windowStart: '12:00', windowEnd: '09:00' },
    { fulfillmentMethod: 'mbt_delivery', deliveryAddress: 'Address', deliveryDate: '2000-01-01' }, { expectedRevision: null }]) {
    const response = await call(detail.id, { expectedRevision: detail.revision, remarks: note, ...patch });
    assert.equal(response.status, 400, JSON.stringify({ patch, response })); assert.deepEqual(await snapshot(detail.id), before);
  }
  const response = await call(detail.id, { expectedRevision: detail.revision, remarks: note, status: 'completed', customerName: 'Attacker',
    vendorId: 9, destinationLocationId: 28, palletTotal: 1000, salesOrderId: 5, lines: [{ originalRate: 1 }], scmInternalNote: 'Overwrite' });
  assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.customerName, detail.customerName);
  assert.equal(response.payload.palletTotal, detail.palletTotal); assert.deepEqual(await rows(detail.id), before.rows);
});
test('header endpoint requires Sales authentication, role, yard and workflow gate before any write', async () => {
  const detail = await newCase(), body = { expectedRevision: detail.revision, remarks: note }, before = await snapshot(detail.id);
  for (const [role, status] of [['anonymous', 401], ['scm', 403], ['outside', 403]]) {
    assert.equal((await call(detail.id, body, role)).status, status); assert.deepEqual(await snapshot(detail.id), before);
  }
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  try { assert.equal((await call(detail.id, body)).status, 404); assert.deepEqual(await snapshot(detail.id), before); }
  finally { await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'"); }
  assert.equal(typeof repo.updateSpecialStockHeader, 'function');
  await assert.rejects(repo.updateSpecialStockHeader(detail.id, body, { authorizedStoreLocationIds: [1] }), { status: 401 });
});
test('issued, closed, cancelled, pending, uncertain and planned requests reject delivery header saves without writes', async () => {
  const patches = ["close_status='closed'", "operationally_complete=true", "sales_order_netsuite_id=9900001,sales_order_ref='TEST-SOB9900001'", "purchase_order_netsuite_id=9900002,purchase_order_ref='TEST-POB9900002'",
    "sales_order_skipped=true", "sales_order_skipped=true,purchase_order_skipped=true", "sales_order_operation_status='creating'", "purchase_order_operation_status='attention'",
    "sales_order_submission_started_at=now()", "attention=true", "quantity_review='{\"id\":\"fixture\",\"status\":\"pending\"}'::jsonb",
    "fulfillment_change='{\"id\":\"fixture\",\"status\":\"attention\"}'::jsonb"];
  for (const patch of patches) {
    const detail = await newCase(); await query('UPDATE sales_special_stock_cases SET ' + patch + ' WHERE request_id=$1', [detail.id]);
    const before = await snapshot(detail.id); assert.equal((await call(detail.id, { expectedRevision: detail.revision, remarks: note, fulfillmentMethod: 'yard_pickup' })).status, 409, patch);
    assert.deepEqual(await snapshot(detail.id), before);
  }
  const detail = await newCase(); await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1", [detail.id]);
  assert.equal((await call(detail.id, { expectedRevision: detail.revision, remarks: note })).status, 409);
});
test('stale and concurrent header saves serialize with exactly one successful revision and audit', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  assert.equal((await call(detail.id, { expectedRevision: detail.revision + 1, remarks: note })).status, 409);
  assert.deepEqual(await snapshot(detail.id), before);
  const results = await Promise.all([call(detail.id, { expectedRevision: detail.revision, remarks: note }), call(detail.id, { expectedRevision: detail.revision, remarks: 'Other note' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]); assert.equal((await audit(detail.id)).length, 1);
  const current = await repo.getSpecialStockCase(detail.id, { audience: 'sales' });
  assert.equal(current.remarks, results.find(result => result.status === 200).payload.remarks); assert.equal(current.revision, detail.revision + 1);
});
test('SO claims and header saves serialize so an order cannot claim an obsolete Note revision', async () => {
  assert.equal(typeof repo.updateSpecialStockHeader, 'function');
  for (let iteration = 0; iteration < 4; iteration++) {
    const detail = await reviewedCase(), save = () => repo.updateSpecialStockHeader(detail.id, { expectedRevision: detail.revision, remarks: note }, context());
    const claim = () => repo.claimSpecialOrderOperation(detail.id, { expectedRevision: detail.revision, orderKind: 'sales_order', operationId: crypto.randomUUID() }, context());
    const results = await Promise.allSettled(iteration % 2 ? [claim(), save()] : [save(), claim()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const current = await repo.getSpecialStockCase(detail.id, { audience: 'sales' });
    if (current.salesOrderOperationStatus === 'creating') assert.equal(current.remarks, ''); else assert.equal(current.remarks, note);
    assert.equal(current.stage, detail.stage); assert.equal(current.lines[0].salesDecision, 'accepted');
  }
});
test('audit failure rolls back Note, delivery, revision and every related row in the header transaction', async () => {
  assert.equal(typeof repo.updateSpecialStockHeader, 'function'); const detail = await reviewedCase(), before = await snapshot(detail.id);
  await withTransaction(async () => {
    await query(`CREATE FUNCTION header_note_fault_${run}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id=${detail.id} AND NEW.event_type='special_case_header_updated' THEN RAISE EXCEPTION 'injected header audit failure'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER header_note_fault_${run} BEFORE INSERT ON sales_special_stock_events FOR EACH ROW EXECUTE FUNCTION header_note_fault_${run}()`);
    await assert.rejects(repo.updateSpecialStockHeader(detail.id, { expectedRevision: detail.revision, remarks: note,
      fulfillmentMethod: 'mbt_delivery', deliveryAddress: '44 Sherwood Ave', deliveryDate: '2099-02-01', deliveryFeeRate: 235 }, context()), /injected header audit failure/);
    assert.deepEqual(await snapshot(detail.id), before);
  }, { rollback: true });
});
test('Note-only edits preserve stored delivery fields even when the preferred delivery date is in the past', async () => {
  const detail = await newCase();
  await query("UPDATE sales_special_stock_cases SET fulfillment_method='mbt_delivery',delivery_address='Old address',delivery_contact_name='Contact',delivery_date='2000-01-01' WHERE request_id=$1", [detail.id]);
  const before = await snapshot(detail.id), response = await call(detail.id, { expectedRevision: detail.revision, remarks: note });
  assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.deliveryDate, '2000-01-01');
  assert.deepEqual((await snapshot(detail.id)).header.special, before.header.special);
});

test('pickup-to-delivery header persists the fee, updates one unitless SO charge and preserves materials and PO costs', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  const response = await call(detail.id, { expectedRevision: detail.revision, remarks: '', fulfillmentMethod: 'mbt_delivery',
    deliveryAddress: 'TEST Delivery', deliveryDate: '2099-02-01', deliveryFeeRate: '235' });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.deliveryFeeRate, 235);
  assert.equal(response.payload.stage, detail.stage);
  const current = await snapshot(detail.id);
  assert.deepEqual(current.rows, before.rows);
  assert.deepEqual(current.orders.filter(line => Number(line.item_id) !== 1987), before.orders);
  const fee = current.orders.filter(line => Number(line.item_id) === 1987);
  assert.equal(fee.length, 1);
  assert.deepEqual([fee[0].order_kind, fee[0].ancillary, fee[0].uom, Number(fee[0].quantity), Number(fee[0].unit_rate)],
    ['sales_order', true, null, 1, 235]);
  const quote = buildSpecialQuote(response.payload, { name: 'TEST MBBS', taxBps: 1300, validityDays: 30 });
  assert.equal(quote.snapshot.lines.filter(line => line.description === 'Delivery Charge').length, 1);
  assert.equal(quote.snapshot.lines.at(-1).amountMinor, 23500);
  const updated = await call(detail.id, { expectedRevision: response.payload.revision, remarks: '', deliveryFeeRate: '0' });
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.deliveryFeeRate, 0);
  const free = (await orders(detail.id)).filter(line => Number(line.item_id) === 1987);
  assert.equal(free.length, 0);
  const pickup = await call(detail.id, { expectedRevision: updated.payload.revision, remarks: '', fulfillmentMethod: 'yard_pickup', deliveryFeeRate: '999' });
  assert.equal(pickup.status, 200, JSON.stringify(pickup.payload)); assert.equal(pickup.payload.deliveryFeeRate, null);
  assert.equal((await orders(detail.id)).filter(line => Number(line.item_id) === 1987).length, 0);
  assert.deepEqual((await snapshot(detail.id)).orders, before.orders);
  assert.equal(remoteCalls, 0);
});

test('invalid fee and stale delivery header leave the case, drafts and audit unchanged', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  for (const rate of [-1, 'bad', '0.1234567', 1000000001]) {
    const response = await call(detail.id, { expectedRevision: detail.revision, remarks: '', fulfillmentMethod: 'mbt_delivery',
      deliveryAddress: 'TEST Delivery', deliveryDate: '2099-02-01', deliveryFeeRate: rate });
    assert.equal(response.status, 400, JSON.stringify(response.payload));
    assert.equal(response.payload.code, 'SPECIAL_DELIVERY_FEE_INVALID');
    assert.deepEqual(await snapshot(detail.id), before);
  }
  assert.equal((await call(detail.id, { expectedRevision: detail.revision + 1, remarks: '', deliveryFeeRate: 235 })).status, 409);
  assert.deepEqual(await snapshot(detail.id), before);
});

test('legacy blank header fees remain optional and saved zero fees cannot be cleared to blank', async () => {
  const detail = await reviewedCase(), before = await orders(detail.id);
  const legacy = await call(detail.id, { expectedRevision: detail.revision, remarks: '', fulfillmentMethod: 'mbt_delivery',
    deliveryAddress: 'TEST Delivery', deliveryDate: '2099-02-01', deliveryFeeRate: '' });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.payload)); assert.equal(legacy.payload.deliveryFeeRate, null);
  assert.deepEqual(await orders(detail.id), before);
  const free = await call(detail.id, { expectedRevision: legacy.payload.revision, remarks: '', deliveryFeeRate: 0 });
  assert.equal(free.status, 200, JSON.stringify(free.payload)); assert.equal(free.payload.deliveryFeeRate, 0);
  const saved = await snapshot(detail.id);
  const blank = await call(detail.id, { expectedRevision: free.payload.revision, remarks: '', deliveryFeeRate: '' });
  assert.equal(blank.status, 400); assert.equal(blank.payload.code, 'SPECIAL_DELIVERY_FEE_INVALID');
  assert.deepEqual(await snapshot(detail.id), saved);
});


test('confirmed, issued and planned requests allow Note-only edits without changing the case, drafts, decisions or order operations', async () => {
  for (const patch of ["sales_order_netsuite_id=9900001,sales_order_ref='TEST-SOB9900001'",
    "sales_order_netsuite_id=9900001,sales_order_ref='TEST-SOB9900001',purchase_order_netsuite_id=9900002,purchase_order_ref='TEST-POB9900002'",
    "sales_order_skipped=true,purchase_order_skipped=true", "attention=true,attention_reason='Unrelated order issue'",
    "quantity_review='{\"status\":\"pending\"}'::jsonb", "fulfillment_change='{\"status\":\"attention\"}'::jsonb"]) {
    let detail = await reviewedCase(); const uniquePatch=patch.replaceAll('9900001',String(9920000+detail.id)).replaceAll('9900002',String(9940000+detail.id)); await query('UPDATE sales_special_stock_cases SET ' + uniquePatch + ' WHERE request_id=$1', [detail.id]);
    detail = await repo.getSpecialStockCase(detail.id, { audience:'sales' });
    const before = await snapshot(detail.id), response = await call(detail.id, { expectedRevision:detail.revision, remarks:note });
    assert.equal(response.status,200,JSON.stringify({patch,response}));assert.equal(response.payload.remarks,note);
    assert.equal(response.payload.stage,detail.stage);assert.equal(response.payload.status,detail.status);
    const current = await snapshot(detail.id);assert.deepEqual(current.header.special,before.header.special);
    assert.deepEqual(current.rows,before.rows);assert.deepEqual(current.orders,before.orders);
    assert.equal(current.events.length,before.events.length+1);assert.equal(current.events.at(-1).details.after.remarks,note);
    const unchanged = await snapshot(detail.id);
    assert.equal((await call(detail.id, {expectedRevision:response.payload.revision,remarks:note})).status,200);
    assert.deepEqual(await snapshot(detail.id),unchanged);
    const cleared = await call(detail.id, {expectedRevision:response.payload.revision,remarks:''});assert.equal(cleared.status,200);
    assert.equal(cleared.payload.remarks,'');assert.equal(remoteCalls,0);
  }
});

test('issued Note-only edits retain role, yard, workflow, revision, terminal and atomic rollback checks', async () => {
  let detail = await reviewedCase();await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=$2,sales_order_ref=$3 WHERE request_id=$1",[detail.id,9960000+detail.id,'TEST-SOB'+(9960000+detail.id)]);
  detail = await repo.getSpecialStockCase(detail.id,{audience:'sales'});const before = await snapshot(detail.id);
  const body={expectedRevision:detail.revision,remarks:note};
  for(const [role,status] of [['anonymous',401],['scm',403],['outside',403]]){
    assert.equal((await call(detail.id,body,role)).status,status);assert.deepEqual(await snapshot(detail.id),before);
  }
  for(const extra of [{fulfillmentMethod:'mbt_delivery',deliveryAddress:'Forged'}, {deliveryFeeRate:0}, {palletTotal:99}]){
    assert.equal((await call(detail.id,{...body,...extra})).status,409);assert.deepEqual(await snapshot(detail.id),before);
  }
  assert.equal((await call(detail.id,{...body,expectedRevision:detail.revision+1})).status,409);
  await withTransaction(async()=>{
    await query(`CREATE FUNCTION confirmed_note_fault_${run}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id=${detail.id} AND NEW.event_type='special_case_header_updated' THEN RAISE EXCEPTION 'injected confirmed note failure'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER confirmed_note_fault_${run} BEFORE INSERT ON sales_special_stock_events FOR EACH ROW EXECUTE FUNCTION confirmed_note_fault_${run}()`);
    await assert.rejects(repo.updateSpecialStockHeader(detail.id,body,context()),/injected confirmed note failure/);
    assert.deepEqual(await snapshot(detail.id),before);
  },{rollback:true});
  const results=await Promise.all([call(detail.id,body),call(detail.id,{...body,remarks:'Other confirmed note'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await audit(detail.id)).length,1);
  for(const terminal of ["close_status='closed'", "close_status='closure_pending'", "operationally_complete=true"]){
    await withTransaction(async()=>{
      await query('UPDATE sales_special_stock_cases SET '+terminal+' WHERE request_id=$1',[detail.id]);
      const current=await repo.getSpecialStockCase(detail.id,{audience:'sales'}),snapshotBefore=await snapshot(detail.id);
      await assert.rejects(repo.updateSpecialStockHeader(detail.id,{expectedRevision:current.revision,remarks:'Blocked note'},context()),{status:409});
      assert.deepEqual(await snapshot(detail.id),snapshotBefore);
    },{rollback:true});
  }
});

test('inline delivery fee editing removes a zero charge and can restore a paid charge without changing reviewed materials',async()=>{
  let detail=await reviewedCase();
  const response=await call(detail.id,{expectedRevision:detail.revision,remarks:'',fulfillmentMethod:'mbt_delivery',
    deliveryAddress:'TEST Address',deliveryDate:'2099-02-01',deliveryFeeRate:235});
  assert.equal(response.status,200,JSON.stringify(response.payload));detail=response.payload;
  const before=await snapshot(detail.id);
  detail=await repo.editSpecialStockCaseLines(detail.id,{expectedRevision:detail.revision,lines:[],deliveryFeeRate:0},context());
  assert.equal(detail.deliveryFeeRate,0);assert.equal(detail.stage,response.payload.stage);
  assert.equal(detail.salesOrderLines.filter(line=>line.itemId===1987).length,0);
  const current=await snapshot(detail.id);assert.deepEqual(current.rows,before.rows);
  assert.deepEqual(current.orders,before.orders.filter(line=>Number(line.item_id)!==1987));
  detail=await repo.editSpecialStockCaseLines(detail.id,{expectedRevision:detail.revision,lines:[],deliveryFeeRate:235},context());
  const fee=detail.salesOrderLines.filter(line=>line.itemId===1987);assert.equal(fee.length,1);
  assert.deepEqual([fee[0].quantity,fee[0].rate,fee[0].uom],[1,235,null]);assert.equal(remoteCalls,0);
});

test('legacy zero-fee SO drafts omit the row before submission and retain it after a durable submission',async()=>{
  for(const submitted of [false,true]){
    let detail=await reviewedCase();const operationId=crypto.randomUUID();
    await query("INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate) VALUES($1,'sales_order',true,1987,'Delivery Charge','Delivery Charge',1,NULL,0)",[detail.id]);
    await query("UPDATE sales_special_stock_cases SET delivery_fee_rate=0,sales_order_operation_status=$2,sales_order_operation_id=$3,sales_order_submission_started_at=$4 WHERE request_id=$1",
      [detail.id,submitted?'attention':'idle',submitted?operationId:null,submitted?new Date():null]);
    detail=await repo.getSpecialStockCase(detail.id,{audience:'sales'});const before=await snapshot(detail.id);
    const claimed=await repo.claimSpecialOrderOperation(detail.id,{expectedRevision:detail.revision,orderKind:'sales_order',operationId},context());
    assert.equal(claimed.salesOrderOperationStatus,'creating');assert.equal(claimed.deliveryFeeRate,0);
    assert.equal(claimed.salesOrderLines.filter(line=>line.itemId===1987).length,submitted?1:0);
    const current=await snapshot(detail.id);assert.deepEqual(current.rows,before.rows);
    assert.deepEqual(current.orders,submitted?before.orders:before.orders.filter(line=>Number(line.item_id)!==1987));
    assert.equal(remoteCalls,0);
  }
});
