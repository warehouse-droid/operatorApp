import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

after(closeDb);
const sales = { operatorId: 'special-line-details-sales', authorizedStoreLocationIds: [1] };
const scm = { operatorId: 'special-line-details-scm' }, scmOther = { operatorId: 'special-line-details-scm-2' };
const vendor = { vendorId: 8899300, vendorName: 'TEST Unilock Alliance' }, corrected = { vendorId: 8899301, vendorName: 'TEST Unilock Ltd.' };
const so = 8899310, po = 8899311;

async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
  const tx = await beginRollbackContext();
  try { await tx.run(async () => {
    for (const [id, role] of [[sales.operatorId, 'sales'], [scm.operatorId, 'scm'], [scmOther.operatorId, 'scm']]) {
      await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids)
        VALUES($1,$1,'TEST Line Details','hash','salt',$2,ARRAY[$2],ARRAY[1]) ON CONFLICT DO NOTHING`, [id, role]);
    }
    let d = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Line Details', vendorName: vendor.vendorName,
      fulfillmentMethod: 'yard_pickup', lines: ['Slab', 'Coping'].map(productName => ({ productName, quantity: 2, uom: 'PCS', rate: 10, requiredDate: '2099-02-01' })) }, sales);
    d = await repo.saveSpecialStockChecks(d.id, { expectedRevision: d.revision, lines: d.lines.map(line => ({ lineId: line.id, kind: 'response',
      supplyStatus: 'in_stock', availabilityMode: 'no_projection', ...vendor, vendorYard: 'TEST AYR' })) }, scm);
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,status,status_text,netsuite_active,customer_id,customer)
      VALUES($1,'TEST-LINE-DETAILS-SO','2099-01-02','B','Sales Order : Pending Fulfillment',true,8899302,'TEST Line Details')`, [so]);
    await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,netsuite_active,vendor_id,vendor)
      VALUES($1,'TEST-LINE-DETAILS-PO','B','Purchase Order : Pending Receipt',true,$2,$3)`, [po, vendor.vendorId, vendor.vendorName]);
    await run(d);
  }); } finally { await tx.rollback(); }
}
const scmCase = d => repo.getSpecialStockCase(d.id, { audience: 'scm' });
const salesCase = d => repo.getSpecialStockCase(d.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
const stock = (d, lines, context = scm) => repo.saveSpecialStockChecks(d.id, { expectedRevision: d.revision, lines }, context);
const accept = async d => repo.saveSpecialCustomerDecisions(d.id, { expectedRevision: d.revision,
  lines: d.lines.filter(line => line.salesDecision !== 'declined').map(line => ({ lineId: line.id, decision: 'accepted' })) }, sales);
const linkSo = d => repo.linkSpecialSalesOrder(d.id, { expectedRevision: d.revision, salesOrderRef: 'TEST-LINE-DETAILS-SO' }, sales);
async function linkPo(d) {
  await query(`UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=$2,purchase_order_ref='TEST-LINE-DETAILS-PO',
    purchase_order_status='Purchase Order : Pending Receipt',purchase_order_operation_status='linked',purchase_order_custom_linkage=true WHERE request_id=$1`, [d.id, po]);
  return scmCase(d);
}
const events = async (d, type) => (await query('SELECT * FROM sales_special_stock_events WHERE request_id=$1 AND event_type=$2 ORDER BY id', [d.id, type])).rows;
// SCM's PO review maps and marks accepted lines ready; the claim then only checks order-level guards.
async function claimPo(d) {
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','EACH','{}',now()) ON CONFLICT DO NOTHING");
  await query(`UPDATE sales_special_stock_lines SET resolved_item_id=2055,resolved_item_name='MBBS-Special Order',
    sales_uom='PC',purchase_uom='PC',sales_quantity=requested_quantity,purchase_quantity=requested_quantity,
    po_ready=true,po_ready_by=$2,po_ready_at=now(),po_ready_response_revision=response_revision
    WHERE request_id=$1 AND sales_decision='accepted'`, [d.id, scm.operatorId]);
  return repo.claimSpecialOrderOperation(d.id, { expectedRevision: d.revision, orderKind: 'purchase_order', operationId: crypto.randomUUID() }, scm);
}
const readiness = (line, input = {}) => ({ lineId: line.id, kind: 'readiness', supplyStatus: line.supplyStatus, ...input });

test('a manual SO link clears the changed customer decision flag so SCM can create the PO', () => fixture(async d => {
  d = await repo.editSpecialStockCaseLines(d.id, { expectedRevision: d.revision, lines: [], decisions: [{ lineId: d.lines[1].id, declined: true }] }, sales);
  d = await accept(d);
  assert.equal(d.lineDecisionsNeedReview, true, 'A declined line still asks Sales to save the SO draft.');
  d = await linkSo(d);
  assert.equal(d.salesOrderSource, 'manual_link');
  assert.equal(d.lineDecisionsNeedReview, false);
  assert.equal((await query('SELECT line_edit_state FROM sales_special_stock_cases WHERE request_id=$1', [d.id])).rows[0].line_edit_state.orderReviewRequired, undefined);
  d = await claimPo(d);
  assert.equal(d.purchaseOrderOperationStatus, 'creating');
}));

test('a flag left on an existing manual SO link no longer blocks PO creation, and migration 332 clears it', () => fixture(async d => {
  d = await linkSo(await accept(d));
  await query(`UPDATE sales_special_stock_cases SET line_edit_state='{"stage":"new_enquiry","orderReviewRequired":true}' WHERE request_id=$1`, [d.id]);
  d = await scmCase(d);
  assert.equal(d.lineDecisionsNeedReview, false);
  const other = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Line Details Draft', vendorName: 'TEST Vendor',
    fulfillmentMethod: 'yard_pickup', lines: [{ productName: 'TEST Draft', quantity: 1, uom: 'PCS', rate: 10, requiredDate: '2099-02-01' }] }, sales);
  await query(`UPDATE sales_special_stock_cases SET line_edit_state='{"orderReviewRequired":true}' WHERE request_id=$1`, [other.id]);
  await query(await readFile(new URL('../../../migrations/332_special_scm_line_details.sql', import.meta.url), 'utf8'));
  const states = Object.fromEntries((await query('SELECT request_id,line_edit_state FROM sales_special_stock_cases WHERE request_id=ANY($1)', [[d.id, other.id]])).rows
    .map(row => [Number(row.request_id), row.line_edit_state]));
  assert.deepEqual(states[d.id], { stage: 'new_enquiry' });
  assert.deepEqual(states[other.id], { orderReviewRequired: true }, 'Requests without a manual SO still need the draft review.');
  assert.equal((await salesCase(other)).lineDecisionsNeedReview, true);
  d = await claimPo(d);
  assert.equal(d.purchaseOrderOperationStatus, 'creating');
}));

test('SCM corrects the case vendor during the stock check; one batch cannot mix vendors', () => fixture(async d => {
  const lines = d.lines.map(line => ({ lineId: line.id, kind: 'response', supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorYard: 'TEST Ltd yard' }));
  await assert.rejects(stock(d, [{ ...lines[0], ...corrected }, { ...lines[1], ...vendor }]), { code: 'SPECIAL_RESPONSE_MIXED_VENDOR' });
  assert.equal((await scmCase(d)).vendorId, vendor.vendorId);
  d = await stock(d, [{ ...lines[0], ...corrected }]);
  assert.equal(d.vendorId, corrected.vendorId);
  assert.equal(d.vendorName, corrected.vendorName);
  assert.deepEqual(d.lines.map(line => [line.responseVendorId, line.responseVendorName, line.brand]),
    d.lines.map(() => [corrected.vendorId, corrected.vendorName, corrected.vendorName]), 'Every line follows the one case vendor.');
  const [event] = await events(d, 'special_vendor_corrected');
  assert.deepEqual(event.details.from, vendor);
  assert.deepEqual(event.details.to, corrected);
  assert.equal(event.details.purchaseOrderVendorUnchanged, false);
  assert.equal(event.audience, 'sales_scm');
  d = await stock(d, [{ ...lines[1], ...corrected }]);
  assert.equal((await events(d, 'special_vendor_corrected')).length, 1, 'Saving the same vendor is not another correction.');
}));

test('after SO and PO linkage SCM edits the six line details and vendor; Sales sees the dated reply only', () => fixture(async d => {
  d = await linkPo(await linkSo(await accept(d)));
  const [line, second] = d.lines;
  d = await stock(d, [readiness(line, { eta: null, requiredDate: '2099-03-15', ...corrected, vendorYard: 'TEST Ltd yard',
    salesVisibleNote: 'Ready for pickup Friday', scmInternalNote: 'Vendor confirmed by phone' }), readiness(second, corrected)]);
  const saved = d.lines.find(item => item.id === line.id);
  assert.deepEqual([saved.requiredDate, saved.supplyStatus, saved.vendorYard, saved.salesVisibleNote, saved.scmInternalNote, saved.salesDecision],
    ['2099-03-15', 'in_stock', 'TEST Ltd yard', 'Ready for pickup Friday', 'Vendor confirmed by phone', 'accepted']);
  assert.ok(saved.salesVisibleNoteUpdatedAt, 'The reply records when SCM changed it.');
  assert.equal(d.vendorId, corrected.vendorId);
  assert.equal(d.purchaseOrderId, po, 'The linked PO is unchanged.');
  assert.equal(Number((await query('SELECT vendor_id FROM purchase_orders WHERE netsuite_id=$1', [po])).rows[0].vendor_id), vendor.vendorId);
  assert.equal((await events(d, 'special_vendor_corrected'))[0].details.purchaseOrderVendorUnchanged, true);
  const [details] = await events(d, 'special_line_details_updated');
  assert.equal(details.audience, 'sales_scm');
  assert.deepEqual(details.details, { before: { requiredDate: '2099-02-01', vendorYard: 'TEST AYR', salesVisibleNote: '' },
    after: { requiredDate: '2099-03-15', vendorYard: 'TEST Ltd yard', salesVisibleNote: 'Ready for pickup Friday' } });
  assert.equal((await events(d, 'special_scm_internal_note_updated'))[0].audience, 'scm');

  const visible = await salesCase(d), salesLine = visible.lines.find(item => item.id === line.id);
  assert.equal(salesLine.salesVisibleNote, 'Ready for pickup Friday');
  assert.ok(salesLine.salesVisibleNoteUpdatedAt);
  assert.equal(Object.hasOwn(salesLine, 'scmInternalNote'), false);
  assert.equal(visible.events.some(event => event.eventType === 'special_scm_internal_note_updated'), false);

  const stamp = (await query('SELECT sales_visible_note_updated_by FROM sales_special_stock_lines WHERE id=$1', [line.id])).rows[0];
  d = await stock(d, [readiness(saved, { requiredDate: '2099-03-15', vendorYard: 'TEST Ltd yard', salesVisibleNote: 'Ready for pickup Friday', scmInternalNote: 'Vendor confirmed by phone' })], scmOther);
  assert.equal((await events(d, 'special_line_details_updated')).length, 1, 'An unchanged save records no detail change.');
  assert.deepEqual((await query('SELECT sales_visible_note_updated_by FROM sales_special_stock_lines WHERE id=$1', [line.id])).rows[0], stamp);
  d = await stock(d, [readiness(saved, { salesVisibleNote: 'Ready Monday instead' })], scmOther);
  assert.equal((await query('SELECT sales_visible_note_updated_by FROM sales_special_stock_lines WHERE id=$1', [line.id])).rows[0].sales_visible_note_updated_by, scmOther.operatorId);
  assert.equal(d.lines.find(item => item.id === line.id).requiredDate, '2099-03-15', 'Omitted details stay saved.');
}));

test('line details validate input and stay locked on closed requests', () => fixture(async d => {
  d = await linkSo(await accept(d));
  const before = await scmCase(d), [line] = d.lines;
  await assert.rejects(stock(d, [readiness(line, { vendorYard: '' })]), { code: 'SPECIAL_RESPONSE_YARD_REQUIRED' });
  await assert.rejects(stock(d, [readiness(line, { requiredDate: '2099-02-30' })]), { code: 'SPECIAL_DATE_INVALID' });
  await assert.rejects(stock(d, [readiness(line, { salesVisibleNote: 'x'.repeat(8001) })]), { code: 'SPECIAL_FIELD_TOO_LONG' });
  assert.deepEqual(await scmCase(d), before);
  d = await stock(d, [readiness(line, { supplyStatus: 'no_stock', vendorYard: '' })]);
  assert.equal(d.lines[0].vendorYard, '', 'No stock does not need a pickup location.');
  await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1", [d.id]);
  await assert.rejects(stock(d, [readiness(d.lines[0], { salesVisibleNote: 'Late reply' })]), { code: 'SPECIAL_CASE_CLOSED' });
  await assert.rejects(stock(d, [readiness(d.lines[0], corrected)]), { code: 'SPECIAL_CASE_CLOSED' });
}));

test('the pre-order stock check dates the Sales reply only when its text changes', () => fixture(async d => {
  const response = (context, salesVisibleNote) => stock(d, [{ lineId: d.lines[0].id, kind: 'response', supplyStatus: 'in_stock', availabilityMode: 'no_projection',
    ...vendor, vendorYard: 'TEST AYR', salesVisibleNote }], context);
  const by = async () => (await query('SELECT sales_visible_note_updated_at,sales_visible_note_updated_by FROM sales_special_stock_lines WHERE id=$1', [d.lines[0].id])).rows[0];
  assert.equal((await by()).sales_visible_note_updated_at, null);
  d = await response(scm, 'First reply');
  assert.equal((await by()).sales_visible_note_updated_by, scm.operatorId);
  d = await response(scmOther, 'First reply');
  assert.equal((await by()).sales_visible_note_updated_by, scm.operatorId);
  d = await response(scmOther, 'Second reply');
  assert.equal((await by()).sales_visible_note_updated_by, scmOther.operatorId);
  d = await response(scmOther, '');
  assert.deepEqual(await by(), { sales_visible_note_updated_at: null, sales_visible_note_updated_by: null });
}));
