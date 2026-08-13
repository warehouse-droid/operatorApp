import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");

const [setupUi, plannerUi, repository, setupHtml, plannerHtml] = await Promise.all([
  fs.readFile(path.join(publicDir, "dispatch-setup.js"), "utf8"),
  fs.readFile(path.join(publicDir, "dispatch.js"), "utf8"),
  fs.readFile(path.join(dirname, "dispatch-setup-repository.js"), "utf8"),
  fs.readFile(path.join(publicDir, "dispatch-setup.html"), "utf8"),
  fs.readFile(path.join(publicDir, "dispatch.html"), "utf8")
]);

function sourceRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0, `Missing source marker: ${startMarker}`);
  assert(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const setupFunctions = [
  sourceRange(setupUi, "function setupRecordActive", "function validateUniqueDriverLogins"),
  sourceRange(setupUi, "function moveSetupDriver", "function renderOwnYards")
].join("\n");
const setupContext = vm.createContext({});
vm.runInContext(`
  let drivers = [
    { id: "old", login: "old", name: "Old", active: false, displayOrder: 0 },
    { id: "bravo", login: "bravo", name: "Bravo", active: true, displayOrder: 1 },
    { id: "alpha", login: "alpha", name: "Alpha", active: true, displayOrder: 2 }
  ];
  let selectedSetupIndex = 1;
  ${setupFunctions}
  const shownBefore = driverSetupRows().map(({ driver }) => driver.login);
  const moved = moveSetupDriver(1, 2);
  const canonicalAfter = drivers.map((driver) => driver.login);
  const shownAfter = driverSetupRows().map(({ driver }) => driver.login);
  const inactiveMove = moveSetupDriver(0, 1);
  globalThis.result = { shownBefore, moved, canonicalAfter, shownAfter, selectedSetupIndex, inactiveMove };
`, setupContext);
const setupResult = JSON.parse(JSON.stringify(setupContext.result));
assert.deepEqual(setupResult.shownBefore, ["bravo", "alpha", "old"], "Setup must show active drivers in persisted order, then disabled drivers.");
assert.equal(setupResult.moved, true, "Active driver drag did not reorder.");
assert.deepEqual(setupResult.canonicalAfter, ["old", "alpha", "bravo"], "Active reorder overwrote the disabled driver canonical slot.");
assert.deepEqual(setupResult.shownAfter, ["alpha", "bravo", "old"], "Dragged active order was not reflected in setup.");
assert.equal(setupResult.selectedSetupIndex, 2, "Selected driver did not follow its canonical record after drag.");
assert.equal(setupResult.inactiveMove, false, "Disabled driver was allowed into the new-plan ordering drag.");

const plannerFunctions = sourceRange(plannerUi, "function normalizedDriverLaneOrder", "function nextDriverSequence");
const plannerContext = vm.createContext({});
vm.runInContext(`
  let drivers = [];
  let trucks = [];
  let driverLaneOrder = [];
  let currentPlan = { id: 77 };
  let currentPlanDate = "2026-07-22";
  const audit = [];
  function driverKey(driver) { return String(driver?.login || driver?.name || "").trim(); }
  function loadDriverKey(truck, load) { return String(load?.driverLogin || truck?.driverLogin || "").trim().toLowerCase(); }
  function loadHasPlanningContentForAssignment(load) { return Boolean(load?.returnOnly || (load?.stops || []).length || (load?.orders || []).length); }
  function driverLoadEntries() {
    const entries = [];
    for (const truck of trucks) {
      for (const load of truck.loads || []) {
        const login = loadDriverKey(truck, load);
        const driver = drivers.find((item) => driverKey(item).toLowerCase() === login) || null;
        entries.push({ truck, load, driverLogin: login, driver });
      }
    }
    return entries;
  }
  function logDispatchAudit(record) { audit.push(record); }
  ${plannerFunctions}
  drivers = [
    { login: "zulu", name: "Zulu", displayOrder: 0 },
    { login: "alpha", name: "Alpha", displayOrder: 1 }
  ];
  trucks = [];
  const freshOrder = [...ensureDriverLaneOrder(defaultDriverLaneOrder())];
  const moved = moveDriverLaneByDrop("zulu", "alpha", true);
  const movedOrder = [...driverLaneOrder];
  drivers = [{ login: "alpha", name: "Alpha", displayOrder: 1 }];
  trucks = [{
    driverLogin: "old", driver: "Old Driver", license: "DZ",
    loads: [{ id: "old-load", driverLogin: "old", driverName: "Old Driver", stops: [{ id: "drop-1" }] }]
  }];
  ensureDriverLaneOrder(["old", "alpha"]);
  const historicalOrder = [...driverLaneOrder];
  const historicalLane = driverLanes().find((lane) => lane.driverLogin === "old");
  trucks = [];
  const resetOrder = [...ensureDriverLaneOrder(defaultDriverLaneOrder())];
  globalThis.result = { freshOrder, moved, movedOrder, historicalOrder, historicalLane, resetOrder, audit };
`, plannerContext);
const plannerResult = JSON.parse(JSON.stringify(plannerContext.result));
assert.deepEqual(plannerResult.freshOrder, ["zulu", "alpha"], "New plan ignored persisted non-alphabetical driver order.");
assert.equal(plannerResult.moved, true, "Marker drop did not reorder a plan lane.");
assert.deepEqual(plannerResult.movedOrder, ["alpha", "zulu"], "Marker drop inserted the lane at the wrong side of its target.");
assert.deepEqual(plannerResult.historicalOrder, ["old", "alpha"], "Saved disabled-driver lane order was filtered by the active setup list.");
assert.equal(plannerResult.historicalLane?.historical, true, "Disabled saved driver was not rendered as a historical lane.");
assert.equal(plannerResult.historicalLane?.driverName, "Old Driver", "Historical lane lost its saved driver name.");
assert.deepEqual(plannerResult.resetOrder, ["alpha"], "A disabled historical driver leaked into fresh plan initialization.");
assert.equal(plannerResult.audit.length, 1, "Marker reorder did not create exactly one lane-order audit record.");

const renumberDriverLoadsSource = sourceRange(
  plannerUi,
  "function renumberDriverLoads",
  "function renumberTruckLoads"
);
const renumberContext = vm.createContext({});
vm.runInContext(`
  const DEFAULT_FIRST_LOAD_START = "07:00";
  function minutes(value) {
    const [hours, minute] = String(value || DEFAULT_FIRST_LOAD_START).split(":").map(Number);
    return (hours * 60) + minute;
  }
  function loadDriverKey(truck, load) {
    return String(load?.driverLogin || truck?.driverLogin || "").trim().toLowerCase();
  }
  const trucks = [{
    id: "LI-TRUCK",
    driverLogin: "li",
    start: "07:00",
    loads: [
      { id: "LI-L1", name: "Load 1", driverSequence: 0, start: "07:00" },
      { id: "LI-L2", name: "Load 2", driverSequence: 2, start: "11:17" },
      { id: "LI-SALES", name: "Load 3", driverSequence: 4, start: "16:34" },
      { id: "LI-RETURN", name: "Return Load", returnOnly: true, driverSequence: 1, start: "10:44" },
      { id: "LI-TRANSFER", name: "Load 4", driverSequence: 3, start: "14:00" }
    ]
  }];
  ${renumberDriverLoadsSource}
  renumberDriverLoads();
  globalThis.result = Object.fromEntries(trucks[0].loads.map((load) => [load.id, load.name]));
`, renumberContext);
const renumberResult = JSON.parse(JSON.stringify(renumberContext.result));
assert.equal(renumberResult["LI-TRANSFER"], "Load 3", "A load dragged earlier kept its stale later load number.");
assert.equal(renumberResult["LI-SALES"], "Load 4", "The displaced later load did not receive the next load number.");
assert.equal(renumberResult["LI-RETURN"], "Return Load", "Driver renumbering changed the Return Load label.");

const replenishmentDependencyCompleteSource = sourceRange(
  plannerUi,
  "function replenishmentDependencyComplete",
  "function replenishmentDependencyTargetRefs"
);
const replenishmentDependencyComplete = Function(
  `"use strict"; ${replenishmentDependencyCompleteSource}; return replenishmentDependencyComplete;`
)();
assert.equal(
  replenishmentDependencyComplete({ status: "active", reconciliationStatus: "reconciled" }),
  true,
  "An exactly reconciled TO dependency was still treated as unreceived by Dispatch."
);
assert.equal(
  replenishmentDependencyComplete({
    status: "active",
    transferReceived: true,
    transferApplicationStatus: "Completed",
    transferReconciliationStatus: "ok"
  }),
  true,
  "Authoritative Completed SCM evidence did not release the Dispatch dependency."
);
assert.equal(
  replenishmentDependencyComplete({
    status: "active",
    transferStatusText: "Transfer Order : Partially Received"
  }),
  false,
  "A partially received NetSuite TO was incorrectly treated as fully received."
);

const replenishmentLoadPrecedenceSource = sourceRange(
  plannerUi,
  "function replenishmentLoadPrecedence",
  "function comparePlanDate"
);
const replenishmentPrecedenceContext = vm.createContext({});
vm.runInContext(`
  const transferOrder = { id: "TOB00749" };
  const currentPlanDate = "2026-07-22";
  const orders = new Map([[transferOrder.id, transferOrder]]);
  const transferLoad = {
    id: "LI-TRANSFER",
    name: "Load 4",
    driverLogin: "li",
    driverSequence: 3,
    stops: [{ id: "to-drop", type: "drop", orderId: transferOrder.id }]
  };
  const salesLoad = {
    id: "LI-SALES",
    name: "Load 3",
    driverLogin: "li",
    driverSequence: 4,
    stops: []
  };
  const truck = {
    id: "LI-TRUCK",
    plate: "CC46868",
    loads: [salesLoad, transferLoad]
  };
  const trucks = [truck];
  let hasTransferAssignment = true;
  function driverOrientedPlanningEnabled() { return true; }
  function loadDriverKey(parentTruck, load) {
    return String(load?.driverLogin || parentTruck?.driverLogin || "").trim().toLowerCase();
  }
  function loadTruckPlate(parentTruck, load) {
    return String(load?.truckPlate || parentTruck?.plate || "").replace(/\\s+/g, "").toUpperCase();
  }
  function driverLoadEntries(login) {
    return trucks.flatMap((parentTruck) => (parentTruck.loads || []).map((load) => ({
      truck: parentTruck,
      load
    }))).filter((entry) => loadDriverKey(entry.truck, entry.load) === login)
      .sort((left, right) => Number(left.load.driverSequence || 0) - Number(right.load.driverSequence || 0));
  }
  function orderById(orderId) { return orders.get(String(orderId || "")) || null; }
  function replenishmentDependencyComplete() { return false; }
  function orderAssignment(orderId) {
    return hasTransferAssignment && String(orderId || "") === transferOrder.id
      ? { truck, load: transferLoad }
      : {};
  }
  function replenishmentTransferCompletionInLoad() { return null; }
  function comparePlanDate(a, b) {
    const left = String(a || "").slice(0, 10);
    const right = String(b || "").slice(0, 10);
    if (!left || !right || left === right) return 0;
    return left < right ? -1 : 1;
  }
  ${replenishmentLoadPrecedenceSource}
  const groupedSales = {
    id: "GOB-116372-116373",
    orderDependencies: [{
      mode: "yard_replenishment",
      status: "active",
      transferOrderRef: transferOrder.id
    }]
  };
  const allowed = replenishmentPlacementBlockMessage(groupedSales, truck, salesLoad);
  transferLoad.driverSequence = 5;
  const blocked = replenishmentPlacementBlockMessage(groupedSales, truck, salesLoad);
  hasTransferAssignment = false;
  transferLoad.driverSequence = 3;
  groupedSales.orderDependencies[0].transferDispatchPlanned = true;
  groupedSales.orderDependencies[0].transferDispatchPlanDate = "2026-07-21";
  const historicalAllowed = replenishmentPlacementBlockMessage(groupedSales, truck, salesLoad);
  delete groupedSales.orderDependencies[0].transferDispatchPlanned;
  delete groupedSales.orderDependencies[0].transferDispatchPlanDate;
  const missingPlanBlocked = replenishmentPlacementBlockMessage(groupedSales, truck, salesLoad);
  globalThis.result = { allowed, blocked, historicalAllowed, missingPlanBlocked };
`, replenishmentPrecedenceContext);
const replenishmentPrecedenceResult = JSON.parse(JSON.stringify(replenishmentPrecedenceContext.result));
assert.equal(
  replenishmentPrecedenceResult.allowed,
  "",
  "The frontend rejected TOB00749 even though its displayed driver sequence is before the grouped SO load."
);
assert.match(
  replenishmentPrecedenceResult.blocked,
  /TOB00749 must be in an earlier load than GOB-116372-116373/,
  "The frontend allowed the grouped SO when its prerequisite TO was actually later in the driver lane."
);
assert.equal(
  replenishmentPrecedenceResult.historicalAllowed,
  "",
  "Dispatch ignored the dependency's prior plan date when the received TO was absent from the current order pool."
);
assert.match(
  replenishmentPrecedenceResult.missingPlanBlocked,
  /requires TOB00749 to be planned before this delivery/,
  "Dispatch stopped enforcing a genuinely unplanned replenishment prerequisite."
);

const replenishmentPlacementFunctions = sourceRange(
  plannerUi,
  "function replenishmentDependencyTargetRefs",
  "function replenishmentPlacementBlockMessage"
);
const groupedOrderDependenciesSource = sourceRange(
  plannerUi,
  "function groupedOrderDependencies",
  "function groupedOrderDependencyLabels"
);
const groupedOrderDependencies = Function(
  `"use strict"; ${groupedOrderDependenciesSource}; return groupedOrderDependencies;`
)();
const groupedOrderDependencyStructureBlockMessageSource = sourceRange(
  plannerUi,
  "function groupedOrderDependencyStructureBlockMessage",
  "function dispatchGroupingRefs"
);
const groupedOrderDependencyStructureBlockMessage = Function(
  "groupedOrderDependencies",
  `"use strict"; ${groupedOrderDependencyStructureBlockMessageSource}; return groupedOrderDependencyStructureBlockMessage;`
)(groupedOrderDependencies);
const som05433GroupingItems = [{
  id: "SOM05433",
  orderDependencies: [
    {
      id: 145,
      mode: "yard_replenishment",
      status: "delivered",
      canonicalSalesOrderRef: "SOM05433",
      dispatchTargetKind: "normal",
      transferOrderRef: "TOB00774",
      lines: [{ loadedQuantity: 0, deliveredQuantity: 0, locallyReceivedQuantity: 0 }]
    },
    {
      id: 146,
      mode: "yard_replenishment",
      status: "active",
      canonicalSalesOrderRef: "SOM05433",
      dispatchTargetKind: "normal",
      transferOrderRef: "TOB00775",
      lines: [{ loadedQuantity: 0, deliveredQuantity: 0, locallyReceivedQuantity: 0 }]
    }
  ]
}];
assert.equal(
  groupedOrderDependencyStructureBlockMessage(som05433GroupingItems),
  "",
  "SOM05433 could not be grouped because its completed TOB00774 dependency was treated as movable work."
);
assert.equal(
  groupedOrderDependencyStructureBlockMessage([{
    id: "SO-RECEIVED-LOCAL",
    orderDependencies: [{
      mode: "yard_replenishment",
      status: "received_local",
      canonicalSalesOrderRef: "SO-RECEIVED-LOCAL",
      dispatchTargetKind: "normal",
      transferOrderRef: "TO-RECEIVED-LOCAL",
      lines: [{ loadedQuantity: 10, deliveredQuantity: 10, locallyReceivedQuantity: 10 }]
    }]
  }]),
  "",
  "A locally received dependency still blocked grouping after its work was complete."
);
assert.equal(
  groupedOrderDependencyStructureBlockMessage([{
    id: "SO-PROGRESSED",
    orderDependencies: [{
      mode: "yard_replenishment",
      status: "loaded",
      canonicalSalesOrderRef: "SO-PROGRESSED",
      dispatchTargetKind: "normal",
      transferOrderRef: "TO-PROGRESSED",
      lines: [{ loadedQuantity: 1 }]
    }]
  }]),
  "",
  "An in-progress yard-replenishment dependency incorrectly blocked grouping."
);
assert.match(
  groupedOrderDependencyStructureBlockMessage([{
    id: "SO-DIRECT",
    orderDependencies: [{
      mode: "direct_to_customer",
      status: "active",
      canonicalSalesOrderRef: "SO-DIRECT",
      dispatchTargetKind: "normal",
      transferOrderRef: "TO-DIRECT"
    }]
  }]),
  /TO-DIRECT is a direct-pickup dependency/,
  "Grouping allowed an active direct-pickup dependency to move."
);
assert.match(
  groupedOrderDependencyStructureBlockMessage([{
    id: "SO-DIRECT-COMPLETED",
    orderDependencies: [{
      mode: "direct_to_customer",
      status: "delivered",
      canonicalSalesOrderRef: "SO-DIRECT-COMPLETED",
      dispatchTargetKind: "normal",
      transferOrderRef: "TO-DIRECT-COMPLETED",
      lines: [{ loadedQuantity: 1, deliveredQuantity: 1 }]
    }]
  }]),
  /TO-DIRECT-COMPLETED is a direct-pickup dependency/,
  "The completed yard-replenishment exception leaked into direct-pickup grouping."
);
assert.equal(
  groupedOrderDependencyStructureBlockMessage([{
    id: "SO-ALREADY-GROUPED",
    orderDependencies: [{
      mode: "yard_replenishment",
      status: "active",
      canonicalSalesOrderRef: "SO-ALREADY-GROUPED",
      dispatchTargetKind: "group",
      transferOrderRef: "TO-ALREADY-GROUPED"
    }]
  }]),
  "",
  "A yard-replenishment dependency's prior dispatch target incorrectly blocked regrouping."
);
const makeReplenishmentPlacementHelpers = Function(
  "dispatchGroupingRefs",
  "stopOrder",
  "requiredPickupLocations",
  "normalizedPickupLocation",
  "replenishmentDependencyComplete",
  `"use strict"; ${replenishmentPlacementFunctions}; return {
    normalizeReplenishmentTransferInsertIndex,
    normalizeReplenishmentDependentInsertIndex,
    replenishmentSequenceWarningsForStops
  };`
);
const replenishmentOrders = new Map();
const salesOrder = {
  id: "SOB115976",
  pickupLocations: ["12441"],
  orderDependencies: [{
    mode: "yard_replenishment",
    status: "active",
    salesOrderRef: "SOB115976",
    dispatchTargetRef: "SOB115976",
    transferOrderRef: "TOB00721"
  }]
};
const transferOrder = {
  id: "TOB00721",
  pickupLocations: ["3445"],
  dependentSalesOrderRef: "SOB115976",
  orderDependency: {
    mode: "yard_replenishment",
    status: "active",
    salesOrderRef: "SOB115976",
    dispatchTargetRef: "SOB115976",
    transferOrderRef: "TOB00721"
  }
};
replenishmentOrders.set(salesOrder.id, salesOrder);
replenishmentOrders.set(transferOrder.id, transferOrder);
const nonFirstChildDependencies = groupedOrderDependencies([
  { id: "SOB115977", orderDependencies: [] },
  salesOrder
]);
assert.deepEqual(
  nonFirstChildDependencies.map((dependency) => dependency.transferOrderRef),
  [transferOrder.id],
  "Grouping lost the dependency belonging to a non-first Sales Order child."
);
const multipleGroupedDependencies = groupedOrderDependencies([
  {
    id: "GOB-NESTED",
    childOrderDetails: [
      { id: "SOB115977", orderDependencies: [] },
      salesOrder,
      {
        id: "SOB115978",
        orderDependencies: [{
          id: 722,
          mode: "yard_replenishment",
          status: "active",
          salesOrderRef: "SOB115978",
          transferOrderRef: "TOB00722"
        }]
      }
    ],
    orderDependencies: salesOrder.orderDependencies
  }
]);
assert.deepEqual(
  multipleGroupedDependencies.map((dependency) => dependency.transferOrderRef),
  ["TOB00721", "TOB00722"],
  "Grouping did not aggregate and deduplicate dependencies from all nested Sales Order children."
);
const replenishmentHelpers = makeReplenishmentPlacementHelpers(
  (order = {}) => new Set([
    order.id,
    ...(order.childOrders || []),
    ...(order.childOrderDetails || []).flatMap((child) => [child?.id, child?.originalOrderId])
  ].map(String).filter(Boolean)),
  (stop = {}) => replenishmentOrders.get(String(stop.orderId || "")) || null,
  (order = {}) => order.pickupLocations || [],
  (value) => String(value || "").trim().toLowerCase(),
  (dependency = {}) => ["delivered", "received_local"].includes(String(dependency.status || "").toLowerCase())
);
const liveBeforeStops = [
  { id: "so-pick", type: "pick", orderId: salesOrder.id, location: "12441" },
  { id: "so-drop", type: "drop", orderId: salesOrder.id, location: "12441" }
];
const normalizedTransferIndex = replenishmentHelpers.normalizeReplenishmentTransferInsertIndex(
  transferOrder,
  { id: "BD98773-L1", stops: liveBeforeStops },
  1
);
assert.equal(
  normalizedTransferIndex,
  0,
  "A replenishment TO inserted before the SO drop must anchor before the SO pickup."
);
const correctedStops = [...liveBeforeStops];
correctedStops.splice(
  normalizedTransferIndex,
  0,
  { id: "to-pick", type: "pick", orderId: transferOrder.id, location: "3445" },
  { id: "to-drop", type: "drop", orderId: transferOrder.id, location: "3445" }
);
assert.deepEqual(
  correctedStops.map((stop) => `${stop.type}:${stop.orderId}`),
  ["pick:TOB00721", "drop:TOB00721", "pick:SOB115976", "drop:SOB115976"],
  "The live Arthur/BD98773 insertion did not normalize to TO pickup/drop before SO pickup/drop."
);
assert.deepEqual(
  replenishmentHelpers.replenishmentSequenceWarningsForStops(correctedStops),
  [],
  "The normalized same-load replenishment sequence was still rejected."
);
const liveInvalidStops = [
  liveBeforeStops[0],
  { id: "to-pick", type: "pick", orderId: transferOrder.id, location: "3445" },
  { id: "to-drop", type: "drop", orderId: transferOrder.id, location: "3445" },
  liveBeforeStops[1]
];
assert.match(
  replenishmentHelpers.replenishmentSequenceWarningsForStops(liveInvalidStops)[0] || "",
  /TOB00721 must finish before SOB115976 pickup/,
  "The frontend did not identify the exact live TO-after-SO-pickup sequence."
);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentTransferInsertIndex(
    { ...transferOrder, orderDependency: { ...transferOrder.orderDependency, mode: "direct_to_customer" } },
    { stops: liveBeforeStops },
    1
  ),
  1,
  "Direct-pickup TO placement was incorrectly reordered as yard replenishment."
);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentTransferInsertIndex(
    { id: "TOB-UNRELATED", pickupLocations: ["3445"] },
    { stops: liveBeforeStops },
    1
  ),
  1,
  "An unrelated TO was incorrectly reordered."
);
const groupedSales = {
  id: "GOB-115976-115977",
  pickupLocations: ["12441"],
  childOrders: ["SOB115977", "SOB115976"],
  childOrderDetails: [{ id: "SOB115977" }, { id: "SOB115976" }],
  orderDependencies: nonFirstChildDependencies
};
replenishmentOrders.set(groupedSales.id, groupedSales);
const groupedStops = [
  { id: "group-pick", type: "pick", orderId: groupedSales.id, location: "12441" },
  { id: "group-drop", type: "drop", orderId: groupedSales.id, location: "Customer" }
];
assert.equal(
  replenishmentHelpers.normalizeReplenishmentTransferInsertIndex(
    { ...transferOrder, orderDependency: { ...transferOrder.orderDependency, dispatchTargetRef: groupedSales.id } },
    { stops: groupedStops },
    1
  ),
  0,
  "A replenishment dependency targeting a grouped SO did not anchor before the group pickup."
);

