import assert from "node:assert/strict";
import {
  assertSalesOrderReloadEligibility,
  authorizeSalesOrderReload,
  buildSalesOrderReloadTargets,
  cancelSalesOrderReload,
  normalizeReloadReason,
  normalizeReloadRequestId,
  reloadPackedQuantities
} from "./sales-order-reload.js";

const REQUEST_ID = "c593b7ce-a8a8-4db0-a9a3-38fd43756f74";

function expectCode(fn, code, status = 409) {
  assert.throws(fn, (error) => error?.code === code && error?.status === status);
}

async function expectRejectCode(fn, code, status = 409) {
  await assert.rejects(fn, (error) => error?.code === code && error?.status === status);
}

function baseLine(overrides = {}) {
  return {
    id: 901,
    line_id: 71,
    item_id: 1354,
    item_name: "Reload test item",
    sku: "RELOAD-ITEM",
    item_description: "Frozen line snapshot",
    item_type: "InvtPart",
    quantity: 143.5,
    unit: "SQFT",
    pallet_qty: 2,
    layer_qty: 2,
    section_qty: 0,
    piece_qty: 0,
    to_plt: 61.5,
    to_lyr: 10.25,
    to_sec: 0,
    to_pcs: 0,
    loaded_qty: 71.75,
    loaded_uom: "SQFT",
    netsuite_active: true,
    sync_exception: null,
    ...overrides
  };
}

function baseEligibility(overrides = {}) {
  const order = {
    netsuite_id: 456789,
    tranid: "SOM456789",
    order_type: "sales_order",
    status: "B",
    status_text: "Sales Order : Pending Fulfillment",
    delivery_method: "Delivery",
    netsuite_active: true,
    fulfillment_status: "not_fulfilled",
    outbound_location_id: 15,
    ...overrides.order
  };
  return {
    order,
    lines: overrides.lines || [baseLine()],
    priorLoadCount: 1,
    completedDropoff: false,
    activeCycle: null,
    activeDraft: false,
    activeConsolidation: false,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "order" && key !== "lines"))
  };
}

assert.equal(normalizeReloadReason("  damaged wrap; truck returned  "), "damaged wrap; truck returned");
expectCode(() => normalizeReloadReason("   "), "RELOAD_REASON_REQUIRED", 400);
expectCode(() => normalizeReloadReason(null), "RELOAD_REASON_REQUIRED", 400);
expectCode(() => normalizeReloadReason("x".repeat(501)), "RELOAD_REASON_TOO_LONG", 400);
assert.equal(normalizeReloadRequestId(` ${REQUEST_ID.toUpperCase()} `), REQUEST_ID);
expectCode(() => normalizeReloadRequestId("retry-me"), "RELOAD_REQUEST_ID_INVALID", 400);
expectCode(() => normalizeReloadRequestId(null), "RELOAD_REQUEST_ID_INVALID", 400);

