import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { processNetSuiteOrderWebhook } from "../../../src/server.js";
import { buildExecutedOrderReviews, executedSourceDigest } from "../../../src/dispatch-executed-order-review.js";
import { evaluateDispatchReviewedPrefix, getDispatchExecutedOrderReviews, publicExecutedOrderReview } from "../../../src/dispatch-executed-order-review-repository.js";

let fixture;
let counter = 0;
before(async () => { fixture = await createDispatchV2Fixture(); });
after(async () => { await fixture?.close(); });

const currentLines = [
  [5034898, "PER-EKO70S-RDM-GN", 1286.58, "SQFT", 35.19, true],
  [5035347, "PER-EKO70S-0714-SB", 115.06, "SQFT", 33, true],
  [5036040, "Alliance Supersand Grey", 25, "EACH", 50, true]
];
const oldLines = [
  [5034895, "PER-RB-STD-GN", 50, "PC", 45, false],
  [5034896, "PER-RB-COP-SB", 11, "PC", 65.56, false],
  [5034897, "Alliance Supersand Grey", 1, "EACH", 50, false],
  [5034899, "Aggregate-Screening", 0.675, "Yard", 1350, false],
  [5034900, "PALLET", 1, "EACH", 40, false]
];
const lookup = (ref, options = {}) => listDispatchOrders({ exactOrderRefs: [ref], includeHiddenScm: true,
  includeFulfilledSalesDeliveries: true, ...options });

async function seed() {
  const n = ++counter;
  const id = 9928500 + n;
  const ref = `SO-ACTIVE-REVIEW-${n}`;
  const groupRef = `GOA-ACTIVE-REVIEW-${n}`;
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,sales_order_type,outbound_location_id,
    outbound_location,netsuite_active,dispatch_address)
    VALUES ($1,$2,'B','Sales Order : Pending Fulfillment','Delivery',1,'3445',true,'Recorded delivery address')`, [id, ref]);
  for (const [lineId, sku, quantity, unit, weight, active] of [...currentLines, ...oldLines]) {
    await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,quantity,unit,item_weight,netsuite_active)
      VALUES ($1,$2,$2,$3,$3,$4,$5,$6,$7)`, [id, lineId, sku, quantity, unit, weight, active]);
  }
  const [source] = await listDispatchOrders({ exactOrderRefs: [ref], includeHiddenScm: true });
  assert.equal(source.items.length, 3);
  assert.equal(source.salesQty, 1426.64);
  assert.equal(source.weight, 50321.73);
  const plan = await fixture.seedPlan({ date: `2095-09-${String(n + 1).padStart(2, "0")}`, refs: [groupRef] });
  const group = { ...source, id: groupRef, childOrders: [ref], childOrderDetails: [source] };
  const trucks = [{ id: "T-ACTIVE-REVIEW", plate: "BL27129", loads: [{ id: `active-review-load-${n}`, name: "Load 2",
    driverLogin: "aurther", driverName: "Aurther", truckId: "T-ACTIVE-REVIEW", truckPlate: "BL27129",
    stops: [{ id: `active-review-stop-${n}`, type: "pick", orderId: groupRef }] }] }];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1",
    [plan.id, JSON.stringify([group]), JSON.stringify(trucks)]);
  await query(`INSERT INTO driver_job_records (job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,
    stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
    VALUES ($1,$2,$3,'aurther','T-ACTIVE-REVIEW','BL27129',$4,$5,'pick',$6::jsonb,'complete',now(),now(),$7::jsonb)`,
    [`active-review-job-${n}`, plan.id, plan.plan_date, trucks[0].loads[0].id, trucks[0].loads[0].stops[0].id,
      JSON.stringify([groupRef]), JSON.stringify({ photoIds: ["retained-photo"], address: source.address })]);
  const activity = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [plan.id])).rows;
  return { id, ref, groupRef, source, activity, plan: { ...plan, orders: [group], trucks } };
}

