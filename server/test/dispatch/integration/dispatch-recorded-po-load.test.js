import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomInt } from "node:crypto";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { confirmDispatchPlan, getDispatchPlan, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { assertDispatchExecutedPrefixPreserved } from "../../../src/dispatch-executed-prefix-repository.js";
import { freezeRecordedPurchaseOrderProjections } from "../../../src/dispatch-recorded-po-projection.js";
import { reconcileAuthoritativeDispatchOrderProjection } from "../../../src/dispatch-plan-order-projection.js";

after(closeDb);

function routeFixture({ recordedResidual, projectedResidual = 225.89, status = "in_progress", stopType = "dropoff", refInRecord = true } = {}) {
  const projection = quantity => ({ version: 1, targetRefs: ["SO-LINKED"], items: [{ quantity }],
    dropoffs: quantity ? [{ key: "location:26", destinationYard: "150", salesQty: quantity, lineRowIds: ["po-line"] }] : [] });
  const order = { id: "PO-RECORDED", type: "PO", sourceYard: "Vendor", pickupLocations: ["Vendor"],
    salesQty: 1500.29, items: [{ lineRowId: "po-line", quantity: 1500.29 }],
    ...(recordedResidual === undefined ? {} : { poRouteProjection: projection(recordedResidual) }) };
  const stops = [{ id: "pick", type: "pick", orderId: order.id, location: "Vendor", orderRefs: [order.id], timing: { arrival: 480, depart: 500 } },
    { id: "drop", type: "drop", orderId: order.id, location: "Vendor", dropLocation: "150", dropoffKey: "location:26",
      dropSalesQty: recordedResidual ?? 1500.29, dropAddress: "Recorded yard", lineRowIds: ["po-line"], timing: { arrival: 550, depart: 570 } }];
  return { recordedPlan: { orders: [order], trucks: [{ id: "", loads: [{ id: "recorded-load", stops }] }] },
    projectedOrders: [{ ...order, poRouteProjection: projection(projectedResidual) }],
    activity: [{ status, load_id: "recorded-load", stop_id: stopType === "pickup" ? "pick" : "drop", stop_type: stopType,
      order_refs: refInRecord ? [order.id.toLowerCase()] : [] }] };
}

for (const recordedResidual of [undefined, 900]) {
  test(`started PO retains its published route projection (${recordedResidual ?? "absent"}) and exact stops`, () => {
    const fixture = routeFixture({ recordedResidual });
    const before = structuredClone(fixture);
    const frozen = freezeRecordedPurchaseOrderProjections(fixture);
    assert.deepEqual(frozen.orders[0].poRouteProjection, fixture.recordedPlan.orders[0].poRouteProjection);
    const result = reconcileAuthoritativeDispatchOrderProjection({ plan: fixture.recordedPlan,
      projectedOrders: frozen.orders, preservedPoOrderRefs: frozen.preservedPoOrderRefs }).plan;
    assert.deepEqual(result.trucks, fixture.recordedPlan.trucks);
    assert.deepEqual(fixture, before);
  });
}

test("complete pickup with missing activity refs resolves its persisted stop and survives zero/new residual projections", () => {
  for (const projectedResidual of [0, 12]) {
    const fixture = routeFixture({ projectedResidual, status: "complete", stopType: "pickup", refInRecord: false });
    const frozen = freezeRecordedPurchaseOrderProjections(fixture);
    assert.ok(frozen.preservedPoOrderRefs.has("po-recorded"));
    const result = reconcileAuthoritativeDispatchOrderProjection({ plan: fixture.recordedPlan,
      projectedOrders: fixture.projectedOrders, preservedPoOrderRefs: frozen.preservedPoOrderRefs }).plan;
    // Test the residual boundary independently of the projection-freezing layer.
    assert.deepEqual(result.trucks[0].loads[0].stops.map(stop => ({ ...stop, timing: undefined })),
      fixture.recordedPlan.trucks[0].loads[0].stops.map(stop => ({ ...stop, timing: undefined })));
  }
});

test("unstarted, travel-only and unrelated activity still use the current residual projection", () => {
  for (const overrides of [{ status: "pending" }, { stopType: "travel" }, { stopType: "truck_switch" }]) {
    const fixture = routeFixture(overrides);
    const frozen = freezeRecordedPurchaseOrderProjections(fixture);
    assert.equal(frozen.preservedPoOrderRefs.size, 0);
    assert.deepEqual(frozen.orders, fixture.projectedOrders);
    const result = reconcileAuthoritativeDispatchOrderProjection({ plan: fixture.recordedPlan, projectedOrders: frozen.orders,
      preservedPoOrderRefs: frozen.preservedPoOrderRefs }).plan;
    assert.equal(result.trucks[0].loads[0].stops.at(-1).dropSalesQty, 225.89);
  }
  const fixture = routeFixture();
  fixture.activity[0].load_id = "another-load";
  fixture.activity[0].order_refs = ["PO-OTHER"];
  assert.equal(freezeRecordedPurchaseOrderProjections(fixture).preservedPoOrderRefs.size, 0);
});

test("only the recorded PO is frozen; another PO and non-PO projections remain current", () => {
  const fixture = routeFixture();
  fixture.projectedOrders.push({ id: "PO-OTHER", type: "PO", poRouteProjection: { version: 1, salesQty: 8 } },
    { id: "SO-OTHER", type: "SO", poPickupManifest: [{ quantity: 7 }] });
  const result = freezeRecordedPurchaseOrderProjections(fixture);
  assert.deepEqual(result.orders.slice(1), fixture.projectedOrders.slice(1));
  assert.deepEqual([...result.preservedPoOrderRefs], ["po-recorded"]);
});

test("a physical SO record cannot masquerade as a recorded PO projection", () => {
  const fixture = routeFixture();
  fixture.recordedPlan.orders[0].type = "SO";
  const result = freezeRecordedPurchaseOrderProjections(fixture);
  assert.equal(result.preservedPoOrderRefs.size, 0);
  assert.deepEqual(result.orders, fixture.projectedOrders);
});

test("property: legacy projection aliases cannot reintroduce stale quantities into the recorded PO", () => {
  fc.assert(fc.property(fc.boolean(), fc.integer({ min: 0, max: 1500 }), (hasRecorded, quantity) => {
    const fixture = routeFixture({ projectedResidual: quantity });
    fixture.projectedOrders[0].po_route_projection = { version: 1, salesQty: quantity };
    if (hasRecorded) { fixture.recordedPlan.orders[0].po_route_projection = { version: 1, salesQty: 1500.29 }; }
    const result = freezeRecordedPurchaseOrderProjections(fixture);
    assert.equal(result.orders[0].po_route_projection, undefined);
    assert.deepEqual(result.orders[0].poRouteProjection, hasRecorded ? { version: 1, salesQty: 1500.29 } : undefined);
  }), { seed: 20260914, numRuns: 50 });
});

test("property: only physical started PO work retains its recorded projection across residual histories", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.integer({ min: 0, max: 1500 }),
    fc.integer({ min: 0, max: 1500 }), (started, physical, hasRecorded, recorded, projected) => {
      const fixture = routeFixture({ recordedResidual: hasRecorded ? recorded : undefined, projectedResidual: projected,
        status: started ? "complete" : "pending", stopType: physical ? "pickup" : "travel" });
      const before = structuredClone(fixture);
      const frozen = freezeRecordedPurchaseOrderProjections(fixture);
      assert.deepEqual(frozen.orders[0].poRouteProjection,
        (started && physical ? fixture.recordedPlan.orders : fixture.projectedOrders)[0].poRouteProjection);
      assert.equal(frozen.preservedPoOrderRefs.has("po-recorded"), started && physical);
      const again = freezeRecordedPurchaseOrderProjections({ ...fixture, projectedOrders: frozen.orders });
      assert.deepEqual(again, frozen);
      assert.deepEqual(fixture, before);
      if (started && physical) {
        const reconciled = reconcileAuthoritativeDispatchOrderProjection({ plan: fixture.recordedPlan,
          projectedOrders: fixture.projectedOrders, preservedPoOrderRefs: frozen.preservedPoOrderRefs }).plan;
        assert.deepEqual(reconciled.trucks[0].loads[0].stops.map(stop => ({ ...stop, timing: undefined })),
          fixture.recordedPlan.trucks[0].loads[0].stops.map(stop => ({ ...stop, timing: undefined })));
      }
    }), { seed: 20260914, numRuns: 100 });
});

