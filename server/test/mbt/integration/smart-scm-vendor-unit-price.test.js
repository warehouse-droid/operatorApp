import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { getSmartScmVendorWorkflowForProposal, ensureSmartScmVendorWorkflow } from "../../../src/smart-scm-vendor-workflow-repository.js";
import { saveSmartScmVendorReplyLoad, stageSmartScmVendorReplyLoad } from "../../../src/smart-scm-vendor-repository.js";

after(closeDb);

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const baseId = 8_700_000_000_000 + Number(seed.slice(-8)) * 100;
const actor = `vendor-price-${seed}`;
const itemId = baseId + 1;
const vendorId = baseId + 2;
let palletItemId = null;
let proposalSequence = 0;

async function createProposal() {
  proposalSequence += 1;
  const run = await query(
    `INSERT INTO scm_smart_planning_runs (
       status, trigger_source, revision, settings_snapshot, totals,
       created_by, completed_at, plan_kind
     ) VALUES ('ready','manual',1,$1::jsonb,'{}'::jsonb,$2,now(),'inventory')
     RETURNING id`,
    [JSON.stringify({ truck_capacity_lbs: 78_000 }), actor]
  );
  const proposal = await query(
    `INSERT INTO scm_smart_proposals (
       run_id, proposal_key, proposal_type, phase, source_kind, source_name,
       destination_location_id, destination_name, vendor, plant, status,
       total_pallets, total_weight_lbs, utilization, order_requested_at,
       order_requested_by, vendor_reply_due_at
     ) VALUES (
       $1,$2,'PO','direct_vendor','vendor',$3,15,'12441',$4,$3,
       'order_requested',4,4000,0.051282,now(),$5,now() + interval '24 hours'
     ) RETURNING id`,
    [run.rows[0].id, `vendor-price:${seed}:${proposalSequence}`,
      `Vendor Price Source ${seed}`, `Vendor Price Vendor ${seed}`, actor]
  );
  const proposalId = Number(proposal.rows[0].id);
  const line = await query(
    `INSERT INTO scm_smart_proposal_lines (
       proposal_id, item_id, item_name, item_description, unit,
       required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
       sales_quantity, pallet_weight_lbs, line_weight_lbs,
       to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
       destination_location_id, destination_name
     ) VALUES (
       $1,$2,$3,'Vendor price fixture','EA',4,4,0,4,40,1000,4000,
       10,0,0,0,false,'{}'::jsonb,15,'12441'
     ) RETURNING id`,
    [proposalId, itemId, `VENDOR-PRICE-ITEM-${seed}`]
  );
  await ensureSmartScmVendorWorkflow(proposalId, actor);
  return { proposalId, lineId: Number(line.rows[0].id) };
}

function reply(lineId, extra = {}) {
  return {
    lines: [{
      proposalLineId: lineId,
      destinationLocationId: 15,
      decision: "hold",
      decisionPallets: 2,
      ...extra
    }]
  };
}

before(async () => {
  await query(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt, role, roles, active
     ) VALUES ($1,$1,$1,'harness','harness','admin',ARRAY['admin']::text[],true)`,
    [actor]
  );
  await query(
    `INSERT INTO inventory_items (
       item_id, item_name, display_name, item_description, stock_unit,
       purchase_unit, last_purchase_price, to_plt, item_weight, vendor_id, vendor
     ) VALUES ($1,$2,$2,'Vendor price fixture','EA','EA',1.64,10,1000,$3,$4)`,
    [itemId, `VENDOR-PRICE-ITEM-${seed}`, vendorId, `Vendor Price Vendor ${seed}`]
  );
  const existingPallet = await query(
    `SELECT item_id FROM inventory_items
      WHERE UPPER(BTRIM(COALESCE(item_name, ''))) = 'PALLET'
      ORDER BY item_id LIMIT 1`
  );
  if (existingPallet.rowCount) {
    palletItemId = Number(existingPallet.rows[0].item_id);
    await query(
      `UPDATE inventory_items
          SET stock_unit = 'EACH', purchase_unit = 'EACH',
              last_purchase_price = 4.25, item_weight = 40
        WHERE item_id = $1`,
      [palletItemId]
    );
  } else {
    palletItemId = baseId + 3;
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit,
         purchase_unit, last_purchase_price, to_plt, item_weight
       ) VALUES ($1,'PALLET','PALLET','Official pallet','EACH','EACH',4.25,1,40)`,
      [palletItemId]
    );
  }
});

