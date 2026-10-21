// @ts-check
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { prepareSalesOrderAutoFulfillmentCandidate } from "../../../src/sales-order-auto-fulfillment-repository.js";
import { buildSalesOrderItemFulfillmentPayload, resolveSalesOrderFulfillmentLines } from "../../../src/sales-order-auto-fulfillment-domain.js";

after(closeDb);

async function inRollback(work) {
  const context = await beginRollbackContext();
  try {
    return await context.run(work);
  } finally {
    await context.rollback();
  }
}

async function seedDriverJobs({ kind, missingPickup, differentLoad, pickupJob, dropJob,
  planId, loadId, splitRef, supplyRef }) {
  if (!missingPickup) {
    await query(`INSERT INTO driver_job_records
      (job_id,plan_id,plan_date,driver_login,truck_plate,load_id,load_name,stop_id,stop_type,
        order_refs,status,completed_at,job_details)
      VALUES ($1,$2,current_date,'split-fixture','FIXTURE',$3,'Load 1','pickup','pickup',
        $4::jsonb,'complete',now(),$5::jsonb)`,
    [pickupJob, planId, differentLoad ? `OTHER-${loadId}` : loadId,
      JSON.stringify([kind === "po" ? splitRef : supplyRef]),
      JSON.stringify(kind === "po"
        ? { pickupLocation: "Split fixture supplier", location: "Split fixture supplier" }
        : { orders: [{ source: "direct_dependency", orderRef: supplyRef }] })]);
  }
  await query(`INSERT INTO driver_job_records
    (job_id,plan_id,plan_date,driver_login,truck_plate,load_id,load_name,stop_id,stop_type,
      order_refs,status,completed_at,job_details)
    VALUES ($1,$2,current_date,'split-fixture','FIXTURE',$3,'Load 1','drop','dropoff',
      $4::jsonb,'complete',now(),$5::jsonb)`,
  [dropJob, planId, loadId, JSON.stringify([splitRef]),
    JSON.stringify({ orders: [{ orderType: "SO", orderRef: splitRef }],
      location: "Fixture customer", dropLocation: "Fixture customer" })]);
}

