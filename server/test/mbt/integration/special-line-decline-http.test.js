import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';
import { pdfText } from '../../field-sales/pdf-text.js';

const run = crypto.randomUUID().replaceAll('-', ''), users = {}, cases = [];
let server, base, flag, originalFetch, originalPriceTrigger, remoteCalls = 0;
const featureMigration = new URL('../../../migrations/262_special_line_decline.sql', import.meta.url);
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
const audit = async id => (await query("SELECT * FROM sales_special_stock_events WHERE request_id=$1 AND (event_type LIKE 'special_case_%edit%' OR event_type LIKE 'special_line_%') ORDER BY id", [id])).rows;
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
  if (existsSync(featureMigration)) await query(readFileSync(featureMigration, 'utf8'));
  await query(readFileSync('migrations/283_special_customer_confirmation.sql', 'utf8'));
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899397,'TEST-QUOTE-CUSTOMER','TEST Quote Customer','TEST Quote Customer','CAD',true,now(),'test',repeat('f',64)) ON CONFLICT DO NOTHING");
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



const decision = (d, index, declined) => ({ lineId: d.lines[index].id, declined });
const getCase = id => repo.getSpecialStockCase(id, { audience: 'sales', authorizedStoreLocationIds: [1] });
const stableLine = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['sales_decision', 'decline_restore', 'decision_revision', 'decided_by', 'decided_at', 'updated_at'].includes(key)));
async function assertStage(d, expected) {
  assert.equal(d.stage, expected);
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1', [d.id])).rows[0].stage, expected);
  for (const audience of ['sales', 'scm']) {
    const found = await repo.listSpecialStockCases({ audience, authorizedStoreLocationIds: [1], stages: [expected], search: d.requestRef });
    assert.ok(found.some(row => row.id === d.id && row.stage === expected), audience + ' stage filter');
  }
}

test('decline/revoke recalculates customer confirmation across Sales, SCM and SQL filters without deleting or resetting any line', async () => {
  for (const mode of ['confirmed', 'new_enquiry', 'await_customer_confirmation']) {
    let d = await reviewedCase({ production: true });
    await query("UPDATE sales_special_stock_lines SET supply_status='in_stock' WHERE id=$1", [d.lines[1].id]);
    if (mode === 'new_enquiry') await query("UPDATE sales_special_stock_lines SET supply_status=NULL,sales_decision='pending' WHERE id=$1", [d.lines[0].id]);
    if (mode === 'await_customer_confirmation') await query("UPDATE sales_special_stock_lines SET sales_decision='pending' WHERE id=$1", [d.lines[1].id]);
    d = await getCase(d.id); await assertStage(d, mode);
    const index = mode === 'await_customer_confirmation' ? 1 : 0, before = await snapshot(d.id);
    const changed = await call(d.id, { expectedRevision: d.revision, decisions: [decision(d, index, true)] });
    assert.equal(changed.status, 200, JSON.stringify(changed.payload)); assert.equal(changed.payload.lines[index].salesDecision, 'declined');
    const declinedStage = 'confirmed';
    assert.equal(changed.payload.lines.length, 2); assert.equal(changed.payload.status, d.status); await assertStage(changed.payload, declinedStage);
    const current = await rows(d.id); assert.deepEqual(current.map(stableLine), before.rows.map(stableLine));
    assert.deepEqual(current[1 - index], before.rows[1 - index]); assert.deepEqual(await orders(d.id), before.orders);
    assert.equal(changed.payload.lines[index].customerNote, 'Customer note');
    const chargeEdit = await call(d.id, { expectedRevision: changed.payload.revision, deliveryFeeRate: 0 });
    assert.equal(chargeEdit.status, 200); await assertStage(chargeEdit.payload, declinedStage);
    assert.equal(chargeEdit.payload.deliveryFeeRate, 0); assert.equal(chargeEdit.payload.lineDecisionsNeedReview, true);
    const revoked = await call(d.id, { expectedRevision: chargeEdit.payload.revision, decisions: [decision(d, index, false)] });
    assert.equal(revoked.status, 200); assert.equal(revoked.payload.lines[index].salesDecision, d.lines[index].salesDecision);
    assert.equal(revoked.payload.status, d.status); await assertStage(revoked.payload, mode);
    assert.deepEqual((await rows(d.id)).map(stableLine), before.rows.map(stableLine));
  }
});

