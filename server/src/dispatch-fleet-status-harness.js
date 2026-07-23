import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHasPlanningContent } from "./dispatch-load-assignment.js";
import { DISPATCH_FLEET_PLANNING_LOCK, dispatchFleetAssignmentStatusConflicts, dispatchFleetPlanConflicts, dispatchLegacyDriverRenameConflicts, unchangedCompletedDispatchLoadIds } from "./dispatch-fleet-status.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [setupUi, plannerUi, server, repository, planRepository, statistics] = await Promise.all([
  fs.readFile(path.join(serverRoot, "public/dispatch-setup.js"), "utf8"),
  fs.readFile(path.join(serverRoot, "public/dispatch.js"), "utf8"),
  fs.readFile(path.join(dirname, "server.js"), "utf8"),
  fs.readFile(path.join(dirname, "dispatch-setup-repository.js"), "utf8"),
  fs.readFile(path.join(dirname, "dispatch-plan-repository.js"), "utf8"),
  fs.readFile(path.join(dirname, "dispatch-statistics-repository.js"), "utf8")
]);

assert(setupUi.includes("/api/dispatch/setup?includeInactive=true"), "Setup management must load inactive fleet records.");
assert(setupUi.includes("toggle-driver-active") && setupUi.includes("toggle-truck-active"), "Driver and truck status buttons are missing.");
assert(setupUi.includes("/api/dispatch/setup/drivers/${encodeURIComponent(driver.id)}/active"), "Driver status button is not connected to the targeted endpoint.");
assert(setupUi.includes("/api/dispatch/setup/trucks/${encodeURIComponent(truck.id)}/active"), "Truck status button is not connected to the targeted endpoint.");
assert(setupUi.includes("active: existingDriver?.active !== false"), "Editing a driver can silently re-enable it.");
assert(setupUi.includes("active: existingTruck?.active !== false"), "Editing a truck can silently re-enable it.");
assert(setupUi.includes("Login (fixed after registration)") && setupUi.includes("Vehicle plate (fixed after registration)"), "Mutable fleet identities can evade active-plan protection.");

assert(plannerUi.includes("if (Array.isArray(setup.trucks))"), "Planner must accept an intentionally empty active-truck list.");
assert(!plannerUi.includes("if (Array.isArray(setup.trucks) && setup.trucks.length)"), "Planner still falls back to built-in trucks when all trucks are disabled.");
assert(plannerUi.includes("if (!activeVehicle && !(savedTruck.loads || []).some(loadHasPlanningContentForAssignment)) continue;"), "Empty saved placeholders can resurrect disabled trucks.");
assert(plannerUi.includes("if (!loadHasPlanningContentForAssignment(entry.load)) continue;"), "Empty saved placeholders can resurrect disabled driver lanes.");
assert(plannerUi.includes("(load?.orders || []).length"), "Legacy orders-only loads can disappear when their assigned fleet record is inactive.");
assert(plannerUi.includes("function normalizedTruckPlate(value)") && plannerUi.includes("replace(/\\s+/g, \"\")"), "Planner truck identity does not match the server's whitespace-insensitive plate identity.");
assert(plannerUi.includes("if (!Array.isArray(saved?.orders) || !Array.isArray(saved?.trucks)) return false;"), "Orderless return-only plans are rejected by the planner restore path.");
assert(plannerUi.includes("const savedTrucks = trucks;") && plannerUi.includes("trucks = trucksFromFleetAndSavedPlan(savedTrucks);"),
  "Fleet status refresh can erase an orderless saved plan locally.");
assert(plannerUi.includes("blockedDispatchSetupUpdate = true") && plannerUi.includes("queueDispatchSetupRefresh(0)"), "Fleet status refresh can discard unsaved local plan edits.");

