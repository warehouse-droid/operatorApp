import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { submitRegularStockRequest } from "../../../src/regular-stock-request-service.js";
import { addPurchaseStockProposals } from "../../../src/regular-stock-purchase-service.js";
import {
  approveSmartScmPoPhase,
  getSmartScmPlanningRun,
  loadSmartScmPlanningDemandStates
} from "../../../src/smart-scm-planning-repository.js";

after(closeDb);
const isolated = (fn) => withTransaction(fn, { rollback: true });

async function fixture({ sourceAvailable = 24, sourceFloor = 2, onOrder = 0 } = {}) {
  const itemId = 8_700_000_000_000 + randomInt(1_000_000_000);
  const itemName = `PO-TO-${itemId}`;
  await query(`INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt,to_pcs,item_weight)
    VALUES($1,$2,'PC',60,1,10)`, [itemId, itemName]);
  await query(`INSERT INTO scm_smart_item_policies(item_id,item_name,stock_unit,to_plt,
    pallet_weight_lbs,lead_time_days,planning_enabled) VALUES($1,$2,'PC',60,600,7,true)`, [itemId, itemName]);
  await query(`INSERT INTO scm_smart_item_yard_policies(item_id,location_id,yard_code,
    eligible,capacity_pallets,minimum_safety_pallets) VALUES
    ($1,1,'3445',true,80,$2),($1,26,'150',true,32,8)`, [itemId, sourceFloor]);
  await query(`INSERT INTO inventory_balances(item_id,location_id,location,
    quantity_available,quantity_on_hand,quantity_on_order,synced_at) VALUES
    ($1,1,'3445',$2,$2,0,now()),($1,26,'150',0,0,$3,now())`, [itemId, sourceAvailable * 60, onOrder * 60]);
  const settings = (await query("SELECT * FROM scm_smart_settings WHERE id=1")).rows[0];
  const snapshot = { ...settings, inventory_planning_mode: "po_then_transfer", skip_12441_enabled: true };
  const runId = Number((await query(`INSERT INTO scm_smart_planning_runs(status,trigger_source,
    settings_snapshot,plan_kind,planning_phase) VALUES('ready','po-to-test',$1::jsonb,
    'inventory','po_pending_approval') RETURNING id`, [JSON.stringify(snapshot)])).rows[0].id);
  return { itemId, itemName, runId };
}

async function proposal(f, options = {}) {
  const { pallets, requested, actualPoId, yard, regular, parent, kind, confirmed } = {
    pallets: 8, requested: false, actualPoId: null, yard: 26, regular: false,
    parent: null, kind: null, confirmed: 0, ...options
  };
  const status = options.status === undefined ? requested ? "order_requested" : "held" : options.status;
  const group = regular ? Number((await query(`INSERT INTO regular_stock_replenishments(item_id,
    source_location_id,quantity) VALUES($1,$2,$3) RETURNING id`, [f.itemId, yard, pallets * 60])).rows[0].id) : null;
  const id = Number((await query(`INSERT INTO scm_smart_proposals(run_id,proposal_key,proposal_type,
    phase,source_kind,source_name,destination_location_id,destination_name,status,
    order_requested_at,netsuite_purchase_order_id,regular_replenishment_id,parent_proposal_id,
    vendor_resolution_kind) VALUES($1,$2,'PO','direct_vendor','vendor','Test vendor',$3,$4,$5,
    CASE WHEN $6 THEN now() END,$7,$8,$9,$10) RETURNING id`,
  [f.runId, `po-to-${f.itemId}-${randomInt(1_000_000_000)}`, yard, yard === 26 ? "150" : "3445",
    status, requested, actualPoId, group, parent, kind])).rows[0].id);
  await query(`INSERT INTO scm_smart_proposal_lines(proposal_id,item_id,item_name,unit,
    required_pallets,proposed_pallets,confirmed_pallets,residual_pallets,sales_quantity,
    to_plt,to_pcs,pallet_weight_lbs,line_weight_lbs,destination_location_id,destination_name)
    VALUES($1,$2,$3,'PC',8,$4::numeric,$5,$4::numeric,$4::numeric*60,60,1,600,$4::numeric*600,$6,$7)`,
  [id, f.itemId, f.itemName, pallets, confirmed, yard, yard === 26 ? "150" : "3445"]);
  if (group) {
    await query("UPDATE regular_stock_replenishments SET current_proposal_id=$2 WHERE id=$1", [group, id]);
  }
  return id;
}