test('historical declines and a changed SCM response revoke to pending; normal stock review then recalculates the stage', async () => {
  let d = await reviewedCase();
  await query("UPDATE sales_special_stock_lines SET sales_decision='declined',sales_customer_note='Saved note',sales_decision_reason='Original reason' WHERE id=$1", [d.lines[0].id]);
  d = await getCase(d.id);
  let changed = await call(d.id, { expectedRevision: d.revision, decisions: [decision(d, 0, false)] });
  assert.equal(changed.status, 200); assert.equal(changed.payload.lines[0].salesDecision, 'pending');
  assert.equal(changed.payload.lines[0].salesCustomerNote, 'Saved note'); assert.equal(changed.payload.lines[0].salesDecisionReason, 'Original reason');
  d = await reviewedCase({ production: true });
  changed = await call(d.id, { expectedRevision: d.revision, decisions: d.lines.map((_, i) => decision(d, i, true)) });
  assert.equal(changed.status, 200); assert.equal(changed.payload.lines.length, 2); assert.ok(changed.payload.lines.every(l => l.salesDecision === 'declined'));
  await assertStage(changed.payload, 'await_customer_confirmation');
  const reviewed = await repo.respondSpecialStockLine(d.id, d.lines[0].id, { expectedRevision: changed.payload.revision,
    supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 331, vendorName: 'TEST Vendor', vendorYard: 'West yard' }, context());
  assert.equal(reviewed.stage, 'await_customer_confirmation');
  const revoked = await call(d.id, { expectedRevision: reviewed.revision, decisions: [decision(d, 0, false)] });
  assert.equal(revoked.status, 200); assert.equal(revoked.payload.lines[0].salesDecision, 'pending');
  await assertStage(revoked.payload, reviewed.stage);
});