{
  const targets = buildSalesOrderReloadTargets([
    baseLine(),
    baseLine({ id: 902, line_id: 72, loaded_qty: 0 }),
    baseLine({ id: 903, line_id: 73, item_type: "Service", loaded_qty: 20 })
  ]);
  assert.deepEqual(targets, [{
    salesOrderLineId: 901,
    netsuiteLineId: 71,
    itemId: 1354,
    itemName: "Reload test item",
    sku: "RELOAD-ITEM",
    itemDescription: "Frozen line snapshot",
    salesUom: "SQFT",
    targetSalesQty: 71.75,
    targetPalletQty: 1,
    targetLayerQty: 1,
    targetSectionQty: 0,
    targetPieceQty: 0,
    toPlt: 61.5,
    toLyr: 10.25,
    toSec: 0,
    toPcs: 0
  }], "Only active, pickable, locally loaded lines should become frozen re-load targets.");

  expectCode(
    () => buildSalesOrderReloadTargets([baseLine({ netsuite_active: false })]),
    "RELOAD_LINE_CONFLICT"
  );
  expectCode(
    () => buildSalesOrderReloadTargets([baseLine({ sync_exception: "qty_reduced" })]),
    "RELOAD_LINE_CONFLICT"
  );
  expectCode(
    () => buildSalesOrderReloadTargets([baseLine({ quantity: 5, loaded_qty: 5.2 })]),
    "RELOAD_LINE_CONFLICT"
  );
  expectCode(
    () => buildSalesOrderReloadTargets([baseLine({
      quantity: 5,
      loaded_qty: 5,
      pallet_qty: 0,
      layer_qty: 0,
      piece_qty: 2,
      to_plt: 0,
      to_lyr: 0,
      to_pcs: 3
    })]),
    "RELOAD_LINE_CONFLICT"
  );
  expectCode(
    () => buildSalesOrderReloadTargets([baseLine({ id: 0 })]),
    "RELOAD_LINE_CONFLICT",
    400
  );

  assert.deepEqual(buildSalesOrderReloadTargets(null), []);
  const sparse = buildSalesOrderReloadTargets([{
    id: 905,
    item_type: "InvtPart",
    quantity: 4,
    loaded_qty: 4
  }])[0];
  assert.deepEqual({
    netsuiteLineId: sparse.netsuiteLineId,
    itemId: sparse.itemId,
    itemName: sparse.itemName,
    sku: sparse.sku,
    itemDescription: sparse.itemDescription,
    salesUom: sparse.salesUom
  }, {
    netsuiteLineId: null,
    itemId: null,
    itemName: "",
    sku: "",
    itemDescription: "",
    salesUom: ""
  });

  const toleranceTarget = buildSalesOrderReloadTargets([baseLine({
    id: 906,
    quantity: 61.5,
    loaded_qty: 61.45,
    pallet_qty: 1,
    layer_qty: 0,
    to_plt: 61.5,
    to_lyr: 0
  })])[0];
  assert.equal(toleranceTarget.targetPalletQty, 1);
  assert.equal(toleranceTarget.targetLayerQty, 0);

  const camelTarget = buildSalesOrderReloadTargets([{
    id: 907,
    lineId: 77,
    itemId: 1354,
    itemName: "Camel item",
    itemDescription: "Camel line",
    itemType: "NonInvtPart",
    quantity: 2,
    loadedQty: 2,
    loadedUom: "EA",
    pieceQty: 2,
    toPcs: 1,
    netsuiteActive: true,
    syncException: null
  }])[0];
  assert.equal(camelTarget.netsuiteLineId, 77);
  assert.equal(camelTarget.itemName, "Camel item");
  assert.equal(camelTarget.targetPieceQty, 2);
}

{
  const target = buildSalesOrderReloadTargets([baseLine()])[0];
  const packed = reloadPackedQuantities(target, {
    packedPalletQty: 0,
    packedLayerQty: 0,
    packedSectionQty: 0,
    packedPieceQty: 0,
    packedSalesQty: 0,
    reloadedSalesQty: 0
  }, {
    pallets: 9,
    layers: 9,
    sections: 9,
    pieces: 9,
    salesQty: 999
  }, { absolute: true });
  assert.deepEqual(packed, {
    packedPalletQty: 1,
    packedLayerQty: 1,
    packedSectionQty: 0,
    packedPieceQty: 0,
    packedSalesQty: 0,
    packedTotalSalesQty: 71.75
  });

  const partiallyDone = reloadPackedQuantities(target, {
    packedPalletQty: 0,
    packedLayerQty: 0,
    packedSectionQty: 0,
    packedPieceQty: 0,
    packedSalesQty: 0,
    reloadedSalesQty: 61.5
  }, { layers: 5 }, { absolute: true });
  assert.equal(partiallyDone.packedLayerQty, 1);
  assert.equal(partiallyDone.packedTotalSalesQty, 10.25);

  const salesOnlyTarget = buildSalesOrderReloadTargets([baseLine({
    id: 904,
    line_id: 74,
    quantity: 10,
    unit: "EA",
    pallet_qty: 0,
    layer_qty: 0,
    piece_qty: 0,
    to_plt: 0,
    to_lyr: 0,
    to_pcs: 0,
    loaded_qty: 6
  })])[0];
  const salesOnly = reloadPackedQuantities(
    salesOnlyTarget,
    { reloadedSalesQty: 2, packedSalesQty: 0 },
    { salesQty: 20 },
    { absolute: true }
  );
  assert.equal(salesOnly.packedSalesQty, 4);
  assert.equal(salesOnly.packedTotalSalesQty, 4);

  const incrementalSalesOnly = reloadPackedQuantities(
    salesOnlyTarget,
    { reloadedSalesQty: 0, packedSalesQty: 1 },
    { salesQty: 2 }
  );
  assert.equal(incrementalSalesOnly.packedSalesQty, 3);

  const incrementalConverted = reloadPackedQuantities(
    target,
    { packedPalletQty: 0, reloadedSalesQty: 0 },
    { pallets: 1 }
  );
  assert.equal(incrementalConverted.packedPalletQty, 1);

  const nonFinite = reloadPackedQuantities(
    { targetSalesQty: Number.POSITIVE_INFINITY },
    { packedSalesQty: Number.NaN },
    { salesQty: 1 }
  );
  assert.equal(nonFinite.packedSalesQty, 0);
}

