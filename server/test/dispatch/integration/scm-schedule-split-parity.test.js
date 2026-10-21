import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {beginRollbackContext, closeDb, query} from '../../../src/db.js';
import {listScmSchedule} from '../../../src/dispatch-repository.js';
import {
  getScmPurchaseOrderCatalogOrder,
  listScmPurchaseOrderCatalog,
  replaceScmPurchaseOrderCatalog,
  upsertScmPurchaseOrderCatalog
} from '../../../src/scm-purchase-order-catalog-repository.js';

after(closeDb);

async function inRollback(operation) {
  const context = await beginRollbackContext();
  try {
    return await context.run(operation);
  } finally {
    await context.rollback();
  }
}

async function fixture() {
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
  const id = Number(`96${nonce.slice(-10)}`);
  const source = `PO-PARITY-${nonce}`;
  const ref = `SN-PARITY-${nonce}`;
  await query(`INSERT INTO purchase_orders (
    netsuite_id, tranid, dispatch_ref, vendor, status, status_text,
    destination_location_id, destination_location, initial_scm_status, netsuite_active, synced_at
  ) VALUES ($1, $2, $3, 'Parity vendor', 'B', 'Purchase Order : Pending Receipt',
    1, '3445', 'Hold', true, now())`, [id, source, ref]);
  await replaceScmPurchaseOrderCatalog({orders: [{
    id: ref, type: 'PO', originalPoRef: source, dispatchRef: ref, customer: 'Parity vendor',
    items: [], scm: {status: 'Hold', method: 'MBT', notes: 'Existing supplier note'}
  }], source: 'schedule-split-parity-test'});
  const reconciliation = await query(`INSERT INTO scm_reconciliation_order_state (
    order_kind, source_order_netsuite_id, source_order_ref, application_status,
    reconciliation_status, reconciliation_source, ordered_qty, remaining_qty, quantity_summary, reconciled_at
  ) VALUES ('PO', $1, $2, 'Queued', 'ok', 'manual', 25, 25, $3::jsonb,
    '2026-09-30T17:05:53.740Z') RETURNING id`, [id, source, JSON.stringify({targets: {
      [source]: {applicationStatus: 'Hold', hasActivePlan: false}
    }})]);
  await query(`INSERT INTO scm_transport_schedule (
    order_kind, order_ref, status, method, notes, reconciliation_order_state_id, updated_by, updated_at
  ) VALUES ('PO', $1, 'Queued', 'MBT', 'Existing supplier note', $2, 'parity-operator',
    '2026-10-01T13:20:18.825092Z')`, [ref, reconciliation.rows[0].id]);
  return {id, source, ref};
}

async function assertParity(ref, expected) {
  const [schedule] = await listScmSchedule({kind: 'PO', exactRef: ref, search: ref});
  const page = await listScmPurchaseOrderCatalog({search: ref});
  const card = page.orders.find(order => order.id === ref);
  const detail = await getScmPurchaseOrderCatalogOrder(ref);
  assert.ok(schedule, 'PO/TO schedule row must exist');
  assert.equal(schedule.calculatedStatus, expected);
  for (const [surface, order] of [['card', card], ['detail', detail]]) {
    assert.equal(order?.scm?.status, schedule.calculatedStatus, `${surface} status for ${ref}`);
    assert.equal(order?.dispatchPlanned, schedule.dispatchPlanned, `${surface} plan for ${ref}`);
    assert.equal(order?.scm?.scheduleId, schedule.scheduleId, `${surface} schedule identity`);
    assert.equal(order?.scm?.updatedAt, schedule.updatedAt, `${surface} schedule revision`);
  }
}

test('SN1401822 shape: a current Queued alias overrides the linked source initial Hold', async () => {
  await inRollback(async () => {
    const {ref} = await fixture();
    await assertParity(ref, 'Queued');
  });
});

