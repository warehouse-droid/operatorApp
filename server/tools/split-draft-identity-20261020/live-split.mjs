// Operational execution of the user's specified split, not a production test.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, query, withTransaction, closeDb } from '/app/src/db.js';
import { resplitUnfinishedSalesOrder } from '/app/src/dispatch-sales-resplit-repository.js';
import { getDispatchSplitPreview } from '/app/src/dispatch-split-preview-repository.js';
import { getNextDispatchSplitSuffix } from '/app/src/delivery-repository.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '/app/src/dispatch-fleet-status.js';
import { lockDispatchPlanEditLeaseDate } from '/app/src/dispatch-plan-lease-repository.js';
import { enqueueDispatchOrderCatalogRefresh } from '/app/src/dispatch-order-catalog-repository.js';

const mode = process.argv.at(-1);
assert.ok(['preflight', 'apply', 'verify'].includes(mode));
pool.options.options = '-c jit=off -c statement_timeout=30000'
  + (mode === 'apply' ? '' : ' -c default_transaction_read_only=on');
const sourceRef = 'SOA09140-S4', parentRef = 'SOA09140';
const planId = '364', planDate = '2026-10-20';
const sessionId = 'codex-user-request-split-draft-identity-20261020';
const siblings = ['SOA09140-S1', 'SOA09140-S3'];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function family() {
  return (await query(`SELECT split_ref,active,full_order FROM dispatch_global_order_splits
    WHERE parent_order_ref=$1 ORDER BY split_ref`, [parentRef])).rows;
}
async function retainedEvidence() {
  const groups = ['GOA-9140S1-9143S1', 'GOA-9140S3-9143S3'];
  return {
    siblings: (await query(`SELECT to_jsonb(s) AS value FROM dispatch_global_order_splits s
      WHERE split_ref=ANY($1::text[]) ORDER BY split_ref`, [siblings])).rows,
    native: (await query(`SELECT to_jsonb(s) AS value FROM sales_orders s
      WHERE tranid=ANY($1::text[]) ORDER BY tranid`, [siblings])).rows,
    lines: (await query(`SELECT to_jsonb(l) AS value FROM sales_order_lines l JOIN sales_orders s
      ON s.netsuite_id=l.sales_order_id WHERE s.tranid=ANY($1::text[]) ORDER BY s.tranid,l.id`, [siblings])).rows,
    groups: (await query(`SELECT to_jsonb(g) AS value FROM dispatch_global_order_groups g
      WHERE group_ref=ANY($1::text[]) ORDER BY group_ref`, [groups])).rows,
    allocations: (await query(`SELECT to_jsonb(a) AS value FROM dispatch_so_po_allocations a
      WHERE id IN (230,255) ORDER BY id`)).rows,
    driver: (await query(`SELECT to_jsonb(j) AS value FROM driver_job_records j
      WHERE order_refs ?| $1::text[] ORDER BY id`, [[...siblings, ...groups]])).rows,
    routes: (await query(`SELECT plan_id,trucks FROM dispatch_plan_snapshots
      WHERE plan_id IN (344,357,364) ORDER BY plan_id`)).rows
  };
}
async function guardNoEditor() {
  await lockDispatchPlanEditLeaseDate(planDate);
  const editors = (await query(`SELECT operator_name FROM dispatch_plan_edit_leases
    WHERE plan_date=$1::date AND expires_at>clock_timestamp()`, [planDate])).rows;
  assert.equal(editors.length, 0, 'A dispatcher is editing this plan; do not change it concurrently.');
}
async function preflight() {
  const rows = await family();
  const source = rows.find(row => row.split_ref === sourceRef);
  assert.equal(source?.active, true);
  assert.deepEqual(rows.filter(row => row.active).map(row => row.split_ref), [...siblings, sourceRef]);
  assert.equal(source.full_order.items.length, 1);
  const line = source.full_order.items[0];
  assert.equal(Number(line.lineId), 4997388);
  assert.equal(Number(line.itemId), 2055);
  assert.equal(line.unit, 'SQFT');
  assert.equal(Number(line.quantity), 4588);
  const preview = await getDispatchSplitPreview({ orderRef: sourceRef, type: 'SO' });
  assert.equal(preview.operatorStatus, 'open');
  const seed = await getNextDispatchSplitSuffix({ originalOrderId: sourceRef, orderType: 'SO' });
  assert.equal(seed.originalOrderId, parentRef);
  assert.equal(seed.nextSuffix, 5);
  const plan = (await query(`SELECT id,plan_date::text,status,revision FROM dispatch_plans
    WHERE id=$1 AND plan_date=$2::date`, [planId, planDate])).rows[0];
  assert.ok(plan && plan.status !== 'cancelled');
  return { rows, source, preview, seed, plan };
}
async function verify() {
  const rows = await family();
  const quantities = Object.fromEntries(rows.filter(row => row.active).map(row =>
    [row.split_ref, row.full_order.items.reduce((sum, item) => sum + Number(item.quantity), 0)]));
  assert.deepEqual(quantities, {
    'SOA09140-S1': 1860, 'SOA09140-S3': 1984, 'SOA09140-S5': 2232, 'SOA09140-S6': 2356
  });
  assert.equal(rows.find(row => row.split_ref === sourceRef)?.active, false);
  const native = (await query(`SELECT s.tranid,s.netsuite_id,s.netsuite_active,s.operator_status,
    s.dispatch_planned,l.line_id,l.quantity,l.unit,l.netsuite_active AS line_active
    FROM sales_orders s JOIN sales_order_lines l ON s.netsuite_id=l.sales_order_id
    WHERE s.tranid=ANY($1::text[]) ORDER BY s.tranid,l.id`,
  [['SOA09140-S5', 'SOA09140-S6']])).rows;
  assert.deepEqual(native.map(row => [row.tranid, Number(row.quantity), row.unit, row.netsuite_active, row.line_active]),
    [['SOA09140-S5', 2232, 'SQFT', true, true], ['SOA09140-S6', 2356, 'SQFT', true, true]]);
  assert.ok(native.every(row => row.operator_status === 'open' && !row.dispatch_planned));
  const audits = (await query(`SELECT id,action,order_id,session_id,created_at,details FROM dispatch_audit_log
    WHERE order_id=$1 AND action='order_resplit' ORDER BY id`, [sourceRef])).rows;
  assert.equal(audits.length, 1);
  return { quantities, familyTotal: Object.values(quantities).reduce((a, b) => a + b, 0),
    retiredSource: sourceRef, native, audits };
}
try {
  if (mode === 'preflight') {
    const checked = await preflight();
    const retained = await retainedEvidence();
    console.log(JSON.stringify({ mode, checked, retained, retainedHash: hash(retained) }));
  } else if (mode === 'verify') {
    console.log(JSON.stringify({ mode, ...await verify(), retainedHash: hash(await retainedEvidence()) }));
  } else {
    const result = await withTransaction(async () => {
      await query("SET LOCAL lock_timeout='3s'");
      await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
      await guardNoEditor();
      const checked = await preflight(), before = await retainedEvidence();
      const parts = [2232, 2356].map(quantity => ({ items: [{
        ...checked.source.full_order.items[0], quantity, splitQty: quantity,
        pallets: 0, layers: 0, sections: 0, pieces: 0
      }] }));
      const changed = await resplitUnfinishedSalesOrder({ orderRef: sourceRef, planId, planDate,
        expectedItems: checked.source.full_order.items, parts, sessionId, assertEditLease: guardNoEditor });
      assert.deepEqual(changed.orders.map(order => order.id), ['SOA09140-S5', 'SOA09140-S6']);
      assert.deepEqual(changed.retiredGlobalOrderRefs, [sourceRef]);
      const after = await retainedEvidence();
      assert.deepEqual(after, before, 'Completed siblings or routes changed');
      const verified = await verify();
      for (const orderRef of [sourceRef, ...changed.orders.map(order => order.id)]) {
        await enqueueDispatchOrderCatalogRefresh({ orderRef, orderType: 'SO', source: sessionId });
      }
      return { mode, before: checked, retainedBefore: before, retainedAfter: after,
        retainedHash: hash(before), changed, verified };
    });
    console.log(JSON.stringify(result));
  }
} finally { await closeDb(); }
