import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import { readFileSync, existsSync } from 'node:fs';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';

const run = crypto.randomUUID().replaceAll('-', ''), users = {}, cases = [];
let server, base, flag, originalFetch, originalPriceTrigger, remoteCalls = 0;
const migration = () => readFileSync(new URL('../../../migrations/' + (existsSync(new URL('../../../migrations/264_special_case_field_edits.sql', import.meta.url)) ? '264_special_case_field_edits.sql' : '249_special_case_line_edits.sql'), import.meta.url), 'utf8');
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
    sales_uom='PC',purchase_uom='PC',sales_quantity=requested_quantity,purchase_quantity=requested_quantity,
    sales_package_quantity=requested_quantity,pieces_per_unit=1,scm_reviewed_quantity=requested_quantity,scm_reviewed_pieces_per_unit=1
    WHERE request_id=$1`, [detail.id, production ? 'production' : 'in_stock', users.sales.id]);
  if (draft) {
    await query(`INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,item_name,description,quantity,uom,unit_rate,native_discount_percent)
      SELECT request_id,id,'sales_order',2055,'MBBS-Special Order',resolved_description,sales_quantity,'PC',original_unit_rate,discount_percent
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

const corrections = { color: 'Black', size: '90mm', detailSpec: 'Rough finish', uom: 'LYR', requiredDate: '2099-03-01',
  customerNote: 'New line note', discountPercent: 25, palletQty: 0, layerQty: 5.5, sectionQty: 6, pieceQty: 7 };
