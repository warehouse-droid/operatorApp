import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

after(closeDb);
const context = { operatorId: 'special-readiness-status-test', authorizedStoreLocationIds: [1] };
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
  const tx = await beginRollbackContext();
  try { await tx.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST Readiness','hash','salt','scm',ARRAY['scm'],ARRAY[1]) ON CONFLICT DO NOTHING", [context.operatorId]);
    let d = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Readiness', vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
      lines: ['Slab', 'Coping'].map(productName => ({ productName, quantity: 2, uom: 'PCS', rate: 10, requiredDate: '2099-02-01' })) }, context);
    for (const line of d.lines) {
      d = await repo.respondSpecialStockLine(d.id, line.id, { expectedRevision: d.revision, supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST dock' }, context);
      d = await repo.decideSpecialStockLine(d.id, line.id, { expectedRevision: d.revision, decision: 'accepted' }, context);
    }
    await run(d);
  }); } finally { await tx.rollback(); }
}
const check = (d, input) => repo.checkSpecialStockReadiness(d.id, d.lines[0].id, { expectedRevision: d.revision, ...input }, context);

test('accepted readiness saves each stock status and records exact before/after history without changing acceptance', () => fixture(async d => {
  let previous = 'in_stock';
  for (const supplyStatus of ['low_inventory', 'production', 'no_stock', 'vendor_transfer', 'in_stock']) {
    const revision = d.revision;
    d = await check(d, { supplyStatus, eta: supplyStatus === 'production' ? '2099-03-01' : null });
    const line = d.lines[0];
    assert.equal(line.supplyStatus, supplyStatus);
    assert.equal(line.availableDate, supplyStatus === 'production' ? '2099-03-01' : null);
    assert.equal(line.salesDecision, 'accepted');
    assert.equal(d.revision, revision + 1);
    const event = d.events.find(e => e.eventType === 'special_stock_readiness_checked');
    assert.equal(event.details.previousSupplyStatus, previous);
    assert.equal(event.details.supplyStatus, supplyStatus);
    assert.equal(event.details.ready, ['in_stock', 'low_inventory'].includes(supplyStatus));
    assert.equal(event.caseLineId ?? event.lineId, line.id);
    previous = supplyStatus;
  }
}));

test('production rejects invalid ETA and stock statuses without changing data, events, or revision', () => fixture(async d => {
  const before = await repo.getSpecialStockCase(d.id, { audience: 'scm' });
  for (const input of [{ supplyStatus: 'ready' }, { supplyStatus: '' }, { supplyStatus: 'already_ordered' }, {}]) {
    await assert.rejects(check(d, input), { code: 'SPECIAL_READINESS_REQUIRED' });
  }
  for (const eta of [null, '', '2026-02-30', 'not-a-date']) {
    await assert.rejects(check(d, { supplyStatus: 'production', eta }), { code: 'SPECIAL_ETA_REQUIRED' });
  }
  assert.deepEqual(await repo.getSpecialStockCase(d.id, { audience: 'scm' }), before);
}));

test('new transfer readiness uses the linked SO placement date and preserves subsequent ETA revisions', () => fixture(async d => {
  await query("INSERT INTO sales_orders(netsuite_id,tranid,trandate,status_text,netsuite_active) VALUES(8899291,'TEST-READINESS-SO','2026-10-09','Pending Fulfillment',true)");
  d = await repo.linkSpecialSalesOrder(d.id, { expectedRevision: d.revision, salesOrderRef: 'TEST-READINESS-SO' }, context);
  d = await check(d, { supplyStatus: 'vendor_transfer' });
  assert.equal(d.lines[0].availableDate, '2026-10-19');
  assert.equal(d.lines[0].availabilityMode, 'so_placement');
  d = await check(d, { supplyStatus: 'vendor_transfer', eta: '2099-03-05' });
  assert.equal(d.lines[0].availableDate, '2099-03-05');
  assert.equal(d.lines[0].availabilityMode, 'dated');
  d = await check(d, { supplyStatus: 'vendor_transfer' });
  assert.equal(d.lines[0].availableDate, '2099-03-05');
  assert.equal(d.lines[0].availabilityMode, 'dated');
}));

