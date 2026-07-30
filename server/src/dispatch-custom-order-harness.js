import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  cancelDispatchCustomOrder,
  canonicalizeDispatchCustomOrdersInPlan,
  completeDispatchCustomOrders,
  createDispatchCustomOrder,
  DispatchCustomOrderPlanError,
  dispatchOrderFromCustomOrder,
  getDispatchCustomOrder,
  listDispatchCustomOrders,
  updateDispatchCustomOrder
} from "./dispatch-custom-order-repository.js";
import {
  getYardMovementDetail,
  listYardMovementCsvRows,
  listYardMovements
} from "./yard-movement-repository.js";
import { getNextDispatchSplitSuffix } from "./delivery-repository.js";
import { dispatchPlannedOrderConflictRefs } from "./dispatch-plan-repository.js";

const [
  migrationSource,
  stopMinutesMigrationSource,
  planningSource,
  driverRepositorySource,
  planRepositorySource,
  serverSource,
  dispatchMenuSource,
  sidebarSource,
  customOrdersUiSource,
  customOrdersHtmlSource
] = await Promise.all([
  fs.readFile(new URL("../migrations/069_dispatch_custom_orders.sql", import.meta.url), "utf8"),
  fs.readFile(new URL("../migrations/086_dispatch_custom_order_stop_minutes.sql", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/dispatch.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./driver-repository.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./dispatch-plan-repository.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./server.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/dispatch-menu.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/app-sidebar.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/dispatch-custom-orders.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/dispatch-custom-orders.html", import.meta.url), "utf8")
]);

function assertStaticIntegration() {
  assert.match(
    planningSource,
    /if\s*\(\s*\[\s*"CUSTOM"\s*,\s*"CUSTOM_ORDER"\s*,\s*"LOCAL_CUSTOM"\s*,\s*"LOCAL_CUSTOM_ORDER"\s*\]\.includes\(text\)\s*\)\s*return\s+"CUSTOM"/,
    "Dispatch Planning must preserve CUSTOM as its own canonical order type."
  );
  assert.match(
    planningSource,
    /activeOrderType\s*===\s*"TO"\s*\?\s*\[\s*"TO"\s*,\s*"CUSTOM"\s*\]\.includes\(order\.type\)/,
    "The TO order-pool tab must include both NetSuite Transfer Orders and Custom Orders."
  );
  assert.match(
    planningSource,
    /\[\s*"SO"\s*,\s*"PO"\s*,\s*"TO"\s*,\s*"CO"\s*\]\.map\(\(type\)\s*=>/,
    "Custom Orders must stay inside the TO section instead of creating an extra planning tab."
  );
  assert.match(
    planningSource,
    /groupItems\.some\(\(item\)\s*=>\s*item\.type\s*===\s*"CUSTOM"\)[\s\S]{0,220}Custom Orders cannot be grouped/,
    "The planner must explicitly block grouping Custom Orders."
  );
  assert.match(
    planningSource,
    /!\[\s*"CO"\s*,\s*"CUSTOM"\s*\]\.includes\(order\.type\)[\s\S]{0,260}open-split-modal/,
    "The planner must not offer Split for a Custom Order."
  );
  assert.match(
    planningSource,
    /selected\.length\s*>\s*1\s*&&\s*!includesCustomOrder[\s\S]{0,180}open-group-modal/,
    "The planner must hide Group whenever the selection contains a Custom Order."
  );
  assert.match(
    driverRepositorySource,
    /function\s+planItemForPickup[\s\S]{0,500}orderType\s*\|\|\s*""\)\.trim\(\)\.toUpperCase\(\)\s*===\s*"CUSTOM"\)\s*return\s+item/,
    "Custom pickup manifests must use the plan's free-type LOAD detail instead of NetSuite allocation subtraction."
  );
  assert.match(
    driverRepositorySource,
    /typeHint\s*\|\|\s*""\)\.trim\(\)\.toUpperCase\(\)\s*===\s*"CUSTOM"\)[\s\S]{0,180}orderDetailsFromPlan/,
    "Driver order details for Custom Orders must come directly from the saved dispatch plan."
  );
  assert.match(
    serverSource,
    /includeCustom\s*=\s*!requestedType\s*\|\|\s*requestedType\s*===\s*"TO"\s*\|\|\s*requestedType\s*===\s*"CUSTOM"/,
    "The server-side TO feed must include open Custom Orders."
  );
  assert.ok(
    /canonicalizeDispatchCustomOrdersInPlan/.test(planRepositorySource),
    "Dispatch Plan persistence must transactionally rehydrate Custom Orders from the database."
  );
  assert.ok(
    (serverSource.match(/await\s+canonicalizeDispatchCustomOrdersInPlan\s*\(/g) || []).length >= 4,
    "Modern save, submitted confirm, snapshot restore, and legacy save candidates must be canonical before validation."
  );
  assert.match(
    serverSource,
    /app\.get\(\s*"\/api\/dispatch\/custom-orders"\s*,\s*requireDispatcher/,
    "The Custom Order management API must require a dispatcher login."
  );
  assert.match(
    serverSource,
    /app\.post\(\s*"\/api\/dispatch\/custom-orders"\s*,\s*requireDispatcher/,
    "The Custom Order creation API must require a dispatcher login."
  );
  assert.match(
    serverSource,
    /app\.put\(\s*"\/api\/dispatch\/custom-orders\/:id"\s*,\s*requireDispatcher/,
    "The Custom Order update API must require a dispatcher login."
  );
  assert.match(
    serverSource,
    /app\.delete\(\s*"\/api\/dispatch\/custom-orders\/:id"\s*,\s*requireDispatcher/,
    "The Custom Order cancellation API must require a dispatcher login."
  );
  assert.match(
    serverSource,
    /app\.get\(\s*"\/dispatch\/custom-orders"/,
    "The dispatcher-facing Custom Orders page route must be registered."
  );
  assert.match(
    dispatchMenuSource,
    /onclick="location\.href='\/dispatch\/custom-orders'"/,
    "The Dispatch menu must link to Custom Orders."
  );
  assert.match(
    sidebarSource,
    /\{\s*label:\s*"Custom Orders"\s*,\s*href:\s*"\/dispatch\/custom-orders"/,
    "The Dispatch sidebar must link to Custom Orders."
  );
  assert.match(
    stopMinutesMigrationSource,
    /ADD COLUMN IF NOT EXISTS stop_minutes integer[\s\S]*CHECK \(stop_minutes IS NULL OR stop_minutes BETWEEN 0 AND 1440\)/,
    "Custom Order destination stop time must be nullable for legacy rows and constrained to 0-1440 minutes."
  );
  assert.match(
    customOrdersUiSource,
    /name="stopMinutes"[\s\S]{0,300}min="0"[\s\S]{0,300}max="1440"[\s\S]{0,300}required/,
    "The Custom Order editor must require a destination stop-time value from 0 to 1440 minutes."
  );
  assert.match(
    customOrdersHtmlSource,
    /dispatch-custom-orders\.js\?v=20260730-stop-time-v1/,
    "The Custom Order editor must cache-bust the stop-time UI."
  );
  assert.match(
    planningSource,
    /current \+= stopStayMinutes\(stop, order, truck\)/,
    "The planning timeline must use the same Custom Order stop-time calculation as the route estimate."
  );
}

function validInput(refNumber, overrides = {}) {
  return {
    refNumber,
    pickupLocation: "North Quarry Gate, 81 External Road, Caledon ON",
    dropoffLocation: "Customer Site, 702 Destination Avenue, Toronto ON",
    orderDetails: "Two wrapped sample racks; call the receiving supervisor before unloading.",
    weightLbs: 2750.1256,
    stopMinutes: 47,
    ...overrides
  };
}

async function expectInputError(input, pattern, message) {
  await assert.rejects(
    createDispatchCustomOrder(input, "custom-order-harness"),
    (error) => {
      assert.equal(error?.status, 400);
      assert.equal(error?.code, "DISPATCH_CUSTOM_ORDER_INVALID");
      assert.match(String(error?.message || ""), pattern);
      return true;
    },
    message
  );
}

async function verifyRepositoryCrud(runId) {
  const primaryRef = `CUSTOM-HARNESS-${runId}`;
  const created = await createDispatchCustomOrder(validInput(primaryRef), "custom-order-harness");
  assert.ok(/^\d+$/.test(created.id), "Created Custom Orders must return their local numeric ID.");
  assert.equal(created.refNumber, primaryRef);
  assert.equal(created.status, "open");
  assert.equal(created.createdBy, "custom-order-harness");
  assert.equal(created.weightLbs, 2750.126, "Weight must be normalized to the table's three-decimal precision.");
  assert.equal(created.stopMinutes, 47);

  const fetched = await getDispatchCustomOrder(created.id);
  assert.deepEqual(fetched, created, "A newly created Custom Order must round-trip through the repository.");

  const searchResult = await listDispatchCustomOrders({
    includeCancelled: false,
    includeCompleted: false,
    search: "receiving supervisor"
  });
  assert.ok(
    searchResult.some((order) => order.id === created.id),
    "Management search must include free-typed Custom Order details."
  );

  const mapped = dispatchOrderFromCustomOrder(created);
  assert.equal(mapped.id, primaryRef);
  assert.equal(mapped.type, "CUSTOM");
  assert.equal(mapped.sourceTable, "dispatch_custom_orders");
  assert.equal(mapped.customOrderId, created.id);
  assert.equal(mapped.sourceYard, created.pickupLocation);
  assert.equal(mapped.sourceAddress, created.pickupLocation);
  assert.deepEqual(mapped.pickupLocations, [created.pickupLocation]);
  assert.equal(mapped.address, created.dropoffLocation);
  assert.equal(mapped.destinationAddress, created.dropoffLocation);
  assert.equal(mapped.destinationYard, created.dropoffLocation);
  assert.equal(mapped.instructions, created.orderDetails);
  assert.equal(mapped.weight, created.weightLbs);
  assert.equal(mapped.stopMinutes, 47);
  assert.equal(mapped.raw.stop_minutes, 47);
  assert.equal(mapped.items.length, 1, "A free-typed Custom Order must expose one dispatch LOAD detail line.");
  assert.equal(mapped.items[0].unit, "LOAD");
  assert.equal(mapped.items[0].quantity, 1);
  assert.equal(mapped.items[0].salesQty, 1);
  assert.equal(mapped.items[0].description, created.orderDetails);
  assert.equal(mapped.items[0].itemWeight, created.weightLbs);
  assert.equal(mapped.items[0].lineWeight, created.weightLbs);

  const updated = await updateDispatchCustomOrder(created.id, validInput(primaryRef, {
    pickupLocation: "Temporary Vendor Dock, 9 Unmapped Lane, Guelph ON",
    dropoffLocation: "Trade Show Hall C, 40 Convention Way, Toronto ON",
    orderDetails: "One display crate and loose signs. Ask for booth 403.",
    weightLbs: 812.5,
    stopMinutes: 62
  }), "custom-order-editor");
  assert.equal(updated.refNumber, primaryRef, "The reference must stay stable after an edit.");
  assert.equal(updated.pickupLocation, "Temporary Vendor Dock, 9 Unmapped Lane, Guelph ON");
  assert.equal(updated.dropoffLocation, "Trade Show Hall C, 40 Convention Way, Toronto ON");
  assert.equal(updated.orderDetails, "One display crate and loose signs. Ask for booth 403.");
  assert.equal(updated.weightLbs, 812.5);
  assert.equal(updated.stopMinutes, 62);
  assert.equal(updated.updatedBy, "custom-order-editor");

  await assert.rejects(
    updateDispatchCustomOrder(created.id, validInput(`${primaryRef}-CHANGED`), "custom-order-editor"),
    (error) => {
      assert.equal(error?.status, 409);
      assert.equal(error?.code, "DISPATCH_CUSTOM_ORDER_REF_LOCKED");
      return true;
    },
    "A Custom Order reference must be locked after creation."
  );

  await assert.rejects(
    createDispatchCustomOrder(validInput(primaryRef.toLowerCase()), "duplicate-harness"),
    (error) => {
      assert.equal(error?.status, 409);
      assert.equal(error?.code, "DISPATCH_CUSTOM_ORDER_REF_EXISTS");
      assert.match(error.message, /already used/i);
      return true;
    },
    "Custom Order references must be unique without regard to case."
  );

  await createDispatchCustomOrder(
    validInput(`${primaryRef}-S7`, { orderDetails: "Reserved split suffix fixture." }),
    "custom-order-harness"
  );
  const nextSplit = await getNextDispatchSplitSuffix({
    originalOrderId: primaryRef,
    orderType: "SO"
  });
  assert.equal(
    nextSplit.nextSuffix,
    8,
    "Future dispatch split IDs must skip references already reserved by Custom Orders."
  );

  await expectInputError(
    validInput("", {}),
    /Reference number is required/i,
    "Blank references must be rejected."
  );
  await expectInputError(
    validInput(`${primaryRef}-NO-PICKUP`, { pickupLocation: " " }),
    /Pickup location\/address is required/i,
    "Blank pickup locations must be rejected."
  );
  await expectInputError(
    validInput(`${primaryRef}-NO-DROPOFF`, { dropoffLocation: "" }),
    /Drop-off location\/address is required/i,
    "Blank drop-off locations must be rejected."
  );
  await expectInputError(
    validInput(`${primaryRef}-NO-DETAILS`, { orderDetails: "" }),
    /Order details is required/i,
    "Blank free-typed details must be rejected."
  );
  await expectInputError(
    validInput(`${primaryRef}-ZERO-WEIGHT`, { weightLbs: 0 }),
    /Weight must be greater than zero/i,
    "Zero weight must be rejected."
  );
  await expectInputError(
    validInput(`${primaryRef}-HUGE-WEIGHT`, { weightLbs: 1000000.001 }),
    /Weight must be .* or less/i,
    "Unreasonably large weight must be rejected."
  );
  await expectInputError(
    validInput(`${primaryRef}-NEGATIVE-STOP`, { stopMinutes: -1 }),
    /Destination stop time must be a whole number from 0 to 1440 minutes/i,
    "Negative destination stop time must be rejected."
  );
  await expectInputError(
    validInput(`${primaryRef}-FRACTIONAL-STOP`, { stopMinutes: 12.5 }),
    /Destination stop time must be a whole number from 0 to 1440 minutes/i,
    "Fractional destination stop time must be rejected."
  );
  await expectInputError(
    validInput(`${primaryRef}-HUGE-STOP`, { stopMinutes: 1441 }),
    /Destination stop time must be a whole number from 0 to 1440 minutes/i,
    "Destination stop time above one day must be rejected."
  );

  const legacy = await createDispatchCustomOrder(
    validInput(`${primaryRef}-LEGACY`, { stopMinutes: undefined }),
    "legacy-custom-order-client"
  );
  assert.equal(legacy.stopMinutes, null, "Older clients may omit destination stop time.");
  assert.equal(
    dispatchOrderFromCustomOrder(legacy).stopMinutes,
    null,
    "Legacy Custom Orders must retain the planner's per-driver delivery timing fallback."
  );

  return { created, updated };
}

async function verifyStatusFiltering(runId) {
  const cancelledRef = `CUSTOM-CANCELLED-${runId}`;
  const cancelledCreated = await createDispatchCustomOrder(
    validInput(cancelledRef, { orderDetails: "Cancelled filtering fixture." }),
    "custom-order-harness"
  );
  const cancelled = await cancelDispatchCustomOrder(cancelledCreated.id, "custom-order-canceller");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelledBy, "custom-order-canceller");
  assert.ok(cancelled.cancelledAt);

  const hiddenCancelled = await listDispatchCustomOrders({
    includeCancelled: false,
    includeCompleted: true,
    search: cancelledRef
  });
  assert.equal(hiddenCancelled.length, 0, "Cancelled Custom Orders must be excluded from the dispatch feed.");
  const visibleCancelled = await listDispatchCustomOrders({
    includeCancelled: true,
    includeCompleted: true,
    search: cancelledRef
  });
  assert.equal(visibleCancelled.length, 1, "Management can explicitly include cancelled Custom Orders.");
  assert.equal(visibleCancelled[0].status, "cancelled");
  await assert.rejects(
    createDispatchCustomOrder(validInput(cancelledRef), "custom-order-harness"),
    (error) => {
      assert.equal(error?.status, 409);
      assert.equal(error?.code, "DISPATCH_CUSTOM_ORDER_REF_EXISTS");
      return true;
    },
    "Cancelled Custom Order references must remain reserved for historical driver-record integrity."
  );

  const completedRef = `CUSTOM-COMPLETED-${runId}`;
  const completedCreated = await createDispatchCustomOrder(
    validInput(completedRef, { orderDetails: "Completed filtering fixture.", weightLbs: 1100 }),
    "custom-order-harness"
  );
  const completedRows = await completeDispatchCustomOrders(
    [completedRef.toLowerCase(), completedRef],
    "driver:custom-order-harness"
  );
  assert.equal(completedRows.length, 1, "Completion must de-duplicate reference values case-insensitively.");
  assert.equal(completedRows[0].id, completedCreated.id);
  assert.equal(completedRows[0].status, "completed");
  assert.ok(completedRows[0].completedAt);

  const hiddenCompleted = await listDispatchCustomOrders({
    includeCancelled: false,
    includeCompleted: false,
    search: completedRef
  });
  assert.equal(hiddenCompleted.length, 0, "Completed Custom Orders must be excluded from the open planning feed.");
  const visibleCompleted = await listDispatchCustomOrders({
    includeCancelled: false,
    includeCompleted: true,
    search: completedRef
  });
  assert.equal(visibleCompleted.length, 1, "Management can include completed Custom Orders.");
  assert.equal(visibleCompleted[0].status, "completed");
}

function submittedCustomPlan(customOrder, {
  clientRef = customOrder.refNumber,
  clientDispatchRef = customOrder.refNumber,
  includePickup = true,
  pickupAfterDrop = false,
  loadId = `LOAD-${customOrder.id}`,
  pickStopId = `PICK-${customOrder.id}`,
  dropStopId = `DROP-${customOrder.id}`
} = {}) {
  const clientOrder = {
    ...dispatchOrderFromCustomOrder(customOrder),
    id: clientRef,
    dispatchRef: clientDispatchRef,
    type: "SO",
    sourceTable: "sales_orders",
    customer: "Attacker supplied party",
    sourceYard: "Attacker pickup",
    sourceAddress: "Attacker pickup",
    defaultSourceAddress: "Attacker pickup",
    pickupAddressOverride: "Attacker pickup",
    pickupLocations: ["Attacker pickup"],
    address: "Attacker drop-off",
    destinationAddress: "Attacker drop-off",
    destinationYard: "Attacker drop-off",
    instructions: "Attacker supplied details",
    notes: "Attacker supplied details",
    stopMinutes: 1,
    weight: 999999,
    items: [{
      lineRowId: "attacker-line",
      lineId: 400,
      sku: "ATTACKER",
      itemName: "Attacker item",
      description: "Attacker supplied details",
      quantity: 999,
      salesQty: 999,
      unit: "PCS",
      itemWeight: 1,
      lineWeight: 999999
    }],
    originalOrderId: "SO-MALICIOUS-PARENT",
    originalPallets: 999,
    childOrders: ["SO-MALICIOUS-CHILD"],
    childOrderDetails: [{ id: "SO-MALICIOUS-CHILD", type: "SO" }],
    groupAliases: ["MALICIOUS-GROUP"],
    groupRef: "MALICIOUS-GROUP",
    grouped: true,
    groupedAt: "2099-01-01T00:00:00.000Z"
  };
  const pickup = {
    id: pickStopId,
    loadId,
    orderId: clientRef,
    type: "pick",
    location: "Attacker pickup"
  };
  const drop = {
    id: dropStopId,
    loadId,
    orderId: clientRef,
    type: "drop",
    location: "Attacker drop-off"
  };
  const customStops = includePickup
    ? pickupAfterDrop ? [drop, pickup] : [pickup, drop]
    : [drop];
  return {
    id: `PLAN-${customOrder.id}`,
    planDate: "2098-08-17",
    orders: [clientOrder],
    trucks: [{
      id: `TRUCK-${customOrder.id}`,
      plate: "CUS-001",
      loads: [{
        id: loadId,
        name: "Custom canonicalization load",
        stops: [
          { id: `UNRELATED-${customOrder.id}`, loadId, orderId: "SO-UNRELATED", type: "drop", location: "Unrelated stop" },
          ...customStops
        ]
      }]
    }]
  };
}

function customStops(plan, refNumber) {
  return (plan.trucks || []).flatMap((truck) =>
    (truck.loads || []).flatMap((load) =>
      (load.stops || [])
        .filter((stop) => String(stop.orderId || "") === refNumber)
        .map((stop) => ({ ...stop, parentLoadId: load.id }))
    )
  );
}

async function expectPlanError(action, messagePattern, assertionMessage) {
  await assert.rejects(
    action,
    (error) => {
      assert.ok(
        error instanceof DispatchCustomOrderPlanError,
        `Expected DispatchCustomOrderPlanError, received ${error?.constructor?.name || typeof error}.`
      );
      assert.equal(error?.status, 409);
      assert.match(String(error?.message || ""), messagePattern);
      return true;
    },
    assertionMessage
  );
}

async function verifyBackendCanonicalization(runId) {
  const suffixRef = `CUSTOM-CANON-${runId}-S1`;
  const stored = await createDispatchCustomOrder(validInput(suffixRef, {
    pickupLocation: "Canonical Pickup, 101 Trusted Source Road, Barrie ON",
    dropoffLocation: "Canonical Drop-off, 202 Trusted Destination Road, Toronto ON",
    orderDetails: "Canonical DB detail: one dedicated machinery load.",
    weightLbs: 4321.25
  }), "custom-order-harness");

  const maliciousPlan = submittedCustomPlan(stored, {
    includePickup: false
  });
  const canonicalPlan = await canonicalizeDispatchCustomOrdersInPlan(maliciousPlan);
  assert.equal(canonicalPlan.orders.length, 1, "A Custom reference ending in -S1 must remain one independent order.");
  const canonical = canonicalPlan.orders[0];
  assert.equal(canonical.id, suffixRef, "The immutable database reference must remain authoritative.");
  assert.equal(canonical.customOrderId, stored.id);
  assert.equal(canonical.type, "CUSTOM");
  assert.equal(canonical.sourceTable, "dispatch_custom_orders");
  assert.equal(canonical.dispatchRef, suffixRef);
  assert.equal(canonical.sourceYard, stored.pickupLocation);
  assert.equal(canonical.sourceAddress, stored.pickupLocation);
  assert.deepEqual(canonical.pickupLocations, [stored.pickupLocation]);
  assert.equal(canonical.address, stored.dropoffLocation);
  assert.equal(canonical.destinationAddress, stored.dropoffLocation);
  assert.equal(canonical.destinationYard, stored.dropoffLocation);
  assert.equal(canonical.instructions, stored.orderDetails);
  assert.equal(canonical.notes, stored.orderDetails);
  assert.equal(canonical.stopMinutes, stored.stopMinutes, "The stored destination stop time must defeat a client plan override.");
  assert.equal(canonical.weight, stored.weightLbs);
  assert.equal(canonical.items.length, 1);
  assert.equal(canonical.items[0].description, stored.orderDetails);
  assert.equal(canonical.items[0].unit, "LOAD");
  assert.equal(canonical.items[0].quantity, 1);
  assert.equal(canonical.items[0].lineWeight, stored.weightLbs);
  assert.ok(!canonical.originalOrderId, "A -S1 suffix must not turn a Custom Order into a split child.");
  assert.ok(!canonical.originalPallets, "Stale split capacity metadata must be removed.");
  assert.deepEqual(canonical.childOrders || [], [], "Client-supplied group members must be removed.");
  assert.deepEqual(canonical.childOrderDetails || [], [], "Client-supplied group detail must be removed.");
  assert.deepEqual(canonical.groupAliases || [], [], "Client-supplied group aliases must be removed.");
  assert.ok(!canonical.groupRef, "Client-supplied group references must be removed.");
  assert.ok(!canonical.grouped, "Client-supplied grouped flags must be removed.");
  assert.ok(!canonical.groupedAt, "Client-supplied grouping timestamps must be removed.");

  const canonicalStops = customStops(canonicalPlan, suffixRef);
  const pickupIndex = canonicalStops.findIndex((stop) => stop.type === "pick");
  const dropIndex = canonicalStops.findIndex((stop) => stop.type === "drop");
  assert.ok(pickupIndex >= 0, "The backend must insert a missing Custom pickup stop.");
  assert.ok(dropIndex >= 0, "The submitted Custom drop must remain assigned.");
  assert.ok(pickupIndex < dropIndex, "The canonical Custom pickup must occur before its drop.");
  assert.equal(canonicalStops[pickupIndex].location, stored.pickupLocation);
  assert.equal(canonicalStops[dropIndex].location, stored.dropoffLocation);
  assert.equal(canonicalStops[pickupIndex].loadId, canonicalStops[pickupIndex].parentLoadId);
  assert.equal(canonicalStops[dropIndex].loadId, canonicalStops[dropIndex].parentLoadId);
  const unrelated = canonicalPlan.trucks[0].loads[0].stops.find((stop) => stop.orderId === "SO-UNRELATED");
  assert.equal(unrelated?.location, "Unrelated stop", "Canonicalization must not rewrite another order's stops.");

  const aliasHijackRef = `SOB-HIJACK-${runId}`;
  const aliasHijackPlan = submittedCustomPlan(stored, { clientRef: aliasHijackRef });
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(aliasHijackPlan),
    /reference|ref|identity|match/i,
    "A valid Custom Order ID must not authorize replacing its immutable reference with a normal-order alias."
  );
  const refMismatchPlan = submittedCustomPlan(stored, {
    clientDispatchRef: `SOB-REF-HIJACK-${runId}`
  });
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(refMismatchPlan),
    /reference|ref|identity|match/i,
    "A mismatched dispatch reference must be rejected even when order.id and customOrderId are valid."
  );

  const duplicateDropPlan = submittedCustomPlan(stored);
  const duplicateLoad = structuredClone(duplicateDropPlan.trucks[0].loads[0]);
  duplicateLoad.id = `${duplicateLoad.id}-DUPLICATE`;
  duplicateLoad.name = "Duplicate Custom load";
  duplicateLoad.stops = duplicateLoad.stops
    .filter((stop) => stop.orderId === stored.refNumber && stop.type === "drop")
    .map((stop) => ({
      ...stop,
      id: `${stop.id}-DUPLICATE`,
      loadId: duplicateLoad.id
    }));
  duplicateDropPlan.trucks[0].loads.push(duplicateLoad);
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(duplicateDropPlan),
    /more than one drop|assigned only once/i,
    "The backend must reject the same Custom Order when it is dropped in two loads."
  );

  const pickupOnlyPlan = submittedCustomPlan(stored);
  pickupOnlyPlan.trucks[0].loads[0].stops = pickupOnlyPlan.trucks[0].loads[0].stops.filter((stop) =>
    stop.orderId !== stored.refNumber || stop.type !== "drop"
  );
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(pickupOnlyPlan),
    /pickup.*without.*drop|orphan pickup/i,
    "The backend must reject an orphan Custom pickup that could create an empty driver job."
  );

  const duplicatePickupPlan = submittedCustomPlan(stored);
  const duplicatePickup = structuredClone(
    duplicatePickupPlan.trucks[0].loads[0].stops.find((stop) =>
      stop.orderId === stored.refNumber && stop.type === "pick"
    )
  );
  duplicatePickup.id = `${duplicatePickup.id}-DUPLICATE`;
  duplicatePickupPlan.trucks[0].loads[0].stops.unshift(duplicatePickup);
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(duplicatePickupPlan),
    /more than one owned pickup|must use one load/i,
    "The backend must reject duplicate Custom-owned pickups that could produce duplicate driver jobs."
  );

  const pickupAfterDropPlan = submittedCustomPlan(stored, { pickupAfterDrop: true });
  const reorderedPlan = await canonicalizeDispatchCustomOrdersInPlan(pickupAfterDropPlan);
  const reorderedStops = customStops(reorderedPlan, stored.refNumber);
  assert.equal(reorderedStops.length, 2, "Reordering a Custom pickup must not duplicate its stop.");
  assert.ok(
    reorderedStops.findIndex((stop) => stop.type === "pick")
      < reorderedStops.findIndex((stop) => stop.type === "drop"),
    "A Custom-owned pickup submitted after its drop must be moved before the drop."
  );

  const secondDatePlan = structuredClone(canonicalPlan);
  secondDatePlan.id = `${canonicalPlan.id}-OTHER-DATE`;
  secondDatePlan.planDate = "2098-08-18";
  assert.ok(
    dispatchPlannedOrderConflictRefs(canonicalPlan, secondDatePlan).has(suffixRef),
    "The exact same Custom Order must remain exclusive across dispatch plan dates."
  );
  const suffixParentRef = suffixRef.replace(/-S1$/i, "");
  const apparentParentPlan = {
    id: "APPARENT-PARENT-PLAN",
    planDate: canonicalPlan.planDate,
    orders: [{ id: suffixParentRef, type: "SO" }],
    trucks: [{
      id: "APPARENT-PARENT-TRUCK",
      loads: [{
        id: "APPARENT-PARENT-LOAD",
        name: "Apparent parent load",
        stops: [{
          id: "APPARENT-PARENT-DROP",
          loadId: "APPARENT-PARENT-LOAD",
          orderId: suffixParentRef,
          type: "drop",
          location: "Unrelated parent destination"
        }]
      }]
    }]
  };
  assert.deepEqual(
    [...dispatchPlannedOrderConflictRefs(canonicalPlan, apparentParentPlan)],
    [],
    "A legitimate Custom reference ending in -S1 must not conflict with an apparent split parent."
  );
  assert.deepEqual(
    [...dispatchPlannedOrderConflictRefs(apparentParentPlan, canonicalPlan)],
    [],
    "Split-parent inference must ignore CUSTOM snapshots in either comparison direction."
  );

  const missingPlan = submittedCustomPlan({
    ...stored,
    id: "987654321012345",
    refNumber: `CUSTOM-MISSING-${runId}`
  });
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(missingPlan),
    /not found|no longer exists|missing/i,
    "A client must not invent a Custom Order that has no database record."
  );

  const cancelled = await createDispatchCustomOrder(validInput(`CUSTOM-CANON-CANCELLED-${runId}`), "custom-order-harness");
  const cancelledPlan = submittedCustomPlan(cancelled);
  await cancelDispatchCustomOrder(cancelled.id, "custom-order-harness");
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(cancelledPlan),
    /cancelled|no longer open/i,
    "A cancelled Custom Order must be rejected even if an old browser still submits it."
  );

  const newlyCompleted = await createDispatchCustomOrder(
    validInput(`CUSTOM-CANON-NEW-COMPLETE-${runId}`),
    "custom-order-harness"
  );
  const newlyCompletedPlan = submittedCustomPlan(newlyCompleted);
  await completeDispatchCustomOrders([newlyCompleted.refNumber], "driver:custom-order-harness");
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(newlyCompletedPlan),
    /completed|delivered|already complete/i,
    "A newly introduced Custom Order that has already completed must not be added to a plan."
  );

  const unrelatedOnlyPlan = {
    id: `UNRELATED-AUTOSAVE-${runId}`,
    planDate: "2098-08-17",
    orders: [{
      id: `SO-UNRELATED-${runId}`,
      type: "SO",
      customer: "Unrelated autosave customer",
      childOrders: []
    }],
    trucks: [{
      id: `TRUCK-UNRELATED-${runId}`,
      plate: "UNR-001",
      loads: [{
        id: `LOAD-UNRELATED-${runId}`,
        name: "Unrelated autosave load",
        stops: [{
          id: `DROP-UNRELATED-${runId}`,
          loadId: `LOAD-UNRELATED-${runId}`,
          orderId: `SO-UNRELATED-${runId}`,
          type: "drop",
          location: "Unrelated autosave destination"
        }]
      }]
    }]
  };
  const staleCatalogPlan = structuredClone(unrelatedOnlyPlan);
  staleCatalogPlan.orders.push(
    missingPlan.orders[0],
    cancelledPlan.orders[0],
    newlyCompletedPlan.orders[0]
  );
  const prunedCatalogPlan = await canonicalizeDispatchCustomOrdersInPlan(
    staleCatalogPlan,
    { previousPlan: unrelatedOnlyPlan }
  );
  assert.deepEqual(
    prunedCatalogPlan.orders.map((order) => order.id),
    [`SO-UNRELATED-${runId}`],
    "Missing, cancelled, and completed Custom catalog rows with no assigned stop must be pruned."
  );
  assert.deepEqual(
    prunedCatalogPlan.trucks,
    unrelatedOnlyPlan.trucks,
    "Inactive unassigned Custom catalog rows must not block or mutate an unrelated autosave."
  );

  const sharedPickupLocation = "Shared Custom Pickup, 77 Consolidation Road, Vaughan ON";
  const sharedFirst = await createDispatchCustomOrder(validInput(`CUSTOM-SHARED-A-${runId}`, {
    pickupLocation: sharedPickupLocation,
    dropoffLocation: "Shared A Destination, 10 First Street, Toronto ON",
    orderDetails: "Shared pickup load A.",
    weightLbs: 500
  }), "custom-order-harness");
  const sharedSecond = await createDispatchCustomOrder(validInput(`CUSTOM-SHARED-B-${runId}`, {
    pickupLocation: sharedPickupLocation,
    dropoffLocation: "Shared B Destination, 20 Second Street, Toronto ON",
    orderDetails: "Shared pickup load B.",
    weightLbs: 600
  }), "custom-order-harness");
  const sharedLoadId = `LOAD-SHARED-${runId}`;
  const sharedPlan = submittedCustomPlan(sharedFirst, {
    loadId: sharedLoadId,
    includePickup: true
  });
  const sharedSecondPlan = submittedCustomPlan(sharedSecond, {
    loadId: sharedLoadId,
    includePickup: false
  });
  sharedPlan.orders.push(sharedSecondPlan.orders[0]);
  sharedPlan.trucks[0].loads[0].stops.push(
    ...sharedSecondPlan.trucks[0].loads[0].stops.filter((stop) => stop.orderId === sharedSecond.refNumber)
  );
  const canonicalSharedPlan = await canonicalizeDispatchCustomOrdersInPlan(sharedPlan);
  const sharedStops = canonicalSharedPlan.trucks[0].loads[0].stops;
  const sharedPickupIndexes = sharedStops
    .map((stop, index) => ({ stop, index }))
    .filter(({ stop }) => stop.type === "pick" && stop.location === sharedPickupLocation);
  assert.equal(
    sharedPickupIndexes.length,
    1,
    "Custom Orders at the same physical pickup must share one canonical pickup stop."
  );
  for (const customOrder of [sharedFirst, sharedSecond]) {
    const dropIndex = sharedStops.findIndex((stop) =>
      stop.type === "drop" && stop.orderId === customOrder.refNumber
    );
    assert.ok(dropIndex > sharedPickupIndexes[0].index, `${customOrder.refNumber} must drop after the shared pickup.`);
    assert.equal(
      sharedStops[dropIndex].location,
      customOrder.dropoffLocation,
      `${customOrder.refNumber} must use its own canonical drop-off.`
    );
  }

  const historical = await createDispatchCustomOrder(
    validInput(`CUSTOM-CANON-HISTORICAL-${runId}`, {
      pickupLocation: "Historical Pickup, 11 History Road, Toronto ON",
      dropoffLocation: "Historical Drop-off, 12 Archive Road, Toronto ON",
      orderDetails: "Historical completed load.",
      weightLbs: 900
    }),
    "custom-order-harness"
  );
  const previousPlan = await canonicalizeDispatchCustomOrdersInPlan(submittedCustomPlan(historical));
  await completeDispatchCustomOrders([historical.refNumber], "driver:custom-order-harness");
  const staleHistorical = structuredClone(previousPlan);
  staleHistorical.orders[0].weight = 1;
  staleHistorical.orders[0].notes = "Stale browser value after driver completion";
  staleHistorical.orders[0].items = [];
  const preservedHistorical = await canonicalizeDispatchCustomOrdersInPlan(
    staleHistorical,
    { previousPlan }
  );
  assert.equal(preservedHistorical.orders[0].weight, historical.weightLbs);
  assert.equal(preservedHistorical.orders[0].notes, historical.orderDetails);
  assert.equal(preservedHistorical.orders[0].items.length, 1);
  assert.equal(
    customStops(preservedHistorical, historical.refNumber).length,
    customStops(previousPlan, historical.refNumber).length,
    "An unchanged historical completed assignment must remain saveable."
  );

  const movedHistorical = structuredClone(previousPlan);
  movedHistorical.trucks[0].loads[0].id = `${movedHistorical.trucks[0].loads[0].id}-MOVED`;
  for (const stop of movedHistorical.trucks[0].loads[0].stops) {
    stop.loadId = movedHistorical.trucks[0].loads[0].id;
  }
  await expectPlanError(
    canonicalizeDispatchCustomOrdersInPlan(movedHistorical, { previousPlan }),
    /completed|delivered|cannot be moved|historical/i,
    "Completed Custom work must not use the historical allowance after its load identity changes."
  );
}