async function seed({ kind = "po", owner = "split", quantity = 947.73, differentLoad,
  missingPickup, differentDrop } = {}) {
  const token = crypto.randomUUID().slice(0, 8).toUpperCase();
  const parentId = 9_870_000_000 + crypto.randomInt(1_000_000);
  const splitId = -parentId;
  const siblingId = -parentId - 1;
  const parentRef = `SO-IF-EVIDENCE-${token}`;
  const splitRef = `${parentRef}-S1`;
  const siblingRef = `${parentRef}-S2`;
  const planId = parentId;
  const loadId = `LOAD-${token}`;
  const pickupJob = `PICK-${token}`;
  const dropJob = `DROP-${token}`;
  const supplyId = parentId + 2;
  const supplyRef = `${kind.toUpperCase()}-IF-EVIDENCE-${token}`;
  await query(`UPDATE mbt_feature_flags SET enabled=true,revision=revision+1,
    updated_by='split-if-regression',updated_at=now()
    WHERE flag_key='dispatch_netsuite_sales_order_if_2967'`);
  for (const [id, ref] of [[parentId, parentRef], [splitId, splitRef], [siblingId, siblingRef]]) {
    await query(`INSERT INTO sales_orders (netsuite_id,tranid,trandate,customer,status,status_text,
      outbound_location_id,outbound_location,sales_order_type,operator_status,local_yard_order_status,
      fulfillment_status,netsuite_active,is_test_fixture)
      VALUES ($1,$2,current_date,'Split evidence fixture','B','Pending Fulfillment',
      28,'2967','Delivery','open','Open','not_fulfilled',true,false)`, [id, ref]);
  }
  const parentLine = (await query(`INSERT INTO sales_order_lines
    (sales_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,
      quantity,unit,location_id,loaded_qty,netsuite_active)
    VALUES ($1,5100029,1,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',
      $2,'SQFT',28,0,true) RETURNING id`, [parentId, quantity * 2])).rows[0].id;
  const splitLine = -Number(parentLine);
  const siblingLine = splitLine - 1_000_000_000;
  for (const [id, orderId] of [[splitLine, splitId], [siblingLine, siblingId]]) {
    await query(`INSERT INTO sales_order_lines
      (id,sales_order_id,line_id,netsuite_order_line,item_id,item_name,sku,item_type,
        quantity,unit,location_id,loaded_qty,netsuite_active)
      VALUES ($1,$2,5100029,1,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',
        $3,'SQFT',28,0,true)`, [id, orderId, quantity]);
  }
  for (const [id, ref] of [[splitId, splitRef], [siblingId, siblingRef]]) {
    await query(`INSERT INTO dispatch_scm_so_splits
      (source_so_id,source_so_ref,split_so_id,split_so_ref,status,created_by)
      VALUES ($1,$2,$3,$4,'active','split-if-regression')`, [parentId, parentRef, id, ref]);
  }
  await query(`INSERT INTO dispatch_plans (id,plan_date,status,note,revision)
    VALUES ($1,current_date,'confirmed','Split evidence fixture',1)`, [planId]);
  const evidenceLine = owner === "parent" ? parentLine : owner === "sibling" ? siblingLine : splitLine;
  let supplyEvidenceId;
  if (kind === "po") {
    await query(`INSERT INTO purchase_orders (netsuite_id,tranid,trandate,vendor,status,status_text,
      destination_location_id,destination_location,receipt_status,netsuite_active)
      VALUES ($1,$2,current_date,'Split supplier','B','Pending Receipt',28,'2967','open',true)`,
    [supplyId, supplyRef]);
    const poLine = (await query(`INSERT INTO purchase_order_lines (purchase_order_id,line_id,
      item_id,item_name,sku,item_type,quantity,unit,location_id,netsuite_active)
      VALUES ($1,661001,2055,'MBBS-Special Order','MBBS-Special Order','NonInvtPart',$2,'SQFT',28,true)
      RETURNING id`, [supplyId, quantity])).rows[0].id;
    supplyEvidenceId = (await query(`INSERT INTO dispatch_so_po_allocations
      (sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,
        item_id,item_name,sku,allocated_sales_qty,status,details,
        dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key)
      VALUES ($1,$2,$3,$4,$5,$6,2055,'MBBS-Special Order','MBBS-Special Order',$7,
        'active',$8::jsonb,$9,'group',$10) RETURNING id`,
    [splitId, splitRef, evidenceLine, supplyId, supplyRef, poLine, quantity,
      JSON.stringify({ poVendorYard: "Split fixture supplier", poAddress: "1 Supplier Road" }),
      `GOA-${token}`, `GOA-${token}::${splitRef}::${evidenceLine}`])).rows[0].id;
  } else {
    await query(`INSERT INTO transfer_orders (netsuite_id,tranid,trandate,status,status_text,
      from_location_id,from_location,to_location_id,to_location,outbound_operator_status,
      local_yard_order_status,fulfillment_status,netsuite_active)
      VALUES ($1,$2,current_date,'B','Pending Fulfillment',15,'12441',28,'2967',
      'open','Open','not_fulfilled',true)`, [supplyId, supplyRef]);
    supplyEvidenceId = (await query(`INSERT INTO order_dependencies
      (sales_order_id,sales_order_ref,transfer_order_id,transfer_order_ref,dependency_mode,
        same_load_required,status,source_location_id,source_location,
        accounting_destination_location_id,accounting_destination_location,planned_plan_id,
        planned_date,planned_load_id,planned_load_name,direct_receipt_job_id,direct_received_at,
        dispatch_target_ref,dispatch_target_kind)
      VALUES ($1,$2,$3,$4,'direct_to_customer',true,'received_local',15,'12441',28,'2967',
        $5,current_date,$6,'Load 1',$7,now(),$2,'split') RETURNING id`,
    [splitId, splitRef, supplyId, supplyRef, planId, loadId, differentDrop ? `OTHER-${token}` : dropJob])).rows[0].id;
    await query(`INSERT INTO order_dependency_lines
      (dependency_id,sales_line_id,item_id,item_name,unit,allocated_quantity,line_role,dispatch_target_line_key)
      VALUES ($1,$2,2055,'MBBS-Special Order','SQFT',$3,'sales_allocation',$4)`,
    [supplyEvidenceId, evidenceLine, quantity, `${splitRef}::${splitRef}::${evidenceLine}`]);
  }
  await seedDriverJobs({ kind, missingPickup, differentLoad, pickupJob, dropJob,
    planId, loadId, splitRef, supplyRef });
  const candidates = (await query(`SELECT id FROM dispatch_sales_order_if_candidates
    WHERE dispatch_order_ref=$1`, [splitRef])).rows;
  assert.equal(candidates.length, 1, "a real driver completion must enqueue exactly one candidate");
  return { candidateId: candidates[0].id, parentId, parentLine, splitLine,
    splitRef, siblingLine, quantity, pickupJob, dropJob, supplyEvidenceId };
}

