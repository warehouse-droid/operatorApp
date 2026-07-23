import {
  changedLockedLoadAssignments,
  dispatchLoadAssignment,
  flattenDispatchPlanLoads,
  loadHasPlanningContent,
  normalizeDispatchPlanLoadAssignments
} from "./dispatch-load-assignment.js";

export const DISPATCH_FLEET_PLANNING_LOCK = "dispatch_fleet_planning_mutation";

function normalizedPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

export function dispatchFleetPlanConflicts(planRows = [], {
  driver = null,
  truck = null,
  drivers = null,
  trucks = null
} = {}) {
  const driverLogin = String(driver?.login || "").trim().toLowerCase();
  const driverName = String(driver?.name || "").trim().toLowerCase();
  const truckId = String(truck?.id || "").trim();
  const truckPlate = normalizedPlate(truck?.plate);
  const knownDriverLogins = new Set((drivers || []).map((item) => String(item?.login || "").trim().toLowerCase()).filter(Boolean));
  const knownTruckIds = new Set((trucks || []).map((item) => String(item?.id || "").trim()).filter(Boolean));
  const hasDriverContext = Array.isArray(drivers);
  const hasTruckContext = Array.isArray(trucks);
  const resourceLabel = driver?.name || driver?.login || truck?.plate || "This resource";
  const conflicts = [];

  for (const row of planRows || []) {
    const completedLoadIds = new Set((row.completedLoadIds || row.completed_load_ids || []).map(String));
    for (const parentTruck of Array.isArray(row?.trucks) ? row.trucks : []) {
      for (const load of Array.isArray(parentTruck?.loads) ? parentTruck.loads : []) {
        if (!loadHasPlanningContent(load)) continue;
        if (completedLoadIds.has(String(load.id || ""))) continue;
        const assignment = dispatchLoadAssignment(parentTruck, load);
        const hasCanonicalDriverLogin = Boolean(String(
          load?.driverLogin
          || load?.driver_login
          || parentTruck?.driverLogin
          || parentTruck?.driver_login
          || ""
        ).trim());
        const rawTruckId = String(load?.truckId || load?.truck_id || parentTruck?.id || "").trim();
        const assignmentDriverLogin = String(assignment.driverLogin || "").trim().toLowerCase();
        const hasKnownCanonicalDriverLogin = hasCanonicalDriverLogin
          && (!hasDriverContext || knownDriverLogins.has(assignmentDriverLogin));
        const hasKnownCanonicalTruckId = /^[1-9]\d*$/.test(rawTruckId)
          && (!hasTruckContext || knownTruckIds.has(rawTruckId));
        const matchesDriver = driver && (
          assignmentDriverLogin === driverLogin
          || (!hasKnownCanonicalDriverLogin && driverName && String(assignment.driverName || "").trim().toLowerCase() === driverName)
        );
        const matchesTruck = truck && (
          (truckId && String(assignment.truckId || "").trim() === truckId)
          || (!hasKnownCanonicalTruckId && truckPlate && normalizedPlate(assignment.truckPlate) === truckPlate)
        );
        if (!matchesDriver && !matchesTruck) continue;
        const planDate = String(row.plan_date || row.planDate || "").slice(0, 10);
        conflicts.push({
          type: "plan_load",
          planId: String(row.id || row.plan_id || row.planId || ""),
          planDate,
          planStatus: row.status,
          loadId: String(load.id || ""),
          loadName: String(load.name || load.id || ""),
          message: `${resourceLabel} is assigned to ${load.name || load.id || "a load"} on ${planDate} (${row.status || "draft"}).`
        });
      }
    }
  }
  return conflicts;
}

export function dispatchLegacyDriverRenameConflicts(planRows = [], renames = []) {
  const changes = (renames || []).map((rename) => ({
    ...rename,
    previousNameKey: String(rename?.previousName || "").trim().toLowerCase()
  })).filter((rename) => rename.previousNameKey);
  if (!changes.length) return [];
  const conflicts = [];
  for (const row of planRows || []) {
    for (const parentTruck of Array.isArray(row?.trucks) ? row.trucks : []) {
      for (const load of Array.isArray(parentTruck?.loads) ? parentTruck.loads : []) {
        if (!loadHasPlanningContent(load)) continue;
        const explicitLogin = String(
          load?.driverLogin
          || load?.driver_login
          || parentTruck?.driverLogin
          || parentTruck?.driver_login
          || ""
        ).trim();
        if (explicitLogin) continue;
        const assignment = dispatchLoadAssignment(parentTruck, load);
        const legacyNameKey = String(assignment.driverName || assignment.driverLogin || "").trim().toLowerCase();
        const rename = changes.find((item) => item.previousNameKey === legacyNameKey);
        if (!rename) continue;
        conflicts.push({
          type: "legacy_driver_name",
          planId: String(row.id || row.plan_id || row.planId || ""),
          planDate: String(row.plan_date || row.planDate || "").slice(0, 10),
          loadId: String(load.id || ""),
          loadName: String(load.name || load.id || ""),
          driverId: String(rename.id || ""),
          driverLogin: String(rename.login || ""),
          previousName: String(rename.previousName || ""),
          nextName: String(rename.nextName || ""),
          message: `${rename.previousName} is assigned by legacy name to ${load.name || load.id || "a load"}. Save/translate or finish that plan before renaming the driver.`
        });
      }
    }
  }
  return conflicts;
}