async function stockCheck(detail, lines, role = 'scm') {
  const response = await fetch(`${base}/api/scm/special-stock-requests/${detail.id}/stock-check`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(users[role]?.token ? { authorization: 'Bearer ' + users[role].token } : {}) },
    body: JSON.stringify({ expectedRevision: detail.revision, lines }) });
  return { status: response.status, payload: await response.json() };
}
const stockLine = (line, fields) => ({ lineId: line.id, kind: 'response', supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 331, vendorName: 'TEST Vendor', vendorYard: 'North', ...fields });
test('SCM required-date correction persists through HTTP and is visible to Sales with its audit', async () => {
  const detail = await newCase(), second = (await rows(detail.id))[1];
  const result = await stockCheck(detail, [stockLine(detail.lines[0], { requiredDate: '2099-03-01' })]);
  assert.equal(result.status, 200, JSON.stringify(result.payload)); assert.equal(result.payload.lines[0].requiredDate, '2099-03-01');
  const sales = await repo.getSpecialStockCase(detail.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
  assert.equal(sales.lines[0].requiredDate, '2099-03-01');
  const event = sales.events.find(e => e.eventType === 'special_item_fields_corrected');
  assert.equal(event.details.from.requiredDate, '2099-02-01'); assert.equal(event.details.to.requiredDate, '2099-03-01');
  assert.deepEqual((await rows(detail.id))[1], second);
});
test('invalid SCM required dates reject and roll back earlier corrections in the same HTTP batch', async () => {
  const detail = await newCase(), before = await snapshot(detail.id);
  for (const requiredDate of ['2099-02-30', '2000-01-01', '', null, {}]) {
    const result = await stockCheck(detail, [stockLine(detail.lines[0], { color: 'Blue' }), stockLine(detail.lines[1], { requiredDate })]);
    assert.equal(result.status, 400, JSON.stringify(result.payload)); assert.deepEqual(await snapshot(detail.id), before);
  }
});
test('SCM required-date corrections retain role and issued-order locks', async () => {
  const detail = await newCase(), before = await snapshot(detail.id), lines = [stockLine(detail.lines[0], { requiredDate: '2099-03-01' })];
  const denied = await stockCheck(detail, lines, 'sales'); assert.equal(denied.status, 403); assert.deepEqual(await snapshot(detail.id), before);
  await query('UPDATE sales_special_stock_cases SET sales_order_skipped=true WHERE request_id=$1', [detail.id]);
  const locked = await snapshot(detail.id), result = await stockCheck(detail, lines);
  assert.equal(result.status, 409); assert.deepEqual(await snapshot(detail.id), locked);
});
test('Sales saves all new fields, updates quote basis, resets only changed reviews and audits every field', async () => {
  const detail = await reviewedCase(), before = await rows(detail.id);
  const result = await call(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, corrections)] });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  for (const [field, value] of Object.entries(corrections)) assert.equal(result.payload.lines[0][field], value, field);
  assert.equal(result.payload.lines[0].rateUom, 'LYR'); assert.equal(result.payload.lines[0].quotedDiscountPercent, 25);
  assert.equal(result.payload.stage, 'new_enquiry'); assert.equal(result.payload.lines[0].salesDecision, 'pending');
  assert.equal((await orders(detail.id)).length, 0); assert.deepEqual((await rows(detail.id))[1], before[1]);
  const event = result.payload.events.find(event => event.eventType === 'special_case_lines_edited');
  assert.equal(event.details.lines[0].to.color, 'Black'); assert.equal(event.details.lines[0].from.color, 'Grey');
  const quote = buildSpecialQuote(result.payload, { name: 'TEST', taxBps: 0 }); assert.equal(quote.snapshot.lines[0].unit, 'LYR');
});
test('Sales discount and note preserve reviews, update native draft discount and leave purchase costs unchanged', async () => {
  const detail = await reviewedCase(), before = await rows(detail.id), oldOrders = await orders(detail.id);
  const result = await call(detail.id, { expectedRevision: detail.revision, lines: [editLine(detail, { discountPercent: 20, customerNote: 'Changed note' })] });
  assert.equal(result.status, 200, JSON.stringify(result.payload)); assert.equal(result.payload.stage, detail.stage);
  assert.equal(result.payload.lines[0].discountPercent, 20); assert.equal(result.payload.lines[0].quotedDiscountPercent, 20);
  assert.equal(result.payload.lines[0].subtotal, 29.4); assert.equal(result.payload.lines[0].customerNote, 'Changed note');
  for (const key of ['stock_checked_at','sales_decision','resolved_item_id','unit_purchase_cost','response_revision']) assert.deepEqual((await rows(detail.id))[0][key], before[0][key], key);
  const saved = await orders(detail.id); assert.equal(Number(saved.find(row => row.order_kind === 'sales_order' && Number(row.case_line_id) === detail.lines[0].id).native_discount_percent), 20);
  assert.deepEqual(saved.filter(row => row.order_kind === 'purchase_order'), oldOrders.filter(row => row.order_kind === 'purchase_order'));
});
test('SCM stock corrections save with the response and clear stale acceptance and conversions', async () => {
  const detail = await reviewedCase(), before = await rows(detail.id);
  const fields = { productName: 'Corrected stone', color: 'Black', size: '90mm', detailSpec: 'Rough', quantity: 5, uom: 'LYR', palletQty: 0, layerQty: 3, sectionQty: 4, pieceQty: 8 };
  const result = await repo.saveSpecialStockChecks(detail.id, { expectedRevision: detail.revision, lines: [{ lineId: detail.lines[0].id, kind: 'response',
    supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 331, vendorName: 'TEST Vendor', vendorYard: 'North', ...fields,
    rate: 1, discountPercent: 99, customerNote: 'Injected', requiredDate: '2099-04-01' }] }, { operatorId: users.scm.id });
  for (const [field, value] of Object.entries(fields)) assert.equal(result.lines[0][field], value, field);
  assert.equal(result.lines[0].rateUom, 'LYR'); assert.equal(result.lines[0].originalRate, 12.25); assert.equal(result.lines[0].discountPercent, 10);
  assert.equal(result.lines[0].customerNote, 'Customer note'); assert.equal(result.lines[0].supplyStatus, 'in_stock');
  assert.equal(result.lines[0].salesDecision, 'pending'); assert.equal(result.lines[0].itemResolution, null);
  assert.equal(result.lines[0].conversionToPc, null); assert.equal(result.stage, 'await_customer_confirmation');
  assert.deepEqual((await rows(detail.id))[1], before[1]); assert.equal((await orders(detail.id)).length, 0);
});
test('SCM invalid second-line corrections roll back the whole stock batch', async () => {
  const detail = await newCase(), before = await snapshot(detail.id);
  const response = (line, patch) => ({ lineId: line.id, kind: 'response', supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 331, vendorName: 'TEST Vendor', vendorYard: 'North', ...patch });
  await assert.rejects(repo.saveSpecialStockChecks(detail.id, { expectedRevision: detail.revision, lines: [response(detail.lines[0], { color: 'Blue' }), response(detail.lines[1], { pieceQty: -1 })] }, { operatorId: users.scm.id }), error => error.status === 400);
  assert.deepEqual(await snapshot(detail.id), before);
});
test('field migration is scoped, repeatable and rollback preserves old data', async () => {
  const detail = await newCase(), before = await snapshot(detail.id);
  await withTransaction(async () => {
    await query(migration()); await query(migration());
    const update = () => query("UPDATE sales_special_stock_lines SET original_rate_uom='LYR',quoted_discount_percent=20 WHERE id=$1", [detail.lines[0].id]);
    await assert.rejects(withTransaction(update), { code: '23514' });
    await query("SELECT set_config('mbbs.special_case_edit_request',$1,true)", [String(detail.id)]);
    await update();
    await query("UPDATE sales_special_stock_cases SET sales_order_operation_status='creating' WHERE request_id=$1", [detail.id]);
    await assert.rejects(withTransaction(() => query("UPDATE sales_special_stock_lines SET original_rate_uom='SEC' WHERE id=$1", [detail.lines[0].id])), { code: '23514' });
  }, { rollback: true });
  assert.deepEqual(await snapshot(detail.id), before);
});

