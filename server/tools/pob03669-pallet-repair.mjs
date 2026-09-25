// Run through pob03669-pallet-repair.py; imported application code is deployed code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from '/app/src/db.js';
import { writeAudit } from '/app/src/auth-repository.js';
import {
  reassignScmPoSplitLineSource, reconcileScmOrderFamily,
  storeLinkedScmReconciliationTransactions
} from '/app/src/scm-reconciliation-repository.js';
import {
  fetchPoToReconciliationOrdersFromNetSuite, fetchPoToLinkedTransactionsFromNetSuite,
  fetchItemReceiptFromNetSuite
} from '/app/src/netsuite.js';

const mode = process.argv[2];
const fault = process.argv[3] || '';
const sourceId = 939701;
const actor = 'system:user-authorized-pob03669-repair';
const note = 'User-authorized repair: align PALLET split identities and original quantities with verified NetSuite receipts.';
const plan = [
  { id: 450, ref: 'SN1399039', receipt: 969277, receiptRef: 'IR14242', qty: 22, before: 22, source: 368856, key: '4851536', line: 34 },
  { id: 454, ref: 'SN1399065', receipt: 969017, receiptRef: 'IR14239', qty: 40, before: 18, source: 127428, key: '4737073', line: 8 },
  { id: 463, ref: 'SN1399105', receipt: 969704, receiptRef: 'IR14245', qty: 23, before: 0, source: 368856, key: '4851536', line: 34 },
  { id: 475, ref: 'SN1399337', receipt: 972610, receiptRef: 'IR14288', qty: 28, before: 0, source: 368856, key: '4851536', line: 34 }
];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const omit = (row, fields) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
const rows = async (sql, params = []) => (await query(sql, params)).rows;

async function snapshot() {
  const headers = await rows('SELECT * FROM dispatch_scm_po_splits WHERE source_po_id=$1 ORDER BY id', [sourceId]);
  const ids = [sourceId, ...headers.map(row => Number(row.split_po_id))];
  const refs = ['pob03669', ...headers.map(row => row.split_po_ref.toLowerCase())];
  const state = {
    headers,
    orders: await rows('SELECT * FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id', [ids]),
    lines: await rows('SELECT * FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[]) ORDER BY id', [ids]),
    ledgers: await rows('SELECT l.* FROM dispatch_scm_po_split_lines l JOIN dispatch_scm_po_splits h ON h.id=l.split_id WHERE h.source_po_id=$1 ORDER BY l.id', [sourceId]),
    schedules: await rows("SELECT * FROM scm_transport_schedule WHERE order_kind='PO' AND (lower(order_ref)=ANY($1::text[]) OR reconciliation_order_state_id=6458) ORDER BY id", [refs]),
    assignments: await rows('SELECT * FROM dispatch_plan_order_assignments WHERE lower(order_ref)=ANY($1::text[]) OR lower(planned_order_ref)=ANY($1::text[]) ORDER BY plan_id,order_ref,planned_order_ref', [refs]),
    completions: await rows("SELECT * FROM dispatch_order_completion_status WHERE order_kind='PO' AND lower(order_ref)=ANY($1::text[]) ORDER BY order_ref", [refs]),
    states: await rows("SELECT * FROM scm_reconciliation_order_state WHERE order_kind='PO' AND source_order_netsuite_id=$1 ORDER BY id", [sourceId]),
    lineStates: await rows('SELECT * FROM scm_reconciliation_order_line_state WHERE order_state_id=6458 ORDER BY id'),
    reviews: await rows('SELECT * FROM scm_reconciliation_review_cases WHERE order_state_id=6458 ORDER BY id'),
    resolutions: await rows('SELECT r.* FROM scm_reconciliation_review_resolutions r JOIN scm_reconciliation_review_cases c ON c.id=r.review_case_id WHERE c.order_state_id=6458 ORDER BY r.id'),
    allocations: await rows('SELECT a.* FROM scm_reconciliation_allocations a JOIN scm_reconciliation_order_line_state l ON l.id=a.order_line_state_id WHERE l.order_state_id=6458 ORDER BY a.id'),
    transactions: await rows("SELECT * FROM scm_reconciliation_transaction_snapshots WHERE source_order_kind='PO' AND source_order_netsuite_id=$1 ORDER BY id", [sourceId]),
    transactionLines: await rows("SELECT l.* FROM scm_reconciliation_transaction_snapshot_lines l JOIN scm_reconciliation_transaction_snapshots t ON t.id=l.transaction_snapshot_id WHERE t.source_order_kind='PO' AND t.source_order_netsuite_id=$1 ORDER BY l.id", [sourceId]),
    postings: await rows('SELECT c.id,c.status,c.created_at,c.completed_at FROM operator_netsuite_posting_commands c WHERE EXISTS (SELECT 1 FROM operator_netsuite_posting_steps s WHERE s.command_id=c.id AND s.source_netsuite_id=$1) ORDER BY c.id', [sourceId]),
    audit: await rows("SELECT id,event_key FROM scm_reconciliation_audit_events WHERE parent_order_kind='PO' AND parent_order_netsuite_id=$1 ORDER BY id", [sourceId]),
    repairAudit: await rows("SELECT id,action,details FROM delivery_audit_log WHERE order_id=$1 AND action='purchase_order.pob03669.pallet_repaired' ORDER BY id", [sourceId])
  };
  return JSON.parse(JSON.stringify(state));
}

