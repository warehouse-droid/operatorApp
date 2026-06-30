import crypto from "node:crypto";
import { config } from "./config.js";

const SAMSARA_BASE_URL = "https://api.samsara.com";

function samsaraToken() {
  return String(config.samsara?.apiToken || "").trim();
}

function requireSamsaraToken() {
  const token = samsaraToken();
  if (!token) throw new Error("Missing SAMSARA_API_TOKEN in server/.env");
  return token;
}

async function samsaraRequest(path, { method = "GET", body = null, includeMeta = false } = {}) {
  const token = requireSamsaraToken();
  const response = await fetch(`${SAMSARA_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const detail = payload?.message || payload?.error || payload?.raw || JSON.stringify(payload);
    throw new Error(`Samsara REST failed: ${response.status} ${response.statusText || ""} ${method} ${path} ${detail}`.trim());
  }
  if (includeMeta) {
    return {
      status: response.status,
      ok: response.ok,
      payload
    };
  }
  return payload;
}

export async function listSamsaraVehicles() {
  const vehicles = [];
  let after = "";
  do {
    const params = new URLSearchParams({ limit: "512" });
    if (after) params.set("after", after);
    const payload = await samsaraRequest(`/fleet/vehicles?${params.toString()}`);
    vehicles.push(...(Array.isArray(payload.data) ? payload.data : []));
    after = payload.pagination?.hasNextPage ? payload.pagination?.endCursor || "" : "";
  } while (after);
  return vehicles;
}

export async function findSamsaraVehicleByPlate(plate) {
  const needle = String(plate || "").replace(/\s+/g, "").toUpperCase();
  if (!needle) throw new Error("Truck plate is required.");
  const vehicles = await listSamsaraVehicles();
  return vehicles.find((vehicle) => String(vehicle.licensePlate || "").replace(/\s+/g, "").toUpperCase() === needle) || null;
}

function normalizedPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function latestStatValue(value) {
  if (Array.isArray(value)) return value[value.length - 1]?.value || value[value.length - 1] || null;
  return value?.value || value || null;
}

function normalizeLocationRow(row = {}, vehicle = {}) {
  const rawLocation = latestStatValue(row.gps) || row.location || row.currentLocation || row;
  const headingRaw = rawLocation?.headingDegrees ?? rawLocation?.heading ?? row.headingDegrees;
  const speedRaw = rawLocation?.speedMilesPerHour ?? rawLocation?.speedMph ?? rawLocation?.speed ?? row.speedMilesPerHour;
  const latitude = Number(
    rawLocation?.latitude
    ?? rawLocation?.lat
    ?? rawLocation?.latitudeDegrees
    ?? row.latitude
    ?? row.lat
  );
  const longitude = Number(
    rawLocation?.longitude
    ?? rawLocation?.lng
    ?? rawLocation?.longitudeDegrees
    ?? row.longitude
    ?? row.lng
  );
  const reverseGeo = rawLocation?.reverseGeo || rawLocation?.address || row.reverseGeo || {};
  return {
    vehicleId: String(row.vehicle?.id || row.id || vehicle.id || ""),
    vehicleName: row.vehicle?.name || row.name || vehicle.name || "",
    plate: row.vehicle?.licensePlate || row.licensePlate || vehicle.licensePlate || "",
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    headingDegrees: Number.isFinite(Number(headingRaw)) ? Number(headingRaw) : null,
    speedMilesPerHour: Number.isFinite(Number(speedRaw)) ? Number(speedRaw) : 0,
    formattedLocation: reverseGeo?.formattedLocation || reverseGeo?.formattedAddress || rawLocation?.formattedLocation || rawLocation?.address || "",
    time: rawLocation?.time || rawLocation?.locatedAtTime || row.time || row.updatedAtTime || ""
  };
}

export async function listSamsaraVehicleLocations({ plates = [] } = {}) {
  const vehicles = await listSamsaraVehicles();
  const wantedPlates = new Set((plates || []).map(normalizedPlate).filter(Boolean));
  const filteredVehicles = wantedPlates.size
    ? vehicles.filter((vehicle) => wantedPlates.has(normalizedPlate(vehicle.licensePlate)))
    : vehicles;
  const vehicleIds = filteredVehicles.map((vehicle) => vehicle.id).filter(Boolean);
  const locations = [];
  let after = "";
  do {
    const params = new URLSearchParams({ limit: "512" });
    if (vehicleIds.length) params.set("vehicleIds", vehicleIds.join(","));
    if (after) params.set("after", after);
    const payload = await samsaraRequest(`/fleet/vehicles/locations?${params.toString()}`);
    locations.push(...(Array.isArray(payload.data) ? payload.data : []));
    after = payload.pagination?.hasNextPage ? payload.pagination?.endCursor || "" : "";
  } while (after);
  const locationById = new Map(locations.map((row) => [String(row.vehicle?.id || row.id || ""), row]));
  const normalizedRows = filteredVehicles.map((vehicle) => normalizeLocationRow(locationById.get(String(vehicle.id)) || {}, vehicle));
  if (!wantedPlates.size) return normalizedRows;

  const bestByPlate = new Map();
  for (const row of normalizedRows) {
    const plate = normalizedPlate(row.plate);
    if (!plate) continue;
    const current = bestByPlate.get(plate);
    const rowTime = Date.parse(row.time || "") || 0;
    const currentTime = Date.parse(current?.time || "") || 0;
    if (!current || rowTime > currentTime) bestByPlate.set(plate, row);
  }
  return (plates || [])
    .map((plate) => bestByPlate.get(normalizedPlate(plate)))
    .filter(Boolean);
}

export async function listSamsaraDrivers() {
  const drivers = [];
  let after = "";
  do {
    const params = new URLSearchParams({ limit: "512" });
    if (after) params.set("after", after);
    const payload = await samsaraRequest(`/fleet/drivers?${params.toString()}`);
    drivers.push(...(Array.isArray(payload.data) ? payload.data : []));
    after = payload.pagination?.hasNextPage ? payload.pagination?.endCursor || "" : "";
  } while (after);
  return drivers;
}

export async function findSamsaraDriverByUsername(username) {
  const needle = String(username || "").trim().toLowerCase();
  if (!needle) throw new Error("Samsara driver username is required.");
  const drivers = await listSamsaraDrivers();
  return drivers.find((driver) => String(driver.username || "").trim().toLowerCase() === needle) || null;
}

export async function getSamsaraHosClock(driverId) {
  if (!driverId) throw new Error("Samsara driver ID is required.");
  const params = new URLSearchParams({ driverIds: String(driverId) });
  const payload = await samsaraRequest(`/fleet/hos/clocks?${params.toString()}`);
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return rows.find((row) => String(row.driver?.id || row.driverId || row.id || "") === String(driverId)) || rows[0] || null;
}

export async function streamSamsaraDvirs({ startTime, endTime, vehicleId = "", limit = 200 } = {}) {
  const rows = [];
  let after = "";
  do {
    const params = new URLSearchParams({
      startTime: startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      endTime: endTime || new Date().toISOString(),
      limit: String(Math.min(Math.max(Number(limit || 200), 1), 200))
    });
    if (vehicleId) params.set("vehicleIds", String(vehicleId));
    if (after) params.set("after", after);
    const payload = await samsaraRequest(`/dvirs/stream?${params.toString()}`);
    rows.push(...(Array.isArray(payload.data) ? payload.data : []));
    after = payload.pagination?.hasNextPage ? payload.pagination?.endCursor || "" : "";
  } while (after);
  return rows;
}

export async function findSamsaraDvirForVehicle({ vehicleId, driverId = "", sinceTime, type = "" } = {}) {
  if (!vehicleId) return null;
  const rows = await streamSamsaraDvirs({
    startTime: sinceTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    vehicleId
  });
  return rows.find((row) => {
    const rowVehicleId = String(row.vehicle?.id || row.vehicleId || "");
    if (String(vehicleId) !== rowVehicleId) return false;
    if (type && String(row.type || "").toLowerCase() !== String(type).toLowerCase()) return false;
    if (!driverId) return true;
    const rowDriverId = String(row.authorSignature?.signatoryUser?.id || row.driver?.id || row.driverId || "");
    return !rowDriverId || rowDriverId === String(driverId);
  }) || null;
}

export async function createSamsaraMechanicDvir({ authorId, vehicleId, licensePlate = "", location = "", safetyStatus = "safe", mechanicNotes = "" }) {
  if (!authorId) throw new Error("SAMSARA_DVIR_AUTHOR_ID is required to create Samsara DVIRs from MBBS.");
  if (!vehicleId && !licensePlate) throw new Error("Vehicle ID or license plate is required for Samsara DVIR.");
  const body = {
    authorId: String(authorId),
    type: "mechanic",
    safetyStatus: safetyStatus === "unsafe" ? "unsafe" : "safe",
    mechanicNotes: mechanicNotes || "Created from MBBS Driver PWA inspection."
  };
  if (vehicleId) body.vehicleId = String(vehicleId);
  if (licensePlate) body.licensePlate = String(licensePlate).slice(0, 12);
  if (location) body.location = String(location);
  const response = await samsaraRequest("/fleet/dvirs", {
    method: "POST",
    body,
    includeMeta: true
  });
  return {
    responseStatus: response.status,
    responsePayload: response.payload,
    dvir: response.payload?.data || response.payload
  };
}

export async function createSamsaraDriverAuthToken({ username, driverId, externalId }) {
  const code = crypto.randomBytes(18).toString("base64url");
  const body = { code };
  if (driverId) body.driverId = driverId;
  else if (externalId) body.externalId = externalId;
  else if (username) body.username = username;
  else throw new Error("Samsara driver username is required.");

  const payload = await samsaraRequest("/fleet/drivers/auth-token", {
    method: "POST",
    body
  });
  return {
    code,
    ...payload,
    data: payload.data || payload
  };
}

export async function setSamsaraDriverDutyStatus({ username, driverId, vehicleId = "", dutyStatus, location = "", remark = "" }) {
  const status = String(dutyStatus || "").trim().toUpperCase();
  if (!["ON_DUTY", "OFF_DUTY"].includes(status)) throw new Error("Duty status must be ON_DUTY or OFF_DUTY.");
  const driver = driverId ? { id: driverId } : await findSamsaraDriverByUsername(username);
  if (!driver?.id) throw new Error(`Samsara driver was not found for username ${username}.`);
  const body = {
    duty_status: status,
    status_change_at_ms: Date.now()
  };
  if (vehicleId) body.vehicle_id = Number(vehicleId);
  if (location) body.location = location;
  if (remark) body.remark = remark;
  const response = await samsaraRequest(`/v1/fleet/drivers/${encodeURIComponent(driver.id)}/hos/duty_status`, {
    method: "POST",
    body,
    includeMeta: true
  });
  let clock = null;
  let clockError = "";
  try {
    clock = await getSamsaraHosClock(driver.id);
  } catch (error) {
    clockError = error.message;
  }
  return {
    driver,
    dutyStatus: status,
    responseStatus: response.status,
    responsePayload: response.payload,
    clock,
    clockError
  };
}

export async function createSamsaraDriverVehicleAssignment({ username, driverId, vehiclePlate, vehicleId }) {
  const driver = driverId ? { id: driverId } : await findSamsaraDriverByUsername(username);
  if (!driver?.id) throw new Error(`Samsara driver was not found for username ${username}.`);
  const vehicle = vehicleId ? { id: vehicleId, licensePlate: vehiclePlate || "" } : await findSamsaraVehicleByPlate(vehiclePlate);
  if (!vehicle?.id) throw new Error(`Samsara vehicle was not found for plate ${vehiclePlate}.`);
  const now = new Date().toISOString();
  const body = {
    driverId: String(driver.id),
    vehicleId: String(vehicle.id),
    startTime: now,
    assignedAtTime: now,
    isPassenger: false,
    metadata: {
      source: "MBBS Driver PWA",
      localVehiclePlate: vehicle.licensePlate || vehiclePlate || ""
    }
  };
  const response = await samsaraRequest("/fleet/driver-vehicle-assignments", {
    method: "POST",
    body,
    includeMeta: true
  });
  return {
    driver,
    vehicle,
    responseStatus: response.status,
    responsePayload: response.payload
  };
}

export async function testSamsaraConnection({ localTrucks = [] } = {}) {
  const vehicles = await listSamsaraVehicles();
  const byPlate = new Map(vehicles.map((vehicle) => [
    String(vehicle.licensePlate || "").replace(/\s+/g, "").toUpperCase(),
    vehicle
  ]));
  const truckMatches = localTrucks.map((truck) => {
    const plate = String(truck.plate || "").replace(/\s+/g, "").toUpperCase();
    const vehicle = byPlate.get(plate);
    return {
      plate: truck.plate || "",
      matched: Boolean(vehicle),
      samsaraVehicleId: vehicle?.id || "",
      samsaraName: vehicle?.name || "",
      licensePlate: vehicle?.licensePlate || ""
    };
  });
  return {
    ok: true,
    vehicleCount: vehicles.length,
    truckMatches
  };
}
