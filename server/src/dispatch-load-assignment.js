const DEFAULT_SWITCH_MINUTES = 10;
const DEFAULT_OWN_YARDS = ["3445", "2967", "12441", "150"];

function text(value) {
  return String(value ?? "").trim();
}

function key(value) {
  const normalized = text(value).toLowerCase();
  return normalized === "unassigned" ? "" : normalized;
}

function yardCode(value) {
  if (value && typeof value === "object") {
    return text(value.code || value.name || value.id);
  }
  return text(value);
}

export function dispatchOwnYardCodes(plan = {}, configuredOwnYards = null) {
  const planCandidates = [
    plan.ownYardCodes,
    plan.ownYards,
    plan.summary?.ownYardCodes,
    plan.summary?.ownYards,
    plan.summary?.dispatchPlanFormat?.ownYardCodes
  ];
  const source = Array.isArray(configuredOwnYards) && configuredOwnYards.length
    ? configuredOwnYards
    : planCandidates.find((candidate) => Array.isArray(candidate) && candidate.length)
      || DEFAULT_OWN_YARDS;
  return [...new Set(source.map(yardCode).filter(Boolean))];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function dispatchMinute(value) {
  const direct = finiteNumber(value);
  if (direct !== null) return Math.round(direct);
  const match = text(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return (Number(match[1]) * 60) + Number(match[2]);
}

export function loadHasPlanningContent(load = {}) {
  return Boolean(
    load.returnOnly
    || (Array.isArray(load.stops) && load.stops.length)
    || (Array.isArray(load.orders) && load.orders.length)
  );
}

export function dispatchLoadAssignment(truck = {}, load = {}, { driverSequence = 0 } = {}) {
  const start = dispatchMinute(load.plannedStartMinute ?? load.timing?.start ?? load.start ?? truck.start);
  const finish = dispatchMinute(load.plannedFinishMinute ?? load.timing?.finish ?? load.finish);
  const handoffMinutes = finiteNumber(
    load.handoffTravelMinutes
    ?? load.handoff_travel_minutes
    ?? load.timing?.handoffTravel?.minutes
  );
  return {
    driverLogin: key(load.driverLogin || load.driver_login || load.driver || truck.driverLogin || truck.driver_login || truck.driver),
    driverName: text(load.driverName || load.driver_name || load.driver || truck.driverName || truck.driver),
    truckId: text(load.truckId || load.truck_id || truck.id),
    truckPlate: text(load.truckPlate || load.truck_plate || truck.plate).toUpperCase(),
    switchYard: text(load.switchYard || load.switch_yard || load.startYard || truck.base),
    parkingSpot: text(load.parkingSpot || load.parking_spot || truck.parkingSpot),
    plannedStartMinute: start,
    plannedFinishMinute: finish,
    handoffTravelMinutes: Math.max(0, Math.round(handoffMinutes ?? 0)),
    handoffTravelFrom: text(load.handoffTravelFrom || load.handoff_travel_from || load.timing?.handoffTravel?.from),
    handoffTravelTo: text(load.handoffTravelTo || load.handoff_travel_to || load.timing?.handoffTravel?.to),
    driverSequence: Math.max(0, Math.round(finiteNumber(load.driverSequence ?? load.driver_sequence) ?? driverSequence))
  };
}

export function normalizeDispatchPlanLoadAssignments(plan = {}) {
  const sequenceByDriver = new Map();
  const trucks = (plan.trucks || []).map((truck) => ({
    ...truck,
    loads: (truck.loads || []).map((load, loadIndex) => {
      const fallbackDriver = key(load.driverLogin || load.driver_login || load.driver || truck.driverLogin || truck.driver_login || truck.driver);
      const nextSequence = sequenceByDriver.get(fallbackDriver) ?? loadIndex;
      const assignment = dispatchLoadAssignment(truck, load, { driverSequence: nextSequence });
      sequenceByDriver.set(assignment.driverLogin, Math.max(nextSequence, assignment.driverSequence) + 1);
      return { ...load, ...assignment };
    })
  }));
  return { ...plan, trucks };
}

export function flattenDispatchPlanLoads(plan = {}) {
  const normalized = normalizeDispatchPlanLoadAssignments(plan);
  const rows = [];
  for (const [truckIndex, truck] of (normalized.trucks || []).entries()) {
    for (const [loadIndex, load] of (truck.loads || []).entries()) {
      rows.push({
        planId: normalized.id ?? normalized.planId ?? null,
        planDate: text(normalized.planDate || normalized.plan_date).slice(0, 10),
        truck,
        load,
        truckIndex,
        loadIndex,
        ...dispatchLoadAssignment(truck, load, { driverSequence: loadIndex })
      });
    }
  }
  return rows;
}

export function driverLoadLanes(plan = {}, configuredDrivers = []) {
  const rows = flattenDispatchPlanLoads(plan);
  const laneByLogin = new Map();
  for (const [index, driver] of (configuredDrivers || []).entries()) {
    const login = key(driver.login || driver.driverLogin);
    if (!login) continue;
    laneByLogin.set(login, {
      driverLogin: login,
      driverName: text(driver.name || driver.driverName || login),
      displayOrder: Number(driver.displayOrder ?? index),
      driver,
      loads: []
    });
  }
  for (const row of rows) {
    const login = row.driverLogin;
    if (!laneByLogin.has(login)) {
      laneByLogin.set(login, {
        driverLogin: login,
        driverName: row.driverName || (login ? login : "Unassigned"),
        displayOrder: login ? 100000 : 200000,
        driver: null,
        loads: []
      });
    }
    laneByLogin.get(login).loads.push(row);
  }
  for (const lane of laneByLogin.values()) {
    lane.loads.sort((left, right) => {
      const leftStart = left.plannedStartMinute ?? Number.MAX_SAFE_INTEGER;
      const rightStart = right.plannedStartMinute ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart
        || left.driverSequence - right.driverSequence
        || left.truckIndex - right.truckIndex
        || left.loadIndex - right.loadIndex;
    });
  }
  return [...laneByLogin.values()].sort((left, right) =>
    left.displayOrder - right.displayOrder || left.driverName.localeCompare(right.driverName)
  );
}

function lastRoutedStop(load = {}) {
  return [...(load.stops || [])].reverse().find((stop) => ["pick", "drop", "return"].includes(String(stop?.type || "")));
}

export function loadEndYard(load = {}, ownYards = null, plan = {}) {
  const own = new Set(dispatchOwnYardCodes(plan, ownYards));
  if (load.returnOnly) {
    const yard = text(load.returnYard || load.return_yard);
    return own.has(yard) ? yard : "";
  }
  const stop = lastRoutedStop(load);
  const order = stop?.type === "drop"
    ? (plan.orders || []).find((item) => text(item?.id) === text(stop?.orderId)) || {}
    : {};
  const scopedPurchaseDrop = text(order?.type).toUpperCase() === "PO"
    && ((stop?.lineRowIds || []).length > 0 || text(stop?.dropoffKey));
  const candidates = stop?.type === "pick"
    ? [stop?.location, stop?.yard]
    : [
        stop?.dropLocation,
        stop?.drop_location,
        stop?.destinationYard,
        stop?.destination_yard,
        scopedPurchaseDrop ? stop?.location : "",
        stop?.yard,
        order?.destinationYard,
        order?.destination_yard,
        order?.toLocation,
        order?.to_location
      ];
  const normalizedCandidates = candidates.map(text).filter(Boolean);
  return normalizedCandidates.find((candidate) => own.has(candidate)) || "";
}

function conflict(code, message, details = {}) {
  return { code, message, ...details };
}

function intervalsOverlap(left, right) {
  return left.start < right.finish && right.start < left.finish;
}

export function validateDispatchLoadAssignments(plan = {}, {
  switchMinutes = DEFAULT_SWITCH_MINUTES,
  ownYards = null,
  requireAssignments = false
} = {}) {
  const rows = flattenDispatchPlanLoads(plan).filter((row) => loadHasPlanningContent(row.load));
  const conflicts = [];
  const parsedSwitchMinutes = Number(switchMinutes);
  const cleanSwitchMinutes = Math.max(0, Math.round(Number.isFinite(parsedSwitchMinutes) ? parsedSwitchMinutes : DEFAULT_SWITCH_MINUTES));
  const resolvedOwnYards = dispatchOwnYardCodes(plan, ownYards);
  const own = new Set(resolvedOwnYards);

  for (const row of rows) {
    if (requireAssignments && (!row.driverLogin || !row.truckPlate)) {
      conflicts.push(conflict("DISPATCH_DRIVER_TIME_CONFLICT", `${row.load.name || row.load.id} requires both a driver and truck before confirmation.`, {
        loadId: text(row.load.id), driverLogin: row.driverLogin, truckPlate: row.truckPlate, reason: "missing_assignment"
      }));
    }
    if (requireAssignments && (row.plannedStartMinute === null || row.plannedFinishMinute === null)) {
      conflicts.push(conflict("DISPATCH_DRIVER_TIME_CONFLICT", `${row.load.name || row.load.id} requires a planned start and finish time before confirmation.`, {
        loadId: text(row.load.id), driverLogin: row.driverLogin, truckPlate: row.truckPlate, reason: "missing_interval"
      }));
    }
    if (row.plannedStartMinute !== null && row.plannedFinishMinute !== null && row.plannedFinishMinute <= row.plannedStartMinute) {
      conflicts.push(conflict("DISPATCH_DRIVER_TIME_CONFLICT", `${row.load.name || row.load.id} has an invalid planned time interval.`, {
        loadId: text(row.load.id), driverLogin: row.driverLogin, truckPlate: row.truckPlate, reason: "invalid_interval"
      }));
    }
  }

  const validRows = rows.filter((row) => row.plannedStartMinute !== null && row.plannedFinishMinute !== null && row.plannedFinishMinute > row.plannedStartMinute);
  const byDriver = new Map();
  for (const row of validRows) {
    if (!row.driverLogin) continue;
    if (!byDriver.has(row.driverLogin)) byDriver.set(row.driverLogin, []);
    byDriver.get(row.driverLogin).push(row);
  }

  const occupancy = validRows.map((row) => ({ ...row, start: row.plannedStartMinute, finish: row.plannedFinishMinute }));
  for (const [driverLogin, driverRows] of byDriver.entries()) {
    driverRows.sort((left, right) => left.plannedStartMinute - right.plannedStartMinute || left.driverSequence - right.driverSequence);
    for (let index = 1; index < driverRows.length; index += 1) {
      const previous = driverRows[index - 1];
      const current = driverRows[index];
      const changedTruck = previous.truckPlate !== current.truckPlate;
      const switchStart = changedTruck ? current.plannedStartMinute - cleanSwitchMinutes : current.plannedStartMinute;
      const handoffMinutes = changedTruck ? Math.max(0, Number(current.handoffTravelMinutes || 0)) : 0;
      const activityStart = switchStart - handoffMinutes;
      if (previous.plannedFinishMinute > activityStart) {
        conflicts.push(conflict("DISPATCH_DRIVER_TIME_CONFLICT", `${previous.driverName || driverLogin} is assigned to overlapping loads ${previous.load.name || previous.load.id} and ${current.load.name || current.load.id}.`, {
          driverLogin,
          loadIds: [text(previous.load.id), text(current.load.id)],
          handoffMinutes,
          switchMinutes: changedTruck ? cleanSwitchMinutes : 0,
          reason: changedTruck ? "switch_approach_overlap" : "overlap"
        }));
        continue;
      }
      if (!changedTruck) continue;
      const previousEndYard = loadEndYard(previous.load, resolvedOwnYards, plan);
      const switchYard = text(current.switchYard);
      const handoffFrom = text(current.handoffTravelFrom);
      const handoffTo = text(current.handoffTravelTo);
      const hasPlannedApproach = handoffMinutes > 0 && handoffFrom && handoffTo === switchYard;
      if (requireAssignments && (!own.has(switchYard) || ((!previousEndYard || previousEndYard !== switchYard) && !hasPlannedApproach))) {
        conflicts.push(conflict("DISPATCH_TRUCK_HANDOFF_INVALID", `Truck switch for ${previous.driverName || driverLogin} needs a travel leg to the same own yard before the switch.`, {
          driverLogin,
          previousLoadId: text(previous.load.id),
          nextLoadId: text(current.load.id),
          previousEndYard,
          switchYard,
          handoffFrom,
          handoffTo,
          handoffMinutes,
          reason: "missing_switch_approach"
        }));
      }
      const currentOccupancy = occupancy.find((item) => item.load === current.load);
      if (currentOccupancy) currentOccupancy.start = switchStart;
      if (hasPlannedApproach) {
        occupancy.push({
          ...current,
          truckId: previous.truckId,
          truckPlate: previous.truckPlate,
          start: activityStart,
          finish: switchStart,
          isHandoffTravel: true
        });
      }
      const previousTargetUse = validRows
        .filter((candidate) => candidate.load !== current.load
          && candidate.truckPlate === current.truckPlate
          && candidate.plannedFinishMinute <= switchStart)
        .sort((left, right) => right.plannedFinishMinute - left.plannedFinishMinute)[0];
      const targetAvailableYard = previousTargetUse
        ? loadEndYard(previousTargetUse.load, resolvedOwnYards, plan)
        : text(current.truck?.base);
      if (requireAssignments && ((previousTargetUse && !targetAvailableYard) || (targetAvailableYard && targetAvailableYard !== switchYard))) {
        conflicts.push(conflict("DISPATCH_TRUCK_HANDOFF_INVALID", targetAvailableYard
          ? `${current.truckPlate} is available at ${targetAvailableYard}, not ${switchYard}, for this truck switch.`
          : `${current.truckPlate} did not finish its previous load at an own yard. Add a return load before this truck switch.`, {
          driverLogin,
          previousLoadId: text(previous.load.id),
          nextLoadId: text(current.load.id),
          truckPlate: current.truckPlate,
          targetAvailableYard,
          switchYard,
          reason: "target_truck_yard_mismatch"
        }));
      }
    }
  }

  const byTruck = new Map();
  for (const row of occupancy) {
    if (!row.truckPlate) continue;
    if (!byTruck.has(row.truckPlate)) byTruck.set(row.truckPlate, []);
    byTruck.get(row.truckPlate).push(row);
  }
  for (const [truckPlate, truckRows] of byTruck.entries()) {
    truckRows.sort((left, right) => left.start - right.start || left.finish - right.finish);
    for (let index = 1; index < truckRows.length; index += 1) {
      const previous = truckRows[index - 1];
      const current = truckRows[index];
      if (intervalsOverlap(previous, current)) {
        conflicts.push(conflict("DISPATCH_TRUCK_OCCUPANCY_CONFLICT", `${truckPlate} is assigned to overlapping loads ${previous.load.name || previous.load.id} and ${current.load.name || current.load.id}.`, {
          truckPlate,
          driverLogins: [previous.driverLogin, current.driverLogin],
          loadIds: [text(previous.load.id), text(current.load.id)],
          reason: "overlap"
        }));
        continue;
      }
      if (!previous.isHandoffTravel && !current.isHandoffTravel && previous.driverLogin && current.driverLogin && previous.driverLogin !== current.driverLogin) {
        const previousEndYard = loadEndYard(previous.load, resolvedOwnYards, plan);
        const handoffYard = text(current.switchYard);
        if (requireAssignments && (!previousEndYard || !own.has(handoffYard) || previousEndYard !== handoffYard)) {
          conflicts.push(conflict("DISPATCH_TRUCK_HANDOFF_INVALID", `${truckPlate} must finish at ${handoffYard || "the next start yard"} before it can be handed to ${current.driverName || current.driverLogin}.`, {
            truckPlate,
            driverLogins: [previous.driverLogin, current.driverLogin],
            loadIds: [text(previous.load.id), text(current.load.id)],
            previousEndYard,
            handoffYard,
            reason: "driver_handoff_yard_mismatch"
          }));
        }
      }
    }
  }
  return conflicts;
}

export function changedLockedLoadAssignments(previousPlan = {}, nextPlan = {}, lockedLoadIds = new Set()) {
  const before = new Map(flattenDispatchPlanLoads(previousPlan).map((row) => [text(row.load.id), row]));
  const after = new Map(flattenDispatchPlanLoads(nextPlan).map((row) => [text(row.load.id), row]));
  const allocationSignature = (plan, row) => {
    const refs = new Set((row?.load?.stops || []).map((stop) => text(stop.orderId)).filter(Boolean));
    return (plan.orders || [])
      .filter((order) => refs.has(text(order.id)))
      .map((order) => ({
        id: text(order.id),
        childOrders: order.childOrders || [],
        items: (order.items || []).map((item) => ({
          id: text(item.id || item.lineId || item.line_id || item.sku || item.itemName),
          quantity: item.quantity ?? item.salesQty ?? null,
          pallets: item.pallets ?? item.pallet_qty ?? null,
          layers: item.layers ?? item.layer_qty ?? null,
          sections: item.sections ?? item.section_qty ?? null,
          pieces: item.pieces ?? item.piece_qty ?? null,
          splitQty: item.splitQty ?? null
        }))
      }));
  };
  const stopSignature = (stop = {}) => ({
    id: text(stop.id),
    type: text(stop.type),
    orderId: text(stop.orderId),
    location: text(stop.location),
    address: text(stop.address),
    yard: text(stop.yard),
    dropoffKey: text(stop.dropoffKey),
    dropLocation: text(stop.dropLocation),
    dropAddress: text(stop.dropAddress),
    destinationYard: text(stop.destinationYard || stop.destination_yard),
    destinationLocationId: text(stop.destinationLocationId || stop.destination_location_id),
    lineRowIds: [...new Set((stop.lineRowIds || []).map(text).filter(Boolean))].sort(),
    arriveTime: text(stop.arriveTime || stop.plannedArrive),
    departTime: text(stop.departTime || stop.plannedDepart),
    timing: {
      arrival: dispatchMinute(stop.timing?.arrival),
      depart: dispatchMinute(stop.timing?.depart)
    }
  });
  const lockedSignature = (plan, row) => row ? JSON.stringify({
    driverLogin: row.driverLogin,
    driverName: row.driverName,
    truckId: row.truckId,
    truckPlate: row.truckPlate,
    switchYard: row.switchYard,
    parkingSpot: row.parkingSpot,
    driverSequence: row.driverSequence,
    plannedStartMinute: row.plannedStartMinute,
    plannedFinishMinute: row.plannedFinishMinute,
    handoffTravelMinutes: row.handoffTravelMinutes,
    handoffTravelFrom: row.handoffTravelFrom,
    handoffTravelTo: row.handoffTravelTo,
    returnOnly: row.load.returnOnly === true,
    returnYard: text(row.load.returnYard || row.load.return_yard),
    stops: (row.load.stops || []).map(stopSignature),
    allocations: allocationSignature(plan, row)
  }) : "";
  const changes = [];
  for (const loadId of lockedLoadIds || []) {
    const previous = before.get(text(loadId));
    const current = after.get(text(loadId));
    const previousSignature = lockedSignature(previousPlan, previous);
    const currentSignature = lockedSignature(nextPlan, current);
    if (previousSignature !== currentSignature) changes.push({ loadId: text(loadId), previous, current });
  }
  return changes;
}

export const dispatchLoadAssignmentDefaults = {
  switchMinutes: DEFAULT_SWITCH_MINUTES,
  ownYards: [...DEFAULT_OWN_YARDS]
};