const transferFirstStops = [
  { id: "to-pick-first", type: "pick", orderId: transferOrder.id, location: "3445" },
  { id: "to-drop-first", type: "drop", orderId: transferOrder.id, location: "12441" }
];
const transferFirstLoad = { id: "BD98773-L1", stops: transferFirstStops };
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(
    groupedSales,
    transferFirstLoad,
    0
  ),
  2,
  "A dependency belonging to a non-first grouped SO child did not place the group after its TO."
);
const transferThenGroupedStops = [
  ...transferFirstStops,
  { id: "group-pick-after-to", type: "pick", orderId: groupedSales.id, location: "12441" },
  { id: "group-drop-after-to", type: "drop", orderId: groupedSales.id, location: "Customer" }
];
assert.deepEqual(
  replenishmentHelpers.replenishmentSequenceWarningsForStops(transferThenGroupedStops),
  [],
  "A grouped SO remained blocked even though its TO completed first in the same load."
);
const groupedThenTransferStops = [
  { id: "group-pick-before-to", type: "pick", orderId: groupedSales.id, location: "12441" },
  { id: "to-pick-after-group", type: "pick", orderId: transferOrder.id, location: "3445" },
  { id: "to-drop-after-group", type: "drop", orderId: transferOrder.id, location: "12441" },
  { id: "group-drop-after-to", type: "drop", orderId: groupedSales.id, location: "Customer" }
];
assert.match(
  replenishmentHelpers.replenishmentSequenceWarningsForStops(groupedThenTransferStops)[0] || "",
  /TOB00721 must finish before .* pickup/,
  "The frontend did not reject a grouped SO pickup before its dependent TO completion."
);
const normalizedDependentIndex = replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(
  salesOrder,
  transferFirstLoad,
  0
);
assert.equal(
  normalizedDependentIndex,
  2,
  "A dependent SO dropped at the start of a TO-first load was not moved after the TO drop."
);
const transferThenSalesStops = [...transferFirstStops];
transferThenSalesStops.splice(
  normalizedDependentIndex,
  0,
  { id: "so-pick-after-to", type: "pick", orderId: salesOrder.id, location: "12441" },
  { id: "so-drop-after-to", type: "drop", orderId: salesOrder.id, location: "Customer" }
);
assert.deepEqual(
  transferThenSalesStops.map((stop) => `${stop.type}:${stop.orderId}`),
  ["pick:TOB00721", "drop:TOB00721", "pick:SOB115976", "drop:SOB115976"],
  "Auto-placement did not keep the dependent SO pickup/drop after TO completion."
);
assert.deepEqual(
  replenishmentHelpers.replenishmentSequenceWarningsForStops(transferThenSalesStops),
  [],
  "The auto-arranged TO-then-SO sequence was still rejected by the frontend guard."
);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(salesOrder, transferFirstLoad, 2),
  2,
  "The first valid dependent SO insertion boundary after the TO drop was changed."
);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(salesOrder, transferFirstLoad),
  2,
  "Default dependent SO placement did not remain immediately after the completed TO."
);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(
    salesOrder,
    { ...transferFirstLoad, stops: [...transferFirstStops, { id: "later-stop", type: "drop", orderId: "OTHER" }] },
    3
  ),
  3,
  "A valid later SO placement was unnecessarily moved back beside the prerequisite TO."
);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(
    {
      ...salesOrder,
      orderDependencies: [{ ...salesOrder.orderDependencies[0], mode: "direct_to_customer" }]
    },
    transferFirstLoad,
    0
  ),
  0,
  "A direct-pickup dependency incorrectly used the yard-replenishment completion boundary."
);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(
    {
      ...salesOrder,
      orderDependencies: [{ ...salesOrder.orderDependencies[0], status: "received_local" }]
    },
    transferFirstLoad,
    0
  ),
  0,
  "A completed replenishment dependency incorrectly changed SO placement."
);
const secondTransferOrder = { id: "TOB00722", pickupLocations: ["2967"] };
replenishmentOrders.set(secondTransferOrder.id, secondTransferOrder);
const multipleTransferStops = [
  ...transferFirstStops,
  { id: "to2-pick", type: "pick", orderId: secondTransferOrder.id, location: "2967" },
  { id: "to2-drop", type: "drop", orderId: secondTransferOrder.id, location: "12441" }
];
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(
    {
      ...salesOrder,
      orderDependencies: [
        ...salesOrder.orderDependencies,
        { ...salesOrder.orderDependencies[0], transferOrderRef: secondTransferOrder.id }
      ]
    },
    { id: transferFirstLoad.id, stops: multipleTransferStops },
    0
  ),
  4,
  "An SO with multiple prerequisite TOs was not placed after the latest completion."
);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(
    {
      ...groupedSales,
      orderDependencies: [
        ...salesOrder.orderDependencies,
        { ...salesOrder.orderDependencies[0], salesOrderRef: "SOB115977", transferOrderRef: secondTransferOrder.id }
      ]
    },
    { id: transferFirstLoad.id, stops: multipleTransferStops },
    0
  ),
  4,
  "Dependencies from multiple grouped SO children were not placed after the latest TO completion."
);
const groupedTransferOrder = {
  id: "GTOB-00721-00722",
  childOrders: [transferOrder.id, secondTransferOrder.id],
  childOrderDetails: [{ id: transferOrder.id }, { id: secondTransferOrder.id }]
};
replenishmentOrders.set(groupedTransferOrder.id, groupedTransferOrder);
assert.equal(
  replenishmentHelpers.normalizeReplenishmentDependentInsertIndex(
    salesOrder,
    {
      id: transferFirstLoad.id,
      stops: [
        { id: "grouped-to-pick", type: "pick", orderId: groupedTransferOrder.id, location: "3445" },
        { id: "grouped-to-drop", type: "drop", orderId: groupedTransferOrder.id, location: "12441" }
      ]
    },
    0
  ),
  2,
  "A prerequisite TO represented by a grouped stop was not recognized."
);