async function verifyDriverOnlyRecord(runId) {
  const refNumber = `CUSTOM-DRIVER-${runId}`;
  const fixtureDate = "2098-08-17";
  const customOrder = await createDispatchCustomOrder(validInput(refNumber, {
    pickupLocation: "Offsite Fabricator, 18 Industrial Crescent, Vaughan ON",
    dropoffLocation: "Event Loading Door, 255 Front Street, Toronto ON",
    orderDetails: "Deliver one 1,640 lb exhibition frame.",
    weightLbs: 1640
  }), "custom-order-harness");
  const photos = [
    "data:image/png;base64,Y3VzdG9tLWRyaXZlci1waG90by0x",
    "data:image/png;base64,Y3VzdG9tLWRyaXZlci1waG90by0y"
  ];
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
       stop_id, stop_type, order_refs, photo_data_urls, status,
       started_at, completed_at, job_details
     ) VALUES (
       $1, $2::date, 'custom-order-harness-driver', 'CUSTOM-HARNESS-TRUCK', 'CUS-001',
       'CUSTOM-HARNESS-LOAD', 'Custom Harness Load',
       'CUSTOM-HARNESS-DROPOFF', 'dropoff', $3::jsonb, $4::jsonb, 'complete',
       $5::timestamptz, $6::timestamptz, $7::jsonb
     )`,
    [
      `JOB-CUSTOM-${runId}`,
      fixtureDate,
      JSON.stringify([refNumber]),
      JSON.stringify(photos),
      `${fixtureDate}T13:00:00.000Z`,
      `${fixtureDate}T13:45:00.000Z`,
      JSON.stringify({
        driverName: "Custom Harness Driver",
        location: customOrder.dropoffLocation,
        address: customOrder.dropoffLocation,
        orderTypes: ["CUSTOM"],
        orders: [{
          orderRef: refNumber,
          type: "CUSTOM",
          party: "Custom Order",
          items: [{
            itemName: "Custom order",
            sku: "CUSTOM",
            description: customOrder.orderDetails,
            units: [{ label: "LOAD", value: 1 }]
          }]
        }]
      })
    ]
  );

  const filters = {
    from: fixtureDate,
    to: fixtureDate,
    yard: "all",
    direction: "outbound",
    orderType: "custom_order",
    search: refNumber
  };
  const movements = await listYardMovements(filters);
  assert.equal(movements.length, 1, "A completed Custom driver stop must create one In/Outbound Record.");
  const movement = movements[0];
  assert.equal(String(movement.order_id), customOrder.id);
  assert.equal(movement.tranid, refNumber);
  assert.equal(movement.order_type, "custom_order");
  assert.equal(movement.direction, "outbound");
  assert.equal(movement.source_location, customOrder.pickupLocation);
  assert.equal(movement.destination_location, customOrder.dropoffLocation);
  assert.equal(movement.driver_only, true, "The delivery must be visible even without a Yard processing record.");
  assert.equal(movement.has_yard_record, false);
  assert.equal(movement.has_driver_record, true);
  assert.equal(movement.driver_record_count, 1);
  assert.equal(movement.driver_photo_count, 2);
  assert.ok(movement.delivery_at);

  const detail = await getYardMovementDetail({
    direction: movement.direction,
    orderType: movement.order_type,
    orderId: movement.order_id,
    from: fixtureDate,
    to: fixtureDate
  });
  assert.ok(detail, "Custom driver-only movement detail must be available.");
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.lines[0].processed_uom, "LOAD");
  assert.equal(Number(detail.lines[0].processed_qty), 1);
  assert.equal(detail.lines[0].item_description, customOrder.orderDetails);
  assert.equal(detail.driverRecords.length, 1);
  assert.equal(detail.driverRecords[0].stop_type, "dropoff");
  assert.equal(detail.driverRecords[0].status, "complete");
  assert.equal(detail.driverPhotos.length, 2);

  const csvRows = await listYardMovementCsvRows(filters);
  assert.equal(csvRows.length, 1);
  assert.equal(csvRows[0].order_ref, refNumber);
  assert.equal(csvRows[0].order_type, "custom_order");
  assert.equal(csvRows[0].driver_only, true);
  assert.equal(csvRows[0].processed_uom, "LOAD");
  assert.equal(csvRows[0].item_description, customOrder.orderDetails);
}

async function verifyExactSalesStoreYardScope(runId) {
  const fixtureDate = "2098-08-17";
  const scopedRefPrefix = `CUSTOM-SCOPE-${runId}`;
  const exactYardOrder = await createDispatchCustomOrder(validInput(`${scopedRefPrefix}-EXACT`, {
    pickupLocation: "150",
    dropoffLocation: "Exact yard-code destination",
    orderDetails: "Exact yard-code scope fixture.",
    weightLbs: 500
  }), "custom-order-harness");
  const offsiteOrder = await createDispatchCustomOrder(validInput(`${scopedRefPrefix}-OFFSITE`, {
    pickupLocation: "150 Main St, Toronto ON",
    dropoffLocation: "Offsite destination",
    orderDetails: "Offsite address scope fixture.",
    weightLbs: 600
  }), "custom-order-harness");

  for (const [index, customOrder] of [exactYardOrder, offsiteOrder].entries()) {
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_date, driver_login, truck_id, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, photo_data_urls, status,
         started_at, completed_at, job_details
       ) VALUES (
         $1, $2::date, 'custom-order-scope-driver', 'CUSTOM-SCOPE-TRUCK', 'CUS-150',
         $3, 'Custom Scope Load',
         $4, 'dropoff', $5::jsonb, '[]'::jsonb, 'complete',
         $6::timestamptz, $7::timestamptz, $8::jsonb
       )`,
      [
        `JOB-CUSTOM-SCOPE-${runId}-${index}`,
        fixtureDate,
        `CUSTOM-SCOPE-LOAD-${runId}-${index}`,
        `CUSTOM-SCOPE-DROPOFF-${runId}-${index}`,
        JSON.stringify([customOrder.refNumber]),
        `${fixtureDate}T15:0${index}:00.000Z`,
        `${fixtureDate}T15:1${index}:00.000Z`,
        JSON.stringify({
          driverName: "Custom Scope Driver",
          location: customOrder.dropoffLocation,
          address: customOrder.dropoffLocation,
          orderTypes: ["CUSTOM"]
        })
      ]
    );
  }

  const unscoped = await listYardMovements({
    from: fixtureDate,
    to: fixtureDate,
    direction: "outbound",
    orderType: "custom_order",
    search: scopedRefPrefix
  });
  assert.deepEqual(
    new Set(unscoped.map((movement) => movement.tranid)),
    new Set([exactYardOrder.refNumber, offsiteOrder.refNumber]),
    "Both exact-yard and offsite Custom records must remain visible without a Sales store scope."
  );

  const yard150Scoped = await listYardMovements({
    from: fixtureDate,
    to: fixtureDate,
    direction: "outbound",
    orderType: "custom_order",
    search: scopedRefPrefix,
    allowedSalesStoreLocationIds: [26]
  });
  assert.deepEqual(
    yard150Scoped.map((movement) => movement.tranid),
    [exactYardOrder.refNumber],
    "Sales store 150 must include the exact Custom pickup code but exclude an offsite address containing 150."
  );
}

