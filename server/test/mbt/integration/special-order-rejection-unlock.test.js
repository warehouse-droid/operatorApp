import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { canAddSpecialItems } from '../../../public/special-stock-request-actions.js';

after(closeDb);
const context = { operatorId: 'special-rejection-test', authorizedStoreLocationIds: [1] };
async function fixture(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('special-rejection-test','special-rejection-test','TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING");
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
      await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899412,'TEST','TEST Rejection','TEST Rejection','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
      let detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899412,
        customerName: 'TEST Rejection', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
        lines: [{ productName: 'TEST product', quantity: 2, uom: 'PCS', rate: 120, requiredDate: '2099-02-01' }] }, context);
      detail = await repo.respondSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision,
        supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST yard' }, context);
      detail = await repo.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
      const draft = { customerId: 8899412, operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 0,
        materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, description: 'TEST product', quantity: 2, packageQuantity: 2, conversionToPc: 1, uom: 'PC', rate: 120 }] };
      detail = await repo.saveSpecialSalesOrderDraft(detail.id, { ...draft, expectedRevision: detail.revision }, context);
      await run(detail, draft);
    });
  } finally { await rollback.rollback(); }
}

for (const kind of ['sales_order', 'purchase_order']) {
  const prefix = kind === 'sales_order' ? 'salesOrder' : 'purchaseOrder';
  for (const submitted of [false, true]) {
    test(`${kind} ${submitted ? 'confirmed rejection' : 'pre-submission failure'} releases its own lock and submission guard`, () => fixture(async (detail, draft) => {
      const operationId = randomUUID();
      await query(`UPDATE sales_special_stock_cases SET ${kind}_operation_status='creating',${kind}_operation_id=$2,
        ${kind}_submission_started_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE request_id=$1`, [detail.id, operationId, submitted]);
      const released = await repo.failSpecialOrderOperation(detail.id, { orderKind: kind, operationId, retryable: true,
        errorCode: submitted ? 'SPECIAL_REMOTE_REJECTED' : undefined, errorMessage: 'TEST rejected' }, context);
      assert.equal(released[`${prefix}OperationStatus`], 'idle');
      assert.equal(released[`${prefix}OperationId`], null);
      assert.equal(released[`${prefix}SubmissionStartedAt`], null);
      assert.equal(released[`${prefix}OperationError`], '');
      assert.equal(released.attention, false);
      assert.ok(released.events.some(event => event.details.error === 'TEST rejected' && event.details.operationId === operationId));
      assert.equal(canAddSpecialItems(released), true);
      const edited = await repo.saveSpecialSalesOrderDraft(detail.id, { ...draft, expectedRevision: released.revision }, context);
      assert.equal(edited.salesOrderLines[0].quantity, 2);
      const retry = await repo.claimSpecialOrderOperation(detail.id, { orderKind: 'sales_order', operationId: randomUUID(), expectedRevision: edited.revision }, context);
      assert.equal(retry.salesOrderOperationStatus, 'creating');
    }));
  }

  test(`${kind} uncertain submission stays protected and cannot be edited`, () => fixture(async detail => {
    const operationId = randomUUID();
    await query(`UPDATE sales_special_stock_cases SET ${kind}_operation_status='creating',${kind}_operation_id=$2,
      ${kind}_submission_started_at=now() WHERE request_id=$1`, [detail.id, operationId]);
    const failed = await repo.failSpecialOrderOperation(detail.id, { orderKind: kind, operationId,
      retryable: true, errorCode: 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN', errorMessage: 'Connection lost' }, context);
    assert.equal(failed[`${prefix}OperationStatus`], 'attention');
    assert.ok(failed[`${prefix}SubmissionStartedAt`]);
    assert.equal(canAddSpecialItems(failed), false);
  }));

  test(`${kind} stale rejection cannot release another operation`, () => fixture(async detail => {
    const operationId = randomUUID();
    await query(`UPDATE sales_special_stock_cases SET ${kind}_operation_status='creating',${kind}_operation_id=$2,
      ${kind}_submission_started_at=now() WHERE request_id=$1`, [detail.id, operationId]);
    const unchanged = await repo.failSpecialOrderOperation(detail.id, { orderKind: kind, operationId: randomUUID(),
      retryable: true, errorCode: 'SPECIAL_REMOTE_REJECTED', errorMessage: 'Stale rejection' }, context);
    assert.equal(unchanged[`${prefix}OperationStatus`], 'creating');
    assert.equal(unchanged[`${prefix}OperationId`], operationId);
    assert.ok(unchanged[`${prefix}SubmissionStartedAt`]);
  }));

  test(`${kind} late failure cannot unlock an already linked order`, () => fixture(async detail => {
    const operationId = randomUUID();
    await query(`UPDATE sales_special_stock_cases SET ${kind}_operation_status='linked',${kind}_operation_id=$2,
      ${kind}_submission_started_at=now(),${kind}_netsuite_id=8899994,${kind}_ref='TEST-LINKED' WHERE request_id=$1`, [detail.id, operationId]);
    const linked = await repo.failSpecialOrderOperation(detail.id, { orderKind: kind, operationId,
      retryable: true, errorCode: 'SPECIAL_REMOTE_REJECTED', errorMessage: 'Late rejection' }, context);
    assert.equal(linked[`${prefix}OperationStatus`], 'linked');
    assert.equal(linked[`${prefix}Id`], 8899994);
    assert.ok(linked[`${prefix}SubmissionStartedAt`]);
    assert.equal(linked.attention, false);
  }));
}

test('releasing a failed SO preserves unrelated attention', () => fixture(async detail => {
  const operationId = randomUUID();
  await query("UPDATE sales_special_stock_cases SET sales_order_operation_status='creating',sales_order_operation_id=$2,attention=true,attention_reason='Vendor requires review' WHERE request_id=$1", [detail.id, operationId]);
  const released = await repo.failSpecialOrderOperation(detail.id, { orderKind: 'sales_order', operationId,
    retryable: true, errorCode: 'SPECIAL_REMOTE_REJECTED', errorMessage: 'Rejected' }, context);
  assert.equal(released.salesOrderOperationStatus, 'idle');
  assert.equal(released.attention, true);
  assert.equal(released.attentionReason, 'Vendor requires review');
}));

test('delivery-date validation still releases the draft before any remote submission', () => fixture(async (detail, draft) => {
  await query("UPDATE sales_special_stock_cases SET fulfillment_method='mbt_delivery',delivery_address='TEST address',delivery_date='2000-01-01' WHERE request_id=$1", [detail.id]);
  const operationId = randomUUID();
  const claimed = await repo.claimSpecialOrderOperation(detail.id, { orderKind: 'sales_order', operationId,
    expectedRevision: detail.revision }, context);
  await assert.rejects(repo.markSpecialOrderSubmitted(detail.id, { orderKind: 'sales_order', operationId,
    expectedRevision: claimed.revision }, context), { code: 'SPECIAL_DELIVERY_DATE_TOO_SOON' });
  const released = await repo.failSpecialOrderOperation(detail.id, { orderKind: 'sales_order', operationId,
    retryable: true, errorCode: 'SPECIAL_DELIVERY_DATE_TOO_SOON', errorMessage: 'Choose a later delivery date' }, context);
  assert.equal(released.salesOrderOperationStatus, 'idle');
  assert.equal(released.salesOrderSubmissionStartedAt, null);
  assert.ok(released.events.some(event => event.eventType === 'special_sales_order_date_rejected'));
  const edited = await repo.saveSpecialSalesOrderDraft(detail.id, { ...draft, expectedRevision: released.revision }, context);
  assert.equal(edited.fulfillmentMethod, 'yard_pickup');
}));