const loadEditFunctions = [
  sourceRange(plannerUi, "function loadDriverKey", "function loadDriver"),
  sourceRange(plannerUi, "function loadHasAssignedDriver", "function truckHasPlanningContent"),
  sourceRange(plannerUi, "function driverLockNotice", "function ownYardFixedMinutesFor"),
  sourceRange(plannerUi, "function isScmReconciliationBlocked", "function orderTypeLabel"),
  sourceRange(plannerUi, "function poDropStopDetails", "function moveStop")
].join("\n");
const loadEditContext = vm.createContext({});
vm.runInContext(`
  let routeNotice = "";
  let selectedOrderId = "";
  let selectedLoadId = "";
  let selectedOrderIds = new Set();
  let trucks = [];
  const pendingOperatorAlertRefs = new Set();
  const audit = [];
  const vrma = {
    id: "VRMA-TEST-1",
    type: "PO",
    sourceTable: "scm_vrma_orders",
    parseSource: "scm-vrma",
    pickupLocations: ["3445"],
    dropoffs: [{
      key: "yard:vendor-return",
      destinationYard: "Vendor Return",
      address: "Vendor Return Address",
      lineRowIds: ["1"],
      pallets: 1
    }]
  };
  function driverOrientedPlanningEnabled() { return true; }
  function truckHasDriver(truck) { return Boolean(truck?.driverLogin); }
  function stopHasDriverActivity() { return false; }
  function stopActivityLockNotice() { return "This stop has already started."; }
  function findLoad(loadId) {
    for (const truck of trucks) {
      const load = (truck.loads || []).find((item) => item.id === loadId);
      if (load) return { truck, load };
    }
    return {};
  }
  function orderById(orderId) { return orderId === vrma.id ? vrma : null; }
  function isOrderPlannedOutsideCurrentPlan() { return false; }
  function orderPlannedElsewhereText() { return ""; }
  function isScmGroupedPoOrder() { return false; }
  function addScmGroupedPoToLoad() { return false; }
  function normalizeReplenishmentTransferInsertIndex(_order, _load, insertIndex) { return insertIndex; }
  function normalizeReplenishmentDependentInsertIndex(_order, _load, insertIndex) { return insertIndex; }
  function replenishmentPlacementBlockMessage() { return ""; }
  function summarizeLoad(load) { return { id: load.id, stops: load.stops.length }; }
  function hasUsableDispatchAddress() { return true; }
  function transitBlockMessage() { return ""; }
  function ensurePickupStops() { return 0; }
  function coTimingViolation() { return ""; }
  function cleanupOrphanPickupStops() {}
  function orderHasDriverActivityInLoad() { return false; }
  function summarizeOrder(order) { return { id: order.id, sourceTable: order.sourceTable }; }
  function logDispatchAudit(record) { audit.push(record); }
  function resetPlan(driverLogin) {
    routeNotice = "";
    trucks = [{
      id: "TRUCK-1",
      plate: "BL42349",
      driverLogin: "",
      loads: [{
        id: "MIKE-L1",
        driverLogin: "mike",
        driverName: "Mike",
        stops: [{
          id: "VRMA-TEST-1-DROP",
          loadId: "MIKE-L1",
          orderId: "VRMA-TEST-1",
          type: "drop",
          location: "3445",
          dropoffKey: "yard:vendor-return"
        }]
      }, {
        id: "MIKE-L2",
        driverLogin,
        driverName: driverLogin ? "Mike" : "",
        stops: []
      }]
    }];
  }
  ${loadEditFunctions}
  resetPlan("mike");
  const assignedMoved = addOrderToLoad(vrma.id, "MIKE-L2");
  const assignedNotice = routeNotice;
  const assignedSourceStops = trucks[0].loads[0].stops.map((stop) => stop.orderId);
  const assignedTargetStops = trucks[0].loads[1].stops.map((stop) => stop.orderId);
  resetPlan("");
  const unassignedMoved = addOrderToLoad(vrma.id, "MIKE-L2");
  const unassignedNotice = routeNotice;
  const unassignedSourceStops = trucks[0].loads[0].stops.map((stop) => stop.orderId);
  const unassignedTargetStops = trucks[0].loads[1].stops.map((stop) => stop.orderId);
  globalThis.result = {
    assignedMoved,
    assignedNotice,
    assignedSourceStops,
    assignedTargetStops,
    unassignedMoved,
    unassignedNotice,
    unassignedSourceStops,
    unassignedTargetStops
  };
`, loadEditContext);
const loadEditResult = JSON.parse(JSON.stringify(loadEditContext.result));
assert.equal(loadEditResult.assignedMoved, true, "A local VRMA could not move to Mike's load-level driver assignment.");
assert.equal(loadEditResult.assignedNotice, "", "A load assigned to Mike showed a false missing-driver notice.");
assert.deepEqual(loadEditResult.assignedSourceStops, [], "The moved VRMA remained on its source load.");
assert.deepEqual(loadEditResult.assignedTargetStops, ["VRMA-TEST-1"], "The moved VRMA did not reach Mike's target load.");
assert.equal(loadEditResult.unassignedMoved, false, "A genuinely unassigned load accepted a VRMA.");
assert.match(loadEditResult.unassignedNotice, /needs a driver before dispatch planning can change loads/);
assert.deepEqual(loadEditResult.unassignedSourceStops, ["VRMA-TEST-1"], "A rejected VRMA move changed its source load.");
assert.deepEqual(loadEditResult.unassignedTargetStops, [], "A rejected VRMA move changed its target load.");

