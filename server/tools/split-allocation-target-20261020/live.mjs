import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { query, closeDb } from '/app/src/db.js';
import { getDispatchSplitPreview } from '/app/src/dispatch-split-preview-repository.js';
import { getNextDispatchSplitSuffix } from '/app/src/delivery-repository.js';

try {
  const health = await fetch('http://127.0.0.1:3000/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const source = await readFile('/app/src/dispatch-sales-resplit-repository.js', 'utf8');
  assert.ok(source.includes('getNextDispatchSplitSuffix({ originalOrderId: row.split_ref, orderType: "SO" })'));
  const allocations = (await query(`SELECT id::text,sales_order_ref,dispatch_target_ref,dispatch_target_kind,
    po_order_ref,allocated_sales_qty::numeric,status FROM dispatch_so_po_allocations WHERE id IN (230,255) ORDER BY id`)).rows;
  assert.deepEqual(allocations.map(row => ({ ...row, allocated_sales_qty: Number(row.allocated_sales_qty) })), [
    { id: '230', sales_order_ref: 'SOA09140', dispatch_target_ref: 'GOA-9140S1-9143S1',
      dispatch_target_kind: 'group', po_order_ref: 'SN1401884', allocated_sales_qty: 1860, status: 'active' },
    { id: '255', sales_order_ref: 'SOA09140-S3', dispatch_target_ref: 'GOA-9140S3-9143S3',
      dispatch_target_kind: 'group', po_order_ref: 'SN1401885', allocated_sales_qty: 1984, status: 'active' }
  ]);
  const memberships = (await query(`SELECT group_ref,member_order_ref FROM dispatch_global_order_group_members
    WHERE group_ref=ANY($1::text[]) ORDER BY group_ref,member_order_ref`, [allocations.map(row => row.dispatch_target_ref)])).rows;
  assert.ok(memberships.some(row => row.group_ref === allocations[0].dispatch_target_ref && row.member_order_ref === 'SOA09140-S1'));
  assert.ok(memberships.some(row => row.group_ref === allocations[1].dispatch_target_ref && row.member_order_ref === 'SOA09140-S3'));
  assert.ok(!memberships.some(row => row.member_order_ref === 'SOA09140-S4'));
  const preview = await getDispatchSplitPreview({ orderRef: 'SOA09140-S4', type: 'SO' });
  const seed = await getNextDispatchSplitSuffix({ originalOrderId: 'SOA09140-S4', orderType: 'SO' });
  assert.equal(preview.operatorStatus, 'open');
  assert.equal(preview.items.reduce((sum, item) => sum + item.quantity, 0), 4588);
  const native = (await query(`SELECT sum(l.quantity)::numeric AS quantity FROM sales_order_lines l
    JOIN sales_orders s ON s.netsuite_id=l.sales_order_id
    WHERE s.tranid='SOA09140-S4' AND l.netsuite_active IS DISTINCT FROM false`)).rows[0];
  assert.equal(Number(native.quantity), 4588);
  assert.equal(seed.originalOrderId, 'SOA09140');
  assert.equal(seed.nextSuffix, 5);
  const family = (await query(`SELECT split_ref,full_order FROM dispatch_global_order_splits
    WHERE parent_order_ref='SOA09140' AND active ORDER BY split_ref`)).rows;
  assert.equal(family.flatMap(row => row.full_order.items).reduce((sum, item) => sum + Number(item.quantity), 0), 8432);
  console.log(JSON.stringify({ localHealth: 200, selectedSplitAllocationCheckDeployed: true,
    soa09140: { remainingSqft: 4588, familySqft: 8432, nextSplitSuffix: seed.nextSuffix,
      allocationIdsPreserved: allocations.map(row => row.id), allocations, memberships },
    actualSplitPerformed: false, businessRecordsModified: false }));
} finally { await closeDb(); }
