import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { query } from '../../../src/db.js';
import { createDispatchPlan } from '../../../src/dispatch-plan-repository.js';
import { getDispatchSplitPreview } from '../../../src/dispatch-split-preview-repository.js';
import { syncDispatchGlobalOrderSplitsFromPlan } from '../../../src/dispatch-delivery-group-repository.js';
import { unsplitSalesOrder } from '../../../src/dispatch-sales-resplit-repository.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { seedSalesOrder, scenario } from '../support/fulfilled-so-fixture.js';

let http;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => http?.close());

// Unsplit retires the split refs. A TO link that targets one of them would be
// left pointing at an order that no longer exists, invisible on the restored
// SO and blocking the TO from being linked again.
async function splitWithLink() {
  const id = 13_000_000_000 + Number.parseInt(crypto.randomBytes(4).toString('hex'), 16);
  const ref = `SO-SPLIT-LINK-${id}`;
  await seedSalesOrder(id, ref, { status: 'B' });
  await query(`UPDATE sales_order_lines SET item_type='NonInvtPart',quantity=88,pallet_qty=0,piece_qty=22,
    to_plt=0,to_lyr=0,to_sec=0,to_pcs=0 WHERE sales_order_id=$1`, [id]);
  const preview = await getDispatchSplitPreview({ orderRef: ref, type: 'SO' });
  const plan = await createDispatchPlan({ planDate: '2098-10-16' });
  const source = { ...preview, sourceTable: 'sales_orders', customer: 'Split link', sourceYard: '3445', pickupLocations: ['3445'],
    address: 'Test Road', destinationAddress: 'Test Road', netsuiteId: String(id) };
  const parts = [1, 2].map(n => ({ ...source, id: `${ref}-S${n}`, originalOrderId: ref, netsuiteId: '',
    items: source.items.map(item => ({ ...item, quantity: 44, pieces: 0 })) }));
  await syncDispatchGlobalOrderSplitsFromPlan({ ...plan, orders: parts, trucks: [] });
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1', [plan.id, JSON.stringify(parts)]);
  const toId = id + 2;
  await query("INSERT INTO transfer_orders(netsuite_id,tranid,netsuite_active) VALUES($1,$2,true)", [toId, `TO-${id}`]);
  await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,transfer_order_ref,
    source_location_id,source_location,accounting_destination_location_id,dependency_mode,status,dispatch_target_ref,dispatch_target_kind)
    VALUES($1,$2,$3,$4,1,'3445',26,'yard_replenishment','active',$5,'split')`, [id, ref, toId, `TO-${id}`, parts[0].id]);
  return { ref, parts, plan, transferRef: `TO-${id}` };
}

test('unsplit is refused while a TO link targets one of the splits it retires', () => scenario(async () => {
  const f = await splitWithLink();
  await assert.rejects(unsplitSalesOrder({ orderRef: f.parts[0].id, planId: f.plan.id, planDate: f.plan.planDate }),
    error => error.status === 409 && new RegExp(`${f.transferRef}[\\s\\S]*${f.parts[0].id}|${f.parts[0].id}[\\s\\S]*${f.transferRef}`, 'u').test(error.message));
  const active = (await query('SELECT split_ref FROM dispatch_global_order_splits WHERE parent_order_ref=$1 AND active ORDER BY split_ref',
    [f.ref])).rows.map(row => row.split_ref);
  assert.deepEqual(active, f.parts.map(part => part.id));
}));

test('an Unsplit refusal is worded as Unsplit, not as a split', () => scenario(async () => {
  const f = await splitWithLink();
  await query("UPDATE order_dependencies SET status='cancelled' WHERE transfer_order_ref=$1", [f.transferRef]);
  await query(`INSERT INTO dispatch_plan_order_assignments(plan_id,plan_date,order_ref,load_id,stop_id)
    VALUES($1,$2::date,$3,'load-1','stop-1')`, [f.plan.id, f.plan.planDate, f.parts[1].id]);
  await assert.rejects(unsplitSalesOrder({ orderRef: f.parts[0].id, planId: f.plan.id, planDate: f.plan.planDate }),
    error => error.code === 'DISPATCH_SPLIT_PLANNED' && /before using Unsplit/u.test(error.message) && !/split(ting)? its/u.test(error.message));
}));