assert(server.includes("DISPATCH_FLEET_IN_USE"), "Disable does not protect active/current plan loads.");
assert(planRepository.includes("dispatchFleetAssignmentStatusConflicts"), "Plan writes do not reject disabled fleet assignments.");
assert(server.includes("revokeDispatchDriverSessions"), "Disabling a driver does not revoke active driver sessions.");
assert((server.match(/active: existing \? existing\.active !== false : true/g) || []).length >= 2, "Bulk setup save can bypass targeted fleet status checks.");
assert(server.includes("{ activeOnly: !includeInactive, deactivateMissing: false }"), "Omitting a record from bulk setup can bypass targeted fleet status checks.");
assert(server.includes("withDispatchFleetPlanningLock"), "Fleet disable is not serialized with plan mutations.");
assert(server.includes("withDispatchFleetPlanningLock(() => writeDispatchSetup"), "Bulk setup and legacy driver renames are not serialized with plan mutations.");
assert(server.includes("DISPATCH_DRIVER_LEGACY_NAME_IN_USE"), "Driver renaming can orphan current legacy name-only assignments.");
assert(planRepository.includes("lockDispatchFleetPlanning") && planRepository.includes("assertActiveDispatchFleetAssignments"), "Plan writes do not recheck fleet status under the shared lock.");
assert(planRepository.includes("DISPATCH_FLEET_PLANNING_LOCK") && DISPATCH_FLEET_PLANNING_LOCK === "dispatch_fleet_planning_mutation", "Plan writes use a different fleet mutation lock.");
assert(repository.includes("const persistedLogin = existing"), "Existing driver login is not a stable identity.");
assert(repository.includes("const persistedPlate = existing"), "Existing truck plate is not a stable identity.");
assert(!repository.includes("active = $14") && !repository.includes("active = $6"), "Bulk fleet setup can still overwrite the active status of existing records.");
assert(repository.includes("SELECT count(*)::integer AS count FROM dispatch_drivers\""), "Driver seeding still depends on active count.");
assert(repository.includes("SELECT count(*)::integer AS count FROM dispatch_trucks\""), "Truck seeding still depends on active count.");
assert(!statistics.includes("dispatch_drivers") && !statistics.includes("dispatch_trucks"), "Statistics became dependent on active fleet setup.");

assert(loadHasPlanningContent({ stops: [] }) === false, "An empty placeholder load should not block disable.");
assert(loadHasPlanningContent({ stops: [{ id: "stop-1" }] }) === true, "A planned stop must block disable.");
assert(loadHasPlanningContent({ returnOnly: true, stops: [] }) === true, "A return-only load must block disable.");

const planRows = [{
  id: "77",
  plan_date: "2026-07-22",
  status: "draft",
  trucks: [{
    id: "truck-1",
    plate: "AB 123",
    loads: [
      { id: "empty", driverLogin: "driver-1", stops: [] },
      { id: "planned", name: "Load 2", driverLogin: "driver-1", truckPlate: "AB 123", stops: [{ id: "stop-1" }] }
    ]
  }]
}];
assert(dispatchFleetPlanConflicts(planRows, { driver: { login: "driver-1", name: "Driver One" } }).length === 1, "Driver disable conflict must ignore placeholders and report planned loads.");
assert(dispatchFleetPlanConflicts(planRows, { truck: { id: "truck-1", plate: "AB123" } }).length === 1, "Truck disable conflict must match normalized plates.");
assert(dispatchFleetPlanConflicts(planRows, { driver: { login: "unused" } }).length === 0, "Unassigned driver was incorrectly blocked.");
assert(dispatchFleetPlanConflicts([{ ...planRows[0], completedLoadIds: ["planned"] }], { driver: { login: "driver-1" } }).length === 0, "A fully completed current-day load still blocks disable.");
assert(dispatchFleetPlanConflicts([{
  ...planRows[0],
  trucks: [{
    ...planRows[0].trucks[0],
    loads: [{
      id: "other-driver",
      driverLogin: "driver-2",
      driverName: "Driver One",
      stops: [{ id: "stop-2" }]
    }]
  }]
}], { driver: { login: "driver-1", name: "Driver One" } }).length === 0, "A canonical login assigned to another driver was matched only by a duplicate display name.");
assert(dispatchFleetPlanConflicts([{
  ...planRows[0],
  trucks: [{
    id: "999999",
    plate: "AB 123",
    loads: [{ id: "unknown-truck", truckId: "999999", truckPlate: "AB 123", stops: [{ id: "stop-3" }] }]
  }]
}], {
  truck: { id: "truck-1", plate: "AB123" },
  trucks: [{ id: "truck-1", plate: "AB123" }]
}).length === 1, "An unknown saved truck ID bypassed plate-based disable protection.");
assert(dispatchLegacyDriverRenameConflicts([{
  id: "88",
  plan_date: "2026-07-22",
  trucks: [{
    driver: "Driver One",
    loads: [{ id: "legacy-name", driver: "Driver One", orders: ["SO-1"] }]
  }]
}], [{ id: "1", login: "driver-1", previousName: "Driver One", nextName: "Driver Renamed" }]).length === 1, "A driver rename orphaned a current legacy name-only assignment.");
assert(dispatchLegacyDriverRenameConflicts([{
  id: "89",
  plan_date: "2026-07-22",
  trucks: [{
    driverLogin: "driver-1",
    loads: [{ id: "canonical-name", driverLogin: "driver-1", driverName: "Driver One", orders: ["SO-1"] }]
  }]
}], [{ id: "1", login: "driver-1", previousName: "Driver One", nextName: "Driver Renamed" }]).length === 0, "A canonical login assignment unnecessarily blocked a driver display-name change.");

