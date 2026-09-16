import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { closeDb, query } from "../../../src/db.js";
import { loadSmartScmPlanningDemandStates, approveSmartScmPoPhase } from "../../../src/smart-scm-planning-repository.js";
import { getSmartScmProposalInventorySnapshot } from "../../../src/smart-scm-proposal-editor.js";
import { searchSmartScmVendorAlternatives } from "../../../src/smart-scm-vendor-repository.js";
import { isolated, fixture, child, completed, phaseRun, vendorProposal, itemId, itemName, conversion } from "../../support/split-inbound-completion-fixture.mjs";

after(closeDb);
const snapshot = locationId => getSmartScmProposalInventorySnapshot(itemId,locationId || 1,conversion);
const planning = () => loadSmartScmPlanningDemandStates();
const state = (result,locationId = 1) => result.states.find(s => Number(s.policy.item_id) === itemId && Number(s.policy.location_id) === locationId);

async function reproduction() {
  const f = await fixture();
  await child(f,{ref:'PO# B03370 (1)',receipt:'received',pallets:24});
  for (const ref of ['OR00807141','OR00807142']) {
    await child(f,{ref});
    await completed(ref);
  }
  return f;
}

test('planner removes the three completed 24-PLT splits with stale NetSuite counters', () => isolated(async () => {
  await reproduction();
  const result = await planning();
  assert.equal(state(result).releasedSplitInboundSales,0);
  assert.equal(state(result).onOrderSales,0);
  assert.equal(state(result).positionPallets,-10.250831);
  assert.deepEqual(result.splitInboundEvidence.filter(row=>Number(row.itemId)===itemId),[]);
}));

test('proposal editor removes completed incoming and preserves authoritative balances', () => isolated(async () => {
  await reproduction();
  const result = await snapshot();
  assert.equal(result.quantityOnOrder,0);
  assert.equal(result.quantityReleasedSplitInbound,0);
  assert.equal(result.quantityOnOrderAuthoritative,74679);
  assert.equal(result.quantityBlanketExcluded,74679);
  assert.equal(result.quantityBackordered,1048.66);
}));

test('vendor alternatives use the same completed split calculation', () => isolated(async () => {
  await reproduction();
  const proposal = await vendorProposal(await phaseRun());
  const results = await searchSmartScmVendorAlternatives(proposal.id,{lineId:proposal.lineId,search:itemName});
  const result = results.find(row => row.itemId === itemId);
  assert.ok(result,'candidate is returned');
  assert.equal(result.quantityOnOrder,0);
  assert.equal(result.quantityReleasedSplitInbound,0);
}));

test('new phase evidence excludes completion and approval remains immutable', () => isolated(async () => {
  const f = await reproduction();
  const pending = await child(f,{quantity:102.3});
  const runId = await phaseRun();
  await approveSmartScmPoPhase(runId);
  const basis = (await query('SELECT phase_two_basis FROM scm_smart_planning_runs WHERE id=$1',[runId])).rows[0].phase_two_basis;
  assert.deepEqual(basis.expectedPurchaseOrderLines.filter(row=>row.itemId===itemId).map(row=>[row.orderRef,row.remainingQuantity]),[[pending.ref,102.3]]);
  await completed(pending.ref);
  await approveSmartScmPoPhase(runId);
  assert.deepEqual((await query('SELECT phase_two_basis FROM scm_smart_planning_runs WHERE id=$1',[runId])).rows[0].phase_two_basis,basis);
}));

test('exact completion leaves siblings, parent matches and wrong order kinds pending', () => isolated(async () => {
  const f = await fixture();
  await child(f,{ref:'INBOUND-EXACT',quantity:100});
  await completed('  inbound-exact  ');
  await child(f,{ref:'INBOUND-EXACT-S2',quantity:200});
  await completed('POB-INBOUND-PARENT');
  await child(f,{ref:'INBOUND-WRONG-KIND',quantity:300});
  await completed('INBOUND-WRONG-KIND','SO');
  assert.equal((await snapshot()).quantityReleasedSplitInbound,500);
  assert.equal(state(await planning()).releasedSplitInboundSales,500);
}));

test('partial posted receipts use baseline plus converted local units without double counting NetSuite', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f,{quantity:1000,receipt:'partial_received',baseline:100,latest:220,pallets:2,layers:3,sections:4,pieces:5});
  // 100 baseline + 204.6 + 30 + 8 + 5 = 347.6 received, not 567.6.
  assert.equal((await snapshot()).quantityReleasedSplitInbound,652.4);
  assert.equal(state(await planning()).releasedSplitInboundSales,652.4);
  await query('UPDATE purchase_order_lines SET netsuite_received_qty=500 WHERE id=$1',[c.lineId]);
  assert.equal((await snapshot()).quantityReleasedSplitInbound,500);
}));

