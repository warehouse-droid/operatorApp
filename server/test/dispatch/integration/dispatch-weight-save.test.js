import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { getDispatchExecutedOrderReviews } from "../../../src/dispatch-executed-order-review-repository.js";

let fixture;
let counter = 0;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks(id,plate,active) VALUES(9942900,'CC46868',true)");
  await query("INSERT INTO dispatch_drivers(id,name,login,active) VALUES(9942901,'Li','li',true)");
  for (const [itemId, weight] of [[9942902, 22.59], [9942903, 23.2], [9942904, 62.91], [9942905, 40]]) {
    await query("INSERT INTO inventory_items(item_id,item_name,item_weight) VALUES($1,$2,$3)", [itemId, `Weight item ${itemId}`, weight]);
  }
});
after(async () => { await fixture?.close(); });

async function seed() {
  const n = ++counter;
  const refs = [`SOB-WEIGHT-SAVE-${n}-A`, `SOB-WEIGHT-SAVE-${n}-B`];
  const ids = [9943000 + n * 2, 9943001 + n * 2];
  for (const [index, ref] of refs.entries()) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,sales_order_type,outbound_location_id,
      outbound_location,netsuite_active,dispatch_address) VALUES($1,$2,'B','Sales Order : Pending Fulfillment',
      'Delivery',1,'3445',true,'Recorded destination')`, [ids[index], ref]);
  }
  for (const [orderId, lineId, itemId, quantity, weight] of [[ids[0], 1, 9942902, 54.18, 22.59],
    [ids[0], 2, 9942903, 216, 23.2], [ids[0], 3, 9942904, 24, 62.91], [ids[1], 4, 9942905, 26, 40]]) {
    await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,quantity,unit,item_weight,netsuite_active)
      VALUES($1,$2,$3,$4,$4,$5,'EACH',$6,true)`, [orderId, lineId, itemId, `Weight item ${itemId}`, quantity, weight]);
  }
  const sources = await listDispatchOrders({ exactOrderRefs: refs, includeHiddenScm: true });
  const children = refs.map(ref => sources.find(source => source.id === ref));
  const group = { ...children[0], id: `GOB-WEIGHT-SAVE-${n}`, childOrders: refs, childOrderDetails: children,
    items: children.flatMap(child => child.items), weight: 8784.966, salesQty: 320.18 };
  assert.equal(children[0].weight, 7744.966);
  const saved = await fixture.seedPlan({ date: `2094-09-${String(n + 1).padStart(2, "0")}`, refs: [group.id] });
  const trucks = [{ id: "T5", plate: "CC46868", loads: [{ id: `weight-load-${n}`, name: "Load 1", driverLogin: "li",
    driverName: "Li", truckId: "T5", truckPlate: "CC46868", driverSequence: 0,
    stops: [{ id: `weight-pick-${n}`, type: "pick", orderId: group.id, location: "3445" },
      { id: `weight-drop-${n}`, type: "drop", orderId: group.id, location: group.address, dropWeight: group.weight }] }] }];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1",
    [saved.id, JSON.stringify([group]), JSON.stringify(trucks)]);
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,
    stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
    VALUES($1,$2,$3,'li','T5','CC46868',$4,$5,'drop',$6::jsonb,'complete',now(),now(),$7::jsonb)`,
  [`weight-job-${n}`, saved.id, saved.plan_date, trucks[0].loads[0].id, trucks[0].loads[0].stops[1].id,
    JSON.stringify(refs), JSON.stringify({ photoIds: ["retained-photo"], recordedWeight: 8784.966 })]);
  return { plan: { ...saved, orders: [group], trucks }, ids };
}

test("unchanged source, group and child totals remain identical through repeated real plan reads", async () => {
  const { plan } = await seed();
  const originalSnapshot = (await query("SELECT * FROM dispatch_plan_snapshots WHERE plan_id=$1", [plan.id])).rows;
  for (let repeat = 0; repeat < 3; repeat++) {
    const read = await getDispatchPlan(plan.id);
    const group = read.orders.find(order => order.id === plan.orders[0].id);
    assert.equal(group.weight, 8784.966);
    assert.equal(group.childOrderDetails[0].weight, 7744.966);
    assert.equal(group.childOrderDetails[1].weight, 1040);
    assert.deepEqual(await getDispatchExecutedOrderReviews(plan.id), []);
  }
  assert.deepEqual((await query("SELECT * FROM dispatch_plan_snapshots WHERE plan_id=$1", [plan.id])).rows, originalSnapshot);
});

test("authenticated save accepts a stop weight update and preserves source and driver evidence", async () => {
  const { plan, ids } = await seed();
  const jobs = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [plan.id])).rows;
  const source = (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id", [ids])).rows;
  const sessionId = `weight-save-${plan.id}`;
  const editLeaseToken = await fixture.acquireLease({ planDate: plan.plan_date, sessionId });
  const loaded = await fixture.request(`/api/dispatch/plans/${plan.id}`);
  const next = structuredClone(plan);
  next.trucks[0].loads[0].stops[1].dropWeight = 8984.966;
  const saved = await fixture.request(`/api/dispatch/plans/${plan.id}`, { method: "PUT", body: {
    orders: next.orders, trucks: next.trucks, summary: {}, planDate: plan.plan_date, sessionId, editLeaseToken,
    baseRevision: plan.revision, baseDigest: loaded.payload.digest
  } });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.id, plan.id, JSON.stringify(saved.payload));
  assert.notEqual(saved.payload.applied, false);
  assert.equal(saved.payload.orders.find(order => order.id === plan.orders[0].id).weight, 8784.966);
  const persisted = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [plan.id])).rows[0];
  assert.equal(persisted.orders.find(order => order.id === plan.orders[0].id).weight, 8784.966);
  assert.equal(persisted.trucks[0].loads[0].stops[1].dropWeight, 8984.966);
  assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1", [plan.id])).rows, jobs);
  assert.deepEqual((await query("SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id", [ids])).rows, source);
  assert.deepEqual(await getDispatchExecutedOrderReviews(plan.id), []);
  assert.equal((await getDispatchPlan(plan.id)).orders.find(order => order.id === plan.orders[0].id).weight, 8784.966);
});