assert(setupUi.includes("driverSetupRows().map(({ driver, canonicalIndex })"), "Setup driver list is not using active-first derived rows.");
assert(setupUi.includes("data-driver-index") && setupUi.includes("draggedDriverSetupIndex"), "Setup driver drag hooks are missing.");
assert(setupUi.includes("previousDrivers = [...drivers]") && setupUi.includes("drivers = previousDrivers"), "Driver drag does not roll back after a failed save.");
assert(plannerUi.includes('dragged = { type: "driver-lane-order", driverLogin }'), "Lane marker drag has no isolated drag type.");
assert(plannerUi.includes('commitPlanMutation("move-driver-lane")'), "Lane marker drop is not persisted as a plan mutation.");
assert(plannerUi.includes('data-driver-lane-reorderable="${canReorder ? "true" : "false"}"'), "Historical/unassigned lanes are not excluded from lane reordering.");
assert(plannerUi.includes('${isHistorical ? "" : `data-driver-lane-drop="'), "Historical disabled lane can still accept dropped work.");
assert(plannerUi.includes("Disabled (historical plan)"), "Historical disabled lanes are not identified to the dispatcher.");
assert(plannerUi.includes("normalizeReplenishmentTransferInsertIndex(order, load, insertIndex)"), "TO insertion does not use the replenishment pickup anchor.");
assert(plannerUi.includes("normalizeReplenishmentDependentInsertIndex(order, load, transferNormalizedInsertIndex)"), "Dependent SO insertion does not use the prerequisite TO completion boundary.");
assert(plannerUi.includes("reflowDriverLaneEntries(targetLogin, targetEntries, timingByLoad, found.load.id);\n  if (driverOrientedPlanningEnabled()) renumberDriverLoads();"), "A whole-load driver-lane drag does not renumber the affected lane.");
assert(plannerUi.includes("if (driverOrientedPlanningEnabled()) renumberDriverLoads();\n}\n\nfunction driverLoadEntries"), "Restoring a saved plan does not repair stale driver load labels.");
assert(plannerUi.includes("replenishmentLoadPrecedence(assignment.truck, assignment.load, targetTruck, targetLoad) === false"), "The frontend replenishment guard does not use canonical load precedence.");
assert(plannerUi.includes("commitPlanMutation:dependencyRejected"), "Plan mutations do not block a locally invalid replenishment stop sequence.");
assert(plannerUi.includes("const orderDependencies = groupedDependencySources.length")
  && plannerUi.includes("groupedOrderDependencies(groupedDependencySources)"),
"Grouped orders do not normalize dependencies from all of their child orders.");
assert(plannerUi.includes("const grouped = normalizeOrder({"), "New groups bypass grouped dependency normalization.");
const savedRestore = sourceRange(plannerUi, "function applySavedPlan", "function compactCurrentPlan");
assert(savedRestore.indexOf("trucks = trucksFromFleetAndSavedPlan(saved.trucks);") < savedRestore.indexOf("ensureDriverLaneOrder(Array.isArray(saved.summary?.driverLaneOrder)"), "Saved lane order is restored before historical truck/load metadata.");
const activityEvidenceFunctions = sourceRange(plannerUi, "function activePhysicalOrderEvidence", "function applyDispatchOrderFeed");
const activityEvidenceContext = vm.createContext({});
vm.runInContext(`
  let driverJobStatusesLoadedPlanId = "183";
  let currentPlan = { id: 183 };
  let trucks = [];
  let driverJobStatuses = [{
    load_id: "SETY-L3",
    stop_id: "RP-PICK",
    stop_type: "pickup",
    status: "complete",
    order_refs: ["RP-BWS-WOODBRIGE-0730-2-v2"]
  }];
  function dispatchGroupingRefs(order = {}) {
    return new Set([order.id, ...(order.childOrders || []), ...(order.groupAliases || [])]
      .map((value) => String(value || ""))
      .filter(Boolean));
  }
  function normalizeOrder(order) { return order; }
  ${activityEvidenceFunctions}
  const planTrucks = [{ loads: [{
    id: "SETY-L3",
    stops: [{ id: "RP-PICK", type: "pick", orderId: "RP-BWS-WOODBRIGE-0730-2-v2", location: "12441" }]
  }] }];
  const previous = {
    id: "RP-BWS-WOODBRIGE-0730-2-v2",
    sourceYard: "12441",
    pickupLocations: ["12441"],
    address: "Old future drop",
    items: [{ lineRowId: 119, itemId: 1784, sku: "PALLET", quantity: 300 }]
  };
  const refreshed = {
    ...previous,
    sourceYard: "3445",
    pickupLocations: ["3445"],
    address: "Updated future drop",
    items: [{ lineRowId: 159, itemId: 1784, sku: "PALLET", quantity: 300 }]
  };
  const evidence = activePhysicalOrderEvidence(planTrucks, 183);
  const protectedOrder = preserveActiveOrderEvidence(previous, refreshed, evidence);
  const unstartedPrevious = { id: "UNSTARTED", items: [{ lineRowId: 10, quantity: 1 }] };
  const unstartedRefreshed = { id: "UNSTARTED", items: [{ lineRowId: 11, quantity: 2 }] };
  const unstartedOrder = preserveActiveOrderEvidence(unstartedPrevious, unstartedRefreshed, evidence);
  const reconciledOrder = reapplyActiveOrderEvidence(
    [{ ...protectedOrder, sourceYard: "3445", pickupLocations: ["3445"] }],
    new Map([[previous.id.toLowerCase(), previous]]),
    evidence
  )[0];

  driverJobStatuses = [{
    load_id: "GROUP-L1",
    stop_id: "GROUP-PICK",
    stop_type: "pickup",
    status: "complete",
    order_refs: ["CHILD-A"]
  }];
  const groupTrucks = [{ loads: [{
    id: "GROUP-L1",
    stops: [{ id: "GROUP-PICK", type: "pick", orderId: "GROUP-A", location: "12441" }]
  }] }];
  const groupedPrevious = {
    id: "GROUP-A",
    childOrders: ["CHILD-A"],
    childOrderDetails: [{ id: "CHILD-A", items: [{ lineRowId: 21, itemId: 1784, quantity: 10 }] }],
    items: [{ lineRowId: 21, itemId: 1784, quantity: 10 }]
  };
  const groupedRefreshed = {
    ...groupedPrevious,
    items: [{ lineRowId: 22, itemId: 1784, quantity: 10 }]
  };
  const groupedEvidence = activePhysicalOrderEvidence(groupTrucks, 183);
  const groupedProtected = preserveActiveOrderEvidence(groupedPrevious, groupedRefreshed, groupedEvidence);

  driverJobStatuses = [{ load_id: "SETY-L3", stop_id: "RP-PICK", stop_type: "pickup", status: "reopened", order_refs: [previous.id] }];
  const reopenedEvidence = activePhysicalOrderEvidence(planTrucks, 183);
  const reopenedOrder = preserveActiveOrderEvidence(previous, refreshed, reopenedEvidence);
  driverJobStatuses = [{ load_id: "SETY-L3", stop_id: "TRAVEL", stop_type: "travel", status: "complete", order_refs: [previous.id] }];
  const travelEvidence = activePhysicalOrderEvidence(planTrucks, 183);
  const travelOrder = preserveActiveOrderEvidence(previous, refreshed, travelEvidence);

  driverJobStatuses = [{ load_id: "DROP-L1", stop_id: "DROP-A", stop_type: "dropoff", status: "complete", order_refs: ["PO-DROP"] }];
  const dropTrucks = [{ loads: [{ id: "DROP-L1", stops: [{ id: "DROP-A", type: "drop", orderId: "PO-DROP" }] }] }];
  const dropPrevious = {
    id: "PO-DROP",
    address: "Recorded drop",
    destinationYard: "12441",
    dropoffs: [{ key: "done", address: "Recorded drop" }],
    notes: "Old note",
    items: [{ lineRowId: 31, itemId: 1784, quantity: 10 }]
  };
  const dropRefreshed = {
    ...dropPrevious,
    address: "Changed recorded drop",
    destinationYard: "2967",
    dropoffs: [{ key: "future", address: "Updated future drop" }],
    notes: "New note",
    items: [{ lineRowId: 32, itemId: 1784, quantity: 10 }]
  };
  const dropEvidence = activePhysicalOrderEvidence(dropTrucks, 183);
  const dropProtected = preserveActiveOrderEvidence(dropPrevious, dropRefreshed, dropEvidence);
  globalThis.result = {
    protectedOrder,
    unstartedOrder,
    reconciledOrder,
    groupedProtected,
    reopenedOrder,
    travelOrder,
    dropProtected
  };
`, activityEvidenceContext);
const activityEvidenceResult = JSON.parse(JSON.stringify(activityEvidenceContext.result));
assert.equal(activityEvidenceResult.protectedOrder.items[0].lineRowId, 119,
  "A live feed refresh replaced the saved item-row evidence for an active order.");
