import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { closeDb, query } from '../../../src/db.js';
import { loadSmartScmPlanningDemandStates, approveSmartScmPoPhase } from '../../../src/smart-scm-planning-repository.js';
import { getSmartScmProposalInventorySnapshot } from '../../../src/smart-scm-proposal-editor.js';
import { searchSmartScmVendorAlternatives } from '../../../src/smart-scm-vendor-repository.js';
import { isolated, fixture, child, phaseRun, vendorProposal, itemId, parentId, itemName, conversion } from '../../support/split-inbound-completion-fixture.mjs';

after(closeDb);
let sequence = 0;
const snapshot = () => getSmartScmProposalInventorySnapshot(itemId, 1, conversion);
const state = result => result.states.find(row => Number(row.policy.item_id) === itemId && Number(row.policy.location_id) === 1);

async function allocation(f, c, quantity, { active = true, progress = 'received', method = 'exact', residual = false } = {}) {
  const order = (await query(`INSERT INTO scm_reconciliation_order_state(order_kind,source_order_netsuite_id,source_order_ref)
    VALUES('PO',$1,'POB-INBOUND-PARENT') ON CONFLICT(order_kind,source_order_netsuite_id)
    DO UPDATE SET source_order_ref=EXCLUDED.source_order_ref RETURNING id`, [parentId])).rows[0];
  const line = (await query(`INSERT INTO scm_reconciliation_order_line_state(order_state_id,netsuite_line_key,local_line_id,item_id)
    VALUES($1,'701',$2,$3) ON CONFLICT(order_state_id,netsuite_line_key)
    DO UPDATE SET local_line_id=EXCLUDED.local_line_id RETURNING id`, [order.id, f.parentLineId, itemId])).rows[0];
  const ledger = (await query('SELECT id FROM dispatch_scm_po_split_lines WHERE split_line_id=$1', [c.lineId])).rows[0];
  return (await query(`INSERT INTO scm_reconciliation_allocations(allocation_key,order_line_state_id,progress_kind,
    target_kind,po_split_line_id,target_order_ref,quantity,allocation_method,active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
  [`reconciled-inbound-${++sequence}`, line.id, progress, residual ? 'source_residual' : 'po_split',
    residual ? null : ledger.id, c.ref, quantity, method, active])).rows[0];
}

test('received 13-PLT split disappears while the new 6-PLT PO remains', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f, { ref: '3022033418', quantity: 546 });
  await allocation(f, c, 546);
  await query(`UPDATE purchase_order_lines SET quantity=546,netsuite_received_qty=546 WHERE id=$1`, [f.parentLineId]);
  await query(`UPDATE inventory_balances SET quantity_available=85,quantity_on_order=252,quantity_backordered=0 WHERE item_id=$1 AND location_id=1`, [itemId]);
  const actual = await getSmartScmProposalInventorySnapshot(itemId, 1, 42);
  assert.equal(actual.quantityReleasedSplitInbound, 0);
  assert.equal(actual.quantityOnOrderAuthoritative, 252);
  assert.equal(actual.quantityOnOrder, 252);
  assert.equal(actual.expectedAvailablePallets, 8.02381);
  assert.equal(state(await loadSmartScmPlanningDemandStates()).onOrderSales, 252);
}));

test('partial reconciled receipts overlap NetSuite and posted local totals', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f, { quantity: 1000, receipt: 'partial_received', baseline: 100, latest: 220, sales: 150 });
  const a = await allocation(f, c, 300);
  assert.equal((await snapshot()).quantityReleasedSplitInbound, 700);
  await query('UPDATE scm_reconciliation_allocations SET quantity=200 WHERE id=$1', [a.id]);
  assert.equal((await snapshot()).quantityReleasedSplitInbound, 750);
  await query('UPDATE purchase_order_lines SET netsuite_received_qty=400 WHERE id=$1', [c.lineId]);
  assert.equal((await snapshot()).quantityReleasedSplitInbound, 600);
}));

test('exact line receipts leave siblings and ignore inactive, fulfillment and residual allocations', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f, { quantity: 100 });
  const a = await allocation(f, c, 100);
  const sibling = await child(f, { quantity: 200 });
  await allocation(f, sibling, 200, { active: false });
  await allocation(f, sibling, 200, { progress: 'fulfilled' });
  await allocation(f, sibling, 200, { residual: true });
  assert.equal((await snapshot()).quantityReleasedSplitInbound, 200);
  await query('UPDATE scm_reconciliation_allocations SET active=false WHERE id=$1', [a.id]);
  assert.equal((await snapshot()).quantityReleasedSplitInbound, 300);
}));

test('planner, vendor alternatives and new phase evidence use allocated receipts', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f, { quantity: 500 });
  await allocation(f, c, 350);
  assert.equal(state(await loadSmartScmPlanningDemandStates()).releasedSplitInboundSales, 150);
  const runId = await phaseRun();
  const proposal = await vendorProposal(runId);
  const alternatives = await searchSmartScmVendorAlternatives(proposal.id, { lineId: proposal.lineId, search: itemName });
  assert.equal(alternatives.find(row => row.itemId === itemId).quantityReleasedSplitInbound, 150);
  await approveSmartScmPoPhase(runId);
  const basis = (await query('SELECT phase_two_basis FROM scm_smart_planning_runs WHERE id=$1', [runId])).rows[0].phase_two_basis;
  assert.deepEqual(basis.expectedPurchaseOrderLines.filter(row => row.itemId === itemId).map(row => [row.orderRef, row.remainingQuantity]), [[c.ref, 150]]);
  await query('UPDATE scm_reconciliation_allocations SET quantity=500 WHERE target_order_ref=$1', [c.ref]);
  await approveSmartScmPoPhase(runId);
  assert.deepEqual((await query('SELECT phase_two_basis FROM scm_smart_planning_runs WHERE id=$1', [runId])).rows[0].phase_two_basis, basis);
}));

test('receipt allocation cannot consume a different line on the same split', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f, { quantity: 100 });
  await allocation(f, c, 100);
  const sibling = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,
    quantity,unit,to_plt,location_id,netsuite_active) VALUES($1,702,$2,$3,200,'SQFT',$4,1,true) RETURNING id`,
  [c.id, itemId, itemName, conversion])).rows[0];
  await query(`INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,item_id,sales_qty)
    SELECT split_id,source_line_id,$2,item_id,200 FROM dispatch_scm_po_split_lines WHERE split_line_id=$1`, [c.lineId, sibling.id]);
  assert.equal((await snapshot()).quantityReleasedSplitInbound, 200);
  assert.equal(state(await loadSmartScmPlanningDemandStates()).releasedSplitInboundSales, 200);
}));

