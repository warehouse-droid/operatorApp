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
assert(plannerUi.includes("commitPlanMutation:dependencyRejected"), "Plan mutations do not block a locally invalid replenishment stop sequence.");
assert(plannerUi.includes("const orderDependencies = groupedDependencySources.length")
  && plannerUi.includes("groupedOrderDependencies(groupedDependencySources)"),
"Grouped orders do not normalize dependencies from all of their child orders.");
assert(plannerUi.includes("const grouped = normalizeOrder({"), "New groups bypass grouped dependency normalization.");
const savedRestore = sourceRange(plannerUi, "function applySavedPlan", "function compactCurrentPlan");
assert(savedRestore.indexOf("trucks = trucksFromFleetAndSavedPlan(saved.trucks);") < savedRestore.indexOf("ensureDriverLaneOrder(Array.isArray(saved.summary?.driverLaneOrder)"), "Saved lane order is restored before historical truck/load metadata.");
assert(repository.includes("displayOrder: numberValue(row.display_order, 0)"), "Setup API does not expose persisted display order.");
assert(repository.includes("cleanDriver(driver, index)"), "Driver request order is not explicitly persisted as display_order.");
assert(setupHtml.includes("20260723-driver-order-v1"), "Dispatch Setup browser asset version was not bumped.");
assert(plannerHtml.includes('/dispatch.js?v=20260728-custom-orders-v3'), "Dispatch planner browser asset version was not bumped.");

console.log(JSON.stringify({
  ok: true,
  activeFirstSetup: true,
  persistedNewPlanOrder: true,
  historicalDisabledLane: true,
  markerLaneDrag: true,
  vrmaLoadDriverGuard: true,
  replenishmentSequenceGuard: true,
  dependentSalesAutoPlacement: true,
  tests: 57
}));
