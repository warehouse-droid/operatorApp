function text(value) {
  return String(value ?? "").trim();
}

function loginKey(value) {
  return text(value).toLowerCase();
}

function plateKey(value) {
  return text(value).toUpperCase();
}

function dateOnly(value) {
  const date = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function loadHasPlanningContent(load = {}) {
  return load.returnOnly === true
    || (Array.isArray(load.stops) && load.stops.length > 0)
    || (Array.isArray(load.orders) && load.orders.length > 0);
}

function oneValue(values, label) {
  const unique = [...new Set(values.map(text).filter(Boolean))];
  if (unique.length > 1) throw new Error(`${label} cannot be represented by the legacy dispatch plan.`);
  return unique[0] || "";
}

function publicDriverMap(drivers = []) {
  const byLogin = new Map();
  for (const driver of drivers) {
    const login = loginKey(driver?.login);
    if (!login) throw new Error("Destination dispatch contains a driver without a login.");
    if (byLogin.has(login)) throw new Error(`Destination dispatch has duplicate driver login ${login}.`);
    byLogin.set(login, driver);
  }
  return byLogin;
}

function publicTruckMap(trucks = []) {
  const byPlate = new Map();
  for (const truck of trucks) {
    const plate = plateKey(truck?.plate);
    if (!plate) throw new Error("Destination dispatch contains a truck without a plate.");
    if (byPlate.has(plate)) throw new Error(`Destination dispatch has duplicate truck plate ${plate}.`);
    byPlate.set(plate, truck);
  }
  return byPlate;
}

function applyLegacyDriver(truck, driver) {
  const ownYardFixedMinutes = Number(driver.ownYardFixedMinutes ?? driver.loadMinutes ?? 40);
  const vendorFixedMinutes = Number(driver.vendorFixedMinutes ?? driver.outsideFixedMinutes ?? driver.unloadMinutes ?? 35);
  const deliveryFixedMinutes = Number(driver.deliveryFixedMinutes ?? driver.outsideFixedMinutes ?? driver.unloadMinutes ?? 35);
  return {
    ...truck,
    driverLogin: loginKey(driver.login),
    driver: text(driver.name) || loginKey(driver.login),
    license: text(driver.license) || "-",
    ownYardFixedMinutes,
    vendorFixedMinutes,
    deliveryFixedMinutes,
    outsideFixedMinutes: deliveryFixedMinutes,
    minutesPerPallet: Number(driver.minutesPerPallet ?? 1),
    loadMinutes: ownYardFixedMinutes,
    unloadMinutes: deliveryFixedMinutes
  };
}

function plannedStartMinute(load = {}) {
  const explicit = Number(load.plannedStartMinute);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const match = /^(\d{1,2}):(\d{2})$/.exec(text(load.start));
  if (!match) return Number.MAX_SAFE_INTEGER;
  return (Number(match[1]) * 60) + Number(match[2]);
}

function minuteText(value) {
  const minute = Math.max(0, Math.round(Number(value || 0)));
  return `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function translatedLoads(sourceTruck, destinationTruck, driver) {
  const sourceLoads = Array.isArray(sourceTruck.loads) ? sourceTruck.loads : [];
  const loads = (sourceLoads.length
    ? sourceLoads
    : [{ id: `${destinationTruck.id}-L1`, name: "Load 1", stops: [] }])
    .map((load, originalIndex) => ({ load, originalIndex }))
    .sort((left, right) => plannedStartMinute(left.load) - plannedStartMinute(right.load)
      || Number(left.load.driverSequence ?? Number.MAX_SAFE_INTEGER) - Number(right.load.driverSequence ?? Number.MAX_SAFE_INTEGER)
      || left.originalIndex - right.originalIndex);
  let reordered = 0;
  let materializedStarts = 0;
  const translated = loads.map(({ load, originalIndex }, translatedIndex) => {
    if (originalIndex !== translatedIndex) reordered += 1;
    const explicitStart = Number(load.plannedStartMinute);
    const start = Number.isFinite(explicitStart) && explicitStart >= 0 ? minuteText(explicitStart) : load.start;
    if (start && start !== load.start) materializedStarts += 1;
    return {
      ...structuredClone(load),
      ...(start ? { start } : {}),
      driverLogin: loginKey(driver.login),
      driverName: text(driver.name) || loginKey(driver.login),
      truckId: String(destinationTruck.id),
      truckPlate: plateKey(destinationTruck.plate)
    };
  });
  return { loads: translated, reordered, materializedStarts };
}

export function translateDriverOrientedDispatchPlan({
  sourcePlan,
  destinationDrivers = [],
  destinationTrucks = [],
  targetDate
} = {}) {
  const sourceDate = dateOnly(sourcePlan?.planDate || sourcePlan?.plan_date);
  const cleanTargetDate = dateOnly(targetDate);
  if (!sourceDate || !cleanTargetDate || sourceDate !== cleanTargetDate) {
    throw new Error(`Source plan date ${sourceDate || "invalid"} does not match destination date ${cleanTargetDate || "invalid"}.`);
  }
  if (text(sourcePlan?.status).toLowerCase() !== "confirmed") {
    throw new Error("Only a confirmed source dispatch plan can be mirrored.");
  }
  if (!Array.isArray(sourcePlan?.orders) || !Array.isArray(sourcePlan?.trucks)) {
    throw new Error("Source dispatch plan is missing orders or trucks.");
  }

  const driverByLogin = publicDriverMap(destinationDrivers);
  const truckByPlate = publicTruckMap(destinationTrucks);
  const activeDriverByPlate = new Map();
  const activeStartYardByPlate = new Map();
  const activeParkingSpotByPlate = new Map();
  const activeDriverPlates = new Map();
  let activeLoadCount = 0;

  for (const sourceTruck of sourcePlan.trucks) {
    const plate = plateKey(sourceTruck?.plate || sourceTruck?.truckPlate);
    if (!plate || !truckByPlate.has(plate)) throw new Error(`Source truck ${plate || "without plate"} is not active on the destination.`);
    const activeLoads = (sourceTruck.loads || []).filter(loadHasPlanningContent);
    if (!activeLoads.length) continue;
    activeLoadCount += activeLoads.length;
    for (const load of activeLoads) {
      const loadPlate = plateKey(load.truckPlate || load.truck_plate || plate);
      if (loadPlate !== plate) throw new Error(`${plate} contains a load assigned to ${loadPlate}.`);
    }
    const driverLogin = loginKey(oneValue(
      activeLoads.map((load) => load.driverLogin || load.driver_login),
      `${plate} has multiple active load drivers`
    ));
    if (!driverLogin) throw new Error(`${plate} has an active load without a driver.`);
    if (!driverByLogin.has(driverLogin)) throw new Error(`Source driver ${driverLogin} is not active on the destination.`);
    if (activeDriverPlates.has(driverLogin) && activeDriverPlates.get(driverLogin) !== plate) {
      throw new Error(`Source driver ${driverLogin} has active loads on multiple trucks.`);
    }
    activeDriverPlates.set(driverLogin, plate);
    activeDriverByPlate.set(plate, driverLogin);
    activeStartYardByPlate.set(plate, oneValue(
      activeLoads.map((load) => load.switchYard || load.switch_yard).filter(Boolean),
      `${plate} has multiple active start yards`
    ));
    activeParkingSpotByPlate.set(plate, oneValue(
      activeLoads.map((load) => load.parkingSpot || load.parking_spot).filter(Boolean),
      `${plate} has multiple active parking spots`
    ));
  }

  const usedDrivers = new Set(activeDriverByPlate.values());
  const assignedDriverByPlate = new Map(activeDriverByPlate);
  const availableDrivers = destinationDrivers.filter((driver) => !usedDrivers.has(loginKey(driver.login)));
  const sourceTruckByPlate = new Map(sourcePlan.trucks.map((truck) => [plateKey(truck.plate || truck.truckPlate), truck]));

  for (const sourceTruck of sourcePlan.trucks) {
    const plate = plateKey(sourceTruck.plate || sourceTruck.truckPlate);
    if (assignedDriverByPlate.has(plate)) continue;
    const preferredLogin = loginKey(sourceTruck.driverLogin || sourceTruck.driver_login);
    if (preferredLogin && driverByLogin.has(preferredLogin) && !usedDrivers.has(preferredLogin)) {
      assignedDriverByPlate.set(plate, preferredLogin);
      usedDrivers.add(preferredLogin);
      const index = availableDrivers.findIndex((driver) => loginKey(driver.login) === preferredLogin);
      if (index >= 0) availableDrivers.splice(index, 1);
      continue;
    }
    const fallback = availableDrivers.shift();
    if (!fallback) throw new Error("Destination does not have enough unique drivers for the legacy truck layout.");
    const fallbackLogin = loginKey(fallback.login);
    assignedDriverByPlate.set(plate, fallbackLogin);
    usedDrivers.add(fallbackLogin);
  }

  for (const destinationTruck of destinationTrucks) {
    const plate = plateKey(destinationTruck.plate);
    if (sourceTruckByPlate.has(plate)) continue;
    const fallback = availableDrivers.shift();
    if (!fallback) throw new Error(`No unique driver is available for destination-only truck ${plate}.`);
    assignedDriverByPlate.set(plate, loginKey(fallback.login));
  }

  const translatedTrucks = [];
  let reorderedLoadCount = 0;
  let materializedLoadStartCount = 0;
  const orderedPlates = [
    ...sourcePlan.trucks.map((truck) => plateKey(truck.plate || truck.truckPlate)),
    ...destinationTrucks.map((truck) => plateKey(truck.plate)).filter((plate) => !sourceTruckByPlate.has(plate))
  ];
  for (const plate of orderedPlates) {
    const destinationTruck = truckByPlate.get(plate);
    const sourceTruck = sourceTruckByPlate.get(plate) || {
      plate,
      base: "",
      parkingSpot: "",
      start: "07:00",
      loads: []
    };
    const driver = driverByLogin.get(assignedDriverByPlate.get(plate));
    if (!destinationTruck || !driver) throw new Error(`Could not translate truck ${plate}.`);
    const startYard = activeStartYardByPlate.get(plate);
    const parkingSpot = activeParkingSpotByPlate.get(plate);
    let translatedTruck = {
      ...structuredClone(sourceTruck),
      id: String(destinationTruck.id),
      plate: plateKey(destinationTruck.plate),
      capacityLbs: Number(destinationTruck.capacityLbs || sourceTruck.capacityLbs || 0),
      travelTimePercent: Number(destinationTruck.travelTimePercent ?? sourceTruck.travelTimePercent ?? 0),
      base: startYard || sourceTruck.base || "",
      parkingSpot: parkingSpot || sourceTruck.parkingSpot || ""
    };
    translatedTruck = applyLegacyDriver(translatedTruck, driver);
    const loadTranslation = translatedLoads(sourceTruck, destinationTruck, driver);
    translatedTruck.loads = loadTranslation.loads;
    reorderedLoadCount += loadTranslation.reordered;
    materializedLoadStartCount += loadTranslation.materializedStarts;
    translatedTrucks.push(translatedTruck);
  }

  const assignedLogins = translatedTrucks.map((truck) => loginKey(truck.driverLogin));
  if (new Set(assignedLogins).size !== assignedLogins.length) {
    throw new Error("Translated legacy plan contains duplicate parent-truck drivers.");
  }

  const plannedOrderRefs = new Set();
  let stopCount = 0;
  for (const truck of translatedTrucks) {
    for (const load of truck.loads || []) {
      stopCount += (load.stops || []).length;
      for (const stop of load.stops || []) {
        if (stop?.type === "drop" && stop.orderId) plannedOrderRefs.add(text(stop.orderId));
      }
    }
  }

  const summary = structuredClone(sourcePlan.summary || {});
  delete summary.driverLaneOrder;
  summary.planDate = cleanTargetDate;
  summary.status = "confirmed";
  summary.mirrorTranslation = {
    source: "localhost:3099",
    sourcePlanId: String(sourcePlan.id || ""),
    sourceRevision: Number(sourcePlan.revision || 0),
    sourcePlanDate: sourceDate,
    target: "localhost:3000",
    mode: "driver_loads_to_legacy_trucks"
  };

  return {
    plan: {
      planDate: cleanTargetDate,
      status: "confirmed",
      orders: structuredClone(sourcePlan.orders),
      trucks: translatedTrucks,
      summary
    },
    report: {
      sourcePlanId: String(sourcePlan.id || ""),
      sourceRevision: Number(sourcePlan.revision || 0),
      orderCount: sourcePlan.orders.length,
      truckCount: translatedTrucks.length,
      activeTruckCount: activeDriverByPlate.size,
      activeLoadCount,
      stopCount,
      plannedOrderCount: plannedOrderRefs.size,
      reorderedLoadCount,
      materializedLoadStartCount,
      inactiveScaffoldingTruckCount: translatedTrucks.filter((truck) => !activeDriverByPlate.has(plateKey(truck.plate))).length,
      driverMappings: translatedTrucks.map((truck) => ({
        truckPlate: plateKey(truck.plate),
        driverLogin: loginKey(truck.driverLogin),
        source: activeDriverByPlate.has(plateKey(truck.plate)) ? "active_load" : "legacy_scaffolding"
      })),
      reassignedParentTruckCount: sourcePlan.trucks.filter((truck) => {
        const plate = plateKey(truck.plate || truck.truckPlate);
        return activeDriverByPlate.has(plate)
          && loginKey(truck.driverLogin || truck.driver_login) !== activeDriverByPlate.get(plate);
      }).length
    }
  };
}
