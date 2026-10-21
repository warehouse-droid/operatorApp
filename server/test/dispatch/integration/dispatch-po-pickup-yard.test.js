import assert from "node:assert/strict";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  enrichDispatchOrdersWithPoTargetAllocations,
  getSalesOrderPoAllocationOptions,
  listDispatchOrders
} from "../../../src/dispatch-repository.js";
import { refreshDispatchPlanAuthoritativeOrderProjection } from "../../../src/dispatch-plan-repository.js";

after(closeDb);
const PO_ID = 9355160028;
const SO_ID = PO_ID + 1;
const PO_REF = "TEST-LOINC-035516";
const SO_REF = "TEST-SOM06647";
const VAUGHAN = "TECHO BLOC Vaughan";
const AYR = "TECHO BLOC Ayr";
const VAUGHAN_ADDRESS = "720 Arrow Rd. North York, ON M9M 2M1";
const AYR_ADDRESS = "2852 Cedar Creek Rd, Ayr, ON N0B 1E0";

async function rollbackTest(run) {
  const transaction = await beginRollbackContext();
  try { await transaction.run(run); } finally { await transaction.rollback(); }
}

async function seed({ pickup = VAUGHAN, override = "", dispatchRef = PO_REF } = {}) {
  for (const [yard, address] of [[AYR, AYR_ADDRESS], [VAUGHAN, VAUGHAN_ADDRESS]]) {
    // Multiple opening-day rows must not duplicate cargo or allocations.
    for (const day of ["Mon-Fri", "Monday"]) {
      await query(`INSERT INTO dispatch_vendor_yards(vendor,yard,address,day_label,active)
        VALUES ('Techo-Bloc',$1,$2,$3,true) ON CONFLICT (vendor,yard,day_label)
        DO UPDATE SET address=EXCLUDED.address,active=true`, [yard, address, day]);
    }
  }
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,vendor,status,status_text,
    destination_location_id,destination_location,source_location,dispatch_vendor_yard,dispatch_address,
    dispatch_pickup_address,receipt_status,initial_scm_status,netsuite_active)
    VALUES ($1,'TEST-POB03914',$2,'Techo-Bloc','B','Pending Receipt',13,'150','Techo-Bloc',
      $3,$4,$5,'not_received','Queued',true)`, [PO_ID, dispatchRef, AYR, AYR_ADDRESS, override]);
  const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,
    item_name,sku,item_description,item_type,quantity,unit,pallet_qty,location_id,location,netsuite_active)
    VALUES ($1,1,2055,'MBBS-Special Order','MBBS-Special Order','MIKA PAVER - ONYX BLACK',
      'NonInvtPart',10,'SQFT',1,13,'150',true) RETURNING id`, [PO_ID])).rows[0];
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,sales_order_type,
    outbound_location_id,outbound_location,dispatch_address,fulfillment_status,netsuite_active)
    VALUES ($1,$2,'Pickup yard fixture','B','Pending Fulfillment','Delivery',13,'150',
      '853 Indian Rd, Mississauga, ON L5H 1R4','not_fulfilled',true)`, [SO_ID, SO_REF]);
  const soLine = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,
    sku,item_description,item_type,quantity,unit,pallet_qty,netsuite_active)
    VALUES ($1,1,2055,'MBBS-Special Order','MBBS-Special Order','MIKA PAVER - ONYX BLACK',
      'NonInvtPart',3,'SQFT',1,true) RETURNING id`, [SO_ID])).rows[0];
  if (pickup !== null) {
    await query(`INSERT INTO scm_transport_schedule(order_kind,order_ref,pickup_point,status,method)
      VALUES ('PO',$1,$2,'Queued','MBT')`, [dispatchRef.toLowerCase(), pickup]);
  }
  await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
    po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_sales_qty,
    dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,2055,'MBBS-Special Order','MBBS-Special Order',3,$2,'normal',$7,'test')`,
  [SO_ID, SO_REF, soLine.id, PO_ID, dispatchRef, poLine.id, `${SO_REF}::${soLine.id}`]);
  return { dispatchRef };
}

async function linkedOrder() {
  const listed = await listDispatchOrders({ type: "SO", exactOrderRefs: [SO_REF] });
  assert.equal(listed.length, 1);
  const [order] = await enrichDispatchOrdersWithPoTargetAllocations(listed);
  return order;
}

test("LOINC linked pickup uses the same SCM yard and address as its PO card", () => rollbackTest(async () => {
  await seed();
  const [po] = await listDispatchOrders({ type: "PO", exactOrderRefs: [PO_REF], includeHiddenScm: true });
  assert.equal(po.sourceYard, VAUGHAN);
  assert.equal(po.sourceAddress, VAUGHAN_ADDRESS);
  const order = await linkedOrder();
  assert.deepEqual(order.pickupLocations, ["150", VAUGHAN]);
  assert.equal(order.poPickupManifest.length, 1);
  assert.equal(order.poPickupManifest[0].items.length, 1);
  assert.equal(order.poPickupManifest[0].location, po.sourceYard);
  assert.equal(order.poPickupManifest[0].address, po.sourceAddress);
}));

test("PO linking options and existing links show the selected yard and pickup override", () => rollbackTest(async () => {
  const override = "722 Arrow Rd, North York, ON";
  await seed({ override });
  const options = await getSalesOrderPoAllocationOptions(SO_REF);
  assert.equal(options.allocations.length, 1);
  assert.equal(options.allocations[0].poVendorYard, VAUGHAN);
  assert.equal(options.allocations[0].poAddress, override);
  const candidate = options.poLines.find(row => row.poRef === PO_REF);
  assert.ok(candidate, "The matching PO must remain available for linking.");
  assert.equal(candidate.vendorYard, VAUGHAN);
  assert.equal(candidate.address, override);
  assert.equal((await linkedOrder()).poPickupManifest[0].address, override);
}));

for (const pickup of [null, ""]) {
  test(`missing or blank SCM pickup retains the PO yard (${pickup})`, () => rollbackTest(async () => {
    await seed({ pickup });
    const order = await linkedOrder();
    assert.deepEqual(order.pickupLocations, ["150", AYR]);
    assert.equal(order.poPickupManifest[0].address, AYR_ADDRESS);
  }));
}

test("a split PO uses its own SCM pickup rather than its parent's yard", () => rollbackTest(async () => {
  const dispatchRef = `${PO_REF}-S1`;
  await seed({ dispatchRef });
  await query(`INSERT INTO scm_transport_schedule(order_kind,order_ref,pickup_point,status)
    VALUES ('PO',$1,$2,'Queued')`, [PO_REF, AYR]);
  const manifest = (await linkedOrder()).poPickupManifest;
  assert.deepEqual(manifest.map(entry => [entry.poOrderRef, entry.location]), [[dispatchRef, VAUGHAN]]);
}));

test("refreshing an unstarted managed pickup replaces Ayr with Vaughan and invalidates its timing", () => rollbackTest(async () => {
  await seed();
  const [order] = await listDispatchOrders({ type: "SO", exactOrderRefs: [SO_REF] });
  const stale = { ...order, pickupLocations: ["150", AYR], poPickupManifest: [
    { poOrderRef: PO_REF, location: AYR, address: AYR_ADDRESS, items: [{ itemId: 2055, quantity: 3 }] }
  ] };
  const plan = await refreshDispatchPlanAuthoritativeOrderProjection({
    orders: [stale], trucks: [{ id: "truck", loads: [{ id: "load", routeEstimate: { totalMinutes: 90 }, stops: [
      { id: "pickup", type: "pick", orderId: SO_REF, location: AYR,
        dependencyManaged: true, dependencyTargetRefs: [SO_REF] },
      { id: "drop", type: "drop", orderId: SO_REF, location: "150" }
    ] }] }]
  });
  assert.deepEqual(plan.orders[0].pickupLocations, ["150", VAUGHAN]);
  const load = plan.trucks[0].loads[0];
  assert.equal(load.stops.some(stop => stop.type === "pick" && stop.location === AYR), false);
  assert.equal(load.stops.filter(stop => stop.type === "pick" && stop.location === VAUGHAN).length, 1);
  assert.equal(load.routeEstimate, undefined);
}));