test('unavailable stock changes after PO require acknowledgement, including status-only changes', () => fixture(async d => {
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(8899292,'TEST-READINESS-PO','Pending Receipt',true)");
  await query("UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=8899292,purchase_order_ref='TEST-READINESS-PO' WHERE request_id=$1", [d.id]);
  d = await check(d, { supplyStatus: 'vendor_transfer' });
  assert.equal(d.postPoChangePending, true);
  await query('UPDATE sales_special_stock_cases SET post_po_change_pending=false WHERE request_id=$1', [d.id]);
  d = await check(d, { supplyStatus: 'no_stock' });
  assert.equal(d.postPoChangePending, true);
  assert.equal(d.postPoChangeDetails.previousSupplyStatus, 'vendor_transfer');
  assert.equal(d.postPoChangeDetails.supplyStatus, 'no_stock');
}));

test('batch readiness is atomic and rejects stale saves', () => fixture(async d => {
  const before = await repo.getSpecialStockCase(d.id, { audience: 'scm' });
  const save = lines => repo.saveSpecialStockChecks(d.id, { expectedRevision: d.revision, lines }, context);
  await assert.rejects(save([
    { lineId: d.lines[0].id, kind: 'readiness', supplyStatus: 'low_inventory' },
    { lineId: d.lines[1].id, kind: 'readiness', supplyStatus: 'production', eta: 'invalid' }
  ]), { code: 'SPECIAL_ETA_REQUIRED' });
  assert.deepEqual(await repo.getSpecialStockCase(d.id, { audience: 'scm' }), before);
  const saved = await save(d.lines.map(line => ({ lineId: line.id, kind: 'readiness', supplyStatus: 'low_inventory' })));
  assert.deepEqual(saved.lines.map(line => line.supplyStatus), ['low_inventory', 'low_inventory']);
  assert.equal(saved.revision, d.revision + 1);
  await assert.rejects(check(d, { supplyStatus: 'no_stock' }), { status: 409 });
}));

test('legacy ready callers preserve Low inventory and dated transfer behavior', () => fixture(async d => {
  await query("UPDATE sales_special_stock_lines SET supply_status='low_inventory' WHERE id=$1", [d.lines[0].id]);
  d = await check(d, { ready: true });
  assert.equal(d.lines[0].supplyStatus, 'low_inventory');
  d = await check(d, { ready: false, eta: '2099-03-01' });
  assert.equal(d.lines[0].supplyStatus, 'production');
  await query("UPDATE sales_special_stock_lines SET supply_status='vendor_transfer' WHERE id=$1", [d.lines[0].id]);
  d = await check(d, { ready: false, eta: '2099-03-05' });
  assert.equal(d.lines[0].supplyStatus, 'vendor_transfer');
  assert.equal(d.lines[0].availableDate, '2099-03-05');
}));

test('readiness retains pending-information, acceptance and closed-case guards', () => fixture(async d => {
  await query("UPDATE sales_special_stock_cases SET information_request='{\"status\":\"pending\",\"question\":\"Size?\"}'::jsonb WHERE request_id=$1", [d.id]);
  await assert.rejects(check(d, { supplyStatus: 'in_stock' }), { code: 'SPECIAL_UPDATE_PENDING' });
  await query("UPDATE sales_special_stock_cases SET information_request='{}'::jsonb WHERE request_id=$1", [d.id]);
  await query("UPDATE sales_special_stock_lines SET sales_decision='pending' WHERE id=$1", [d.lines[0].id]);
  await assert.rejects(check(d, { supplyStatus: 'in_stock' }), { code: 'SPECIAL_READINESS_LINE_INVALID' });
  await query("UPDATE sales_special_stock_lines SET sales_decision='accepted' WHERE id=$1", [d.lines[0].id]);
  await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1", [d.id]);
  await assert.rejects(check(d, { supplyStatus: 'in_stock' }), { code: 'SPECIAL_CASE_CLOSED' });
}));