assert.equal(activityEvidenceResult.protectedOrder.sourceYard, "12441",
  "A live feed refresh replaced the materialized source yard for an active pickup.");
assert.deepEqual(activityEvidenceResult.protectedOrder.pickupLocations, ["12441"],
  "A live feed refresh replaced the materialized pickup locations for an active pickup.");
assert.equal(activityEvidenceResult.protectedOrder.address, "Updated future drop",
  "Protecting active pickup evidence prevented a future drop detail from refreshing.");
assert.equal(activityEvidenceResult.unstartedOrder.items[0].lineRowId, 11,
  "An unstarted order did not receive its latest live-feed details.");
assert.equal(activityEvidenceResult.reconciledOrder.sourceYard, "12441",
  "Transit reconciliation overwrote active pickup evidence after the feed merge.");
assert.equal(activityEvidenceResult.groupedProtected.items[0].lineRowId, 21,
  "A child-order activity reference did not protect its grouped root allocation.");
assert.equal(activityEvidenceResult.reopenedOrder.items[0].lineRowId, 159,
  "A reopened record incorrectly froze an order feed snapshot.");
assert.equal(activityEvidenceResult.travelOrder.items[0].lineRowId, 159,
  "Travel-only activity incorrectly froze a physical order allocation.");
assert.equal(activityEvidenceResult.dropProtected.address, "Recorded drop",
  "A completed drop's materialized destination was replaced by a feed refresh.");