// Property pass: for varied integer piece targets and progress, packing is both
// fail-open up to the exact remaining quantity and fail-closed above it.
for (let targetQty = 1; targetQty <= 80; targetQty += 1) {
  for (let completed = 0; completed <= targetQty; completed += 1) {
    const target = buildSalesOrderReloadTargets([baseLine({
      id: 1000 + targetQty,
      line_id: 1000 + targetQty,
      quantity: targetQty,
      unit: "EA",
      pallet_qty: 0,
      layer_qty: 0,
      section_qty: 0,
      piece_qty: targetQty,
      to_plt: 0,
      to_lyr: 0,
      to_sec: 0,
      to_pcs: 1,
      loaded_qty: targetQty
    })])[0];
    const result = reloadPackedQuantities(
      target,
      { reloadedSalesQty: completed },
      { pieces: targetQty * 3 },
      { absolute: true }
    );
    assert.equal(result.packedPieceQty, targetQty - completed);
    assert.equal(result.packedTotalSalesQty, targetQty - completed);
  }
}

assert.equal(assertSalesOrderReloadEligibility(baseEligibility()).eligible, true);
expectCode(() => assertSalesOrderReloadEligibility(), "RELOAD_NOT_DELIVERY_SO");
for (const [fixture, code] of [
  [baseEligibility({ order: { order_type: "transfer_order" } }), "RELOAD_NOT_DELIVERY_SO"],
  [baseEligibility({ order: { netsuite_id: -44 } }), "RELOAD_NOT_DELIVERY_SO"],
  [baseEligibility({ order: { delivery_method: "Pick-Up" } }), "RELOAD_NOT_DELIVERY_SO"],
  [baseEligibility({ order: { status: "G", status_text: "Billed" } }), "RELOAD_NETSUITE_COMPLETE"],
  [baseEligibility({ order: { status: "B", status_text: "Closed" } }), "RELOAD_NETSUITE_COMPLETE"],
  [baseEligibility({ order: { fulfillment_status: "fulfilled" } }), "RELOAD_NETSUITE_COMPLETE"],
  [baseEligibility({ order: { netsuite_active: false } }), "RELOAD_NETSUITE_COMPLETE"],
  [baseEligibility({ priorLoadCount: 0 }), "RELOAD_NO_PRIOR_LOAD"],
  [baseEligibility({ completedDropoff: true }), "RELOAD_DRIVER_COMPLETE"],
  [baseEligibility({ activeCycle: { id: 77 } }), "RELOAD_ACTIVE"],
  [baseEligibility({ activeDraft: true }), "RELOAD_OPERATOR_ACTIVE"],
  [baseEligibility({ activeConsolidation: true }), "RELOAD_OPERATOR_ACTIVE"],
  [baseEligibility({ lines: [baseLine({ loaded_qty: 0 })] }), "RELOAD_NO_LOADED_QUANTITY"]
]) {
  expectCode(() => assertSalesOrderReloadEligibility(fixture), code);
}

{
  const camelEligibility = assertSalesOrderReloadEligibility({
    order: {
      netsuiteId: 456789,
      orderRef: "SOM456789",
      orderType: "sales_order",
      status: "B",
      statusText: "Partially Fulfilled",
      fulfillmentStatus: "partial_fulfilled",
      deliveryMethod: "Delivery",
      netsuiteActive: true,
      lines: [baseLine()]
    },
    priorLoadCount: 1
  });
  assert.equal(camelEligibility.eligible, true);
  assert.equal(camelEligibility.targets.length, 1);

  expectCode(() => assertSalesOrderReloadEligibility({
    order: {
      netsuite_id: 456789,
      tranid: "SOM456789",
      order_type: "sales_order",
      status: "B",
      status_text: "Pending Fulfillment",
      delivery_method: "Delivery"
    },
    priorLoadCount: 1
  }), "RELOAD_NO_LOADED_QUANTITY");
}

