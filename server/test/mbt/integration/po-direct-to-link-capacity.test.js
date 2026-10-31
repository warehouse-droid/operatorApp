import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { createOrderDependency, getOrderDependencyOptions, updateOrderDependencyMode } from '../../../src/order-dependency-repository.js';
import { createSalesOrderPoAllocation, getSalesOrderPoAllocationOptions } from '../../../src/dispatch-repository.js';
import { seedLinkGroup } from '../../support/link-to-fix-fixture.mjs';

after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

// Operator adds PO links and direct-pickup TO links on a sales line and refuses
// the load when together they exceed it, so linking must enforce the same sum.
async function seed() {
  const f = await seedLinkGroup();
  await query('DELETE FROM local_co_orders WHERE co_ref=$1', [f.coRef]);
  f.poId = 9_996_000_000 + crypto.randomInt(1_000_000);
  f.poRef = `PO-CAP-${f.poId}`;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,vendor,dispatch_vendor_yard,
    dispatch_address,destination_location_id,destination_location,netsuite_active)
    VALUES($1,$2,'B','Purchase Order : Pending Receipt','Capacity vendor','Capacity Yard','1 Vendor Road',26,'150',true)`,
  [f.poId, f.poRef]);
  f.poLineId = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,
    item_type_text,quantity,piece_qty,to_pcs,unit,netsuite_active)
    VALUES($1,1,2340,'LINK-ITEM','LINK-ITEM','InvtPart','Inventory Item',20,20,1,'EA',true) RETURNING id`, [f.poId])).rows[0].id;
  return f;
}

async function linkPo(f, target, lineIndex, salesQty) {
  const options = await getSalesOrderPoAllocationOptions(target, { planDate: f.plan.planDate });
  const line = options.salesLines.find(candidate => Number(candidate.id) === Number(f.lines[lineIndex].id));
  return createSalesOrderPoAllocation({ dispatchTargetRef: target, salesOrderRef: f.members[lineIndex],
    targetLineKey: line.targetLineKey, poLineId: f.poLineId, poRef: f.poRef, planDate: f.plan.planDate,
    targetSignature: options.order.targetSignature, quantities: { salesQty }, createdBy: 'link-capacity-regression' });
}

async function linkTo(f, mode, quantitiesFor = line => line.suggestedQuantities) {
  const options = await getOrderDependencyOptions({ dispatchTargetRef: f.groupRef, transferOrderRef: f.transferRef,
    planDate: f.plan.planDate });
  return createOrderDependency({ dispatchTargetRef: f.groupRef, planDate: f.plan.planDate, transferOrderRef: f.transferRef,
    mode, targetSignature: options.targetSignature,
    allocations: options.matchingLines.map((line, index) => ({ targetLineKey: line.targetLineKey, quantities: quantitiesFor(line, index) })) });
}

test('a PO cannot link what a direct TO link already supplies', () => isolated(async () => {
  const f = await seed();
  await linkTo(f, 'direct_to_customer');
  await assert.rejects(linkPo(f, f.groupRef, 0, 4), /open sales quantity is only 0/u);
}));

test('a direct TO link cannot supply what a PO link already covers', () => isolated(async () => {
  const f = await seed();
  await linkPo(f, f.members[0], 0, 4);
  await assert.rejects(linkTo(f, 'direct_to_customer'), /exceeds .* remaining quantity 0/u);
}));

test('a direct TO link still takes what the PO link left', () => isolated(async () => {
  const f = await seed();
  await linkPo(f, f.members[0], 0, 3);
  const dependency = await linkTo(f, 'direct_to_customer', (line, index) => index === 0
    ? { salesQty: 1 } : line.suggestedQuantities);
  assert.equal(dependency.status, 'active');
}));

test('a replenishment link leaves PO capacity untouched', () => isolated(async () => {
  const f = await seed();
  await linkTo(f, 'yard_replenishment');
  await linkPo(f, f.groupRef, 0, 4);
}));

test('switching a replenishment link to direct pickup cannot oversupply a PO-linked line', () => isolated(async () => {
  const f = await seed();
  const dependency = await linkTo(f, 'yard_replenishment');
  await linkPo(f, f.members[0], 0, 4);
  await assert.rejects(updateOrderDependencyMode(dependency.id, 'direct_to_customer', null, f.plan.planDate),
    /PO links already cover it/u);
  assert.equal((await query('SELECT dependency_mode FROM order_dependencies WHERE id=$1', [dependency.id])).rows[0].dependency_mode,
    'yard_replenishment');
}));