assert.equal(activityEvidenceResult.dropProtected.dropoffs[0].key, "future",
  "Protecting one completed drop prevented later multi-drop feed details from refreshing.");
assert.equal(activityEvidenceResult.dropProtected.notes, "New note",
  "Protecting drop evidence prevented an unrelated order note from refreshing.");
const applyFeedSource = sourceRange(plannerUi, "function applyDispatchOrderFeed", "function mergeDispatchOrderSearchFeed");
assert(applyFeedSource.includes("|| orderMatchesActivityRefs(order, activityEvidence.all)"),
  "An active planned order can disappear when a partial feed omits it.");
assert(applyFeedSource.indexOf("reconcileTransitCoSourceOrders();") < applyFeedSource.indexOf("reapplyActiveOrderEvidence"),
  "The main order feed does not restore active evidence after transit reconciliation.");
const searchFeedSource = sourceRange(plannerUi, "function mergeDispatchOrderSearchFeed", "function cancelDispatchOrderSearch");
assert(searchFeedSource.indexOf("reconcileTransitCoSourceOrders();") < searchFeedSource.indexOf("reapplyActiveOrderEvidence"),
  "The search order feed does not restore active evidence after transit reconciliation.");
const planForDateLoader = sourceRange(plannerUi, "async function loadPlanForDate", "async function loadPlanById");
assert(planForDateLoader.indexOf("await loadDriverJobStatuses();") < planForDateLoader.indexOf("applyDispatchPlanSnapshotResult(snapshot)"),
  "Plan startup merges the live feed before loading driver evidence.");