test("saved material and PALLET prices are load-scoped, refreshable, and resettable", async () => {
  const first = await createProposal();
  await saveSmartScmVendorReplyLoad(first.proposalId, {
    ...reply(first.lineId, { unitPrice: 2.75 }),
    palletUnitPrice: 5.5
  }, actor);

  const stored = await query(
    `SELECT line.last_purchase_price, line.reason,
            proposal.pallet_last_purchase_price
       FROM scm_smart_proposal_lines line
       JOIN scm_smart_proposals proposal ON proposal.id = line.proposal_id
      WHERE line.id = $1`,
    [first.lineId]
  );
  assert.equal(Number(stored.rows[0].last_purchase_price), 2.75);
  assert.equal(stored.rows[0].reason.vendorReplyDraft.unitPriceOverride, true);
  assert.equal(Number(stored.rows[0].pallet_last_purchase_price), 5.5);

  const refreshed = await getSmartScmVendorWorkflowForProposal(first.proposalId);
  assert.equal(refreshed.lines[0].lastPurchasePrice, 2.75);
  assert.equal(refreshed.lines[0].unitPriceOverridden, true);
  assert.equal(refreshed.physicalPalletLines[0].lastPurchasePrice, 5.5);
  assert.equal(refreshed.physicalPalletLines[0].unitPriceOverridden, true);

  const itemMaster = await query(
    `SELECT item_id, last_purchase_price FROM inventory_items
      WHERE item_id = ANY($1::bigint[]) ORDER BY item_id`,
    [[itemId, palletItemId]]
  );
  assert.deepEqual(itemMaster.rows.map((row) => Number(row.last_purchase_price)).sort((a, b) => a - b), [1.64, 4.25]);

  const second = await createProposal();
  const unaffected = await getSmartScmVendorWorkflowForProposal(second.proposalId);
  assert.equal(unaffected.lines[0].lastPurchasePrice, 1.64);
  assert.equal(unaffected.lines[0].unitPriceOverridden, false);
  assert.equal(unaffected.physicalPalletLines[0].lastPurchasePrice, 4.25);
  assert.equal(unaffected.physicalPalletLines[0].unitPriceOverridden, false);

  await saveSmartScmVendorReplyLoad(first.proposalId, {
    ...reply(first.lineId, { unitPrice: null }),
    palletUnitPrice: null
  }, actor);
  const reset = await getSmartScmVendorWorkflowForProposal(first.proposalId);
  assert.equal(reset.lines[0].lastPurchasePrice, 1.64);
  assert.equal(reset.lines[0].unitPriceOverridden, false);
  assert.equal(reset.physicalPalletLines[0].lastPurchasePrice, 4.25);
  assert.equal(reset.physicalPalletLines[0].unitPriceOverridden, false);
});

test("invalid price rolls back decisions and both saved price scopes", async () => {
  const load = await createProposal();
  await assert.rejects(
    saveSmartScmVendorReplyLoad(load.proposalId, {
      ...reply(load.lineId, { unitPrice: 0 }),
      palletUnitPrice: 7.25
    }, actor),
    (error) => error?.status === 400 && /greater than zero/i.test(error.message)
  );
  const stored = await query(
    `SELECT proposal.status, proposal.pallet_last_purchase_price,
            line.vendor_decision, line.last_purchase_price, line.reason
       FROM scm_smart_proposals proposal
       JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
      WHERE proposal.id = $1`,
    [load.proposalId]
  );
  assert.equal(stored.rows[0].status, "order_requested");
  assert.equal(stored.rows[0].pallet_last_purchase_price, null);
  assert.equal(stored.rows[0].vendor_decision, null);
  assert.equal(stored.rows[0].last_purchase_price, null);
  assert.deepEqual(stored.rows[0].reason, {});
});