test('a source PO card uses its current dispatch reference when the NetSuite PO has an alias', async () => {
  await inRollback(async () => {
    const {ref, source} = await fixture();
    await upsertScmPurchaseOrderCatalog({orders: [{
      id: source, type: 'PO', originalPoRef: source, items: [], scm: {status: 'Hold'}
    }], source: 'schedule-split-parity-source-test'});
    const [schedule] = await listScmSchedule({kind: 'PO', exactRef: source});
    const page = await listScmPurchaseOrderCatalog({search: source});
    const card = page.orders.find(order => order.id === source);
    const detail = await getScmPurchaseOrderCatalogOrder(source);
    assert.equal(schedule.orderRef, ref);
    assert.equal(schedule.calculatedStatus, 'Queued');
    assert.equal(card?.scm?.status, schedule.calculatedStatus);
    assert.equal(detail?.scm?.status, schedule.calculatedStatus);
    assert.equal(detail?.scm?.updatedAt, null, 'an alias revision must not become the source write revision');
  });
});

test('every saved schedule status stays equal across PO/TO schedule and PO split without rebuilding the catalog', async () => {
  await inRollback(async () => {
    const {ref} = await fixture();
    for (const status of ['Queued', 'Planned', 'Hold', 'Urgent', 'Priority', 'Surplus Only',
      'Book Appt', 'In Transit', 'Partially Done', 'Cancelled', 'Completed', 'Reconcile Review']) {
      await query(`UPDATE scm_transport_schedule SET status=$2, updated_at=clock_timestamp()
        WHERE order_kind='PO' AND order_ref=$1`, [ref, status]);
      await assertParity(ref, status);
    }
  });
});

test('PO split follows the same active assignment and cancellation evidence as the schedule', async () => {
  await inRollback(async () => {
    const {ref} = await fixture();
    const plan = await query(`INSERT INTO dispatch_plans (plan_date, status, note, revision)
      VALUES ('2399-12-30', 'draft', 'PO status parity fixture', 1) RETURNING id`);
    await query(`INSERT INTO dispatch_plan_order_assignments (
      plan_id, plan_date, order_ref, planned_order_ref, assignment_kind, load_id, stop_id, assignment
    ) VALUES ($1, '2399-12-30', $2, $2, 'direct', 'PARITY-LOAD', 'PARITY-STOP',
      '{"dispatchOrderKind":"PO","dispatchDriverName":"Parity Driver"}'::jsonb)`, [plan.rows[0].id, ref]);
    await assertParity(ref, 'Planned');
    await query(`UPDATE scm_transport_schedule SET status='Hold' WHERE order_kind='PO' AND order_ref=$1`, [ref]);
    await assertParity(ref, 'Hold');
    await query(`UPDATE dispatch_plans SET status='cancelled' WHERE id=$1`, [plan.rows[0].id]);
    await query(`UPDATE scm_transport_schedule SET status='Queued' WHERE order_kind='PO' AND order_ref=$1`, [ref]);
    await assertParity(ref, 'Queued');
    await query(`UPDATE dispatch_plans SET status='draft' WHERE id=$1`, [plan.rows[0].id]);
    await query(`UPDATE dispatch_plan_order_assignments SET assignment='{"dispatchOrderKind":"SO"}'::jsonb
      WHERE plan_id=$1`, [plan.rows[0].id]);
    await assertParity(ref, 'Queued');
  });
});

test('completion of a linked source cannot overwrite the exact alias remaining Partially Done', async () => {
  await inRollback(async () => {
    const {ref, source} = await fixture();
    await query(`UPDATE scm_transport_schedule SET status='Partially Done' WHERE order_kind='PO' AND order_ref=$1`, [ref]);
    await query(`SELECT dispatch_record_order_completion(
      'PO', $1, now(), 'manual_dispatch', $2, NULL, current_date, NULL,
      'operator', 'parity-operator', 'Parity test source completion', '{}'::jsonb
    )`, [source, `parity-completion:${source}`]);
    await assertParity(ref, 'Partially Done');
  });
});