async function issuedCase() {
  const detail = await reviewedCase();
  await query('UPDATE sales_special_stock_cases SET sales_order_skipped=true,purchase_order_skipped=true WHERE request_id=$1', [detail.id]);
  return repo.getSpecialStockCase(detail.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
}
const adjustmentLines = (detail, patch) => detail.lines.map((line, index) => ({ caseLineId: line.id, quantity: line.packageQuantity,
  discountPercent: line.discountPercent, ...(index === 0 ? patch : {}) }));
test('issued order metadata proposal stays pending until SCM approval and persists every approved field', async () => {
  const detail = await issuedCase(), before = await rows(detail.id);
  const patch = { ...corrections, productName: 'New stone', quantity: 4 };
  const pending = await repo.requestSpecialQuantityChange(detail.id, { expectedRevision: detail.revision, lines: adjustmentLines(detail, patch) }, context());
  assert.equal(pending.quantityReview.status, 'pending'); assert.equal(pending.quantityReview.lines[0].toFields.color, 'Black');
  assert.deepEqual(await rows(detail.id), before);
  const claimed = await repo.claimSpecialQuantityReview(detail.id, { expectedRevision: pending.revision, reviewId: pending.quantityReview.id }, { operatorId: users.scm.id });
  const approved = await repo.finishSpecialQuantityReview(detail.id, { reviewId: claimed.quantityReview.id }, { operatorId: users.scm.id });
  for (const [field, value] of Object.entries(corrections)) assert.equal(approved.lines[0][field], value, field);
  assert.equal(approved.lines[0].productName, 'New stone'); assert.equal(approved.lines[0].rateUom, 'LYR');
  assert.equal(approved.lines[0].packageQuantity, 4); assert.equal(approved.lines[0].conversionToPc, 1);
  assert.equal(approved.salesOrderLines[0].quantity, 4); assert.equal(approved.salesOrderLines[0].description, 'New stone Black 90mm Rough finish');
  for (const line of [approved.salesOrderLines[0], approved.purchaseOrderLines[0]]) { assert.equal(line.palletQty, 0); assert.equal(line.layerQty, 5.5); assert.equal(line.pieceQty, 7); }
  assert.equal(approved.purchaseOrderLines[0].unitPurchaseCost, 8); assert.deepEqual((await rows(detail.id))[1], before[1]);
});
test('description-only issued adjustment is reviewable and rejection leaves original fields and drafts intact', async () => {
  const detail = await issuedCase(), before = await snapshot(detail.id);
  const pending = await repo.requestSpecialQuantityChange(detail.id, { expectedRevision: detail.revision, lines: adjustmentLines(detail, { color: 'Blue' }) }, context());
  assert.equal(pending.quantityReview.lines.length, 1); assert.equal(pending.quantityReview.adjustmentVersion, 2);
  await repo.rejectSpecialQuantityReview(detail.id, { expectedRevision: pending.revision, reviewId: pending.quantityReview.id, reason: 'Keep original' }, { operatorId: users.scm.id });
  assert.deepEqual(await rows(detail.id), before.rows); assert.deepEqual(await orders(detail.id), before.orders);
});

test('verified issued-order field corrections reach canonical SO and PO rows used by Dispatch', async () => {
  await withTransaction(async () => {
    let detail = await reviewedCase();
    const ids = [8900000 + detail.id * 2, 8900001 + detail.id * 2];
    const snapshots = [];
    for (const [index, kind] of ['sales_order', 'purchase_order'].entries()) {
      const sales = kind === 'sales_order', orderId = ids[index];
      if (sales) await query("INSERT INTO sales_orders(netsuite_id,tranid,order_location_id,order_location,outbound_location_id,outbound_location,status_text,netsuite_active) VALUES($1,$2,1,'3445',1,'3445','Pending Fulfillment',true)", [orderId, 'TEST-FIELDS-' + orderId]);
      else await query("INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,status_text,netsuite_active) VALUES($1,$2,1,'Pending Receipt',true)", [orderId, 'TEST-FIELDS-' + orderId]);
      const saved = (await orders(detail.id)).filter(row => row.order_kind === kind), snapshot = { header: {}, lines: [] };
      for (const [position, row] of saved.entries()) {
        const lineId = orderId * 100 + position + 1;
        await query(`INSERT INTO ${sales ? 'sales_order_lines' : 'purchase_order_lines'}(${kind}_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active,pallet_qty,layer_qty,section_qty,piece_qty) VALUES($1,$2,$3,$4,$5,$6,$7,true,1,2,3,4)`,
          [orderId,lineId,row.item_id,row.item_name,row.description,row.quantity,row.uom]);
        await query('UPDATE sales_special_stock_order_lines SET remote_line_id=$2 WHERE id=$1', [row.id,lineId]);
        snapshot.lines.push({ remoteLineId: lineId, itemId: Number(row.item_id), quantity: Number(row.quantity), unitId: row.uom === 'EACH' ? 246 : 865,
          rate: String(sales ? row.unit_rate : row.unit_purchase_cost), description: row.description, pack: { palletQty:1,layerQty:2,sectionQty:3,pieceQty:4 } });
      }
      snapshots.push({ id: orderId, kind, baseline: snapshot, target: structuredClone(snapshot) });
    }
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=$2,sales_order_ref=$4,sales_order_status='Pending Fulfillment',sales_order_approved=true,purchase_order_netsuite_id=$3,purchase_order_ref=$5,purchase_order_status='Pending Receipt' WHERE request_id=$1", [detail.id,ids[0],ids[1],'TEST-FIELDS-'+ids[0],'TEST-FIELDS-'+ids[1]]);
    detail = await repo.getSpecialStockCase(detail.id, { audience: 'scm' });
    const pending = await repo.requestSpecialQuantityChange(detail.id, { expectedRevision: detail.revision,
      lines: adjustmentLines(detail, { color: 'Black', pieceQty: 9 }) }, context());
    await repo.claimSpecialQuantityReview(detail.id, { expectedRevision: pending.revision, reviewId: pending.quantityReview.id }, { operatorId: users.scm.id });
    for (const order of snapshots) { order.target.lines[0].description = 'Old item 0 Black 80mm Smooth'; order.target.lines[0].pack.pieceQty = 9; }
    await repo.saveSpecialQuantityReviewPlan(detail.id, { reviewId: pending.quantityReview.id, plan: { version: 2, orders: snapshots }, remoteStarted: true });
    await repo.finishSpecialQuantityReview(detail.id, { reviewId: pending.quantityReview.id, verifiedOrderIds: ids,
      verifiedOrders: snapshots.map(order => ({ id: order.id, kind: order.kind, ...order.target })) }, { operatorId: users.scm.id });
    for (const [index, kind] of ['sales_order', 'purchase_order'].entries()) {
      const row = (await query(`SELECT item_description,piece_qty FROM ${kind}_lines WHERE ${kind}_id=$1 ORDER BY line_id`, [ids[index]])).rows[0];
      assert.equal(row.item_description, 'Old item 0 Black 80mm Smooth'); assert.equal(Number(row.piece_qty), 9);
    }
  }, { rollback: true });
});


test('property: issued adjustments always use one and preserve original rate and purchase cost', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 20 }), fc.constantFrom('PLT','LYR','SEC','PCS','EACH','SQFT'),
    fc.constantFrom(4, 0, -1, 'invalid', null, {}, undefined), async (quantity, uom, conversion) => {
      await withTransaction(async () => {
        const detail = await issuedCase(), before = await rows(detail.id);
        const pending = await repo.requestSpecialQuantityChange(detail.id, { expectedRevision: detail.revision,
          lines: adjustmentLines(detail, { quantity, uom, color: 'Black', conversionToPc: conversion }) }, context());
        const proposal = pending.quantityReview.lines[0];
        assert.equal(proposal.toConversion, 1); assert.equal(proposal.toQuantity, quantity);
        assert.equal(proposal.toPurchaseQuantity, quantity); assert.equal(proposal.toRate, 12.25);
        assert.deepEqual(await rows(detail.id), before);
        await repo.claimSpecialQuantityReview(detail.id, { expectedRevision: pending.revision, reviewId: pending.quantityReview.id }, { operatorId: users.scm.id });
        const approved = await repo.finishSpecialQuantityReview(detail.id, { reviewId: pending.quantityReview.id }, { operatorId: users.scm.id });
        assert.equal(approved.lines[0].conversionToPc, 1); assert.equal(approved.salesOrderLines[0].quantity, quantity);
        assert.equal(approved.salesOrderLines[0].rate, 12.25); assert.equal(approved.purchaseOrderLines[0].unitPurchaseCost, 8);
      }, { rollback: true });
    }), { seed: 20261004, numRuns: 20 });
});