test("confirmation copies edited prices into immutable NetSuite PO review snapshots", async () => {
  const load = await createProposal();
  const staged = await stageSmartScmVendorReplyLoad(load.proposalId, {
    lines: [{
      proposalLineId: load.lineId,
      destinationLocationId: 15,
      decision: "confirm",
      decisionPallets: 2,
      unitPrice: 3.25
    }],
    palletUnitPrice: 6.75
  }, actor);
  assert(staged.reviewProposalId);

  const review = await query(
    `SELECT proposal.pallet_last_purchase_price, line.last_purchase_price,
            line.purchase_unit, line.reason
       FROM scm_smart_proposals proposal
       JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
      WHERE proposal.id = $1`,
    [staged.reviewProposalId]
  );
  assert.equal(Number(review.rows[0].last_purchase_price), 3.25);
  assert.equal(review.rows[0].purchase_unit, "EA");
  assert.equal(review.rows[0].reason.vendorReplyDraft.unitPriceOverride, true);
  assert.equal(Number(review.rows[0].pallet_last_purchase_price), 6.75);

  await query("UPDATE inventory_items SET last_purchase_price = 99 WHERE item_id = ANY($1::bigint[])", [[itemId, palletItemId]]);
  const refreshed = await getSmartScmVendorWorkflowForProposal(load.proposalId);
  assert.equal(refreshed.lines[0].lastPurchasePrice, 3.25);
  assert.equal(refreshed.physicalPalletLines[0].lastPurchasePrice, 6.75);
  assert.equal(refreshed.canEditVendorReply, false);
  await query("UPDATE inventory_items SET last_purchase_price = 4.25 WHERE item_id = $1", [palletItemId]);
});

test("an immutable PO review snapshot never changes when vendor and LPP prices change", async () => {
  const load = await createProposal();
  const staged = await stageSmartScmVendorReplyLoad(load.proposalId, {
    lines: [{
      proposalLineId: load.lineId,
      destinationLocationId: 15,
      decision: "confirm",
      decisionPallets: 2,
      unitPrice: 10.67
    }]
  }, actor);

  await query("UPDATE inventory_items SET last_purchase_price = 88 WHERE item_id = $1", [itemId]);
  await query(
    `INSERT INTO scm_netsuite_vendor_item_codes (
       item_id, vendor_id, subsidiary_id, vendor_code, source, preferred_vendor,
       vendor_price, vendor_price_synced_at, synced_at, updated_at
     ) VALUES ($1,$2,1,$3,'item_vendor',true,12.6,now(),now(),now())
     ON CONFLICT (item_id, vendor_id, subsidiary_id) DO UPDATE SET
       vendor_price = EXCLUDED.vendor_price,
       vendor_price_synced_at = EXCLUDED.vendor_price_synced_at,
       updated_at = EXCLUDED.updated_at`,
    [itemId, vendorId, `IMMUTABLE-${seed}`]
  );

  const reloaded = await getSmartScmVendorWorkflowForProposal(load.proposalId);
  assert.equal(reloaded.displayProposalId, staged.reviewProposalId);
  assert.equal(reloaded.lines[0].lastPurchasePrice, 10.67,
    "A created PO/review must retain the price used at confirmation rather than rewriting history.");
});