function validateInitial(state) {
  assert.equal(state.orders.find(row => Number(row.netsuite_id) === sourceId)?.tranid, 'POB03669');
  assert.equal(state.reviews.filter(row => row.status === 'open' && row.severity === 'blocking').length, 1);
  assert.equal(Number(state.reviews.find(row => row.status === 'open')?.id), 375);
  assert.ok(state.postings.every(row => ['completed', 'failed'].includes(row.status)), 'ACTIVE_POSTING');
  for (const item of plan) {
    const ledger = state.ledgers.find(row => Number(row.id) === item.id);
    const header = state.headers.find(row => row.id === ledger?.split_id);
    const child = state.lines.find(row => row.id === ledger?.split_line_id);
    assert.equal(header?.split_po_ref, item.ref);
    assert.equal(header?.status, 'active');
    assert.equal(Number(ledger?.item_id), 1784);
    assert.equal(ledger?.unit, 'EACH');
    assert.equal(Number(ledger?.source_line_id), 127428);
    assert.equal(Number(ledger?.requested_sales_qty), item.qty);
    assert.equal(Number(ledger?.sales_qty), item.before);
    assert.equal(Number(child?.quantity), item.before);
    assert.equal(Number(child?.netsuite_order_line), 8);
    assert.equal(child?.line_id, '4737073');
    assert.equal(child?.confirmed_at, null);
    for (const field of ['pallet_qty', 'layer_qty', 'section_qty', 'piece_qty']) {
      assert.equal(Number(ledger[field]), 0);
      assert.equal(Number(ledger[`requested_${field}`]), 0);
    }
  }
}

async function capture() {
  const startedAt = new Date().toISOString();
  const before = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return snapshot();
  });
  validateInitial(before);
  const fetched = await Promise.allSettled([
    fetchPoToReconciliationOrdersFromNetSuite({ kind: 'PO', orderIds: [sourceId], targetOnly: true, includeOpen: false }),
    fetchPoToLinkedTransactionsFromNetSuite([sourceId])
  ]);
  for (const result of fetched) if (result.status === 'rejected') throw result.reason;
  const [orders, transactions] = fetched.map(result => result.value);
  assert.equal(orders.length, 1);
  const order = orders[0];
  assert.equal(order.id, sourceId);
  assert.equal(order.tranid, 'POB03669');
  for (const [line, key, quantity] of [[8, '4737073', 249], [34, '4851536', 341]]) {
    const found = order.lines.filter(row => Number(row.orderLine) === line);
    assert.equal(found.length, 1);
    assert.equal(String(found[0].sourceLineKey), key);
    assert.equal(Number(found[0].itemId), 1784);
    assert.equal(Number(found[0].quantity), quantity);
  }
  assert.ok(transactions.length > 0 && transactions.every(row => Number(row.sourceOrderId) === sourceId));
  assert.ok(transactions.some(row => Number(row.transactionId) === 994070 && row.transactionRef === 'IR14645'));
  for (const old of before.transactions.filter(row => !row.is_deleted)) {
    assert.ok(transactions.some(row => Number(row.transactionId) === Number(old.netsuite_transaction_id)), `Missing receipt ${old.transaction_ref}`);
  }
  const receipts = [];
  for (let offset = 0; offset < plan.length; offset += 2) {
    const result = await Promise.allSettled(plan.slice(offset, offset + 2).map(async item => {
      const record = await fetchItemReceiptFromNetSuite(item.receipt);
      assert.equal(Number(record.createdFrom?.id), sourceId);
      assert.equal(record.tranId, item.receiptRef);
      assert.equal(record.memo, item.ref);
      const pallets = record.item.items.filter(row => Number(row.item?.id) === 1784 && row.itemReceive !== false);
      assert.equal(pallets.length, 1);
      assert.equal(Number(pallets[0].orderLine), item.line);
      assert.equal(Number(pallets[0].quantity), item.qty);
      const linked = transactions.filter(row => Number(row.transactionId) === item.receipt && Number(row.itemId) === 1784);
      assert.equal(linked.length, 1);
      assert.equal(Number(linked[0].sourceOrderLine), item.line);
      assert.equal(Number(linked[0].quantity), item.qty);
      return { id: item.receipt, ref: item.receiptRef, memo: record.memo, line: item.line, quantity: item.qty };
    }));
    for (const row of result) { if (row.status === 'rejected') throw row.reason; receipts.push(row.value); }
  }
  assert.equal(digest(await snapshot()), digest(before), 'LOCAL_STATE_CHANGED_DURING_READ');
  return { startedAt, capturedAt: new Date().toISOString(), before, order, transactions, receipts, beforeHash: digest(before) };
}