assertStaticIntegration();

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('dispatch-custom-order-harness'))");
    await query(migrationSource);
    await query(stopMinutesMigrationSource);

    const runId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await verifyRepositoryCrud(runId);
    await verifyStatusFiltering(runId);
    await verifyBackendCanonicalization(runId);
    await verifyDriverOnlyRecord(runId);
    await verifyExactSalesStoreYardScope(runId);

    console.log(JSON.stringify({
      ok: true,
      repositoryCrud: true,
      validationAndCaseInsensitiveDuplicates: true,
      customDispatchMapper: true,
      customDestinationStopTime: true,
      legacyStopTimeFallback: true,
      backendCanonicalization: true,
      immutableReferenceGuard: true,
      crossDateAssignmentExclusivity: true,
      customSplitSuffixIdentity: true,
      inactiveUnassignedCatalogPruning: true,
      sharedCanonicalPickup: true,
      historicalCompletedAssignmentGuard: true,
      toPlanningSectionIntegration: true,
      groupingAndSplittingBlocked: true,
      driverManifestFromPlan: true,
      cancelledAndCompletedFeedFiltering: true,
      driverOnlyInboundOutboundRecord: true,
      exactCustomSalesStoreYardScope: true,
      dispatcherMenuAndApiRoutes: true,
      rolledBack: true
    }));
  });
} finally {
  await rollback.rollback();
  await closeDb();
}