test("a real linked PO displays later NetSuite rate changes while retaining its review snapshot", async () => {
  const load = await createProposal();
  const staged = await stageSmartScmVendorReplyLoad(load.proposalId, {
    lines: [{
      proposalLineId: load.lineId,
      destinationLocationId: 15,
      decision: "confirm",
      decisionPallets: 2,
      unitPrice: 10.67
    }],
    palletUnitPrice: 6.75
  }, actor);
  const purchaseOrderId = baseId + 50_000 + proposalSequence;
  const purchaseOrderRef = `PO-WEBHOOK-PRICE-${seed}-${proposalSequence}`;
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       foreign_total, destination_location_id, destination_location,
       netsuite_active, synced_at
     ) VALUES ($1,$2,current_date,$3,$4,'B','Purchase Order : Pending Receipt',
       322.6,15,'12441',true,now())`,
    [purchaseOrderId, purchaseOrderRef, vendorId, `Vendor Price Vendor ${seed}`]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, rate, amount, netsuite_active, netsuite_closed, raw, synced_at
     ) VALUES
       ($1,$2,$3,$4,$4,20,'EA',15,'12441',12.6,252,true,false,'{}'::jsonb,now()),
       ($1,$5,$6,'PALLET','PALLET',2,'EACH',15,'12441',35,70,true,false,'{}'::jsonb,now())`,
    [purchaseOrderId, purchaseOrderId + 1, itemId, `VENDOR-PRICE-ITEM-${seed}`,
      purchaseOrderId + 2, palletItemId]
  );
  await query(
    `UPDATE scm_smart_proposals
        SET status = 'completed', netsuite_purchase_order_id = $2,
            netsuite_purchase_order_ref = $3, updated_at = now()
      WHERE id = $1`,
    [staged.reviewProposalId, purchaseOrderId, purchaseOrderRef]
  );
  await query(
    `UPDATE scm_smart_vendor_workflows
        SET review_proposal_id = $2, workflow_status = 'po_created',
            netsuite_purchase_order_id = $3, netsuite_purchase_order_ref = $4,
            updated_at = now()
      WHERE source_proposal_id = $1`,
    [load.proposalId, staged.reviewProposalId, purchaseOrderId, purchaseOrderRef]
  );

  const first = await getSmartScmVendorWorkflowForProposal(load.proposalId);
  assert.equal(first.lines[0].lastPurchasePrice, 12.6);
  assert.equal(first.lines[0].purchaseAmount, 252);
  assert.equal(first.lines[0].unitPriceSource, "netsuite_po_rate");
  assert.equal(first.lines[0].vendorReplyConfirmedUnitPrice, 10.67);
  assert.equal(first.physicalPalletLines[0].lastPurchasePrice, 35);
  assert.equal(first.physicalPalletLines[0].purchaseAmount, 70);

  await query(
    `UPDATE purchase_order_lines
        SET rate = 13.25, amount = 265, synced_at = now()
      WHERE purchase_order_id = $1 AND item_id = $2`,
    [purchaseOrderId, itemId]
  );
  const later = await getSmartScmVendorWorkflowForProposal(load.proposalId);
  assert.equal(later.lines[0].lastPurchasePrice, 13.25);
  assert.equal(later.lines[0].purchaseAmount, 265);

  const savedReview = await query(
    "SELECT last_purchase_price FROM scm_smart_proposal_lines WHERE proposal_id = $1 AND item_id = $2",
    [staged.reviewProposalId, itemId]
  );
  assert.equal(Number(savedReview.rows[0].last_purchase_price), 10.67,
    "NetSuite display synchronization must not rewrite confirmation evidence.");
});

test("concurrent saves serialize one complete material-and-PALLET price pair", async () => {
  const load = await createProposal();
  await Promise.all([
    saveSmartScmVendorReplyLoad(load.proposalId, {
      ...reply(load.lineId, { unitPrice: 2.1 }),
      palletUnitPrice: 5.1
    }, actor),
    saveSmartScmVendorReplyLoad(load.proposalId, {
      ...reply(load.lineId, { unitPrice: 2.2 }),
      palletUnitPrice: 5.2
    }, actor)
  ]);
  const saved = await query(
    `SELECT line.last_purchase_price AS line_price,
            proposal.pallet_last_purchase_price AS pallet_price
       FROM scm_smart_proposal_lines line
       JOIN scm_smart_proposals proposal ON proposal.id = line.proposal_id
      WHERE proposal.id = $1`,
    [load.proposalId]
  );
  const pair = [Number(saved.rows[0].line_price), Number(saved.rows[0].pallet_price)];
  assert([
    [2.1, 5.1],
    [2.2, 5.2]
  ].some((expected) => expected[0] === pair[0] && expected[1] === pair[1]),
  `concurrent saves must not tear across price scopes; received ${pair.join(" / ")}`);
});