function authorizationFixture(overrides = {}) {
  const calls = [];
  const audits = [];
  const cycle = {
    id: 88,
    salesOrderId: 456789,
    requestId: REQUEST_ID,
    status: "authorized",
    reason: "damaged wrap"
  };
  const dependencies = {
    findCycleByRequestId: async () => null,
    findLocalOrderIdentity: async (orderId) => {
      calls.push("identity");
      assert.equal(orderId, 456789);
      return { netsuiteId: 456789, tranid: "SOM456789", outboundLocationId: 15 };
    },
    assertActorYardAccess: async (actor, locationId) => {
      calls.push("yard");
      assert.equal(actor.id, "manager-1");
      assert.equal(locationId, 15);
    },
    refreshOrder: async ({ orderRef }) => {
      calls.push("refresh");
      assert.equal(orderRef, "SOM456789");
    },
    withTransaction: async (callback) => {
      calls.push("transaction");
      return callback();
    },
    lockAuthorizationSnapshot: async () => {
      calls.push("lock");
      return baseEligibility();
    },
    createCycle: async ({ order, targets, reason, requestId, actor }) => {
      calls.push("create");
      assert.equal(order.netsuite_id, 456789);
      assert.equal(targets[0].targetSalesQty, 71.75);
      assert.equal(reason, "damaged wrap");
      assert.equal(requestId, REQUEST_ID);
      assert.equal(actor.id, "manager-1");
      return cycle;
    },
    writeAudit: async (entry) => audits.push(entry),
    ...overrides
  };
  return { calls, audits, cycle, dependencies };
}

{
  const fixture = authorizationFixture();
  const result = await authorizeSalesOrderReload({
    orderId: 456789,
    requestId: REQUEST_ID,
    reason: " damaged wrap ",
    actor: { id: "manager-1", roles: ["yard_manager"], yardLocationIds: [15] }
  }, fixture.dependencies);
  assert.equal(result.id, 88);
  assert.deepEqual(fixture.calls, ["identity", "yard", "refresh", "transaction", "lock", "create"]);
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0].action, "delivery.reload.authorize");
}

{
  const fixture = authorizationFixture({
    findCycleByRequestId: async () => fixture.cycle,
    refreshOrder: async () => assert.fail("An idempotent retry must not repeat the NetSuite refresh."),
    createCycle: async () => assert.fail("An idempotent retry must not create another cycle.")
  });
  const result = await authorizeSalesOrderReload({
    orderId: 456789,
    requestId: REQUEST_ID,
    reason: "damaged wrap",
    actor: { id: "manager-1" }
  }, fixture.dependencies);
  assert.equal(result.id, 88);
  assert.deepEqual(fixture.calls, []);
}

{
  const fixture = authorizationFixture({
    findCycleByRequestId: async () => ({ ...fixture.cycle, salesOrderId: 999999 })
  });
  await expectRejectCode(() => authorizeSalesOrderReload({
    orderId: 456789,
    requestId: REQUEST_ID,
    reason: "damaged wrap",
    actor: { id: "manager-1" }
  }, fixture.dependencies), "RELOAD_REQUEST_ID_CONFLICT");
}

{
  const fixture = authorizationFixture({
    findLocalOrderIdentity: async () => null
  });
  await expectRejectCode(() => authorizeSalesOrderReload({
    orderId: 456789,
    requestId: REQUEST_ID,
    reason: "damaged wrap",
    actor: { id: "manager-1" }
  }, fixture.dependencies), "RELOAD_ORDER_NOT_FOUND", 404);
}

{
  let lookups = 0;
  let fixture;
  fixture = authorizationFixture({
    findCycleByRequestId: async () => {
      lookups += 1;
      return lookups === 2 ? fixture.cycle : null;
    },
    findLocalOrderIdentity: async () => ({
      netsuiteId: 456789,
      orderRef: "SOM456789",
      outbound_location_id: 15
    }),
    createCycle: async () => assert.fail("A transaction-race retry must not create another cycle.")
  });
  const result = await authorizeSalesOrderReload({
    orderId: 456789,
    requestId: REQUEST_ID,
    reason: "damaged wrap",
    actor: { id: "manager-1" }
  }, fixture.dependencies);
  assert.equal(result.id, 88);
  assert.equal(lookups, 2);
}

{
  let lookups = 0;
  const fixture = authorizationFixture({
    findCycleByRequestId: async () => {
      lookups += 1;
      return lookups === 2 ? { sales_order_id: 999999 } : null;
    }
  });
  await expectRejectCode(() => authorizeSalesOrderReload({
    orderId: 456789,
    requestId: REQUEST_ID,
    reason: "damaged wrap",
    actor: { id: "manager-1" }
  }, fixture.dependencies), "RELOAD_REQUEST_ID_CONFLICT");
}

await expectRejectCode(() => authorizeSalesOrderReload({
  orderId: 0,
  requestId: REQUEST_ID,
  reason: "damaged wrap",
  actor: { id: "manager-1" }
}, {}), "RELOAD_ORDER_ID_INVALID", 400);