async function dbScenario(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(async () => {
    const sid = 8_700_000_000 + randomInt(1_000_000), pid = sid + 1_000_000;
    await query("INSERT INTO sales_orders(netsuite_id,tranid,netsuite_active) VALUES($1,$2,true)", [sid, `SO-REC-${sid}`]);
    const sl = (await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,quantity) VALUES($1,1,2055,1274.4) RETURNING id", [sid])).rows[0].id;
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor,dispatch_vendor_yard,netsuite_active) VALUES($1,'PO-RECORDED','Vendor','Vendor',true)", [pid]);
    const pl = (await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,quantity) VALUES($1,1,2055,1500.29) RETURNING id", [pid])).rows[0].id;
    const fixture = routeFixture();
    fixture.recordedPlan.orders[0].items[0].lineRowId = String(pl);
    fixture.recordedPlan.orders[0].items[0].itemId = 2055;
    fixture.recordedPlan.orders[0].destinationYard = "150";
    const row = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES('2197-09-14','confirmed',1) RETURNING id")).rows[0];
    const plan = { ...fixture.recordedPlan, id: String(row.id), planDate: "2197-09-14", revision: 1, summary: {} };
    await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2::jsonb,$3::jsonb,'{}')", [plan.id, JSON.stringify(plan.orders), JSON.stringify(plan.trucks)]);
    await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key,status)
      VALUES($1,$2,$3,$4,'PO-RECORDED',$5,2055,1274.4,$2,'normal',$6,'active')`, [sid, `SO-REC-${sid}`, sl, pid, pl, `SO-REC-${sid}::SO-REC-${sid}::${sl}`]);
    await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,stop_id,stop_type,order_refs,status,started_at)
      VALUES($1,$2,'2197-09-14','recorded-load','','','recorded-load','Recorded PO','drop','dropoff','["PO-RECORDED"]','in_progress',now())`, [`recorded-${sid}`, plan.id]);
    await run(plan);
  }); } finally { await rollback.rollback(); }
}