test('property: reconciliation is a cumulative receipt source bounded by ordered quantity', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f, { receipt: 'partial_received' });
  const a = await allocation(f, c, 0);
  await fc.assert(fc.asyncProperty(fc.record({
    ordered: fc.integer({ min: 0, max: 10000 }), base: fc.integer({ min: 0, max: 500 }),
    local: fc.integer({ min: 0, max: 10000 }), latest: fc.integer({ min: 0, max: 15000 }),
    reconciled: fc.integer({ min: 0, max: 15000 }), active: fc.boolean()
  }), async ({ ordered, base, local, latest, reconciled, active }) => {
    await query(`UPDATE purchase_order_lines SET quantity=$2,netsuite_received_baseline_qty=$3,
      received_sales_qty=$4,netsuite_received_qty=$5 WHERE id=$1`, [c.lineId, ordered, base, local, latest]);
    await query('UPDATE scm_reconciliation_allocations SET quantity=$2,active=$3 WHERE id=$1', [a.id, reconciled, active]);
    const expected = Math.max(0, ordered - Math.max(base + local, latest, active ? reconciled : 0));
    const actual = (await snapshot()).quantityReleasedSplitInbound;
    assert.equal(actual, expected);
    assert.ok(actual >= 0 && actual <= ordered);
  }), { seed: 5057, numRuns: 60 });
}));
