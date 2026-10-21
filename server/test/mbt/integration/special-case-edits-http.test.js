import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, withTransaction, closeDb } from '../../../src/db.js';
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
  originalPriceTrigger = (await query("SELECT pg_get_functiondef('preserve_special_original_price()'::regprocedure) AS definition")).rows[0].definition;
  await query(migration());
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
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

for (const patch of [{ productName: 'New <stone>' }, { quantity: 2.5 }]) test(`material ${Object.keys(patch)[0]} edit restarts only changed reviews, invalidates both drafts and preserves unaffected SQL rows`, async () => {
  const detail = await reviewedCase(), before = await rows(detail.id);
  const response = await call(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, patch)] });
  assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.stage, 'new_enquiry');
  assert.equal(response.payload.requestRef, detail.requestRef); assert.equal(response.payload.revision, detail.revision + 1);
  const current = await rows(detail.id); assert.deepEqual(current[1], before[1]);
  assert.equal(current[0].supply_status, null); assert.equal(current[0].sales_decision, 'pending'); assert.equal(current[0].resolved_item_id, null);
  assert.equal(current[0].unit_purchase_cost, null); assert.equal(current[0].stock_checked_at, null); assert.equal(current[0].decided_at, null);
  assert.equal(Number(current[0].original_unit_rate), 12.25); assert.equal(current[0].color, before[0].color); assert.equal(current[0].requested_uom, 'PLT');
  assert.equal(current[0].product_name, patch.productName ?? before[0].product_name); assert.equal(Number(current[0].requested_quantity), patch.quantity ?? 3);
  assert.equal((await orders(detail.id)).length, 0);
  const privateEvent = (await query("SELECT * FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_case_line_review_invalidated'", [detail.id])).rows;
  assert.equal(privateEvent.length, 1); assert.equal(privateEvent[0].audience, 'scm');
  assert.deepEqual(privateEvent[0].details.before, JSON.parse(JSON.stringify(before[0])));
  assert.ok(!response.payload.events.some(event => event.eventType === 'special_case_line_review_invalidated'));
  assert.doesNotMatch(JSON.stringify(response.payload.events), /Private stock check|unit_purchase_cost|scm_internal_note/);
  await assert.rejects(repo.claimSpecialOrderOperation(detail.id, { expectedRevision: response.payload.revision, orderKind: 'sales_order', operationId: crypto.randomUUID() }),
    error => error.status === 409);
});
test('material rate-only edits preserve every stage and stock decision, and synchronize converted SO rates without altering purchase costs', async () => {
  for (const mode of ['new', 'reviewed', 'production']) {
    const detail = mode === 'new' ? await newCase() : await reviewedCase({ production: mode === 'production' });
    const before = await snapshot(detail.id), response = await call(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, { rate: 18 })] });
    assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.stage, detail.stage); assert.equal(response.payload.status, detail.status);
    const afterRows = await rows(detail.id), omit = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['original_unit_rate', 'updated_at'].includes(key)));
    assert.deepEqual(omit(afterRows[0]), omit(before.rows[0])); assert.deepEqual(afterRows[1], before.rows[1]);
    assert.equal(Number(afterRows[0].original_unit_rate), 18);
    const afterOrders = await orders(detail.id);
    assert.deepEqual(afterOrders.filter(row => row.order_kind === 'purchase_order'), before.orders.filter(row => row.order_kind === 'purchase_order'));
    if (mode !== 'new') { const row = afterOrders.find(row => row.order_kind === 'sales_order' && Number(row.case_line_id) === detail.lines[0].id);
      assert.equal(Number(row.unit_rate), 9); assert.equal(Number(row.quantity), 6); assert.equal(Number(row.native_discount_percent), 10); }
    assert.equal((await audit(detail.id)).length, 1);
  }
});
test('PALLET edits preserve all material SQL rows and progress, update one draft charge, and keep quote materials before any SO draft', async () => {
  for (const draft of [false, true]) {
    const detail = draft ? await reviewedCase() : await newCase(), before = await rows(detail.id);
    const response = await call(detail.id, { expectedRevision: detail.revision, pallet: { quantity: 5, rate: 45 } });
    assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.stage, detail.stage); assert.equal(response.payload.status, detail.status);
    assert.deepEqual(await rows(detail.id), before); assert.equal(response.payload.palletTotal, 5); assert.equal(response.payload.palletRate, 45);
    const pallets = response.payload.salesOrderLines.filter(line => line.itemId === 1784); assert.equal(pallets.length, draft ? 1 : 0);
    if (draft) { assert.equal(pallets[0].quantity, 5); assert.equal(pallets[0].rate, 45); }
    const quote = buildSpecialQuote(response.payload, { name: 'TEST MBBS', taxBps: 1300 });
    assert.equal(quote.snapshot.lines.length, 3); assert.equal(quote.snapshot.lines.at(-1).amountMinor, 22500);
  }
});
test('mixed material and PALLET edits restart once and commit all requested values atomically', async () => {
  const detail = await reviewedCase(), response = await call(detail.id, { expectedRevision: detail.revision,
    lines: [editLine(detail, { productName: 'Changed', quantity: 4, rate: 20 })], pallet: { quantity: 5, rate: 45 } });
  assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.stage, 'new_enquiry');
  assert.equal(response.payload.lines[0].productName, 'Changed'); assert.equal(response.payload.lines[0].quantity, 4); assert.equal(response.payload.lines[0].originalRate, 20);
  assert.equal(response.payload.palletTotal, 5); assert.equal(response.payload.palletRate, 45); assert.equal((await audit(detail.id)).length, 1);
});
test('equivalent edits are a complete no-op including revision, timestamps, order drafts and audit', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  const response = await call(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, { productName: ' Old item 0 ', quantity: '3.000', rate: '12.250000' })],
    pallet: { quantity: '3', rate: '40.000000' } });
  assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.deepEqual(await snapshot(detail.id), before);
});
test('PALLET removal and zero sales rate keep progress and cannot leave a duplicate or empty-material quote', async () => {
  for (const pallet of [{ quantity: 0, rate: '' }, { quantity: 3, rate: 0 }]) {
    const detail = await reviewedCase(), before = await rows(detail.id), response = await call(detail.id, { expectedRevision: detail.revision, pallet });
    assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.stage, detail.stage); assert.deepEqual(await rows(detail.id), before);
    const quote = buildSpecialQuote(response.payload, { name: 'TEST MBBS', taxBps: 1300 });
    assert.equal(quote.snapshot.lines.filter(line => line.description === 'PALLET').length, pallet.quantity ? 1 : 0);
    assert.equal(response.payload.salesOrderLines.filter(line => line.itemId === 1784).length, pallet.quantity ? 1 : 0);
    if (pallet.quantity) assert.equal(quote.snapshot.lines.at(-1).amountMinor, 0);
  }
});
test('authenticated saved quote PDF reflects edited rates and PALLET while the request remains reviewed', async () => {
  const detail = await reviewedCase(), changed = await call(detail.id, { expectedRevision: detail.revision,
    lines: [editLine(detail, { rate: 18 })], pallet: { quantity: 5, rate: 45 } });
  assert.equal(changed.status, 200, JSON.stringify(changed.payload)); assert.equal(changed.payload.stage, detail.stage);
  const response = await fetch(`${base}/api/sales/special-stock-requests/${detail.id}/quote.pdf`, { headers: { authorization: 'Bearer ' + users.sales.token } });
  assert.equal(response.status, 200); const text = pdfText(Buffer.from(await response.arrayBuffer()));
  assert.match(text, /5EACHPALLET\$45\.00\$225\.00/); assert.equal(text.split('PALLET').length, 2); assert.match(text, /Old item 0 Grey 80mm Smooth/);
});
test('Sales authentication, role, yard scope and workflow gate protect edits without changing any data', async () => {
  const detail = await newCase(), before = await snapshot(detail.id), body = { expectedRevision: detail.revision, lines: [editLine(detail, { rate: 20 })] };
  assert.equal((await call(detail.id, body, 'none')).status, 401); assert.equal((await call(detail.id, body, 'scm')).status, 403);
  assert.equal((await call(detail.id, body, 'outside')).status, 403);
  try { await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'"); assert.equal((await call(detail.id, body)).status, 404); }
  finally { await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'"); }
  assert.deepEqual(await snapshot(detail.id), before);
});
test('foreign/duplicate IDs, hostile values, overflow and stale revisions reject the whole batch before writes', async () => {
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  const stale = await call(detail.id, { expectedRevision: detail.revision + 1, lines: [editLine(detail, { rate: 20 })] });
  assert.equal(stale.status, 409); assert.equal(stale.payload.code, 'SPECIAL_REVISION_CONFLICT');
  for (const lines of [null, [editLine(detail, { lineId: 999999999 })], [editLine(detail), editLine(detail)],
    [editLine(detail, { productName: '' })], [editLine(detail, { quantity: 0 })], [editLine(detail, { quantity: true })],
    [editLine(detail, { rate: -1 })], [editLine(detail, { rate: 0.1234567 })], [editLine(detail, { quantity: 1e9, rate: 1e9 })]]) {
    const response = await call(detail.id, { expectedRevision: detail.revision, lines, pallet: { quantity: 5, rate: 45 } });
    assert.equal(response.status, 400, JSON.stringify(response.payload));
  }
  const invalidPallet = await call(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, { rate: 20 })], pallet: { quantity: 1.5, rate: 40 } });
  assert.equal(invalidPallet.status, 400); assert.deepEqual(await snapshot(detail.id), before);
});
test('existing or skipped orders, closure, remote submissions, uncertain operations and reviews lock all edits', async () => {
  for (const assignment of ["close_status='closed'", "close_status='closure_pending'", 'operationally_complete=true',
    "sales_order_netsuite_id=123456789,sales_order_ref='TEST-SOB123456789'", "purchase_order_netsuite_id=123456789,purchase_order_ref='TEST-POB123456789'",
    'sales_order_skipped=true', 'sales_order_skipped=true,purchase_order_skipped=true', "sales_order_operation_status='creating'", "purchase_order_operation_status='attention'",
    'sales_order_submission_started_at=now()', 'purchase_order_submission_started_at=now()',
    "quantity_review='{\"id\":\"test\",\"status\":\"pending\"}'::jsonb", "fulfillment_change='{\"id\":\"test\",\"status\":\"pending\"}'::jsonb", 'attention=true']) {
    const detail = await newCase(); await query('UPDATE sales_special_stock_cases SET ' + assignment + ' WHERE request_id=$1', [detail.id]);
    const before = await snapshot(detail.id), response = await call(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, { rate: 20 })] });
    assert.equal(response.status, 409, assignment + ': ' + JSON.stringify(response.payload)); assert.equal(response.payload.code, 'SPECIAL_CASE_EDIT_LOCKED');
    assert.deepEqual(await snapshot(detail.id), before);
  }
});
test('direct repository edits require an actor and forged stock/order/header fields cannot escape the whitelist', async () => {
  assert.equal(typeof repo.editSpecialStockCaseLines, 'function');
  const detail = await newCase(), before = await rows(detail.id);
  await assert.rejects(repo.editSpecialStockCaseLines(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, { rate: 20 })] },
    { authorizedStoreLocationIds: [1] }), { status: 401, code: 'SPECIAL_ACTOR_REQUIRED' });
  const response = await call(detail.id, { expectedRevision: detail.revision, vendorId: 999, storeLocationId: 28, salesOrderId: 42, closeStatus: 'closed',
    lines: [editLine(detail, { rate: 20, supplyStatus: 'in_stock', salesDecision: 'accepted', resolvedItemId: 999, unitPurchaseCost: 0 })] });
  assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.vendorId, 331); assert.equal(response.payload.storeLocationId, 1);
  assert.equal(response.payload.closeStatus, 'active'); assert.equal(response.payload.salesOrderId, null);
  const stored = (await rows(detail.id))[0]; assert.equal(stored.supply_status, before[0].supply_status); assert.equal(stored.sales_decision, before[0].sales_decision);
  assert.equal(stored.unit_purchase_cost, before[0].unit_purchase_cost); assert.equal(stored.resolved_item_id, before[0].resolved_item_id);
});
test('failure on the second SQL edit rolls back every line, PALLET, draft, revision and audit change', async () => {
  assert.equal(typeof repo.editSpecialStockCaseLines, 'function');
  const detail = await reviewedCase(), before = await snapshot(detail.id);
  await withTransaction(async () => {
    await query(`CREATE FUNCTION case_edit_fault_${run}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id=${detail.id} AND NEW.product_name='reject fixture' THEN RAISE EXCEPTION 'injected case edit failure'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER case_edit_fault_${run} BEFORE UPDATE ON sales_special_stock_lines FOR EACH ROW EXECUTE FUNCTION case_edit_fault_${run}()`);
    await assert.rejects(repo.editSpecialStockCaseLines(detail.id, { expectedRevision: detail.revision,
      lines: [editLine(detail, { rate: 20 }), editLine(detail, { productName: 'reject fixture' }, 1)], pallet: { quantity: 5, rate: 45 } }, context()), /injected case edit failure/);
    assert.deepEqual(await snapshot(detail.id), before);
  }, { rollback: true });
});
test('concurrent saves commit once per original revision without duplicate pricing events', async () => {
  const detail = await reviewedCase(), body = { expectedRevision: detail.revision, lines: [editLine(detail, { rate: 20 })] };
  const results = await Promise.all([call(detail.id, body), call(detail.id, body)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]); assert.equal((await audit(detail.id)).length, 1);
});
test('SO claim and material edit serialize without claiming an order with stale reviewed content', async () => {
  assert.equal(typeof repo.editSpecialStockCaseLines, 'function');
  for (let iteration = 0; iteration < 6; iteration++) {
    const detail = await reviewedCase(), edit = () => repo.editSpecialStockCaseLines(detail.id,
      { expectedRevision: detail.revision, lines: [editLine(detail, { productName: 'Changed' })] }, context());
    const claim = () => repo.claimSpecialOrderOperation(detail.id, { expectedRevision: detail.revision, orderKind: 'sales_order', operationId: crypto.randomUUID() }, context());
    const results = await Promise.allSettled(iteration % 2 ? [claim(), edit()] : [edit(), claim()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const current = await repo.getSpecialStockCase(detail.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
    if (current.salesOrderOperationStatus === 'creating') { assert.equal(current.lines[0].productName, 'Old item 0'); assert.equal(current.salesOrderLines.length, 3); }
    else { assert.equal(current.stage, 'new_enquiry'); assert.equal(current.lines[0].productName, 'Changed'); assert.equal(current.salesOrderLines.length, 0); }
  }
});
test('price-trigger migration is repeatable, rolls back without data changes, and grants only scoped pre-order rate edits', async () => {
  assert.equal(typeof repo.editSpecialStockCaseLines, 'function');
  const detail = await newCase(), before = await snapshot(detail.id);
  const definition = (await query("SELECT pg_get_functiondef('preserve_special_original_price()'::regprocedure) AS definition")).rows[0].definition;
  await withTransaction(async () => {
    await query(migration()); await query(migration());
    const update = () => query('UPDATE sales_special_stock_lines SET original_unit_rate=20 WHERE id=$1', [detail.lines[0].id]);
    await assert.rejects(withTransaction(update), { code: '23514' });
    await query("SELECT set_config('mbbs.special_case_edit_request',$1,true)", [String(detail.id + 1)]);
    await assert.rejects(withTransaction(update), { code: '23514' });
    await query("SELECT set_config('mbbs.special_case_edit_request',$1,true)", [String(detail.id)]);
    await update(); assert.equal(Number((await rows(detail.id))[0].original_unit_rate), 20);
    await assert.rejects(withTransaction(() => query("UPDATE sales_special_stock_lines SET original_rate_uom='PC' WHERE id=$1", [detail.lines[0].id])), { code: '23514' });
    await assert.rejects(withTransaction(() => query('UPDATE sales_special_stock_lines SET quoted_discount_percent=25 WHERE id=$1', [detail.lines[0].id])), { code: '23514' });
    await query("UPDATE sales_special_stock_cases SET sales_order_operation_status='creating' WHERE request_id=$1", [detail.id]);
    await assert.rejects(withTransaction(() => query('UPDATE sales_special_stock_lines SET original_unit_rate=21 WHERE id=$1', [detail.lines[0].id])), { code: '23514' });
  }, { rollback: true });
  assert.deepEqual(await snapshot(detail.id), before);
  assert.equal((await query("SELECT pg_get_functiondef('preserve_special_original_price()'::regprocedure) AS definition")).rows[0].definition, definition);
  assert.equal((await query("SELECT current_setting('mbbs.special_case_edit_request',true) AS edit")).rows[0].edit || '', '');
});
test('saved drafts without PALLET receive one charge, while duplicate, issued or inconsistent drafts reject atomically', async () => {
  const detail = await reviewedCase();
  await query("DELETE FROM sales_special_stock_order_lines WHERE request_id=$1 AND item_id=1784", [detail.id]);
  const changed = await call(detail.id, { expectedRevision: detail.revision, pallet: { quantity: 5, rate: 45 } });
  assert.equal(changed.status, 200, JSON.stringify(changed.payload));
  assert.equal(changed.payload.salesOrderLines.filter(line => line.itemId === 1784).length, 1);
  assert.equal(buildSpecialQuote(changed.payload, { name: 'TEST MBBS', taxBps: 1300 }).snapshot.lines.at(-1).amountMinor, 22500);
  for (const corruption of ['duplicate', 'remote', 'conversion']) {
    const record = await reviewedCase();
    if (corruption === 'duplicate') await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate)
      VALUES($1,'sales_order',true,1784,'PALLET','PALLET',3,'EACH',40)`, [record.id]);
    else if (corruption === 'remote') await query("UPDATE sales_special_stock_order_lines SET remote_line_id=99 WHERE request_id=$1", [record.id]);
    else await query("UPDATE sales_special_stock_order_lines SET quantity=7 WHERE request_id=$1 AND order_kind='sales_order' AND case_line_id=$2", [record.id, record.lines[0].id]);
    const before = await snapshot(record.id), response = await call(record.id, { expectedRevision: record.revision,
      lines: [editLine(record, { rate: 18 })], pallet: { quantity: 5, rate: 45 } });
    assert.equal(response.status, 409, corruption + ': ' + JSON.stringify(response.payload)); assert.equal(response.payload.code, 'SPECIAL_CASE_EDIT_LOCKED');
    assert.deepEqual(await snapshot(record.id), before);
  }
});
test('entering legacy prices preserves the editor unit basis for rate-only and restarted material edits', async () => {
  for (const restart of [false, true]) {
    let detail = await newCase();
    await query(`INSERT INTO sales_special_stock_lines(request_id,line_number,product_name,requested_quantity,requested_uom,
      scm_reviewed_quantity,sales_uom,sales_package_quantity) VALUES($1,3,'Legacy material',4,'PLT',4,'PC',4)`, [detail.id]);
    detail = await repo.getSpecialStockCase(detail.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
    assert.equal(detail.lines[2].originalRate, null); assert.equal(detail.lines[2].rateUom, 'PC');
    const before = await rows(detail.id), response = await call(detail.id, { expectedRevision: detail.revision,
      lines: [editLine(detail, { rate: 10, ...(restart ? { productName: 'New legacy material' } : {}) }, 2)] });
    assert.equal(response.status, 200, JSON.stringify(response.payload));
    assert.equal(response.payload.lines[2].rateUom, 'PC'); assert.equal(response.payload.lines[2].originalRate, 10);
    assert.deepEqual((await rows(detail.id)).slice(0, 2), before.slice(0, 2));
    assert.equal(response.payload.stage, 'new_enquiry');
    const quote = buildSpecialQuote(response.payload, { name: 'TEST MBBS', taxBps: 1300 });
    assert.equal(quote.snapshot.lines[2].unit, 'PC'); assert.equal(quote.snapshot.lines[2].amountMinor, 4000);
  }
});
test('legacy embedded discounts and non-PALLET draft charges are preserved when the selling rate changes', async () => {
  const detail = await reviewedCase();
  await query("UPDATE sales_special_stock_order_lines SET native_discount_percent=NULL,unit_rate=5.5125 WHERE request_id=$1 AND order_kind='sales_order' AND case_line_id=$2", [detail.id, detail.lines[0].id]);
  await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate)
    VALUES($1,'sales_order',true,2055,'MBBS-Special Order','Delivery',1,'EACH',30)`, [detail.id]);
  const delivery = (await orders(detail.id)).find(row => row.description === 'Delivery');
  const response = await call(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, { rate: 18 })] });
  assert.equal(response.status, 200, JSON.stringify(response.payload)); assert.equal(response.payload.stage, detail.stage);
  const material = response.payload.salesOrderLines.find(row => row.caseLineId === detail.lines[0].id);
  assert.equal(material.rate, 8.1);
  assert.equal((await orders(detail.id)).find(row => Number(row.case_line_id) === detail.lines[0].id && row.order_kind === 'sales_order').native_discount_percent, null);
  assert.deepEqual((await orders(detail.id)).find(row => row.description === 'Delivery'), delivery);
  const quote = buildSpecialQuote(response.payload, { name: 'TEST MBBS', taxBps: 1300 });
  assert.equal(quote.snapshot.lines[0].amountMinor, 4860);
  assert.equal(quote.snapshot.lines.find(row => row.description === 'Delivery').amountMinor, 3000);
});
test('missing PALLET item master rolls back a combined price and PALLET draft edit', async () => {
  const detail = await reviewedCase();
  await query("DELETE FROM sales_special_stock_order_lines WHERE request_id=$1 AND item_id=1784", [detail.id]);
  const before = await snapshot(detail.id);
  await withTransaction(async () => {
    await query('CREATE TEMP TABLE inventory_items (LIKE public.inventory_items INCLUDING DEFAULTS) ON COMMIT DROP');
    await assert.rejects(repo.editSpecialStockCaseLines(detail.id, { expectedRevision: detail.revision,
      lines: [editLine(detail, { rate: 18 })], pallet: { quantity: 5, rate: 45 } }, context()),
    { status: 409, code: 'SPECIAL_SO_ITEM_NOT_FOUND' });
    assert.deepEqual(await snapshot(detail.id), before);
  }, { rollback: true });
});