const unchangedCompleted = unchangedCompletedDispatchLoadIds(planRows[0], planRows[0], ["planned"]);
assert(unchangedCompleted.has("planned"), "An unchanged completed load was not eligible for inactive history preservation.");
const changedLegacyOrders = {
  ...planRows[0],
  trucks: [{
    ...planRows[0].trucks[0],
    loads: [{ id: "legacy", driverLogin: "driver-1", orders: ["SO-NEW"] }]
  }]
};
const previousLegacyOrders = {
  ...changedLegacyOrders,
  trucks: [{
    ...changedLegacyOrders.trucks[0],
    loads: [{ id: "legacy", driverLogin: "driver-1", orders: ["SO-OLD"] }]
  }]
};
assert(!unchangedCompletedDispatchLoadIds(previousLegacyOrders, changedLegacyOrders, ["legacy"]).has("legacy"), "A completed legacy load accepted replacement orders under its disabled fleet assignment.");

const statusPlan = { planDate: "2026-07-22", trucks: planRows[0].trucks };
const fleet = {
  drivers: [
    { id: "1", login: "driver-1", name: "Primary Driver", active: false },
    { id: "2", login: "active-driver", name: "driver-1", active: true }
  ],
  trucks: [{ id: "9", plate: "AB123", active: false }]
};
const inactiveConflicts = dispatchFleetAssignmentStatusConflicts(statusPlan, fleet);
assert(inactiveConflicts.some((conflict) => conflict.code === "DISPATCH_DRIVER_DISABLED"), "An active driver name can mask a disabled canonical login.");
assert(inactiveConflicts.some((conflict) => conflict.code === "DISPATCH_TRUCK_DISABLED"), "Disabled truck assignment was accepted.");
assert(dispatchFleetAssignmentStatusConflicts(statusPlan, {
  drivers: [{ id: "1", login: "driver-1", name: "Primary Driver", active: true }],
  trucks: [{ id: "9", plate: "AB123", active: true }]
}).length === 0, "Active canonical fleet assignments were rejected.");
assert(dispatchFleetAssignmentStatusConflicts({
  trucks: [{ id: "9", plate: "AB 123", loads: [{ id: "collision", orders: ["SO-1"], truckId: "9", truckPlate: "AB 123" }] }]
}, {
  drivers: [],
  trucks: [
    { id: "9", plate: "AB 123", active: false },
    { id: "10", plate: "AB123", active: true }
  ]
}).some((conflict) => conflict.code === "DISPATCH_TRUCK_DISABLED"), "A normalized plate collision masked a disabled truck with an exact ID.");

console.log(JSON.stringify({
  setupManagementShowsInactive: true,
  targetedStatusButtons: true,
  plannerActiveOnly: true,
  activeLoadProtection: true,
  historicalStatisticsIndependent: true
}));
