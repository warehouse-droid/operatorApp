import test, { before as beforeAll, after } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { buildPlannedOrderReviews, buildExecutedOrderReviews, executedSourceDigest } from "../../../src/dispatch-executed-order-review.js";
import { getDispatchExecutedOrderReviews, evaluateDispatchReviewedPrefix, publicExecutedOrderReview } from "../../../src/dispatch-executed-order-review-repository.js";

let fixture;
let counter = 0;
beforeAll(async () => { fixture = await createDispatchV2Fixture(); });
after(async () => { await fixture?.close(); });

async function seed() {
  const n = ++counter;
  const id = 9939500 + n;
  const ref = `SO-WEIGHT-REVIEW-${n}`;
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,sales_order_type,outbound_location_id,
    outbound_location,netsuite_active,dispatch_address)
    VALUES ($1,$2,'B','Sales Order : Pending Fulfillment','Delivery',1,'3445',true,'Recorded delivery address')`, [id, ref]);
  await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,quantity,unit,item_weight,netsuite_active)
    VALUES ($1,7,77,'CARGO','CARGO',10,'PC',20,true)`, [id]);
  const [source] = await listDispatchOrders({ exactOrderRefs: [ref], includeHiddenScm: true });
  const saved = await fixture.seedPlan({ date: `2096-09-${String(n + 1).padStart(2, "0")}`, refs: [ref] });
  const plan = { ...saved, orders: [source], trucks: [{ id: "T-WEIGHT", plate: "TEST", loads: [{
    id: `weight-load-${n}`, driverLogin: "test", truckId: "T-WEIGHT", truckPlate: "TEST",
    stops: [{ id: `weight-pick-${n}`, type: "pick", orderId: ref }, { id: `weight-drop-${n}`, type: "drop", orderId: ref }]
  }] }] };
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1",
    [plan.id, JSON.stringify(plan.orders), JSON.stringify(plan.trucks)]);
  return { id, ref, source, plan };
}

test("all weight-only changes are silent across execution stages, including SN1400072 rounding", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 10000000 }), fc.integer({ min: 1, max: 1000000 }),
    fc.constantFrom("planned", "picked", "delivered"), (weight, delta, stage) => {
      const before = { id: "SN1400072", weight: weight / 10000, items: [{ lineId: 7, quantity: 26, unit: "EACH" }] };
      const source = { ...before, weight: (weight + delta) / 10000 };
      const plan = { id: 340, orders: [before], trucks: [{ loads: [{ id: "l1", stops: [
        { id: "p", type: "pick", orderId: before.id }, { id: "d", type: "drop", orderId: before.id }
      ] }] }] };
      const activity = stage === "planned" ? [] : [{ status: "complete", load_id: "l1",
        stop_id: stage === "picked" ? "p" : "d", stop_type: stage === "picked" ? "pick" : "drop" }];
      const input = { previousPlan: plan, sourceOrders: [source], activity };
      const original = structuredClone(input);
      assert.deepEqual(buildPlannedOrderReviews(input), []);
      before.weight = 77531.9376; source.weight = 77531.938;
      assert.deepEqual(buildPlannedOrderReviews(input), []);
      before.weight = original.previousPlan.orders[0].weight; source.weight = original.sourceOrders[0].weight;
      assert.deepEqual(input, original);
      source.items = [{ ...before.items[0], quantity: 27 }];
      const [notice] = buildPlannedOrderReviews(input);
      assert.deepEqual(notice.changes.map(change => change.field), ["quantity"]);
      assert.equal(notice.replanRequested, stage !== "delivered");
    }), { seed: 28092026, numRuns: 80 });
});