test("SOA09413 regression: inactive historical lines do not create an executed group review", async () => {
  const f = await seed();
  const beforeLines = (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY line_id", [f.id])).rows;
  assert.deepEqual(await getDispatchExecutedOrderReviews(f.plan.id), []);
  assert.equal((await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rowCount, 0);
  assert.deepEqual((await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY line_id", [f.id])).rows, beforeLines);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.activity);
});

test("current-source lookup excludes historical lines with both history switches enabled", async () => {
  const f = await seed();
  const [current] = await lookup(f.ref, { search: f.ref, includeInactiveSalesOrderSearchCandidates: true,
    includeInactiveSalesOrderLines: false });
  assert.deepEqual(current.items.map(item => item.lineId), currentLines.map(line => line[0]));
  assert.equal(current.salesQty, 1426.64);
  assert.equal(current.weight, 50321.73);
  const [historical] = await lookup(f.ref);
  assert.equal(historical.items.length, 8, "existing historical lookup remains available");
  assert.equal(historical.salesQty, 1490.315);
  assert.equal(historical.weight, 54294.14);
});

test("real SO addition, removal and quantity change are reviewed without resurrecting historical lines", async () => {
  const f = await seed();
  await query("UPDATE sales_order_lines SET netsuite_active=false WHERE sales_order_id=$1 AND line_id=5035347", [f.id]);
  await query("UPDATE sales_order_lines SET quantity=26 WHERE sales_order_id=$1 AND line_id=5036040", [f.id]);
  await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,quantity,unit,item_weight,netsuite_active)
    VALUES ($1,5037001,599,'New active cargo','NEW-ACTIVE',2,'EACH',50,true)`, [f.id]);
  const [review] = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(review.groupRef, f.groupRef);
  assert.deepEqual(review.changes.filter(change => change.field === "item_added").map(change => change.lineId), ["5037001"]);
  assert.deepEqual(review.changes.filter(change => change.field === "item_removed").map(change => change.lineId), ["5035347"]);
  assert.ok(review.changes.some(change => change.lineId === "5036040" && change.field === "quantity" && change.before === 25 && change.after === 26));
  assert.equal((await getDispatchExecutedOrderReviews(f.plan.id))[0].token, review.token);
});

for (const acknowledged of [false, true]) {
  test(`old false ${acknowledged ? "acknowledged" : "pending"} observation is hidden without deleting its evidence`, async () => {
    const f = await seed();
    const [oldSource] = await lookup(f.ref);
    const [review] = buildExecutedOrderReviews({ previousPlan: f.plan, activity: f.activity, sourceOrders: [oldSource] });
    assert.equal(review.changes.filter(change => change.field === "item_added").length, 5);
    const publicReview = publicExecutedOrderReview(review);
    await query(`INSERT INTO dispatch_executed_order_reviews (plan_id,token,order_ref,source_digest,review,changes,acknowledged_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,CASE WHEN $7 THEN now() ELSE NULL END)`,
      [f.plan.id, review.token, f.ref, executedSourceDigest(oldSource), JSON.stringify(publicReview), JSON.stringify(publicReview.changes), acknowledged]);
    const beforeReviews = (await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rows;
    assert.deepEqual(await getDispatchExecutedOrderReviews(f.plan.id), []);
    assert.deepEqual((await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rows, beforeReviews);
  });
}

test("planned source update requests re-planning before driver activity begins and remains informational", async () => {
  const f = await seed();
  await query("DELETE FROM driver_job_records WHERE plan_id=$1", [f.plan.id]);
  assert.deepEqual(await getDispatchExecutedOrderReviews(f.plan.id), []);
  await query("UPDATE sales_order_lines SET quantity=26 WHERE sales_order_id=$1 AND line_id=5036040", [f.id]);
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(reviews.length, 1, "a planned order needs notice before execution too");
  assert.equal(reviews[0].replanRequested, true);
  assert.equal(reviews[0].groupRef, f.groupRef);
  assert.deepEqual(reviews[0].changes.filter(change => change.field === "item_added"), []);
  assert.equal((await getDispatchExecutedOrderReviews(f.plan.id))[0].token, reviews[0].token);
  const [fresh] = await lookup(f.ref, { includeInactiveSalesOrderLines: false });
  const next = structuredClone(f.plan);
  next.orders[0] = { ...next.orders[0], items: fresh.items, childOrderDetails: [fresh] };
  assert.equal((await evaluateDispatchReviewedPrefix({ previousPlan: f.plan, nextPlan: next })).allowed, true);
  assert.equal(next.orders[0].childOrderDetails[0].items.find(item => item.lineId === 5036040).quantity, 26,
    "a source update to unexecuted work must not be restored to old execution data");
});

test("unassigned order changes do not request re-planning", async () => {
  const f = await seed();
  await query("DELETE FROM driver_job_records WHERE plan_id=$1", [f.plan.id]);
  await query("UPDATE dispatch_plan_snapshots SET trucks='[]'::jsonb WHERE plan_id=$1", [f.plan.id]);
  await query("UPDATE sales_order_lines SET quantity=26 WHERE sales_order_id=$1 AND line_id=5036040", [f.id]);
  assert.deepEqual(await getDispatchExecutedOrderReviews(f.plan.id), []);
});

test("a later unexecuted stop requests re-planning while fully recorded work remains a notice", async () => {
  const f = await seed();
  await query("UPDATE sales_order_lines SET quantity=26 WHERE sales_order_id=$1 AND line_id=5036040", [f.id]);
  const [recorded] = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(recorded.replanRequested, false);
  const trucks = structuredClone(f.plan.trucks);
  trucks[0].loads[0].stops.push({ id: "remaining-drop", type: "drop", orderId: f.groupRef });
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.plan.id, JSON.stringify(trucks)]);
  const [remaining] = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(remaining.replanRequested, true);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.activity);
});

test("a pending notice does not block subsequent real webhook updates", async () => {
  const f = await seed();
  await query("UPDATE sales_order_lines SET quantity=26 WHERE sales_order_id=$1 AND line_id=5036040", [f.id]);
  const [pending] = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(pending.acknowledged, false);
  const result = await processNetSuiteOrderWebhook({ id: f.id, recordType: "salesorder", eventType: "edit", tranid: f.ref,
    status: "B", statusText: "Sales Order : Pending Fulfillment", locationId: 1, locationText: "3445",
    entityId: 1, entityText: "Test", deliveryMethodId: 2, deliveryMethodText: "Delivery",
    lines: currentLines.map(([lineUniqueKey, sku, quantity, unit, itemWeight]) => ({ lineUniqueKey, itemId: lineUniqueKey,
      itemName: sku, sku, quantity: lineUniqueKey === 5036040 ? 27 : quantity, unit, itemWeight, itemType: "InvtPart", locationId: 1 }))
  }, { scheduleDelayedStatus: false, emitEvents: false });
  assert.equal(result.ok, true);
  assert.equal(Number((await query("SELECT quantity FROM sales_order_lines WHERE sales_order_id=$1 AND line_id=5036040", [f.id])).rows[0].quantity), 27);
  const reviews = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].acknowledged, false);
  assert.notEqual(reviews[0].token, pending.token);
  assert.ok(reviews[0].changes.some(change => change.lineId === "5036040" && change.field === "quantity" && change.after === 27));
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [f.plan.id])).rows, f.activity);
});