test('quote excludes declined lines, orders wait for a newly saved draft, and revoked omitted items return to the quote', async () => {
  const d = await reviewedCase(), changed = await call(d.id, { expectedRevision: d.revision, decisions: [decision(d, 1, true)] });
  assert.equal(changed.status, 200); assert.equal(changed.payload.lineDecisionsNeedReview, true);
  for (const orderKind of ['sales_order', 'purchase_order']) await assert.rejects(repo.claimSpecialOrderOperation(d.id,
    { expectedRevision: changed.payload.revision, orderKind, operationId: crypto.randomUUID() }), { code: 'SPECIAL_DECISION_REVIEW_REQUIRED', status: 409 });
  await assert.rejects(repo.linkSpecialSalesOrder(d.id, { expectedRevision: changed.payload.revision, source: 'standalone', salesOrderId: 123, salesOrderRef: 'TEST-SO' }, context()),
    { code: 'SPECIAL_DECISION_REVIEW_REQUIRED', status: 409 });
  const skipFlag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_test_skip_orders'")).rows[0].enabled;
  try {
    await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_test_skip_orders'");
    for (const orderKind of ['sales_order', 'purchase_order']) await assert.rejects(repo.skipSpecialOrderCreation(d.id,
      { expectedRevision: changed.payload.revision, orderKind }, context()), { code: 'SPECIAL_DECISION_REVIEW_REQUIRED', status: 409 });
  } finally { await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_test_skip_orders'", [skipFlag]); }
  const response = await fetch(`${base}/api/sales/special-stock-requests/${d.id}/quote.pdf`, { headers: { authorization: 'Bearer ' + users.sales.token } });
  assert.equal(response.status, 200); assert.doesNotMatch(pdfText(Buffer.from(await response.arrayBuffer())), /Old item 1/);
  const accepted = changed.payload.lines[0];
  const saved = await repo.saveSpecialSalesOrderDraft(d.id, { expectedRevision: changed.payload.revision, customerId: 8899397,
    operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 3, palletRate: 40,
    materialLines: [{ caseLineId: accepted.id, itemId: 2055, description: 'Old item 0 Grey 80mm Smooth', quantity: 6,
      packageQuantity: 3, conversionToPc: 2, uom: 'PC', rate: 12.25, discountPercent: 10 }] }, context());
  assert.equal(saved.lineDecisionsNeedReview, false);
  assert.ok(saved.salesOrderLines.filter(l => !l.ancillary).every(l => l.caseLineId === accepted.id));
  assert.ok(saved.purchaseOrderLines.every(l => l.caseLineId === accepted.id));
  const revoked = await call(d.id, { expectedRevision: saved.revision, decisions: [decision(d, 1, false)] });
  assert.equal(revoked.status, 200); assert.equal(revoked.payload.lines[1].salesDecision, 'accepted');
  const q = buildSpecialQuote(revoked.payload, { name: 'TEST Company', taxBps: 1300 });
  assert.ok(q.snapshot.lines.some(l => l.description.includes('Old item 1'))); assert.equal(revoked.payload.lineDecisionsNeedReview, true);
  assert.doesNotMatch(JSON.stringify(revoked.payload), /Private stock check|unitPurchaseCost|scmInternalNote/);
});

test('invalid, foreign and duplicate actions, stale saves, scope failures and order locks leave the whole request unchanged', async () => {
  const d = await reviewedCase(), before = await snapshot(d.id), body = { expectedRevision: d.revision, decisions: [decision(d, 0, true)] };
  for (const decisions of [null, [{ lineId: 99999999, declined: true }], [decision(d, 0, true), decision(d, 0, false)], [{ lineId: d.lines[0].id, declined: 'true' }]]) {
    assert.equal((await call(d.id, { ...body, decisions, pallet: { quantity: 5, rate: 45 } })).status, 400);
  }
  for (const [role, status] of [['none', 401], ['scm', 403], ['outside', 403]]) assert.equal((await call(d.id, body, role)).status, status);
  assert.equal((await call(d.id, { ...body, expectedRevision: d.revision + 1 })).status, 409); assert.deepEqual(await snapshot(d.id), before);
  for (const assignment of ["close_status='closed'", "sales_order_netsuite_id=42,sales_order_ref='TEST-SOB42'", 'sales_order_submission_started_at=now()']) {
    const locked = await reviewedCase(); await query('UPDATE sales_special_stock_cases SET ' + assignment + ' WHERE request_id=$1', [locked.id]);
    const original = await snapshot(locked.id); assert.equal((await call(locked.id, { expectedRevision: locked.revision, decisions: [decision(locked, 0, true)] })).status, 409);
    assert.deepEqual(await snapshot(locked.id), original);
  }
});

test('two concurrent decline saves have one winner and one revision conflict; repeating the saved state is a true no-op', async () => {
  const d = await reviewedCase();
  const responses = await Promise.all([0, 1].map(i => call(d.id, { expectedRevision: d.revision, decisions: [decision(d, i, true)] })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const changed = await getCase(d.id); assert.equal(changed.lines.filter(l => l.salesDecision === 'declined').length, 1);
  const before = await snapshot(d.id);
  const same = await call(d.id, { expectedRevision: changed.revision, decisions: changed.lines.map(l => ({ lineId: l.id, declined: l.salesDecision === 'declined' })) });
  assert.equal(same.status, 200); assert.deepEqual(await snapshot(d.id), before);
});

test('failure on a later decision rolls back both decisions, charges, stage, revision and history together', async () => {
  const d = await reviewedCase(), before = await snapshot(d.id), name = 'test_decline_failure_' + run;
  await query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${d.lines[1].id} AND NEW.sales_decision='declined' THEN RAISE EXCEPTION 'TEST decline failure'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER ${name} BEFORE UPDATE ON sales_special_stock_lines FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    const response = await call(d.id, { expectedRevision: d.revision, decisions: d.lines.map((_, i) => decision(d, i, true)), pallet: { quantity: 5, rate: 45 }, deliveryFeeRate: 15 });
    assert.equal(response.status, 500); assert.deepEqual(await snapshot(d.id), before);
  } finally { await query(`DROP TRIGGER ${name} ON sales_special_stock_lines`); await query(`DROP FUNCTION ${name}()`); }
});

test('an edited declined line allows remaining accepted lines to confirm; revoking the decline requires a fresh stock check', async () => {
  const d = await reviewedCase();
  const changed = await call(d.id, { expectedRevision: d.revision, lines: [editLine(d, { quantity: 4 })], decisions: [decision(d, 0, true)] });
  assert.equal(changed.status, 200); assert.equal(changed.payload.lines[0].salesDecision, 'declined'); assert.equal(changed.payload.lines[0].supplyStatus, null);
  assert.equal(changed.payload.stage, 'confirmed');
  const edited = await call(d.id, { expectedRevision: changed.payload.revision,
    lines: [editLine(changed.payload, { quantity: 5 })], decisions: [decision(d, 0, true)] });
  assert.equal(edited.status, 200); assert.equal(edited.payload.lines[0].salesDecision, 'declined'); await assertStage(edited.payload, 'confirmed');
  const revoked = await call(d.id, { expectedRevision: edited.payload.revision, decisions: [decision(d, 0, false)] });
  assert.equal(revoked.status, 200); assert.equal(revoked.payload.lines[0].salesDecision, 'pending'); assert.equal(revoked.payload.stage, 'new_enquiry');
});

test('legacy decline migration plus current status view is repeatable and its schema changes roll back transactionally', async () => {
  assert.ok(existsSync(featureMigration));
  const sql = readFileSync(featureMigration, 'utf8') + readFileSync('migrations/283_special_customer_confirmation.sql', 'utf8'), before = (await query('SELECT * FROM special_stock_workflow_stages ORDER BY request_id')).rows;
  await query(sql); await query(sql); assert.deepEqual((await query('SELECT * FROM special_stock_workflow_stages ORDER BY request_id')).rows, before);
  await assert.rejects(withTransaction(async () => {
    await query('DROP VIEW special_stock_workflow_stages'); await query('ALTER TABLE sales_special_stock_cases DROP COLUMN line_edit_state');
    await query('ALTER TABLE sales_special_stock_lines DROP COLUMN decline_restore');
    await query(sql);
    assert.equal((await query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='sales_special_stock_lines' AND column_name='decline_restore'")).rows[0].n, 1);
    throw new Error('TEST rollback migration');
  }), /TEST rollback migration/);
  assert.deepEqual((await query('SELECT * FROM special_stock_workflow_stages ORDER BY request_id')).rows, before);
});
