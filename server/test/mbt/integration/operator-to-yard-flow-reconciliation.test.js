import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { listDeliveryOrders } from '../../../src/delivery-repository.js';
import { reconcileTransferOrder, enableLegacyTransferReceiving } from '../../../tools/operator-to-yard-flow-reconcile.mjs';
import { seedYardTransfer, yardRollback, yardLoad, yardDeliver } from '../../support/operator-to-yard-flow-fixture.mjs';
after(closeDb);

function evidence(f, status = 'B') {
  return { at: new Date().toISOString(), headers: [{ id: String(f.id), tranid: f.ref, status, status_text: status === 'G' ? 'Received' : 'Pending Fulfillment' }],
    sources: [{ id: f.id, tranid: f.ref, status, destinationLocationId: 28, destinationLocation: '2967', lines: [
      { stage: 'outbound', sourceLineKey: '5073149', itemId: 2299, unit: 'PC', quantity: 5, identityStatus: 'exact', logicalLineIdentity: 'pair', netsuite_order_line: 1 },
      { stage: 'receiving', sourceLineKey: '5073151', itemId: 2299, unit: 'PC', quantity: 5, identityStatus: 'exact', logicalLineIdentity: 'pair', netsuite_order_line: 1 }
    ] }], records: [] };
}
test('production repair uses cumulative real loads, preserves drafts and is idempotent', () => yardRollback(async () => {
  const f = await seedYardTransfer(); await yardLoad(f);
  await query("UPDATE transfer_order_lines SET loaded_qty=99,packed_piece_qty=2 WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id]);
  const before = (await query("SELECT received_piece_qty,confirmed FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id])).rows;
  const first = await reconcileTransferOrder(f.id, evidence(f), { apply: true });
  assert.equal(first.changedLines, 1);
  assert.equal(Number((await query("SELECT loaded_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id])).rows[0].loaded_qty), 5);
  assert.deepEqual((await query("SELECT received_piece_qty,confirmed FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id])).rows, before);
  assert.equal((await reconcileTransferOrder(f.id, evidence(f), { apply: true })).writes, 0);
}));
test('missing destination rows are created with local quantity and without a fabricated receipt', () => yardRollback(async () => {
  const f = await seedYardTransfer(2); await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id]);
  const result = await reconcileTransferOrder(f.id, evidence(f), { apply: true });
  assert.equal(result.addedReceivingLines, 1);
  const row = (await query("SELECT quantity,received_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id])).rows[0];
  assert.equal(Number(row.quantity), 2); assert.equal(Number(row.received_piece_qty), 0);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('verified historical completion closes local work without inventing physical milestones', () => yardRollback(async () => {
  const f = await seedYardTransfer(); const result = await reconcileTransferOrder(f.id, evidence(f, 'G'), { apply: true });
  assert.equal(result.kind, 'historical_completed');
  const row = (await query('SELECT outbound_operator_status,receiving_status,status FROM transfer_orders WHERE netsuite_id=$1', [f.id])).rows[0];
  assert.deepEqual(row, { outbound_operator_status: 'loaded', receiving_status: 'received', status: 'G' });
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('historical completion retains old packing balances without reopening outbound work', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  await query("UPDATE transfer_order_lines SET loaded_qty=1,packed_piece_qty=2 WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id]);
  const before = (await query('SELECT loaded_qty,packed_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY id', [f.id])).rows;
  await reconcileTransferOrder(f.id, evidence(f, 'G'), { apply: true });
  const outbound = await listDeliveryOrders({ orderType: 'transfer_order', locationId: 1 });
  assert.ok(!outbound.some(order => String(order.netsuite_id) === String(f.id)));
  assert.deepEqual((await query('SELECT loaded_qty,packed_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY id', [f.id])).rows, before);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('missing remote identity cannot repair or reopen a transfer', () => yardRollback(async () => {
  const f = await seedYardTransfer(); const e = evidence(f); e.headers = [];
  const before = (await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1', [f.id])).rows;
  const result = await reconcileTransferOrder(f.id, e, { apply: true }); assert.equal(result.kind, 'review'); assert.equal(result.writes, 0);
  assert.deepEqual((await query('SELECT * FROM transfer_orders WHERE netsuite_id=$1', [f.id])).rows, before);
}));
test('dry run and a later failure leave no partial repair or operational audit', () => yardRollback(async () => {
  const f = await seedYardTransfer(); await query("UPDATE transfer_order_lines SET loaded_qty=99 WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id]);
  await reconcileTransferOrder(f.id, evidence(f), { apply: false });
  assert.equal(Number((await query("SELECT loaded_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id])).rows[0].loaded_qty), 99);
  const e = evidence(f); e.sources[0].lines[1].sourceLineKey = 'not-an-integer';
  await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id]);
  await assert.rejects(reconcileTransferOrder(f.id, e, { apply: true }), /bigint|integer/u);
  assert.equal(Number((await query("SELECT loaded_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id])).rows[0].loaded_qty), 99);
  assert.equal((await query("SELECT id FROM delivery_audit_log WHERE order_id=$1 AND action='operator.to.reconcile'", [f.id])).rowCount, 0);
}));
test('an audit failure rolls back a repair after real database writes', () => yardRollback(async () => {
  const f = await seedYardTransfer(); await query("UPDATE transfer_order_lines SET loaded_qty=99 WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id]);
  await query(`CREATE FUNCTION pg_temp.reject_to_reconcile_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reconciliation audit failure'; END $$`);
  await query(`CREATE TRIGGER reject_to_reconcile_audit BEFORE INSERT ON delivery_audit_log FOR EACH ROW
    WHEN (NEW.order_id=${f.id} AND NEW.action='operator.to.reconcile') EXECUTE FUNCTION pg_temp.reject_to_reconcile_audit()`);
  await assert.rejects(reconcileTransferOrder(f.id, evidence(f), { apply: true }), /reconciliation audit failure/u);
  assert.equal(Number((await query("SELECT loaded_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id])).rows[0].loaded_qty), 99);
  assert.equal((await query("SELECT id FROM delivery_audit_log WHERE order_id=$1 AND action='operator.to.reconcile'", [f.id])).rowCount, 0);
}));
test('a legacy load recovers its unique saved scope and verified IF without replaying an external posting', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f);
  await query('DELETE FROM transfer_order_posting_jobs WHERE id=$1', [loaded.id]);
  await query("INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES($1,'2048-01-01','confirmed',1)", [f.plan]);
  await query(`INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,load_id,assignment)
    VALUES($1,'2048-01-01',$2,$3,'{"dispatchTruckPlate":"TEST","dispatchLoadName":"Legacy"}'::jsonb)`, [f.plan, f.ref, f.load]);
  await query(`UPDATE operator_load_records SET response=response||'{"dispatchPlanDate":"2048-01-01","dispatchTruckPlate":"TEST","dispatchLoadName":"Legacy"}'::jsonb WHERE id=$1`, [loaded.operator_record_id]);
  const e = evidence(f, 'F'); e.sources[0].lines[0].raw = { identityStatus: 'exact', physicalRows: [
    { id: String(f.id), item_id: '2299', signed_quantity: -5, source_line_key: '5073149', order_line_number: '1', do_not_print_line: 'F' },
    { id: String(f.id), item_id: '2299', signed_quantity: -5, source_line_key: '5073150', order_line_number: '2', do_not_print_line: 'T' }
  ] };
  e.linked = [{ sourceOrderId: f.id, transactionId: 900, transactionType: 'ItemShip', status: 'C', itemId: 2299, quantity: 5, unit: 'PC', sourceOrderLineAliases: ['2'] }];
  e.records = [{ type: 'ItemShip', sourceId: f.id, id: 900, record: { id: '900', tranId: 'IF900', createdFrom: { id: String(f.id) }, item: { items: [{ orderLine: 2, item: { id: '2299' }, quantity: 5, unitsDisplay: 'PC' }] } } }];
  const result = await reconcileTransferOrder(f.id, e, { apply: true }); assert.equal(result.capturedLoadJobs.length, 1);
  const job = (await query('SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=$1', [f.id])).rows[0];
  assert.equal(job.status, 'completed'); assert.equal(job.snapshot.planId, String(f.plan)); assert.equal(job.snapshot.loadId, f.load);
  assert.equal(job.result.transactions[0].transactionId, 900); assert.equal(job.command_id, null);
  assert.equal((await reconcileTransferOrder(f.id, e, { apply: true })).writes, 0);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('closed TOs preserve their local yard work', () => yardRollback(async () => {
  const f = await seedYardTransfer(); const before = (await query('SELECT loaded_qty,packed_piece_qty,received_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY line_stage', [f.id])).rows;
  const result = await reconcileTransferOrder(f.id, evidence(f, 'H'), { apply: true }); assert.equal(result.kind, 'closed');
  assert.deepEqual((await query('SELECT loaded_qty,packed_piece_qty,received_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY line_stage', [f.id])).rows, before);
}));
test('existing IF recovery retains immutable quantities without requiring Driver evidence', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f); await yardDeliver(f);
  await query("UPDATE transfer_order_posting_jobs SET status='attention',last_error='remaining quantity' WHERE id=$1", [loaded.id]);
  const e = evidence(f, 'G'); e.sources[0].lines[0].raw = { identityStatus: 'exact', physicalRows: [
    { id: String(f.id), item_id: '2299', signed_quantity: -5, source_line_key: '5073149', order_line_number: '1', do_not_print_line: 'F' },
    { id: String(f.id), item_id: '2299', signed_quantity: -5, source_line_key: '5073150', order_line_number: '2', do_not_print_line: 'T' }
  ] };
  e.linked = [{ sourceOrderId: f.id, transactionId: 900, transactionType: 'ItemShip', status: 'C', itemId: 2299, quantity: 5, unit: 'PC', sourceOrderLineAliases: ['2'] }];
  e.records = [{ type: 'ItemShip', sourceId: f.id, id: 900, record: { id: '900', createdFrom: { id: String(f.id) }, item: { items: [{ orderLine: 2, item: { id: '2299' }, quantity: 5, unitsDisplay: 'PC' }] } } }];
  const result = await reconcileTransferOrder(f.id, e, { apply: true }); assert.equal(result.recoveredIfJobs.length, 1);
  const job = (await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1', [loaded.id])).rows[0];
  assert.equal(job.status, 'completed'); assert.equal(job.completion_event_id, null); assert.equal(job.command_id, null); assert.deepEqual(job.snapshot, loaded.snapshot);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('verified current source identity restores only matching inactive lines', () => yardRollback(async () => {
  const f = await seedYardTransfer(); await query("UPDATE transfer_order_lines SET netsuite_active=false,sync_exception='line_deleted' WHERE transfer_order_id=$1", [f.id]);
  const result = await reconcileTransferOrder(f.id, evidence(f), { apply: true }); assert.equal(result.reactivatedLines, 2);
  assert.ok((await query('SELECT netsuite_active,sync_exception FROM transfer_order_lines WHERE transfer_order_id=$1', [f.id])).rows.every(line => line.netsuite_active && line.sync_exception === null));
}));
test('a verified historical reference alias keeps completion without changing local identity and cannot authorize active work', () => yardRollback(async () => {
  const f = await seedYardTransfer(), e = evidence(f, 'G'), remoteId = f.id + 50;
  e.headers[0].id = String(remoteId); e.historicalIdentityAliases = [{ localId: String(f.id), sourceId: String(remoteId), orderRef: f.ref, sourceRecordType: 'TrnfrOrd' }];
  assert.equal((await reconcileTransferOrder(f.id, e, { apply: true })).kind, 'historical_completed');
  assert.equal((await query('SELECT netsuite_id FROM transfer_orders WHERE netsuite_id=$1', [f.id])).rows[0].netsuite_id, String(f.id));
  e.headers[0].status = 'B'; const rejected = await reconcileTransferOrder(f.id, e, { apply: true });
  assert.equal(rejected.kind, 'review'); assert.equal(rejected.writes, 0);
}));

function legacyEvidence(f) {
  const e = evidence(f, 'F'); e.sources[0].lines[0].orderLineAliases = ['1', '2'];
  e.sources[0].lines[0].raw = { identityStatus: 'exact', physicalRows: [
    { id: String(f.id), item_id: '2299', signed_quantity: -5, source_line_key: '5073149', order_line_number: '1', do_not_print_line: 'F' },
    { id: String(f.id), item_id: '2299', signed_quantity: -5, source_line_key: '5073150', order_line_number: '2', do_not_print_line: 'T' }
  ] };
  e.linked = [{ sourceOrderId: f.id, transactionId: 900, transactionType: 'ItemShip', status: 'C', itemId: 2299, quantity: 2, unit: 'PC', sourceOrderLineAliases: ['2'] }];
  e.records = [{ type: 'ItemShip', sourceId: f.id, id: 900, record: { id: '900', createdFrom: { id: String(f.id) }, item: { items: [{ orderLine: 2, item: { id: '2299' }, quantity: 2, unitsDisplay: 'PC' }] } } }];
  return e;
}
test('historical Receiving acceptance records only verified shipment quantities and is idempotent', () => yardRollback(async () => {
  const f = await seedYardTransfer(), e = legacyEvidence(f);
  const accepted = await enableLegacyTransferReceiving(f.id, e); assert.equal(accepted.created, true); assert.equal(accepted.verifiedLoadLines[0].quantity, 2);
  assert.equal((await enableLegacyTransferReceiving(f.id, e)).created, false);
  assert.equal((await query("SELECT id FROM delivery_audit_log WHERE order_id=$1 AND action='operator.to.legacy_receiving_enabled'", [f.id])).rowCount, 1);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('wrong-source legacy fulfillment and completed headers cannot create Receiving acceptance', () => yardRollback(async () => {
  const f = await seedYardTransfer(), e = legacyEvidence(f); e.records[0].record.createdFrom.id = String(f.id + 1);
  await assert.rejects(enableLegacyTransferReceiving(f.id, e), /No uniquely verified/u);
  e.headers[0].status = 'G'; await assert.rejects(enableLegacyTransferReceiving(f.id, e), /active ordinary transfer/u);
  assert.equal((await query("SELECT id FROM delivery_audit_log WHERE order_id=$1 AND action='operator.to.legacy_receiving_enabled'", [f.id])).rowCount, 0);
}));