test('missing historical conversion uses one without prompting while order-rate drift still blocks edits', async () => {
  let detail = await issuedCase();
  await query('UPDATE sales_special_stock_lines SET pieces_per_unit=NULL WHERE request_id=$1', [detail.id]);
  detail = await repo.getSpecialStockCase(detail.id, { audience: 'sales' });
  const pending = await repo.requestSpecialQuantityChange(detail.id, { expectedRevision: detail.revision,
    lines: adjustmentLines(detail, { quantity: 4, uom: 'LYR' }) }, context());
  assert.equal(pending.quantityReview.lines[0].fromConversion, 1);
  assert.equal(pending.quantityReview.lines[0].toConversion, 1);
  assert.equal(pending.quantityReview.lines[0].toQuantity, 4);
  detail = await issuedCase();
  await query("UPDATE sales_special_stock_order_lines SET unit_rate=99 WHERE request_id=$1 AND order_kind='sales_order' AND case_line_id=$2", [detail.id,detail.lines[0].id]);
  await assert.rejects(repo.requestSpecialQuantityChange(detail.id, { expectedRevision: detail.revision,
    lines: adjustmentLines(detail, { quantity: 4, uom: 'LYR' }) }, context()), { code: 'SPECIAL_RATE_LOCKED' });
});