async function transferPallets(f) {
  await approveSmartScmPoPhase(f.runId);
  const plan = await getSmartScmPlanningRun(f.runId);
  return plan.proposals.filter((p) => p.proposalType === "TO")
    .flatMap((p) => p.lines).filter((line) => line.itemId === f.itemId)
    .reduce((sum, line) => sum + line.proposedPallets, 0);
}

async function stockingPurchase(f, { requested = false } = {}) {
  const actor = f.itemName;
  const vendorId = randomInt(1_000_000_000);
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
    VALUES($1,$1,$1,'test','test','scm',ARRAY['scm'],true)`, [actor]);
  await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES($1,'PO TO vendor','PO TO pickup')", [vendorId]);
  const context = { operatorId: actor, authorizedDestinationLocationIds: [26], allowOverAvailability: false };
  const policy = { item_id: f.itemId, item_name: f.itemName, stock_unit: "PC", to_plt: 60,
    pallet_weight_lbs: 600, vendor_id: vendorId, vendor: "PO TO vendor", vendor_yard_id: vendorId,
    vendor_yard: "PO TO pickup", plant: "PO TO pickup" };
  const dependencies = { loadPurchaseStock: async () => ({ onHand: 0, available: 0, preferredStock: 480 }),
    loadPurchasePolicy: async () => policy };
  const request = await submitRegularStockRequest({ deliveryMethod: "stocking", stockingType: "purchase",
    destinationLocationId: 26, lines: [{ itemId: f.itemId, pieces: 180 }] }, context, dependencies);
  const accepted = await addPurchaseStockProposals(request.id, { expectedRevision: request.revision,
    lines: [{ lineId: request.lines[0].id }] }, context, dependencies);
  const id = accepted.lines[0].purchase.proposals[0].proposalId;
  if (requested) {
    await query("UPDATE scm_smart_proposals SET status='order_requested',order_requested_at=now() WHERE id=$1", [id]);
  }
  return id;
}

test("unrequested PO proposals leave the full 8 pallets for TO planning", () => isolated(async () => {
  const f = await fixture();
  await proposal(f);
  assert.equal(await transferPallets(f), 8);
}));

test("Order Request for 3 of 8 pallets leaves 5 for TO planning", () => isolated(async () => {
  const f = await fixture();
  await proposal(f, { pallets: 3, requested: true });
  assert.equal(await transferPallets(f), 5);
}));

test("a fully requested PO covers all 8 pallets before a real PO exists", () => isolated(async () => {
  const f = await fixture();
  await proposal(f, { requested: true });
  assert.equal(await transferPallets(f), 0);
}));

test("an unrequested priority replenishment is not ordered supply at the handoff", () => isolated(async () => {
  const f = await fixture();
  await proposal(f, { regular: true });
  assert.equal(await transferPallets(f), 8);
}));

test("a requested priority replenishment is covered once", () => isolated(async () => {
  const f = await fixture();
  await proposal(f, { pallets: 3, regular: true, requested: true });
  assert.equal(await transferPallets(f), 5);
}));

test("an unrequested Stocking Purchase load leaves all 8 pallets for TO planning", () => isolated(async () => {
  const f = await fixture();
  await stockingPurchase(f);
  assert.equal(await transferPallets(f), 8);
}));

test("requested Stocking Purchase coverage is applied once, for its 3 pallets", () => isolated(async () => {
  const f = await fixture();
  await stockingPurchase(f, { requested: true });
  assert.equal(await transferPallets(f), 5);
}));

test("Order Requests from earlier planning cycles still cover outstanding demand", () => isolated(async () => {
  const earlier = await fixture();
  await proposal(earlier, { pallets: 3, requested: true });
  const runId = Number((await query(`INSERT INTO scm_smart_planning_runs(status,trigger_source,
    settings_snapshot,plan_kind,planning_phase) SELECT 'ready','po-to-next',settings_snapshot,
    'inventory','po_pending_approval' FROM scm_smart_planning_runs WHERE id=$1 RETURNING id`, [earlier.runId])).rows[0].id);
  assert.equal(await transferPallets({ ...earlier, runId }), 5);
}));

test("real inbound is not counted again through its requested proposal", () => isolated(async () => {
  const f = await fixture({ onOrder: 3 });
  await proposal(f, { pallets: 3, requested: true, actualPoId: f.itemId + 1 });
  assert.equal(await transferPallets(f), 5);
}));

test("cancelled and superseded requests leave the full shortage for TOs", () => isolated(async () => {
  const f = await fixture();
  await proposal(f, { requested: true, status: "cancelled" });
  await proposal(f, { requested: true, status: "superseded" });
  assert.equal(await transferPallets(f), 8);
}));

test("vendor review covers confirmed quantity rather than the superseded parent", () => isolated(async () => {
  const f = await fixture();
  const parent = await proposal(f, { requested: true, status: "superseded" });
  await proposal(f, { requested: true, status: "confirmed", parent, kind: "netsuite_po_review", confirmed: 3 });
  assert.equal(await transferPallets(f), 5);
}));

test("requested quantities at another yard do not hide destination shortage", () => isolated(async () => {
  const f = await fixture();
  await proposal(f, { requested: true, yard: 1 });
  assert.equal(await transferPallets(f), 8);
}));

test("approval freezes request coverage and repeated approval does not duplicate transfers", () => isolated(async () => {
  const f = await fixture();
  const id = await proposal(f, { pallets: 3, requested: true });
  assert.equal(await transferPallets(f), 5);
  const before = await getSmartScmPlanningRun(f.runId);
  await query("UPDATE scm_smart_proposals SET order_requested_at=NULL,status='held' WHERE id=$1", [id]);
  assert.equal(await transferPallets(f), 5);
  const afterPlan = await getSmartScmPlanningRun(f.runId);
  assert.deepEqual(afterPlan.phaseTwoBasis, before.phaseTwoBasis);
  assert.deepEqual(afterPlan.proposals.filter((p) => p.proposalType === "TO").map((p) => p.id),
    before.proposals.filter((p) => p.proposalType === "TO").map((p) => p.id));
}));

test("reported source stock 24 below protected floor 35 still blocks automatic transfer", () => isolated(async () => {
  const f = await fixture({ sourceFloor: 35 });
  await proposal(f);
  const planning = await loadSmartScmPlanningDemandStates();
  const source = planning.states.find((s) => s.key === `${f.itemId}:1`);
  assert.equal(source.availablePallets, 24);
  assert.equal(source.rop, 35);
  assert.equal(await transferPallets(f), 0);
  const plan = await getSmartScmPlanningRun(f.runId);
  assert.equal(plan.phaseTwoBasis.exceptions.find((e) => e.itemId === f.itemId && e.yard === "150").remainingPallets, 8);
}));

test("an interrupted phase update rolls back generated transfers and coverage evidence", () => isolated(async () => {
  const f = await fixture();
  await proposal(f, { pallets: 3, requested: true });
  await query(`CREATE FUNCTION pg_temp.fail_po_to_handoff() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN IF NEW.id=${f.runId} AND NEW.planning_phase='transfer_ready' THEN
    RAISE EXCEPTION 'PO_TO_HANDOFF_ROLLBACK'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER fail_po_to_handoff BEFORE UPDATE ON scm_smart_planning_runs
    FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_po_to_handoff()`);
  await assert.rejects(() => approveSmartScmPoPhase(f.runId), /PO_TO_HANDOFF_ROLLBACK/);
  const plan = await getSmartScmPlanningRun(f.runId);
  assert.equal(plan.planningPhase, "po_pending_approval");
  assert.deepEqual(plan.phaseTwoBasis, {});
  assert.equal(plan.proposals.filter((p) => p.proposalType === "TO").length, 0);
}));

test("concurrent approval builds one frozen transfer phase", async () => {
  const f = await fixture();
  await proposal(f, { pallets: 3, requested: true });
  const outcomes = await Promise.all([approveSmartScmPoPhase(f.runId), approveSmartScmPoPhase(f.runId)]);
  assert.deepEqual(outcomes.map((plan) => plan.phaseApprovalReused).sort(), [false, true]);
  assert.deepEqual(outcomes[0].phaseTwoBasis, outcomes[1].phaseTwoBasis);
  assert.equal(await transferPallets(f), 5);
});