await expectRejectCode(() => authorizeSalesOrderReload({
  orderId: 456789,
  requestId: REQUEST_ID,
  reason: "damaged wrap"
}, {}), "RELOAD_ACTOR_REQUIRED", 401);

{
  const fixture = authorizationFixture({
    lockAuthorizationSnapshot: async () => baseEligibility({ completedDropoff: true }),
    createCycle: async () => assert.fail("An ineligible order must not create a cycle.")
  });
  await assert.rejects(
    () => authorizeSalesOrderReload({
      orderId: 456789,
      requestId: REQUEST_ID,
      reason: "damaged wrap",
      actor: { id: "manager-1", yardLocationIds: [15] }
    }, fixture.dependencies),
    (error) => error.code === "RELOAD_DRIVER_COMPLETE" && error.status === 409
  );
  assert.equal(fixture.audits.length, 0, "Failed authorization must not claim a success audit.");
}

{
  const calls = [];
  const result = await cancelSalesOrderReload({
    orderId: 456789,
    cycleId: 88,
    reason: "No longer required",
    actor: { id: "manager-1" }
  }, {
    withTransaction: async (callback) => callback(),
    lockCycle: async () => ({ id: 88, salesOrderId: 456789, status: "authorized", activityStartedAt: null }),
    cancelCycle: async ({ cycleId, reason }) => {
      calls.push({ cycleId, reason });
      return { id: cycleId, status: "cancelled", reason };
    },
    writeAudit: async (entry) => calls.push(entry)
  });
  assert.equal(result.status, "cancelled");
  assert.equal(calls[0].reason, "No longer required");
  assert.equal(calls[1].action, "delivery.reload.cancel");

  await assert.rejects(
    () => cancelSalesOrderReload({
      orderId: 456789,
      cycleId: 88,
      reason: "Too late",
      actor: { id: "manager-1" }
    }, {
      withTransaction: async (callback) => callback(),
      lockCycle: async () => ({
        id: 88,
        salesOrderId: 456789,
        status: "in_progress",
        activityStartedAt: "2026-08-07T10:00:00.000Z"
      }),
      cancelCycle: async () => assert.fail("A started cycle must not be cancelled."),
      writeAudit: async () => assert.fail("A rejected cancellation must not write success audit.")
    }),
    (error) => error.code === "RELOAD_ALREADY_STARTED" && error.status === 409
  );

  const cancelled = await cancelSalesOrderReload({
    orderId: 456789,
    cycleId: 88,
    reason: "Already cancelled",
    actor: { id: "manager-1" }
  }, {
    withTransaction: async (callback) => callback(),
    lockCycle: async () => ({ id: 88, sales_order_id: 456789, status: "cancelled" }),
    cancelCycle: async () => assert.fail("An idempotent cancellation must not cancel twice."),
    writeAudit: async () => assert.fail("An idempotent cancellation must not audit twice.")
  });
  assert.equal(cancelled.status, "cancelled");

  await expectRejectCode(() => cancelSalesOrderReload({
    orderId: 456789,
    cycleId: 88,
    reason: "Missing cycle",
    actor: { id: "manager-1" }
  }, {
    withTransaction: async (callback) => callback(),
    lockCycle: async () => null
  }), "RELOAD_CYCLE_NOT_FOUND", 404);

  await expectRejectCode(() => cancelSalesOrderReload({
    orderId: 456789,
    cycleId: 88,
    reason: "Wrong order",
    actor: { id: "manager-1" }
  }, {
    withTransaction: async (callback) => callback(),
    lockCycle: async () => ({ id: 88, salesOrderId: 999999, status: "authorized" })
  }), "RELOAD_CYCLE_NOT_FOUND", 404);

  await expectRejectCode(() => cancelSalesOrderReload({
    orderId: 456789,
    cycleId: 88,
    reason: "Invalid status",
    actor: { id: "manager-1" }
  }, {
    withTransaction: async (callback) => callback(),
    lockCycle: async () => ({ id: 88, salesOrderId: 456789, status: null })
  }), "RELOAD_ALREADY_STARTED");
}

await expectRejectCode(() => cancelSalesOrderReload({
  orderId: 456789,
  cycleId: 0,
  reason: "Invalid cycle",
  actor: { id: "manager-1" }
}, {}), "RELOAD_CYCLE_ID_INVALID", 400);

await expectRejectCode(() => cancelSalesOrderReload({
  orderId: 456789,
  cycleId: 88,
  reason: "Missing actor"
}, {}), "RELOAD_ACTOR_REQUIRED", 401);

console.log("Sales Order re-load policy and service harness passed (6,480 quantity properties)." );