test('new adjustments normalize a legacy conversion only through the existing SCM approval', async () => {
  let detail = await issuedCase();
  await query('UPDATE sales_special_stock_lines SET pieces_per_unit=2,sales_quantity=requested_quantity*2,purchase_quantity=requested_quantity*2 WHERE request_id=$1', [detail.id]);
  await query("UPDATE sales_special_stock_order_lines SET quantity=quantity*2,unit_rate=CASE WHEN order_kind='sales_order' THEN unit_rate/2 ELSE unit_rate END WHERE request_id=$1 AND case_line_id IS NOT NULL", [detail.id]);
  detail = await repo.getSpecialStockCase(detail.id, { audience: 'sales' });
  const savedBefore = await rows(detail.id);
  const pending = await repo.requestSpecialQuantityChange(detail.id, { expectedRevision: detail.revision,
    lines: adjustmentLines(detail, { quantity: 4, uom: 'LYR' }) }, context());
  assert.equal(pending.quantityReview.lines[0].fromConversion, 2);
  assert.equal(pending.quantityReview.lines[0].toConversion, 1);
  assert.deepEqual(await rows(detail.id), savedBefore);
  await repo.claimSpecialQuantityReview(detail.id, { expectedRevision: pending.revision, reviewId: pending.quantityReview.id }, { operatorId: users.scm.id });
  const approved = await repo.finishSpecialQuantityReview(detail.id, { reviewId: pending.quantityReview.id }, { operatorId: users.scm.id });
  assert.equal(approved.salesOrderLines[0].quantity, 4); assert.equal(approved.salesOrderLines[0].rate, 12.25);
  assert.equal(approved.purchaseOrderLines[0].quantity, 4); assert.equal(approved.purchaseOrderLines[0].unitPurchaseCost, 8);
});