function driverIdentityMaps(drivers = []) {
  const byLogin = new Map();
  const byName = new Map();
  for (const driver of drivers || []) {
    const login = String(driver?.login || "").trim().toLowerCase();
    const name = String(driver?.name || "").trim().toLowerCase();
    if (login) byLogin.set(login, driver);
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(driver);
    }
  }
  return { byLogin, byName };
}

function truckIdentityMaps(trucks = []) {
  const byId = new Map();
  const byPlate = new Map();
  for (const truck of trucks || []) {
    const id = String(truck?.id || "").trim();
    const plate = normalizedPlate(truck?.plate);
    if (id) byId.set(id, truck);
    if (plate) {
      if (!byPlate.has(plate)) byPlate.set(plate, []);
      byPlate.get(plate).push(truck);
    }
  }
  return { byId, byPlate };
}

export function unchangedCompletedDispatchLoadIds(previousPlan = {}, nextPlan = {}, completedLoadIds = []) {
  const completed = new Set((completedLoadIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  if (!completed.size) return new Set();
  const countLoads = (plan) => {
    const counts = new Map();
    for (const row of flattenDispatchPlanLoads(plan)) {
      const loadId = String(row.load?.id || "").trim();
      if (loadId) counts.set(loadId, (counts.get(loadId) || 0) + 1);
    }
    return counts;
  };
  const beforeCounts = countLoads(previousPlan);
  const afterCounts = countLoads(nextPlan);
  const changed = new Set(changedLockedLoadAssignments(previousPlan, nextPlan, completed).map((row) => String(row.loadId)));
  return new Set([...completed].filter((loadId) =>
    beforeCounts.get(loadId) === 1
    && afterCounts.get(loadId) === 1
    && !changed.has(loadId)
  ));
}

export function dispatchFleetAssignmentStatusConflicts(
  plan = {},
  { drivers = [], trucks = [] } = {},
  { allowedInactiveLoadIds = [] } = {}
) {
  const normalized = normalizeDispatchPlanLoadAssignments(plan);
  const driverMaps = driverIdentityMaps(drivers);
  const truckMaps = truckIdentityMaps(trucks);
  const allowedInactive = new Set(Array.from(allowedInactiveLoadIds || []).map(String));
  const conflicts = [];

  for (const parentTruck of normalized.trucks || []) {
    for (const load of parentTruck.loads || []) {
      if (!loadHasPlanningContent(load)) continue;
      if (allowedInactive.has(String(load.id || ""))) continue;
      const assignment = dispatchLoadAssignment(parentTruck, load);
      if (assignment.driverLogin) {
        const driverLogin = assignment.driverLogin.toLowerCase();
        const exactDriver = driverMaps.byLogin.get(driverLogin);
        const legacyNameMatches = exactDriver ? [] : (driverMaps.byName.get(driverLogin) || []);
        const resolvedDriver = exactDriver || (legacyNameMatches.length === 1 ? legacyNameMatches[0] : null);
        if (!resolvedDriver || resolvedDriver.active === false) {
          conflicts.push({
            code: "DISPATCH_DRIVER_DISABLED",
            message: `${load.name || load.id} is assigned to disabled or unavailable driver ${assignment.driverName || assignment.driverLogin}. Reassign the load before saving.`,
            loadId: String(load.id || ""),
            driverLogin: assignment.driverLogin
          });
        }
      }

      if (assignment.truckId || assignment.truckPlate) {
        const exactTruckId = truckMaps.byId.get(String(assignment.truckId || ""));
        const plateMatches = truckMaps.byPlate.get(normalizedPlate(assignment.truckPlate)) || [];
        const plateMatchesExactId = exactTruckId
          && (!assignment.truckPlate || normalizedPlate(exactTruckId.plate) === normalizedPlate(assignment.truckPlate));
        const resolvedTruck = exactTruckId
          ? (plateMatchesExactId ? exactTruckId : null)
          : (plateMatches.length === 1 ? plateMatches[0] : null);
        if (!resolvedTruck || resolvedTruck.active === false) {
          conflicts.push({
            code: "DISPATCH_TRUCK_DISABLED",
            message: `${load.name || load.id} is assigned to disabled or unavailable truck ${assignment.truckPlate || assignment.truckId}. Reassign the load before saving.`,
            loadId: String(load.id || ""),
            truckId: assignment.truckId,
            truckPlate: assignment.truckPlate
          });
        }
      }
    }
  }
  return conflicts;
}