for (const kind of ["po", "to"]) {
  test(`materialized split uses its own ${kind.toUpperCase()} execution evidence and retains NetSuite lineage`, async () => {
    await inRollback(async () => {
      const fixture = await seed({ kind });
      const prepared = await prepareSalesOrderAutoFulfillmentCandidate(fixture.candidateId);
      assert.equal(prepared.status, "queued", prepared.lastError);
      assert.equal(prepared.sourceSalesOrderId, fixture.parentId);
      assert.equal(prepared.lineSnapshot.length, 1);
      const line = prepared.lineSnapshot[0];
      assert.equal(line.localLineId, String(fixture.splitLine));
      assert.equal(line.sourceLineId, String(fixture.parentLine));
      assert.equal(line.orderLine, 1);
      assert.equal(line.deliveredQuantity, fixture.quantity);
      assert.equal(line.operatorLoadedQuantity, 0, "supplier delivery requires no yard load");
      const evidence = kind === "po" ? line.poEvidence : line.toEvidence;
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].pickupJobId, fixture.pickupJob);
      assert.equal(evidence[0].deliveryJobId, fixture.dropJob);
      const liveLines = [
        { orderLine: 1, itemId: 2055, remainingQuantity: fixture.quantity * 2,
          fulfilledQuantity: 0, location: 28 },
        { orderLine: 5, itemId: 599, remainingQuantity: 10, fulfilledQuantity: 0, location: 28 }
      ];
      const selected = resolveSalesOrderFulfillmentLines({
        action: "snapshot", snapshotLines: prepared.lineSnapshot, liveLines
      });
      const payload = buildSalesOrderItemFulfillmentPayload({
        selectedLines: selected, availableLines: liveLines, externalId: prepared.externalId
      });
      assert.deepEqual(payload.item.items.filter(item => item.itemReceive)
        .map(item => ({ orderLine: item.orderLine, quantity: item.quantity })),
      [{ orderLine: 1, quantity: fixture.quantity }]);
      assert.equal(payload.item.items.find(item => item.orderLine === 5).itemReceive, false);
      const repeated = await prepareSalesOrderAutoFulfillmentCandidate(fixture.candidateId);
      assert.equal(repeated.snapshotHash, prepared.snapshotHash);
      assert.equal(repeated.externalId, prepared.externalId);
      const claims = (await query(`SELECT source_line_id,claimed_quantity
        FROM dispatch_sales_order_if_line_claims WHERE candidate_id=$1 AND active`,
      [fixture.candidateId])).rows;
      assert.equal(claims.length, 1);
      assert.equal(String(claims[0].source_line_id), String(fixture.parentLine));
      assert.equal(Number(claims[0].claimed_quantity), fixture.quantity);
    });
  });
  for (const owner of ["parent", "sibling"]) {
    test(`${kind.toUpperCase()} evidence on the ${owner} cannot satisfy a materialized split`, async () => {
      await inRollback(async () => {
        const fixture = await seed({ kind, owner });
        const prepared = await prepareSalesOrderAutoFulfillmentCandidate(fixture.candidateId);
        assert.equal(prepared.status, "waiting_evidence");
        assert.equal(prepared.lineSnapshot.length, 0);
        assert.equal(prepared.attemptCount, 0);
      });
    });
  }
  for (const invalid of ["missingPickup", "differentLoad", ...(kind === "to" ? ["differentDrop"] : [])]) {
    test(`${kind.toUpperCase()} split remains blocked for ${invalid}`, async () => {
      await inRollback(async () => {
        const fixture = await seed({ kind, [invalid]: true });
        const prepared = await prepareSalesOrderAutoFulfillmentCandidate(fixture.candidateId);
        assert.equal(prepared.status, "waiting_evidence");
        assert.equal(prepared.attemptCount, 0);
      });
    });
  }
}

test("split quantity conservation holds across integral and fractional supplier quantities", async () => {
  for (const quantity of [0.01, 1, 11, 135, 947.73, 10000.125]) {
    await inRollback(async () => {
      const fixture = await seed({ quantity });
      const candidate = await prepareSalesOrderAutoFulfillmentCandidate(fixture.candidateId);
      assert.equal(candidate.status, "queued", `quantity ${quantity}: ${candidate.lastError}`);
      assert.equal(candidate.lineSnapshot[0].deliveredQuantity, quantity);
      assert.equal(candidate.lineSnapshot[0].completedPoQuantity, quantity);
      assert.equal(candidate.lineSnapshot[0].targetQuantity, quantity);
    });
  }
});

test("supplier quantity and split ownership property", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("po", "to"),
    fc.integer({ min: 1, max: 10_000_000 }),
    async (kind, thousandths) => {
      await inRollback(async () => {
        const fixture = await seed({ kind, quantity: thousandths / 1000 });
        const candidate = await prepareSalesOrderAutoFulfillmentCandidate(fixture.candidateId);
        assert.equal(candidate.status, "queued", candidate.lastError);
        assert.equal(candidate.lineSnapshot[0].deliveredQuantity, thousandths / 1000);
        assert.equal(candidate.lineSnapshot[0].localLineId, String(fixture.splitLine));
        assert.equal(candidate.lineSnapshot[0].sourceLineId, String(fixture.parentLine));
      });
    }
  ), { seed: 20261020, numRuns: 16, endOnFailure: true });
});