async function lockFamily(state) {
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='45s'");
  await query('LOCK TABLE operator_netsuite_posting_order_claims IN SHARE ROW EXCLUSIVE MODE');
  await query('SELECT netsuite_id FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id FOR UPDATE', [state.orders.map(row => row.netsuite_id)]);
  await query('SELECT id FROM purchase_order_lines WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [state.lines.map(row => row.id)]);
  await query('SELECT id FROM dispatch_scm_po_splits WHERE source_po_id=$1 ORDER BY id FOR UPDATE', [sourceId]);
  await query('SELECT id FROM dispatch_scm_po_split_lines WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [state.ledgers.map(row => row.id)]);
  await query('SELECT id FROM scm_transport_schedule WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [state.schedules.map(row => row.id)]);
  await query('SELECT id FROM scm_reconciliation_order_state WHERE id=6458 FOR UPDATE');
}

async function repairRows(state) {
  for (const item of plan.filter(row => row.line === 34)) {
    const result = await reassignScmPoSplitLineSource({ ledgerLineId: item.id, expectedSourceLineId: 127428,
      newSourceLineId: item.source, note, actor });
    assert.equal(result.after.candidateBaselineQty, 0);
  }
  for (const item of plan) {
    const ledger = state.ledgers.find(row => Number(row.id) === item.id);
    await query('UPDATE dispatch_scm_po_split_lines SET sales_qty=$2 WHERE id=$1', [item.id, item.qty]);
    await query(`UPDATE purchase_order_lines SET quantity=$2,netsuite_active=true,netsuite_order_line=$3,
      netsuite_order_line_synced_at=now(),synced_at=now() WHERE id=$1`, [ledger.split_line_id, item.qty, item.line]);
  }
  // The generic adjustment action temporarily blocks all schedules. Retain the
  // pre-existing operational status before the ordinary reconciliation runs.
  for (const row of state.schedules) {
    await query('UPDATE scm_transport_schedule SET status=$2,updated_by=$3,updated_at=$4 WHERE id=$1',
      [row.id, row.status, row.updated_by, row.updated_at]);
  }
}

function validateRows(state) {
  for (const item of plan) {
    const ledger = state.ledgers.find(row => Number(row.id) === item.id);
    const child = state.lines.find(row => row.id === ledger?.split_line_id);
    assert.equal(Number(ledger?.source_line_id), item.source, 'REPAIR_SOURCE');
    assert.equal(Number(ledger?.sales_qty), item.qty, 'REPAIR_QUANTITY');
    assert.equal(Number(ledger?.requested_sales_qty), item.qty, 'REQUESTED_QUANTITY');
    assert.equal(Number(child?.quantity), item.qty, 'CHILD_QUANTITY');
    assert.equal(child?.line_id, item.key, 'CHILD_SOURCE_KEY');
    assert.equal(Number(child?.netsuite_order_line), item.line, 'REPAIR_ORDERLINE');
    assert.equal(Number(child?.raw?.sourceLineId), item.source, 'RAW_SOURCE');
    assert.equal(child?.netsuite_active, true);
  }
  for (const [id, quantity, allocated] of [[127428, 249, 249], [368856, 341, 241]]) {
    const source = state.lines.find(row => Number(row.id) === id);
    assert.equal(Number(source?.quantity), quantity);
    assert.equal(Number(source?.netsuite_received_baseline_qty), 0);
    const active = new Set(state.headers.filter(row => row.status === 'active').map(row => row.id));
    const total = state.ledgers.filter(row => Number(row.source_line_id) === id && active.has(row.split_id))
      .reduce((sum, row) => sum + Number(row.sales_qty), 0);
    assert.equal(total, allocated);
    assert.ok(total <= quantity);
  }
}

function validatePreservation(before, after) {
  for (const key of ['headers', 'orders', 'assignments', 'completions', 'postings']) assert.deepEqual(after[key], before[key], key);
  const ids = new Set(plan.map(row => row.id));
  const children = new Set(before.ledgers.filter(row => ids.has(Number(row.id))).map(row => row.split_line_id));
  assert.deepEqual(after.ledgers.filter(row => !ids.has(Number(row.id))), before.ledgers.filter(row => !ids.has(Number(row.id))));
  assert.deepEqual(after.lines.filter(row => !children.has(row.id)), before.lines.filter(row => !children.has(row.id)));
  const allowed = ['line_id', 'quantity', 'netsuite_active', 'netsuite_order_line', 'netsuite_order_line_synced_at', 'synced_at', 'raw'];
  for (const childId of children) assert.deepEqual(omit(after.lines.find(row => row.id === childId), allowed), omit(before.lines.find(row => row.id === childId), allowed));
  for (const old of before.schedules) {
    const current = after.schedules.find(row => row.id === old.id);
    assert.ok(current);
    assert.deepEqual(omit(current, ['status', 'reconciliation_blocked', 'reconciliation_order_state_id', 'last_reconciled_at', 'updated_at', 'updated_by']),
      omit(old, ['status', 'reconciliation_blocked', 'reconciliation_order_state_id', 'last_reconciled_at', 'updated_at', 'updated_by']));
    if (['Hold', 'Completed'].includes(old.status)) assert.equal(current.status, old.status);
  }
  for (const old of before.transactions.filter(row => !row.is_deleted)) assert.equal(after.transactions.find(row => row.id === old.id)?.is_deleted, false);
}

function validateReconciliation(state, result) {
  assert.equal(result.reconciliationStatus, 'ok', result.reason);
  assert.equal(result.reason || '', '');
  assert.equal(state.reviews.filter(row => row.status === 'open' && row.severity === 'blocking').length, 0);
  assert.equal(state.reviews.find(row => Number(row.id) === 375)?.resolution_action, 'auto_resolve');
  assert.ok(state.schedules.every(row => !row.reconciliation_blocked));
  assert.ok(state.transactions.some(row => Number(row.netsuite_transaction_id) === 994070 && !row.is_deleted));
  for (const item of plan) {
    const quantity = state.allocations.filter(row => row.active && row.progress_kind === 'received' && Number(row.po_split_line_id) === item.id)
      .reduce((sum, row) => sum + Number(row.quantity), 0);
    assert.equal(quantity, item.qty, `${item.ref} receipt allocation`);
  }
}

async function perform(evidence, rollback) {
  assert.ok(Date.now() - Date.parse(evidence.capturedAt) < 15 * 60 * 1000, 'REFRESH_EVIDENCE');
  return withTransaction(async () => {
    await lockFamily(evidence.before);
    const before = await snapshot();
    assert.equal(digest(before), evidence.beforeHash, 'LOCAL_STATE_CHANGED');
    validateInitial(before);
    const stored = await storeLinkedScmReconciliationTransactions({ order: evidence.order, transactions: evidence.transactions,
      source: 'manual', authoritativeObservedBefore: evidence.startedAt });
    assert.equal(stored.deleted, 0);
    await repairRows(before);
    if (fault === 'source') await query('UPDATE dispatch_scm_po_split_lines SET source_line_id=127428 WHERE id=450');
    if (fault === 'quantity') await query('UPDATE dispatch_scm_po_split_lines SET sales_qty=39 WHERE id=454');
    if (fault === 'orderline') await query('UPDATE purchase_order_lines SET netsuite_order_line=8 WHERE id=-98065629124451');
    validateRows(await snapshot());
    const first = await reconcileScmOrderFamily({ kind: 'PO', sourceOrderId: sourceId, source: 'manual', authoritativeOrder: evidence.order });
    const firstState = await snapshot();
    validatePreservation(before, firstState);
    validateReconciliation(firstState, first);
    const second = await reconcileScmOrderFamily({ kind: 'PO', sourceOrderId: sourceId, source: 'manual', authoritativeOrder: evidence.order });
    assert.deepEqual(second.quantities, first.quantities);
    assert.deepEqual(second.targets, first.targets, 'RECONCILIATION_NOT_STABLE');
    const after = await snapshot();
    validateRows(after);
    validatePreservation(before, after);
    validateReconciliation(after, second);
    await writeAudit({ actorType: 'system', source: 'scm', action: 'purchase_order.pob03669.pallet_repaired', orderId: sourceId,
      details: { actor, note, evidenceAt: evidence.capturedAt, receiptEvidence: evidence.receipts, plan,
        beforeHash: evidence.beforeHash, afterHash: digest(after), reviewCaseId: 375, reconciliation: second.quantities } });
    return { rollback, stored, result: second, after: await snapshot() };
  }, { rollback });
}

function publicSummary(state) {
  const source = state.states[0];
  return { orderRef: 'POB03669', applicationStatus: source.application_status, reconciliationStatus: source.reconciliation_status,
    reason: source.reconciliation_reason, received: source.received_qty, remaining: source.remaining_qty,
    openBlockingReviews: state.reviews.filter(row => row.status === 'open' && row.severity === 'blocking').length,
    blockedSchedules: state.schedules.filter(row => row.reconciliation_blocked).length,
    repairedLines: plan.map(item => { const l = state.ledgers.find(row => Number(row.id) === item.id);
      const c = state.lines.find(row => row.id === l.split_line_id);
      return { split: item.ref, quantity: Number(l.sales_qty), sourceKey: c.line_id, orderLine: Number(c.netsuite_order_line) }; }) };
}

try {
  assert.ok(['capture', 'rehearse', 'apply', 'verify'].includes(mode));
  assert.ok(!fault || (mode === 'rehearse' && ['source', 'quantity', 'orderline'].includes(fault)));
  let output;
  if (mode === 'capture') output = { evidence: await capture() };
  else if (mode === 'verify') {
    const current = await snapshot();
    validateRows(current);
    validatePreservation(evidenceInput.before, current);
    validateReconciliation(current, { reconciliationStatus: current.states[0].reconciliation_status, reason: current.states[0].reconciliation_reason });
    output = { summary: publicSummary(current), after: current };
  } else {
    const current = await snapshot();
    if (mode === 'apply' && current.repairAudit.length > evidenceInput.before.repairAudit.length) {
      validateRows(current);
      validatePreservation(evidenceInput.before, current);
      validateReconciliation(current, { reconciliationStatus: current.states[0].reconciliation_status, reason: current.states[0].reconciliation_reason });
      output = { alreadyApplied: true, summary: publicSummary(current) };
    } else {
      let result;
      let failure;
      try { result = await perform(evidenceInput, mode !== 'apply'); } catch (error) { failure = error; }
      if (mode === 'rehearse' || failure) assert.equal(digest(await snapshot()), evidenceInput.beforeHash, 'ROLLBACK_STATE_CHANGED');
      if (fault) {
        assert.ok(failure, 'MUTANT_SURVIVED');
        assert.equal(failure.code, 'ERR_ASSERTION');
        assert.equal(failure.message.split('\n')[0], { source: 'REPAIR_SOURCE', quantity: 'REPAIR_QUANTITY', orderline: 'REPAIR_ORDERLINE' }[fault]);
        output = { fault, rejected: true, rollbackVerified: true };
      } else {
        if (failure) throw failure;
        output = { ...result, summary: publicSummary(result.after), rollbackVerified: mode === 'rehearse' };
      }
    }
  }
  console.log('POB03669_REPAIR_RESULT ' + JSON.stringify(output));
} finally { await closeDb(); }