test("real plan refresh retains 1500.29 after the late 1274.4 allocation without persisting a read", () => dbScenario(async recorded => {
  const fresh = await getDispatchPlan(recorded.id);
  assert.deepEqual(fresh.trucks[0].loads[0].stops, recorded.trucks[0].loads[0].stops);
  assert.equal(fresh.orders[0].poRouteProjection, undefined);
  assert.equal((await assertDispatchExecutedPrefixPreserved({ previousPlan: recorded, nextPlan: fresh })).allowed, true);
  assert.deepEqual((await query("SELECT trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [recorded.id])).rows[0].trucks, recorded.trucks);
}));

test("a stale legacy projection in a save payload cannot replace the recorded PO manifest", () => dbScenario(async recorded => {
  const fresh = await getDispatchPlan(recorded.id);
  fresh.orders[0].po_route_projection = { version: 1, salesQty: 225.89, items: [] };
  const saved = await saveDispatchPlanSnapshot(recorded.id, { ...fresh, baseRevision: recorded.revision });
  assert.equal(saved.orders[0].po_route_projection, undefined);
  assert.equal(saved.orders[0].poRouteProjection, undefined);
  assert.equal(saved.trucks[0].loads[0].stops.at(-1).dropSalesQty, 1500.29);
}));

test("unchanged recorded load saves and confirms while direct edits to its active drop remain rejected", () => dbScenario(async recorded => {
  const fresh = await getDispatchPlan(recorded.id);
  const saved = await saveDispatchPlanSnapshot(recorded.id, { ...fresh, baseRevision: recorded.revision });
  const confirmed = await confirmDispatchPlan(recorded.id);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.trucks[0].loads[0].stops.at(-1).dropSalesQty, 1500.29);
  const edited = structuredClone(saved);
  edited.trucks[0].loads[0].stops.at(-1).dropSalesQty = 225.89;
  await assert.rejects(assertDispatchExecutedPrefixPreserved({ previousPlan: recorded, nextPlan: edited }), error => error.code === "DISPATCH_ACTIVE_LOAD_LOCKED");
  await assert.rejects(saveDispatchPlanSnapshot(recorded.id, { ...edited, baseRevision: confirmed.revision }), error => error.code === "DISPATCH_ACTIVE_LOAD_LOCKED");
}));