test("zero Item Vendor price falls back to LPP in both display and PO review", async () => {
  const load = await createProposal();
  await query("UPDATE inventory_items SET last_purchase_price = 10.67 WHERE item_id = $1", [itemId]);
  await query(
    `INSERT INTO scm_netsuite_vendor_item_codes (
       item_id, vendor_id, subsidiary_id, vendor_code, source, preferred_vendor,
       vendor_price, vendor_price_synced_at, synced_at, updated_at
     ) VALUES ($1,$2,1,$3,'item_vendor',true,0,now(),now(),now())
     ON CONFLICT (item_id, vendor_id, subsidiary_id) DO UPDATE SET
       vendor_code = EXCLUDED.vendor_code,
       source = EXCLUDED.source,
       preferred_vendor = EXCLUDED.preferred_vendor,
       vendor_price = EXCLUDED.vendor_price,
       vendor_price_synced_at = EXCLUDED.vendor_price_synced_at,
       synced_at = EXCLUDED.synced_at,
       updated_at = EXCLUDED.updated_at`,
    [itemId, vendorId, `VENDOR-ZERO-${seed}`]
  );

  const displayed = await getSmartScmVendorWorkflowForProposal(load.proposalId);
  assert.equal(displayed.lines[0].lastPurchasePrice, 10.67);
  assert.equal(displayed.lines[0].unitPriceSource, "last_purchase_price");
  const displayedPalletPrice = displayed.physicalPalletLines[0]?.lastPurchasePrice ?? null;

  const staged = await stageSmartScmVendorReplyLoad(load.proposalId, {
    lines: [{
      proposalLineId: load.lineId,
      destinationLocationId: 15,
      decision: "confirm",
      decisionPallets: 2
    }]
  }, actor);
  const review = await query(
    `SELECT last_purchase_price, reason
       FROM scm_smart_proposal_lines
      WHERE proposal_id = $1 AND item_id = $2`,
    [staged.reviewProposalId, itemId]
  );
  assert.equal(Number(review.rows[0].last_purchase_price), 10.67);
  assert.equal(review.rows[0].reason.vendorReplyPriceSnapshot.source, "last_purchase_price");
  if (displayedPalletPrice !== null) {
    const reviewPallet = await query(
      "SELECT pallet_last_purchase_price FROM scm_smart_proposals WHERE id = $1",
      [staged.reviewProposalId]
    );
    assert.equal(Number(reviewPallet.rows[0].pallet_last_purchase_price), displayedPalletPrice,
      "PALLET must use the same vendor-price/LPP selection and snapshot rule as material lines.");
  }
});

test("positive Item Vendor price is displayed and snapshotted into PO review without a manual edit", async () => {
  const load = await createProposal();
  await query(
    `INSERT INTO scm_netsuite_vendor_item_codes (
       item_id, vendor_id, subsidiary_id, vendor_code, source, preferred_vendor,
       vendor_price, vendor_price_synced_at, synced_at, updated_at
     ) VALUES ($1,$2,1,$3,'item_vendor',true,12.6,now(),now(),now())
     ON CONFLICT (item_id, vendor_id, subsidiary_id) DO UPDATE SET
       vendor_code = EXCLUDED.vendor_code,
       source = EXCLUDED.source,
       preferred_vendor = EXCLUDED.preferred_vendor,
       vendor_price = EXCLUDED.vendor_price,
       vendor_price_synced_at = EXCLUDED.vendor_price_synced_at,
       synced_at = EXCLUDED.synced_at,
       updated_at = EXCLUDED.updated_at`,
    [itemId, vendorId, `VENDOR-PRICE-${seed}`]
  );

  const displayed = await getSmartScmVendorWorkflowForProposal(load.proposalId);
  assert.equal(displayed.lines[0].lastPurchasePrice, 12.6);
  assert.equal(displayed.lines[0].unitPriceSource, "vendor_price");
  assert.equal(displayed.lines[0].unitPriceOverridden, false);

  const staged = await stageSmartScmVendorReplyLoad(load.proposalId, {
    lines: [{
      proposalLineId: load.lineId,
      destinationLocationId: 15,
      decision: "confirm",
      decisionPallets: 2
    }]
  }, actor);
  const review = await query(
    `SELECT last_purchase_price, reason
       FROM scm_smart_proposal_lines
      WHERE proposal_id = $1 AND item_id = $2`,
    [staged.reviewProposalId, itemId]
  );
  assert.equal(Number(review.rows[0].last_purchase_price), 12.6,
    "The real PO review must retain vendor price; this cannot be a display-only fix.");
  assert.equal(review.rows[0].reason.vendorReplyPriceSnapshot.source, "vendor_price");
  const reloadedReview = await getSmartScmVendorWorkflowForProposal(load.proposalId);
  assert.equal(reloadedReview.lines[0].lastPurchasePrice, 12.6);
  assert.equal(reloadedReview.lines[0].unitPriceSource, "vendor_price");
});