const planByIdLoader = sourceRange(plannerUi, "async function loadPlanById", "async function restoreServerPlan");
assert(planByIdLoader.indexOf("await loadDriverJobStatuses();") < planByIdLoader.indexOf("applySavedPlan(plan)"),
  "Historical plan loading merges the live feed before loading driver evidence.");
const restoreLoader = sourceRange(plannerUi, "async function restoreServerPlan", "async function pollServerPlan");
assert(restoreLoader.indexOf("await loadDriverJobStatuses();") < restoreLoader.indexOf("applySavedPlan(saved)"),
  "Remote plan refresh merges the live feed before loading driver evidence.");
assert(savedRestore.indexOf("reconcileTransitCoSourceOrders();") < savedRestore.indexOf("reapplyActiveOrderEvidence"),
  "Saved-plan restore does not reapply active evidence after transit reconciliation.");
const initDispatchSource = sourceRange(plannerUi, "async function initDispatch", "window.addEventListener(\"mbbs-language-changed\"");
assert.equal((initDispatchSource.match(/loadDriverJobStatuses\(/g) || []).length, 0,
  "Dispatch initialization repeats the status request already owned by plan loading.");
assert(repository.includes("displayOrder: numberValue(row.display_order, 0)"), "Setup API does not expose persisted display order.");
assert(repository.includes("cleanDriver(driver, index)"), "Driver request order is not explicitly persisted as display_order.");
assert(setupHtml.includes("20260803-mbt-bin-trucks-v1"), "Dispatch Setup browser asset version was not bumped.");
assert(plannerHtml.includes('/dispatch.js?v=20260813-delivery-to-dependency-v1'), "Dispatch planner browser asset version was not bumped.");

const activityPositionSource = sourceRange(
  plannerUi,
  "function physicalActivityPositionChanged",
  "function stopActivityLockNotice"
);
const physicalActivityPositionChanged = Function(
  "stopHasDriverActivity",
  `"use strict"; ${activityPositionSource}; return physicalActivityPositionChanged;`
)((_load, stop) => stop?.id === "ACTIVE");
const activityLoad = { stops: [{ id: "EARLY-A" }, { id: "EARLY-B" }, { id: "ACTIVE" }, { id: "FUTURE-A" }, { id: "FUTURE-B" }] };
assert.equal(physicalActivityPositionChanged(activityLoad, [{ id: "EARLY-B" }, { id: "EARLY-A" }, { id: "ACTIVE" }, { id: "FUTURE-A" }, { id: "FUTURE-B" }]), true,
  "Equal-count edits before a started stop must not rewrite the executed prefix.");
assert.equal(physicalActivityPositionChanged(activityLoad, [{ id: "EARLY-A" }, { id: "EARLY-B" }, { id: "ACTIVE" }, { id: "FUTURE-B" }, { id: "FUTURE-A" }]), false,
  "Future stops after the activity boundary must remain reorderable.");
assert.equal(physicalActivityPositionChanged(activityLoad, [{ id: "EARLY-A" }, { id: "ACTIVE" }, { id: "FUTURE-A" }, { id: "FUTURE-B" }]), true,
  "Removing a stop before active evidence must be blocked.");

const optimizeSource = sourceRange(plannerUi, "function optimizeSelectedRoute", "function escapeHtml");
const optimizeLoad = {
  stops: [
    { id: "EARLY-A", type: "drop", windowStart: "12:00" },
    { id: "ACTIVE", type: "drop", windowStart: "11:00" },
    { id: "FUTURE-LATE", type: "drop", windowStart: "15:00" },
    { id: "FUTURE-PICK", type: "pick", windowStart: "16:00" },
    { id: "FUTURE-EARLY", type: "drop", windowStart: "13:00" }
  ]
};
const optimizeSelectedRoute = Function(
  "selectedLoad",
  "stopHasDriverActivity",
  "stopOrder",
  "minutes",
  `"use strict"; ${optimizeSource}; return optimizeSelectedRoute;`
)(
  () => ({ load: optimizeLoad }),
  (_load, stop) => stop?.id === "ACTIVE",
  (stop) => stop,
  (value) => Number(String(value).split(":")[0]) * 60 + Number(String(value).split(":")[1])
);
optimizeSelectedRoute();
assert.deepEqual(optimizeLoad.stops.map((stop) => stop.id), ["EARLY-A", "ACTIVE", "FUTURE-PICK", "FUTURE-EARLY", "FUTURE-LATE"],
  "Route optimization must preserve the executed prefix and sort only future stops.");
const addOrderSource = sourceRange(plannerUi, "function addOrderToLoad", "function pullExistingStop");
assert.match(addOrderSource, /if \(existing\?\.locked\)\s*{\s*routeNotice\s*=\s*stopActivityLockNotice\(existing\.stop\);\s*return false;/,
  "An active stop must never be removed and reinserted by same-load order placement.");

console.log(JSON.stringify({
  ok: true,
  activeFirstSetup: true,
  persistedNewPlanOrder: true,
  historicalDisabledLane: true,
  markerLaneDrag: true,
  vrmaLoadDriverGuard: true,
  replenishmentSequenceGuard: true,
  dependentSalesAutoPlacement: true,
  driverLoadRenumberAfterDrag: true,
  canonicalReplenishmentLoadPrecedence: true,
  tests: 96
}));