test('full NetSuite receipt and received header each remove incoming even with stale other counters', () => isolated(async () => {
  const f = await fixture();
  await child(f,{quantity:100,latest:100,baseline:0});
  await child(f,{quantity:100,receipt:'received'});
  assert.equal((await snapshot()).quantityOnOrder,0);
}));

test('unposted and unconfirmed receipt drafts remain incoming', () => isolated(async () => {
  const f = await fixture();
  await child(f,{quantity:1000,pallets:8,receipt:'not_received'});
  await child(f,{quantity:1000,pallets:8,receipt:'partial_received',confirmed:false});
  assert.equal((await snapshot()).quantityReleasedSplitInbound,2000);
}));

test('Driver pickup remains incoming until the exact split drop-off is completed', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f,{ref:'PO-INBOUND-DRIVER',quantity:123});
  const job = await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,completed_at)
    VALUES('inbound-pickup','test-driver','pickup',$1::jsonb,'complete',now()) RETURNING id`,[JSON.stringify([c.ref])]);
  assert.equal((await snapshot()).quantityReleasedSplitInbound,123);
  await query(`UPDATE driver_job_records SET stop_type='dropoff' WHERE id=$1`,[job.rows[0].id]);
  assert.equal((await snapshot()).quantityReleasedSplitInbound,0);
}));

test('a new unposted receipt draft cannot reuse an older partial receipt header', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f,{quantity:1000,pallets:8,receipt:'partial_received',latest:100});
  await query(`UPDATE purchase_orders SET received_at='2020-01-01' WHERE netsuite_id=$1`,[c.id]);
  assert.equal((await snapshot()).quantityReleasedSplitInbound,900);
}));

test('same-yard and cross-yard pending children survive terminal child filters', () => isolated(async () => {
  const f = await fixture();
  await child(f,{quantity:100});
  await child(f,{quantity:200,locationId:15});
  for (const patch of [{active:false},{closed:true},{splitStatus:'cancelled'},{status:'Purchase Order : Closed'}]) await child(f,{quantity:300,...patch});
  assert.equal((await snapshot()).quantityReleasedSplitInbound,100);
  assert.equal((await snapshot(15)).quantityReleasedSplitInbound,200);
  const result = await planning();
  assert.equal(state(result).releasedSplitInboundSales,100);
  assert.equal(state(result,15).releasedSplitInboundSales,200);
}));

test('ordinary parent evidence does not regain quantities from completed child splits', () => isolated(async () => {
  const f = await fixture({blanket:false});
  const c = await child(f,{quantity:100,locationId:15});
  const before = await planning();
  assert.equal(state(before).onOrderSales,74579);
  assert.equal(state(before,15).onOrderSales,100);
  await completed(c.ref);
  const runId = await phaseRun();
  await approveSmartScmPoPhase(runId);
  const basis = (await query('SELECT phase_two_basis FROM scm_smart_planning_runs WHERE id=$1',[runId])).rows[0].phase_two_basis;
  assert.deepEqual(basis.expectedPurchaseOrderLines.filter(row=>row.itemId===itemId).map(row=>[row.orderRef,row.remainingQuantity]),[['POB-INBOUND-PARENT',74579]]);
}));

test('property: outstanding split supply equals ordered less the greater cumulative receipt total', () => isolated(async () => {
  const f = await fixture();
  const c = await child(f,{receipt:'partial_received'});
  await fc.assert(fc.asyncProperty(fc.record({qty:fc.integer({min:0,max:10000}),base:fc.integer({min:0,max:1000}),
    latest:fc.integer({min:0,max:12000}),local:fc.integer({min:0,max:12000})}),async ({qty,base,latest,local})=>{
    await query(`UPDATE purchase_order_lines SET quantity=$2,netsuite_received_baseline_qty=$3,
      netsuite_received_qty=$4,received_sales_qty=$5,to_plt=0,to_lyr=0,to_sec=0,to_pcs=0 WHERE id=$1`,[c.lineId,qty,base,latest,local]);
    const expected = Math.max(0,qty-Math.max(latest,base+local));
    const actual = (await snapshot()).quantityReleasedSplitInbound;
    assert.equal(actual,expected);
    assert.ok(actual>=0 && actual<=qty);
  }),{seed:3737,numRuns:40});
}));