for (const acknowledged of [false, true]) {
  test(`legacy ${acknowledged ? "acknowledged" : "pending"} weight-only notice is hidden with its evidence retained`, async () => {
    const f = await seed();
    const before = structuredClone(f.plan);
    before.orders[0].weight = 199.9996;
    await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1", [f.plan.id, JSON.stringify(before.orders)]);
    const load = before.trucks[0].loads[0];
    const [review] = buildExecutedOrderReviews({ previousPlan: before, sourceOrders: [f.source],
      activity: [{ status: "complete", load_id: load.id, stop_id: load.stops[1].id, stop_type: "drop" }] });
    const legacy = publicExecutedOrderReview(review);
    assert.equal(legacy.changes[0].field, "weight");
    await query(`INSERT INTO dispatch_executed_order_reviews (plan_id,token,order_ref,source_digest,review,changes,acknowledged_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,CASE WHEN $7 THEN now() ELSE NULL END)`,
    [f.plan.id, review.token, f.ref, executedSourceDigest(f.source), JSON.stringify(legacy), JSON.stringify(legacy.changes), acknowledged]);
    const ledger = (await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rows;
    assert.deepEqual(await getDispatchExecutedOrderReviews(f.plan.id), []);
    assert.deepEqual((await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rows, ledger);
  });
}

for (const acknowledged of [false, true]) {
  test(`weight changes preserve a genuine ${acknowledged ? "acknowledged" : "pending"} notice until cargo changes again`, async () => {
    const f = await seed();
    await query("UPDATE sales_order_lines SET quantity=11 WHERE sales_order_id=$1", [f.id]);
    const [first] = await getDispatchExecutedOrderReviews(f.plan.id);
    assert.deepEqual(first.changes.map(change => change.field).sort(), ["quantity", "salesQty"]);
    if (acknowledged) {
      await query("UPDATE dispatch_executed_order_reviews SET acknowledged_at=now() WHERE plan_id=$1", [f.plan.id]);
    }
    await query("UPDATE sales_order_lines SET item_weight=30 WHERE sales_order_id=$1", [f.id]);
    const [next] = await getDispatchExecutedOrderReviews(f.plan.id);
    assert.equal(next.token, first.token);
    assert.equal(next.acknowledged, acknowledged);
    assert.equal(next.replanRequested, true);
    assert.equal((await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rowCount, 1);
    await query("UPDATE sales_order_lines SET quantity=12 WHERE sales_order_id=$1", [f.id]);
    const changed = await getDispatchExecutedOrderReviews(f.plan.id);
    assert.equal(changed.length, 1);
    assert.notEqual(changed[0].token, first.token);
    assert.equal(changed[0].acknowledged, false);
  });
}

test("legacy mixed weight and cargo acknowledgement survives a later weight update", async () => {
  const f = await seed();
  await query("UPDATE sales_order_lines SET quantity=11 WHERE sales_order_id=$1", [f.id]);
  const [source] = await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true });
  const load = f.plan.trucks[0].loads[0];
  const [review] = buildExecutedOrderReviews({ previousPlan: f.plan, sourceOrders: [source],
    activity: [{ status: "complete", load_id: load.id, stop_id: load.stops[1].id, stop_type: "drop" }] });
  const legacy = publicExecutedOrderReview(review);
  assert.ok(legacy.changes.some(change => change.field === "weight"));
  await query(`INSERT INTO dispatch_executed_order_reviews (plan_id,token,order_ref,source_digest,review,changes,acknowledged_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,now())`,
  [f.plan.id, review.token, f.ref, executedSourceDigest(source), JSON.stringify(legacy), JSON.stringify(legacy.changes)]);
  await query("UPDATE sales_order_lines SET item_weight=30 WHERE sales_order_id=$1", [f.id]);
  const [notice] = await getDispatchExecutedOrderReviews(f.plan.id);
  assert.equal(notice.acknowledged, true);
  assert.equal(notice.token, review.token);
  assert.ok(notice.changes.every(change => change.field !== "weight"));
  assert.equal((await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rowCount, 1);
});

test("weight updates process without review and continue to pass the executed-prefix save check", async () => {
  const f = await seed();
  const load = f.plan.trucks[0].loads[0];
  const activity = [{ status: "complete", load_id: load.id, stop_id: load.stops[1].id, stop_type: "drop" }];
  await query("UPDATE sales_order_lines SET item_weight=30 WHERE sales_order_id=$1", [f.id]);
  const [source] = await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true });
  assert.equal(source.weight, 300);
  const nextPlan = structuredClone(f.plan);
  nextPlan.orders = [source];
  assert.equal((await evaluateDispatchReviewedPrefix({ previousPlan: f.plan, nextPlan, activity })).allowed, true);
  assert.deepEqual(await getDispatchExecutedOrderReviews(f.plan.id), []);
  assert.equal((await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1", [f.plan.id])).rowCount, 0);
  assert.equal((await query("SELECT item_weight FROM sales_order_lines WHERE sales_order_id=$1", [f.id])).rows[0].item_weight, "30");
});
