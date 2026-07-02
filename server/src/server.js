import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config, listEnvFiles, selectEnvFile } from "./config.js";
import { beginRollbackContext, pool, query, withTransaction } from "./db.js";
import { buildAuthorizationUrl, exchangeCodeForToken, fetchDeliveryOrdersFromNetSuite, fetchDeliveryOrderFromNetSuite, fetchCustomerPickupOrderFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite, fetchTransferDeliveryOrdersFromNetSuite, fetchTransferDeliveryOrderFromNetSuite, fetchTransferOrderDetailsFromNetSuite, fetchPurchaseOrdersFromNetSuite, fetchPurchaseOrderFromNetSuite, fetchPurchaseOrderDetailsFromNetSuite, fetchTransferReceivingOrdersFromNetSuite, fetchTransferReceivingOrderFromNetSuite, fetchInventoryBalanceForItemFromNetSuite, fetchInventoryBalancesFromNetSuite, fetchItemFulfillmentFromNetSuite, fetchItemReceiptFromNetSuite, fetchTransactionStatusFromNetSuite, transformSalesOrderToItemFulfillment, transformTransferOrderToItemFulfillment, transformPurchaseOrderToItemReceipt, transformTransferOrderToItemReceipt } from "./netsuite.js";
import { listDeliveryOrders, getDeliveryOrder, getFulfillableDeliveryOrder, buildItemFulfillmentPayload, markDeliveryPrepared, updateDeliveryStatus, confirmDeliveryLine, setDeliveryLinePackedQuantity, unpackDeliveryLine, unpackDeliveryOrder, recordDeliveryFulfillment, recordDeliveryFulfillmentFailure, recordDeliveryLoad, listDeliveryFulfillments, listControlLoadedOrders, getControlLoadedOrderDetail, listControlLoadedOrderCsvRows, getDeliveryPrepNotifications, resetDeliveryFulfillmentState, applyConfirmedDispatchPlanToDelivery } from "./delivery-repository.js";
import { clearCustomerPickupDraft, confirmCustomerPickupLine, findCustomerPickupOrder, isPendingApprovalStatus, isPickupDeliveryMethod, recordCustomerPickupLoad } from "./customer-pickup-repository.js";
import { createOperator, getOperatorByToken, hasOperators, listAudit, listOperators, loginOperator, logoutToken, setOperatorActive, updateOperatorPassword, writeAudit } from "./auth-repository.js";
import { applyInventoryClassificationRules, confirmCycleCountLine, getCycleCountDraft, listCycleCountRecords, listInventoryClassifications, listInventoryFacets, listInventoryItems, submitCycleCount, updateInventoryClassification, upsertInventoryBalances } from "./inventory-repository.js";
import { listReceivingVendors, listReceivingSources, listReceivingOrders, getReceivingOrder, searchReceivingItems, confirmReceivingLine, getReceivableReceivingOrder, buildItemReceiptPayload, recordReceivingReceipt, recordReceivingReceiptFailure, listReceivingReceipts, listLocalCoSources, listLocalCoReceivingOrders, searchLocalCoItems, getLocalCoReceivingOrder, confirmLocalCoReceivingLine, receiveLocalCoOrder } from "./receiving-repository.js";
import { listExistingInboundOrderIds, listExistingOutboundOrderIds, markMissingInboundOrderLines, markMissingInboundOrders, markMissingOutboundOrderLines, markOutboundOrderMissing, updatePurchaseOrderNetSuiteStatus, updateSalesOrderNetSuiteStatus, upsertInboundTransferOrderLines, upsertInboundTransferOrders, upsertOutboundTransferOrderLines, upsertOutboundTransferOrders, upsertPurchaseOrderLines, upsertPurchaseOrders, upsertSalesOrderLines, upsertSalesOrders } from "./order-sync-repository.js";
import { listOperatorHistory, listRecordWarnings, reportOperatorRecordError, resolveRecordWarning } from "./history-repository.js";
import { listDispatchOrders, refreshDispatchEnrichment, setPurchaseOrderVendorYard, updateDispatchOrderDetails, getSalesOrderPoAllocationOptions, createSalesOrderPoAllocation, createSalesOrderPoAllocations, cancelSalesOrderPoAllocation, createDispatchOperatorRequest, upsertLocalCoOrder, cancelLocalCoOrder, listDispatchOperatorRequests, resolveDispatchOperatorRequestsForOrder } from "./dispatch-repository.js";
import { listDispatchVendorYards, updateDispatchVendorYard, upsertDispatchVendorYard, listDispatchParserRules, updateDispatchParserRule, listOllamaAudit } from "./dispatch-enrichment.js";
import { listDispatchAudit, writeDispatchAudit } from "./dispatch-audit-repository.js";
import { confirmDispatchPlan, createDispatchPlan, getCurrentDispatchPlan, getDispatchPlan, listDispatchPlans, reopenDispatchPlan, saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import { getDispatchStatistics } from "./dispatch-statistics-repository.js";
import { getDriverDayState, getNextDriverJob, listDriverHistory, listDriverJobStatuses, recordDriverJobPhotos, skipDriverDvirForTesting, startDriverJob, submitDriverDvir } from "./driver-repository.js";
import { createSamsaraDriverAuthToken, createSamsaraDriverVehicleAssignment, findSamsaraDriverByUsername, listSamsaraVehicleLocations, setSamsaraDriverDutyStatus, testSamsaraConnection } from "./samsara.js";
import { createPhotoReadToken, createPhotoUploadToken, isR2PhotoReference, publicPhotoUploadConfig } from "./photo-upload.js";

const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const qrScannerDir = path.resolve(dirname, "../node_modules/qr-scanner");
const dataDir = path.resolve(dirname, "../data");
const dispatchPlanPath = path.join(dataDir, "dispatch-plan.json");
const dispatchSetupPath = path.join(dataDir, "dispatch-setup.json");
const deliveryLocations = [1, 13, 15, 26];
const fulfillmentJobs = new Map();
const receivingJobs = new Map();
const driverSessions = new Map();
const eventClients = new Set();
const delayedTransactionStatusRefreshes = new Map();
const driverGeocodeCache = new Map();
let eventSeq = 0;

const defaultDispatchSetup = {
  drivers: [
    { name: "Alex Wong", license: "AZ", number: "A90211", login: "alex", ownYardFixedMinutes: 42, vendorFixedMinutes: 36, deliveryFixedMinutes: 36, outsideFixedMinutes: 36, minutesPerPallet: 1, loadMinutes: 42, unloadMinutes: 36 },
    { name: "Jenny Lee", license: "DZ", number: "D18870", login: "jenny", ownYardFixedMinutes: 38, vendorFixedMinutes: 32, deliveryFixedMinutes: 32, outsideFixedMinutes: 32, minutesPerPallet: 1, loadMinutes: 38, unloadMinutes: 32 }
  ],
  trucks: [
    { plate: "MBBS-101", capacityLbs: 48000 },
    { plate: "MBBS-205", capacityLbs: 44000 },
    { plate: "MBBS-318", capacityLbs: 52000 }
  ],
  ownYards: [
    { code: "3445", name: "3445", locationId: 1, address: "3445 Kennedy Road, Toronto, ON", lat: 43.8204306, lng: -79.3053423 },
    { code: "2967", name: "2967", locationId: 13, address: "2967 Kennedy Road, Toronto, ON", lat: 43.806119, lng: -79.2986377 },
    { code: "12441", name: "12441", locationId: 15, address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON", lat: 43.948694, lng: -79.3727582 },
    { code: "150", name: "150", locationId: 26, address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada" }
  ],
  sync: {
    mode: "manual",
    intervalSeconds: 60,
    maxRunSeconds: 900,
    running: false,
    lastStartedAt: "",
    lastFinishedAt: "",
    lastSource: "",
    lastStatus: "idle",
    lastError: ""
  },
  samsara: {
    dvirAuthorId: config.samsara.dvirAuthorId || ""
  }
};

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function orderTransactionType(orderRef, order = {}) {
  const type = order.type || (String(orderRef).startsWith("PO") ? "PO" : String(orderRef).startsWith("TO") ? "TO" : "SO");
  return {
    SO: "Sales Order",
    TO: "Transfer Order",
    PO: "Purchase Order"
  }[type] || "Sales Order";
}

function dispatchOperatorAssignmentMap(plan = {}) {
  const orderById = new Map((plan.orders || []).map((order) => [String(order?.id || ""), order]));
  const assignments = new Map();
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop" || !stop.orderId) continue;
        const order = orderById.get(String(stop.orderId || ""));
        if (!["SO", "TO"].includes(order?.type)) continue;
        const orderRef = String(order.id || stop.orderId || "");
        assignments.set(orderRef, [
          order.type,
          plan.planDate || "",
          truck.plate || "",
          load.name || "",
          truck.parkingSpot || ""
        ].join("|"));
      }
    }
  }
  return assignments;
}

function changedDispatchOperatorRefs(beforePlan = {}, afterPlan = {}) {
  const before = dispatchOperatorAssignmentMap(beforePlan);
  const after = dispatchOperatorAssignmentMap(afterPlan);
  const changed = [];
  for (const [orderRef, signature] of after.entries()) {
    if (before.get(orderRef) !== signature) changed.push(orderRef);
  }
  return changed;
}

function dispatchPlanStopIds(plan) {
  return new Set((plan?.trucks || []).flatMap((truck) =>
    (truck.loads || []).flatMap((load) => (load.stops || []).map((stop) => String(stop.id || "")))
  ));
}

function sanitizeDispatchPlanOrders(orders = []) {
  const groupedChildren = new Set();
  for (const order of orders || []) {
    for (const childId of order?.childOrders || []) {
      if (childId) groupedChildren.add(String(childId));
    }
  }
  return (orders || []).filter((order) => !groupedChildren.has(String(order?.id || "")));
}

function shippedDispatchCsv(plan, driverJobStatuses = []) {
  const ordersById = new Map((plan.orders || []).map((order) => [String(order.id || ""), order]));
  const currentStopIds = dispatchPlanStopIds(plan);
  const rows = [["Order Number", "Transaction Type", "Weight", "Tracking Number", "Label Integration"]];
  const exported = new Set();
  const completedRefs = new Set();

  for (const record of driverJobStatuses) {
    if (record.status !== "complete" || record.stop_type !== "dropoff") continue;
    if (!currentStopIds.has(String(record.stop_id || ""))) continue;
    for (const ref of record.order_refs || []) {
      const orderRef = String(ref || "").trim();
      if (!orderRef || orderRef.startsWith("CO-")) continue;
      completedRefs.add(orderRef);
    }
  }

  for (const orderRef of completedRefs) {
    const order = ordersById.get(orderRef) || {};
    const originalRef = order.originalOrderId || "";
    if (originalRef) {
      const splitRefs = (plan.orders || [])
        .filter((item) => String(item.originalOrderId || "") === String(originalRef))
        .map((item) => String(item.id || ""))
        .filter(Boolean);
      if (!splitRefs.length || splitRefs.some((ref) => !completedRefs.has(ref))) continue;
    }
    const exportRef = order.sourceOrderId || order.relatedSoId || originalRef || orderRef;
    const key = `${exportRef}|${orderTransactionType(orderRef, order)}`;
    if (exported.has(key)) continue;
    exported.add(key);
    rows.push([exportRef, orderTransactionType(orderRef, order), "", "", ""]);
  }

  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function normalizedPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function monitorOrderSummary(order) {
  if (!order) return null;
  return {
    id: order.id || "",
    type: order.type || "",
    customer: order.customer || order.vendor || "",
    address: order.address || order.dropAddress || "",
    windowStart: order.windowStart || "",
    windowEnd: order.windowEnd || ""
  };
}

function monitorLoadForTruck(plan, truck, driverJobStatuses = []) {
  if (!plan || !truck) return null;
  const ordersById = new Map((plan.orders || []).map((order) => [String(order.id || ""), order]));
  const plate = normalizedPlate(truck.plate);
  const loads = Array.isArray(truck.loads) ? truck.loads : [];
  for (const load of loads) {
    const loadStatuses = driverJobStatuses.filter((record) =>
      normalizedPlate(record.truck_plate || record.truckPlate) === plate
      && String(record.load_id || record.loadId || "") === String(load.id || "")
    );
    const statusByStop = new Map(loadStatuses.map((record) => [String(record.stop_id || record.stopId || ""), record.status || ""]));
    const plannedStops = Array.isArray(load.stops) ? load.stops : [];
    const started = loadStatuses.some((record) => ["in_progress", "complete"].includes(record.status));
    const complete = plannedStops.length > 0 && plannedStops.every((stop) => statusByStop.get(String(stop.id || "")) === "complete");
    if (!started || complete) continue;
    const orderIds = [...new Set(plannedStops.map((stop) => String(stop.orderId || "")).filter(Boolean))];
    const currentStatus = loadStatuses.find((record) => record.status === "in_progress") || null;
    return {
      loadId: load.id || "",
      loadName: load.name || "Load",
      status: currentStatus ? "in_progress" : "started",
      orderIds,
      orders: orderIds.map((id) => monitorOrderSummary(ordersById.get(id))).filter(Boolean),
      stops: plannedStops.map((stop, index) => ({
        id: stop.id || "",
        sequence: index + 1,
        type: stop.type || "",
        location: stop.location || "",
        orderId: stop.orderId || "",
        status: statusByStop.get(String(stop.id || "")) || "pending"
      })),
      startedAt: loadStatuses.find((record) => record.started_at)?.started_at || "",
      completedStops: plannedStops.filter((stop) => statusByStop.get(String(stop.id || "")) === "complete").length,
      stopCount: plannedStops.length
    };
  }
  return null;
}

function uniqueYardLocations(yards = []) {
  const seen = new Set();
  return yards.map((yard) => ({
    id: yard.id || yard.code || `${yard.vendor || ""}-${yard.yard || yard.name || ""}`,
    type: yard.type || "vendor",
    code: yard.code || "",
    name: yard.name || yard.yard || "",
    vendor: yard.vendor || "",
    address: yard.address || "",
    lat: yard.lat ?? null,
    lng: yard.lng ?? null,
    active: yard.active !== false
  })).filter((yard) => {
    if (!yard.address && !(yard.lat && yard.lng)) return false;
    const key = `${yard.type}|${yard.code}|${yard.vendor}|${yard.name}|${yard.address}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isCanadaCoordinate(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= 41
    && lat <= 84
    && lng >= -142
    && lng <= -52;
}

function normalizedLocationText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function coordinateDistanceMeters(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const fromLat = Number(fromLatitude);
  const fromLng = Number(fromLongitude);
  const toLat = Number(toLatitude);
  const toLng = Number(toLongitude);
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) return 0;
  const earthRadiusMeters = 6371000;
  const lat1 = fromLat * Math.PI / 180;
  const lat2 = toLat * Math.PI / 180;
  const deltaLat = (toLat - fromLat) * Math.PI / 180;
  const deltaLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function truckLocationChanged(previous, truck) {
  if (!previous) return true;
  const distance = coordinateDistanceMeters(previous.latitude, previous.longitude, truck.latitude, truck.longitude);
  const previousText = normalizedLocationText(previous.formatted_location);
  const nextText = normalizedLocationText(truck.formattedLocation);
  return distance >= 25 || (previousText && nextText && previousText !== nextText);
}

async function recordTruckLocationHistory(trucks = []) {
  const fresh = (trucks || []).filter((truck) =>
    truck.plate
    && truck.locationTime
    && isCanadaCoordinate(truck.latitude, truck.longitude)
  );
  if (!fresh.length) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const truck of fresh) {
      const latest = await client.query(
        `SELECT latitude, longitude, formatted_location
           FROM dispatch_truck_location_history
          WHERE plate = $1
          ORDER BY location_time DESC
          LIMIT 1`,
        [truck.plate]
      );
      if (!truckLocationChanged(latest.rows[0], truck)) continue;
      await client.query(
        `INSERT INTO dispatch_truck_location_history (
           plate, vehicle_id, vehicle_name, latitude, longitude, heading_degrees,
           speed_miles_per_hour, formatted_location, location_time
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
         ON CONFLICT (plate, location_time) DO UPDATE SET
           vehicle_id = EXCLUDED.vehicle_id,
           vehicle_name = EXCLUDED.vehicle_name,
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           heading_degrees = EXCLUDED.heading_degrees,
           speed_miles_per_hour = EXCLUDED.speed_miles_per_hour,
           formatted_location = EXCLUDED.formatted_location`,
        [
          truck.plate,
          truck.vehicleId || "",
          truck.vehicleName || "",
          Number(truck.latitude),
          Number(truck.longitude),
          Number.isFinite(Number(truck.headingDegrees)) ? Number(truck.headingDegrees) : null,
          Number(truck.speedMilesPerHour || 0) || 0,
          truck.formattedLocation || "",
          truck.locationTime
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function truckLocationTrails(plates = []) {
  const normalizedPlates = [...new Set((plates || []).map((plate) => String(plate || "").trim()).filter(Boolean))];
  if (!normalizedPlates.length) return {};
  const result = await pool.query(
    `SELECT plate, latitude, longitude, heading_degrees, speed_miles_per_hour,
            formatted_location, location_time
       FROM dispatch_truck_location_history
      WHERE plate = ANY($1::text[])
        AND location_time >= now() - interval '10 minutes'
      ORDER BY plate, location_time ASC`,
    [normalizedPlates]
  );
  return result.rows.reduce((byPlate, row) => {
    if (!byPlate[row.plate]) byPlate[row.plate] = [];
    byPlate[row.plate].push({
      lat: Number(row.latitude),
      lng: Number(row.longitude),
      headingDegrees: Number.isFinite(Number(row.heading_degrees)) ? Number(row.heading_degrees) : null,
      speedMilesPerHour: Number(row.speed_miles_per_hour || 0) || 0,
      formattedLocation: row.formatted_location || "",
      at: row.location_time
    });
    return byPlate;
  }, {});
}

async function estimatedTruckSpeeds(plates = []) {
  const normalizedPlates = [...new Set((plates || []).map((plate) => String(plate || "").trim()).filter(Boolean))];
  if (!normalizedPlates.length) return {};
  const result = await pool.query(
    `SELECT plate, latitude, longitude, location_time
       FROM dispatch_truck_location_history
      WHERE plate = ANY($1::text[])
        AND location_time >= now() - interval '20 seconds'
      ORDER BY plate, location_time ASC`,
    [normalizedPlates]
  );
  const rowsByPlate = result.rows.reduce((byPlate, row) => {
    if (!byPlate[row.plate]) byPlate[row.plate] = [];
    byPlate[row.plate].push(row);
    return byPlate;
  }, {});
  return Object.entries(rowsByPlate).reduce((speeds, [plate, rows]) => {
    if (rows.length < 2) return speeds;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const seconds = (new Date(last.location_time).getTime() - new Date(first.location_time).getTime()) / 1000;
    if (!Number.isFinite(seconds) || seconds <= 0) return speeds;
    const kilometers = coordinateDistanceMeters(first.latitude, first.longitude, last.latitude, last.longitude) / 1000;
    const kmh = kilometers / (seconds / 3600);
    if (Number.isFinite(kmh)) speeds[plate] = kmh;
    return speeds;
  }, {});
}

function validCoordinate(latitude, longitude) {
  return Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
}

async function geocodeStopAddress(address) {
  const text = String(address || "").trim();
  if (!text || !config.googleMapsApiKey) return null;
  const key = normalizedLocationText(text);
  if (driverGeocodeCache.has(key)) return driverGeocodeCache.get(key);
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", text);
  url.searchParams.set("region", "ca");
  url.searchParams.set("components", "country:CA");
  url.searchParams.set("key", config.googleMapsApiKey);
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  const location = payload.results?.[0]?.geometry?.location;
  const point = validCoordinate(location?.lat, location?.lng)
    ? { latitude: Number(location.lat), longitude: Number(location.lng), source: "google_geocode" }
    : null;
  driverGeocodeCache.set(key, point);
  return point;
}

async function expectedPointForDriverJob(job) {
  const setup = await readDispatchSetup();
  const ownCandidates = [job?.toLocation, job?.location, job?.address]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const candidate of ownCandidates) {
    const yard = (setup.ownYards || []).find((item) =>
      [item.code, item.name, item.address].some((value) => normalizedLocationText(value) === normalizedLocationText(candidate))
    );
    if (yard && validCoordinate(yard.lat, yard.lng)) {
      return {
        latitude: Number(yard.lat),
        longitude: Number(yard.lng),
        address: yard.address || yard.name || candidate,
        source: "own_yard"
      };
    }
  }
  const address = job?.stopType === "travel"
    ? job?.toAddress || job?.address
    : job?.address || job?.toAddress || job?.location;
  const geocoded = await geocodeStopAddress(address);
  return geocoded ? { ...geocoded, address } : { address: address || "", source: "unavailable" };
}

async function samsaraLocationForDriverJob(job) {
  const plate = String(job?.truckPlate || "").trim();
  if (!plate) return null;
  const locations = await listSamsaraVehicleLocations({ plates: [plate] });
  const location = locations.find((item) => normalizedPlate(item.plate) === normalizedPlate(plate)) || locations[0] || null;
  if (!location || !validCoordinate(location.latitude, location.longitude)) return null;
  return {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    accuracy: 0,
    plate: location.plate || plate,
    vehicleId: location.vehicleId || "",
    vehicleName: location.vehicleName || "",
    formattedLocation: location.formattedLocation || "",
    locationTime: location.time || "",
    source: "samsara"
  };
}

async function checkDriverJobLocation(job) {
  const truckLocation = await samsaraLocationForDriverJob(job);
  const latitude = Number(truckLocation?.latitude);
  const longitude = Number(truckLocation?.longitude);
  if (!validCoordinate(latitude, longitude)) {
    return {
      status: "unavailable",
      message: `Samsara truck location was not available for ${job?.truckPlate || "this truck"}.`,
      truckPlate: job?.truckPlate || ""
    };
  }
  const expected = await expectedPointForDriverJob(job);
  if (!validCoordinate(expected.latitude, expected.longitude)) {
    return {
      status: "unavailable",
      message: expected.address
        ? "Expected address could not be geocoded for verification."
        : "Expected stop address is missing.",
      expectedAddress: expected.address || ""
    };
  }
  const distanceMeters = coordinateDistanceMeters(latitude, longitude, expected.latitude, expected.longitude);
  const thresholdMeters = 500;
  const ok = distanceMeters <= thresholdMeters;
  return {
    status: ok ? "ok" : "warning",
    message: ok
      ? `Truck location verified within ${Math.round(distanceMeters)} m.`
      : `Samsara truck GPS is ${Math.round(distanceMeters)} m from the expected stop. Recheck before confirming.`,
    distanceMeters: Math.round(distanceMeters),
    thresholdMeters: Math.round(thresholdMeters),
    expectedAddress: expected.address || "",
    expectedLatitude: expected.latitude,
    expectedLongitude: expected.longitude,
    currentLatitude: latitude,
    currentLongitude: longitude,
    truckPlate: truckLocation.plate || job?.truckPlate || "",
    truckLocationTime: truckLocation.locationTime || "",
    truckFormattedLocation: truckLocation.formattedLocation || "",
    source: truckLocation.source || "samsara",
    expectedSource: expected.source || ""
  };
}

function emitAppEvent(type, payload = {}) {
  const event = {
    id: ++eventSeq,
    type,
    at: new Date().toISOString(),
    payload
  };
  const body = `id: ${event.id}\nevent: app-event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    try {
      client.res.write(body);
    } catch {
      eventClients.delete(client);
    }
  }
}

function updateFulfillmentJob(jobId, patch) {
  const current = fulfillmentJobs.get(jobId) || { id: jobId };
  fulfillmentJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function updateReceivingJob(jobId, patch) {
  const current = receivingJobs.get(jobId) || { id: jobId };
  receivingJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function bearerToken(req) {
  const header = req.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return req.body?.token || req.query.token || "";
}

function operatorId(req) {
  return req.operator?.id || "";
}

function publicDriver(driver) {
  if (!driver) return null;
  return {
    login: driver.login,
    name: driver.name,
    license: driver.license,
    number: driver.number,
    hasSamsaraPrimary: Boolean(String(driver.samsaraPrimaryLogin || "").trim()),
    hasSamsaraSecondary: Boolean(String(driver.samsaraSecondaryLogin || "").trim()),
    samsaraPrimaryUsername: String(driver.samsaraPrimaryLogin || "").trim(),
    samsaraSecondaryUsername: String(driver.samsaraSecondaryLogin || "").trim()
  };
}

function samsaraUsernameForDriver(driver, account = "primary") {
  return account === "secondary"
    ? String(driver?.samsaraSecondaryLogin || "").trim()
    : String(driver?.samsaraPrimaryLogin || "").trim();
}

function publicSamsaraAuthResult(result = {}, { includeSecret = false } = {}) {
  const data = result.data || {};
  const token = data.token || data.authToken || result.token || result.authToken || "";
  return {
    ok: true,
    code: includeSecret ? result.code || "" : "",
    authToken: includeSecret ? token : "",
    tokenPreview: token ? `${String(token).slice(0, 8)}...${String(token).slice(-4)}` : "",
    expiresAt: data.expiresAt || data.expiresAtTime || result.expiresAt || result.expiresAtTime || "",
    rawKeys: Object.keys(data)
  };
}

function driverToken(req) {
  const header = req.get("authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return req.body?.token || req.query.token || "";
}

async function requireDriver(req, res, next) {
  try {
    const token = driverToken(req);
    const session = driverSessions.get(token);
    if (!session) return res.status(401).json({ error: "Driver login required" });
    const setup = await readDispatchSetup();
    const driver = (setup.drivers || []).find((item) => String(item.login || "").trim().toLowerCase() === session.login);
    if (!driver) {
      driverSessions.delete(token);
      return res.status(401).json({ error: "Driver login required" });
    }
    req.driver = driver;
    req.driverLogin = session.login;
    next();
  } catch (error) {
    next(error);
  }
}

async function photoPreviewViewer(req) {
  const token = bearerToken(req);
  const operator = await getOperatorByToken(token);
  if (operator) {
    return {
      id: operator.id,
      username: operator.username,
      role: operator.role,
      source: ["dispatcher", "admin"].includes(operator.role) ? "dispatch" : "operator"
    };
  }
  const session = driverSessions.get(token);
  if (session) {
    return {
      id: session.login,
      login: session.login,
      role: "driver",
      source: "driver"
    };
  }
  return null;
}

async function requirePhotoPreviewViewer(req, res, next) {
  try {
    const viewer = await photoPreviewViewer(req);
    if (!viewer) return res.status(401).json({ error: "Login required" });
    req.photoViewer = viewer;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireOperator(req, res, next) {
  try {
    const operator = await getOperatorByToken(bearerToken(req));
    if (!operator) return res.status(401).json({ error: "Login required" });
    req.operator = operator;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.operator?.role !== "admin") return res.status(403).json({ error: "Admin account required" });
  next();
}

function requireDispatcher(req, res, next) {
  if (!["dispatcher", "admin"].includes(req.operator?.role)) {
    return res.status(403).json({ error: "Dispatcher account required" });
  }
  next();
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const result = await Promise.race([
    promise.then((value) => ({ value }), (error) => ({ error })),
    timeout
  ]);
  clearTimeout(timer);
  return result;
}

async function readDispatchSetup() {
  const text = await fs.readFile(dispatchSetupPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!text) return defaultDispatchSetup;
  const saved = JSON.parse(text);
  return {
    drivers: Array.isArray(saved.drivers) ? saved.drivers : defaultDispatchSetup.drivers,
    trucks: Array.isArray(saved.trucks) ? saved.trucks : defaultDispatchSetup.trucks,
    ownYards: Array.isArray(saved.ownYards) ? saved.ownYards : defaultDispatchSetup.ownYards,
    sync: normalizeSyncSettings(saved.sync),
    samsara: {
      ...defaultDispatchSetup.samsara,
      ...(saved.samsara || {})
    }
  };
}

function normalizeSyncSettings(sync = {}) {
  const cleanSync = { ...(sync || {}) };
  delete cleanSync.salesOrderCreatedFrom;
  const mode = cleanSync.mode === "auto" ? "auto" : "manual";
  const intervalSeconds = Number(cleanSync.intervalSeconds || defaultDispatchSetup.sync.intervalSeconds);
  const maxRunSeconds = Number(cleanSync.maxRunSeconds || defaultDispatchSetup.sync.maxRunSeconds);
  return {
    ...defaultDispatchSetup.sync,
    ...cleanSync,
    mode,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds >= 30 ? Math.round(intervalSeconds) : defaultDispatchSetup.sync.intervalSeconds,
    maxRunSeconds: Number.isFinite(maxRunSeconds) && maxRunSeconds >= 60 ? Math.round(maxRunSeconds) : defaultDispatchSetup.sync.maxRunSeconds,
    running: Boolean(sync.running)
  };
}

async function writeDispatchSetup(patch = {}) {
  const current = await readDispatchSetup();
  const payload = {
    drivers: Array.isArray(patch.drivers) ? patch.drivers : current.drivers,
    trucks: Array.isArray(patch.trucks) ? patch.trucks : current.trucks,
    ownYards: Array.isArray(patch.ownYards) ? patch.ownYards : current.ownYards,
    sync: patch.sync ? normalizeSyncSettings({ ...current.sync, ...patch.sync }) : current.sync,
    samsara: patch.samsara ? { ...current.samsara, ...patch.samsara } : current.samsara
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dispatchSetupPath, JSON.stringify(payload, null, 2));
  return payload;
}

function normalizeOrderType(value) {
  return value === "transfer_order" || value === "transfer" ? "transfer_order" : "sales_order";
}

async function syncDeliveryLocation(locationId, { includeDetails = true, orderType = "sales_order" } = {}) {
  assertDispatchSyncCanContinue("delivery list");
  const normalizedOrderType = normalizeOrderType(orderType);
  const discoveredOrders = normalizedOrderType === "transfer_order"
    ? await fetchTransferDeliveryOrdersFromNetSuite(locationId)
    : await fetchDeliveryOrdersFromNetSuite(locationId);
  assertDispatchSyncCanContinue("delivery list");
  if (normalizedOrderType === "transfer_order") await upsertOutboundTransferOrders(discoveredOrders);
  else await upsertSalesOrders(discoveredOrders);

  const existingIds = await listExistingOutboundOrderIds({ locationId, orderFamily: normalizedOrderType });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];

  let orderCount = discoveredOrders.length;
  let detailCount = 0;
  let missingCount = 0;
  for (const orderId of orderIds) {
    assertDispatchSyncCanContinue(`delivery order ${orderId}`);
    const trackedOrder = normalizedOrderType === "transfer_order"
      ? await fetchTransferDeliveryOrderFromNetSuite(orderId, locationId)
      : await fetchDeliveryOrderFromNetSuite(orderId, locationId);
    assertDispatchSyncCanContinue(`delivery order ${orderId}`);
    if (!trackedOrder) {
      await markOutboundOrderMissing(orderId, { orderFamily: normalizedOrderType });
      await writeAudit({
        actorType: "system",
        source: "netsuite",
        action: "netsuite.order.missing",
        orderId,
        details: { locationId }
      });
      missingCount += 1;
      continue;
    }

    if (normalizedOrderType === "transfer_order") await upsertOutboundTransferOrders([trackedOrder]);
    else await upsertSalesOrders([trackedOrder]);
    if (!discoveredOrders.some((order) => String(order.id) === String(orderId))) orderCount += 1;

    if (includeDetails) {
      assertDispatchSyncCanContinue(`delivery detail ${orderId}`);
      const lines = normalizedOrderType === "transfer_order"
        ? await fetchTransferOrderDetailsFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId);
      assertDispatchSyncCanContinue(`delivery detail ${orderId}`);
      if (normalizedOrderType === "transfer_order") await upsertOutboundTransferOrderLines(orderId, lines);
      else await upsertSalesOrderLines(orderId, lines);
      await markMissingOutboundOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }

  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.delivery.sync",
    details: { locationId, orderType: normalizedOrderType, discovered: discoveredOrders.length, tracked: orderCount, missing: missingCount, lines: detailCount }
  });

  return { discovered: discoveredOrders.length, tracked: orderCount, missing: missingCount, lines: detailCount };
}

let syncRunning = false;
let activeSyncRun = null;

class DispatchSyncStoppedError extends Error {
  constructor(message) {
    super(message);
    this.name = "DispatchSyncStoppedError";
  }
}

function assertDispatchSyncCanContinue(context = "") {
  if (!activeSyncRun) return;
  if (activeSyncRun.cancelRequested) {
    throw new DispatchSyncStoppedError(activeSyncRun.cancelReason || "Sync was stopped by an admin.");
  }
  if (Date.now() > activeSyncRun.deadlineAt) {
    activeSyncRun.cancelRequested = true;
    activeSyncRun.cancelReason = `Sync stopped after exceeding ${activeSyncRun.maxRunSeconds} seconds${context ? ` at ${context}` : ""}.`;
    throw new DispatchSyncStoppedError(activeSyncRun.cancelReason);
  }
}

async function runDispatchSync({ source = "manual", actorOperatorId = null } = {}) {
  if (syncRunning) {
    return { skipped: true, reason: "sync_running" };
  }
  syncRunning = true;
  const runId = crypto.randomUUID();
  const settings = (await readDispatchSetup()).sync;
  const maxRunSeconds = Number(settings.maxRunSeconds || defaultDispatchSetup.sync.maxRunSeconds);
  activeSyncRun = {
    id: runId,
    source,
    maxRunSeconds,
    deadlineAt: Date.now() + (maxRunSeconds * 1000),
    cancelRequested: false,
    cancelReason: ""
  };
  const startedAt = new Date().toISOString();
  await writeDispatchSetup({
    sync: {
      running: true,
      lastStartedAt: startedAt,
      lastSource: source,
      lastStatus: "running",
      lastError: ""
    }
  });
  try {
    assertDispatchSyncCanContinue("start");
    const synced = await syncDispatchOrderFeed();
    assertDispatchSyncCanContinue("enrichment");
    const enriched = await refreshDispatchEnrichment();
    const finishedAt = new Date().toISOString();
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: "success",
        lastError: ""
      }
    });
    await writeAudit({
      actorType: actorOperatorId ? "operator" : "system",
      actorOperatorId,
      source: "netsuite",
      action: source === "auto" ? "netsuite.auto_sync" : "netsuite.manual_sync",
      details: { synced, enriched }
    });
    emitAppEvent("dispatch.orders.updated", { source, syncedAt: finishedAt });
    return { synced, enriched, startedAt, finishedAt };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const stopped = error instanceof DispatchSyncStoppedError;
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: stopped ? "stopped" : "failed",
        lastError: error.message
      }
    });
    await writeAudit({
      actorType: actorOperatorId ? "operator" : "system",
      actorOperatorId,
      source: "netsuite",
      action: stopped
        ? (source === "auto" ? "netsuite.auto_sync_stopped" : "netsuite.manual_sync_stopped")
        : (source === "auto" ? "netsuite.auto_sync_failed" : "netsuite.manual_sync_failed"),
      details: { error: error.message }
    });
    if (stopped) return { stopped: true, startedAt, finishedAt, error: error.message };
    throw error;
  } finally {
    if (activeSyncRun?.id === runId) activeSyncRun = null;
    syncRunning = false;
  }
}

async function stopDispatchSync({ actorOperatorId = null, reason = "Stopped manually from Control Panel." } = {}) {
  const setup = await readDispatchSetup();
  const hadActiveRun = Boolean(activeSyncRun && syncRunning);
  if (activeSyncRun) {
    activeSyncRun.cancelRequested = true;
    activeSyncRun.cancelReason = reason;
  }
  await writeDispatchSetup({
    sync: {
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastStatus: hadActiveRun ? "stop_requested" : "stopped",
      lastError: hadActiveRun ? `${reason} The current NetSuite request will finish before the runner exits.` : reason
    }
  });
  await writeAudit({
    actorType: actorOperatorId ? "operator" : "system",
    actorOperatorId,
    source: "control",
    action: hadActiveRun ? "sync.stop_requested" : "sync.running_flag_cleared",
    details: { previousStatus: setup.sync?.lastStatus || "", previousRunning: Boolean(setup.sync?.running), hadActiveRun }
  });
  return (await readDispatchSetup()).sync;
}

async function clearOperationalOrderData({ actorOperatorId = null } = {}) {
  if (syncRunning || activeSyncRun) {
    throw new Error("Stop the current sync before clearing order data.");
  }
  const tables = [
    "dispatch_so_po_allocations",
    "dispatch_operator_requests",
    "dispatch_audit_log",
    "driver_job_records",
    "driver_day_records",
    "local_co_receipt_records",
    "co_order_lines",
    "co_orders",
    "local_co_order_lines",
    "local_co_orders",
    "dispatch_plan_snapshots",
    "dispatch_plans",
    "delivery_fulfillment_records",
    "delivery_preparation_records",
    "sales_order_lines",
    "transfer_order_lines",
    "purchase_order_lines",
    "sales_orders",
    "transfer_orders",
    "purchase_orders",
    "receiving_receipt_records",
    "operator_record_warnings"
  ];
  const counts = await withTransaction(async () => {
    const counts = {};
    for (const table of tables) {
      const result = await query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      counts[table] = result.rows[0]?.count || 0;
    }
    await query(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    return counts;
  });
  await writeAudit({
    actorType: actorOperatorId ? "operator" : "system",
    actorOperatorId,
    source: "control",
    action: "order_data.clear",
    details: { tables, counts }
  });
  await fs.rm(dispatchPlanPath, { force: true }).catch(() => {});
  emitAppEvent("dispatch.plan.cleared", { change: "order_data_clear" });
  emitAppEvent("dispatch.orders.updated", { change: "order_data_clear" });
  emitAppEvent("delivery.order.updated", { change: "order_data_clear" });
  emitAppEvent("receiving.order.updated", { change: "order_data_clear" });
  return { tables, counts };
}

async function autoSyncTick() {
  try {
    const setup = await readDispatchSetup();
    if (setup.sync?.mode !== "auto") return;
    await runDispatchSync({ source: "auto" });
  } catch (error) {
    console.error("Dispatch auto-sync failed:", error.message);
  }
}

async function recoverInterruptedSyncState() {
  const setup = await readDispatchSetup();
  if (!setup.sync?.running) return;
  await writeDispatchSetup({
    sync: {
      running: false,
      lastFinishedAt: new Date().toISOString(),
      lastStatus: "interrupted",
      lastError: "Server restarted before the sync completed. Please run sync again if needed."
    }
  });
}

async function syncDispatchOrderFeed() {
  const deliveryResults = [];
  const receivingResults = [];
  for (const locationId of deliveryLocations) {
    assertDispatchSyncCanContinue(`location ${locationId} sales orders`);
    deliveryResults.push({
      locationId,
      orderType: "sales_order",
      synced: await syncDeliveryLocation(locationId, { orderType: "sales_order" })
    });
    assertDispatchSyncCanContinue(`location ${locationId} transfer delivery orders`);
    deliveryResults.push({
      locationId,
      orderType: "transfer_order",
      synced: await syncDeliveryLocation(locationId, { orderType: "transfer_order" })
    });
    assertDispatchSyncCanContinue(`location ${locationId} purchase receiving orders`);
    receivingResults.push({
      destinationLocationId: locationId,
      orderType: "purchase_order",
      synced: await syncPurchaseReceiving({ locationId })
    });
    assertDispatchSyncCanContinue(`location ${locationId} transfer receiving orders`);
    receivingResults.push({
      destinationLocationId: locationId,
      orderType: "transfer_order",
      synced: await syncTransferReceiving({ destinationLocationId: locationId })
    });
  }
  return { delivery: deliveryResults, receiving: receivingResults };
}

async function syncPurchaseReceiving({ locationId = 1, includeDetails = true } = {}) {
  assertDispatchSyncCanContinue("purchase order list");
  const discoveredOrders = await fetchPurchaseOrdersFromNetSuite(locationId);
  assertDispatchSyncCanContinue("purchase order list");
  await upsertPurchaseOrders(discoveredOrders);
  const existingIds = await listExistingInboundOrderIds({ orderFamily: "purchase_order", destinationLocationId: locationId });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];
  let detailCount = 0;
  for (const orderId of orderIds) {
    assertDispatchSyncCanContinue(`purchase order ${orderId}`);
    const trackedOrder = await fetchPurchaseOrderFromNetSuite(orderId, locationId);
    assertDispatchSyncCanContinue(`purchase order ${orderId}`);
    if (!trackedOrder) continue;
    await upsertPurchaseOrders([trackedOrder]);
    if (includeDetails) {
      assertDispatchSyncCanContinue(`purchase order detail ${orderId}`);
      const lines = await fetchPurchaseOrderDetailsFromNetSuite(orderId, locationId);
      assertDispatchSyncCanContinue(`purchase order detail ${orderId}`);
      await upsertPurchaseOrderLines(orderId, lines);
      await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }
  await markMissingInboundOrders({ orderFamily: "purchase_order", activeOrderIds: discoveredOrders.map((order) => order.id), destinationLocationId: locationId });
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.receiving.purchase_order.sync",
    details: { locationId, discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount }
  });
  return { discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount };
}

async function syncTransferReceiving({ sourceLocationId = null, destinationLocationId = null, includeDetails = true } = {}) {
  assertDispatchSyncCanContinue("transfer receiving list");
  const discoveredOrders = await fetchTransferReceivingOrdersFromNetSuite({ sourceLocationId, destinationLocationId });
  assertDispatchSyncCanContinue("transfer receiving list");
  await upsertInboundTransferOrders(discoveredOrders);
  const existingIds = await listExistingInboundOrderIds({ orderFamily: "transfer_order", sourceLocationId, destinationLocationId });
  const orderIds = [...new Set([
    ...discoveredOrders.map((order) => String(order.id)),
    ...existingIds.map((id) => String(id))
  ])];
  let detailCount = 0;
  for (const orderId of orderIds) {
    assertDispatchSyncCanContinue(`transfer receiving order ${orderId}`);
    const trackedOrder = await fetchTransferReceivingOrderFromNetSuite(orderId);
    assertDispatchSyncCanContinue(`transfer receiving order ${orderId}`);
    if (!trackedOrder) continue;
    await upsertInboundTransferOrders([trackedOrder]);
    if (includeDetails) {
      assertDispatchSyncCanContinue(`transfer receiving detail ${orderId}`);
      const lines = await fetchTransferOrderDetailsFromNetSuite(orderId, destinationLocationId || null, { direction: "destination" });
      assertDispatchSyncCanContinue(`transfer receiving detail ${orderId}`);
      await upsertInboundTransferOrderLines(orderId, lines);
      await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
      detailCount += lines.length;
    }
  }
  await markMissingInboundOrders({
    orderFamily: "transfer_order",
    activeOrderIds: discoveredOrders.map((order) => order.id),
    sourceLocationId,
    destinationLocationId
  });
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.receiving.transfer_order.sync",
    details: { sourceLocationId, destinationLocationId, discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount }
  });
  return { discovered: discoveredOrders.length, tracked: orderIds.length, lines: detailCount };
}

async function syncReceivingOrderDetails(orderId, { orderType = null, locationId = null, sourceLocationId = null } = {}) {
  const existing = await getReceivingOrder(orderId);
  const normalizedOrderType = orderType || existing?.order_type || "purchase_order";
  if (normalizedOrderType === "transfer_order") {
    const effectiveDestinationLocationId = locationId || existing?.destination_location_id || null;
    const storedSourceLocationId = existing?.source_location_id && String(existing.source_location_id) !== String(effectiveDestinationLocationId)
      ? existing.source_location_id
      : null;
    const effectiveSourceLocationId = sourceLocationId || storedSourceLocationId;
    const order = await fetchTransferReceivingOrderFromNetSuite(orderId, effectiveSourceLocationId);
    if (!order) return { order: false, lines: 0 };
    await upsertInboundTransferOrders([order]);
    const lines = await fetchTransferOrderDetailsFromNetSuite(orderId, effectiveDestinationLocationId || order.destination_location_id, { direction: "destination" });
    await upsertInboundTransferOrderLines(orderId, lines);
    await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
    return { order: true, orderType: "transfer_order", lines: lines.length };
  }

  const effectiveLocationId = locationId || existing?.destination_location_id || null;
  const order = await fetchPurchaseOrderFromNetSuite(orderId, effectiveLocationId);
  if (!order) return { order: false, lines: 0 };
  await upsertPurchaseOrders([order]);
  const lines = await fetchPurchaseOrderDetailsFromNetSuite(orderId, effectiveLocationId);
  await upsertPurchaseOrderLines(orderId, lines);
  await markMissingInboundOrderLines(orderId, lines.map((line) => line.line_id));
  return { order: true, orderType: "purchase_order", lines: lines.length };
}

function webhookNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  return Math.abs(Number(String(value).replaceAll(",", ""))) || 0;
}

function webhookString(value) {
  return String(value ?? "").trim();
}

function webhookDate(value) {
  const text = webhookString(value);
  return text ? text.slice(0, 10) : null;
}

function webhookLocationText(value) {
  const text = webhookString(value);
  if (text === "1") return "3445";
  if (text === "13") return "2967";
  if (text === "15") return "12441";
  if (text === "26") return "150";
  return text;
}

function webhookRecordType(value) {
  const text = webhookString(value).toLowerCase();
  if (["salesorder", "salesord", "sales_order", "so"].includes(text)) return "sales_order";
  if (["purchaseorder", "purchord", "purchase_order", "po"].includes(text)) return "purchase_order";
  if (["transferorder", "trnfrord", "transfer_order", "to"].includes(text)) return "transfer_order";
  return "";
}

const EXCLUDED_SALES_ORDER_PREFIXES = ["SOV", "SOT"];

function isExcludedSalesOrderRef(value) {
  const text = webhookString(value).toUpperCase();
  return EXCLUDED_SALES_ORDER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function webhookLineHasConversion(line) {
  return webhookNumber(line.to_plt ?? line.toPlt) > 0
    || webhookNumber(line.to_lyr ?? line.toLyr) > 0
    || webhookNumber(line.to_sec ?? line.toSec) > 0
    || webhookNumber(line.to_pcs ?? line.toPcs) > 0;
}

function deriveWebhookQuantitiesFromSales(line, quantity) {
  if (!webhookLineHasConversion(line)) {
    return {
      pallet_qty: 0,
      layer_qty: 0,
      section_qty: 0,
      piece_qty: 0,
      quantity
    };
  }
  let remaining = quantity;
  const next = {
    pallet_qty: 0,
    layer_qty: 0,
    section_qty: 0,
    piece_qty: 0,
    quantity
  };
  const conversions = [
    ["pallet_qty", "to_plt", "toPlt"],
    ["layer_qty", "to_lyr", "toLyr"],
    ["section_qty", "to_sec", "toSec"],
    ["piece_qty", "to_pcs", "toPcs"]
  ];
  for (const [qtyField, snake, camel] of conversions) {
    const conversion = webhookNumber(line[snake] ?? line[camel]);
    if (!conversion || remaining <= 0) continue;
    const units = Math.floor((remaining / conversion) + 0.000001);
    next[qtyField] = units;
    remaining = Number((remaining - (units * conversion)).toFixed(6));
  }
  return next;
}

function normalizeWebhookLine(line, { locationId = null, locationText = "", processedQuantity = null, remainingForDelivery = false } = {}) {
  const quantity = webhookNumber(line.quantity);
  const processed = webhookNumber(processedQuantity ?? line.netsuite_received_qty ?? line.quantityShipRecv ?? line.quantityshiprecv);
  const remainingQuantity = Math.max(quantity - processed, 0);
  const derived = remainingForDelivery && processed > 0
    ? deriveWebhookQuantitiesFromSales(line, remainingQuantity)
    : {
      pallet_qty: webhookNumber(line.pallet_qty ?? line.pallets ?? line.custcol_plt ?? line.plt),
      layer_qty: webhookNumber(line.layer_qty ?? line.layers ?? line.custcol_lyr ?? line.lyr),
      section_qty: webhookNumber(line.section_qty ?? line.sections ?? line.custcol_sec ?? line.sec),
      piece_qty: webhookNumber(line.piece_qty ?? line.pieces ?? line.custcol_pcs ?? line.pcs),
      quantity: remainingForDelivery ? remainingQuantity : quantity
    };

  return {
    line_id: line.uniquekey ?? line.uniqueKey ?? line.lineUniqueKey ?? line.line_unique_key ?? line.line_id ?? line.lineId ?? line.id,
    item_id: line.item_id ?? line.itemId,
    item_name: line.item_name ?? line.itemName ?? line.sku,
    item_type: line.item_type ?? line.itemType,
    item_type_text: line.item_type_text ?? line.itemTypeText,
    item_description: line.item_description ?? line.itemDescription ?? line.description ?? "",
    quantity: derived.quantity,
    netsuite_received_qty: processed,
    unit: line.unit ?? line.unitText ?? "",
    item_weight: line.item_weight ?? line.itemWeight ?? line.weight,
    location_id: line.location_id ?? line.locationId ?? locationId,
    location: line.location ?? line.locationText ?? locationText,
    pallet_qty: derived.pallet_qty,
    layer_qty: derived.layer_qty,
    piece_qty: derived.piece_qty,
    section_qty: derived.section_qty,
    to_plt: line.to_plt ?? line.toPlt,
    to_lyr: line.to_lyr ?? line.toLyr,
    to_sec: line.to_sec ?? line.toSec,
    to_pcs: line.to_pcs ?? line.toPcs,
    raw: line
  };
}

function normalizeWebhookDeliveryOrder(payload, { type, locationId, locationText }) {
  const isTransfer = type === "transfer_order";
  return {
    id: payload.id,
    tranid: payload.tranid,
    trandate: webhookDate(payload.trandate),
    customer_id: isTransfer ? (payload.transferLocationId ?? payload.destinationLocationId) : payload.entityId,
    customer: isTransfer ? `Transfer to ${payload.transferLocationText || payload.destinationLocationText || ""}`.trim() : payload.entityText,
    status: payload.status,
    status_text: payload.statusText || payload.status_text,
    memo: payload.memo || payload.note || payload.custbody7 || "",
    expected_delivery_date: webhookDate(payload.expectedDeliveryDate || payload.custbody4),
    foreigntotal: payload.foreignTotal,
    order_location_id: isTransfer ? (payload.transferLocationId ?? payload.destinationLocationId) : payload.locationId,
    order_location: isTransfer ? (payload.transferLocationText ?? payload.destinationLocationText) : payload.locationText,
    outbound_location_id: locationId,
    outbound_location: locationText,
    delivery_method_id: payload.deliveryMethodId,
    delivery_method: isTransfer ? "Transfer Order" : payload.deliveryMethodText,
    order_type: type,
    source_location_id: isTransfer ? (payload.sourceLocationId ?? payload.locationId ?? locationId) : payload.sourceLocationId,
    source_location: isTransfer ? (payload.sourceLocationText ?? payload.locationText ?? locationText) : payload.sourceLocationText,
    destination_location_id: isTransfer ? (payload.transferLocationId ?? payload.destinationLocationId) : payload.destinationLocationId,
    destination_location: isTransfer ? (payload.transferLocationText ?? payload.destinationLocationText) : payload.destinationLocationText
  };
}

function normalizeWebhookReceivingOrder(payload, { type, locationId, locationText }) {
  const isTransfer = type === "transfer_order";
  return {
    id: payload.id,
    order_type: type,
    tranid: payload.tranid,
    trandate: webhookDate(payload.trandate),
    vendor_id: isTransfer ? (payload.sourceLocationId ?? payload.locationId) : payload.entityId,
    vendor: isTransfer ? (payload.sourceLocationText ?? payload.locationText) : payload.entityText,
    status: payload.status,
    status_text: payload.statusText || payload.status_text,
    memo: payload.memo || payload.note || payload.custbody7 || "",
    foreigntotal: payload.foreignTotal,
    source_location_id: isTransfer ? (payload.sourceLocationId ?? payload.locationId) : payload.sourceLocationId,
    source_location: isTransfer ? (payload.sourceLocationText ?? payload.locationText) : payload.sourceLocationText,
    destination_location_id: locationId,
    destination_location: locationText
  };
}

const DELAYED_STATUS_REFRESH_CONFIG = {
  sales_order: {
    netsuiteType: "SalesOrd",
    updateStatus: updateSalesOrderNetSuiteStatus,
    events: ["dispatch.orders.updated", "delivery.order.updated"]
  },
  purchase_order: {
    netsuiteType: "PurchOrd",
    updateStatus: updatePurchaseOrderNetSuiteStatus,
    events: ["dispatch.orders.updated", "receiving.order.updated"]
  }
};

function scheduleTransactionStatusRefresh(orderType, orderId, { tranid = "", delayMs = 10000 } = {}) {
  const config = DELAYED_STATUS_REFRESH_CONFIG[orderType];
  if (!config) return;
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return;
  const key = `${orderType}:${id}`;
  const existing = delayedTransactionStatusRefreshes.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    delayedTransactionStatusRefreshes.delete(key);
    try {
      const status = await fetchTransactionStatusFromNetSuite(id, config.netsuiteType);
      if (!status) {
        await writeAudit({
          actorType: "system",
          source: "netsuite-webhook",
          action: "netsuite.webhook.delayed_status_missing",
          details: { netsuiteOrderId: id, orderType, tranid }
        });
        return;
      }
      const updated = await config.updateStatus(id, {
        status: status.status,
        statusText: status.status_text
      });
      await writeAudit({
        actorType: "system",
        source: "netsuite-webhook",
        action: "netsuite.webhook.delayed_status_refresh",
        details: {
          netsuiteOrderId: id,
          orderType,
          tranid: status.tranid || tranid,
          status: status.status,
          statusText: status.status_text,
          updated: Boolean(updated)
        }
      });
      for (const eventName of config.events) {
        emitAppEvent(eventName, { orderId: id, tranid: status.tranid || tranid, orderType, source: "netsuite-webhook-delayed-status" });
      }
    } catch (error) {
      await writeAudit({
        actorType: "system",
        source: "netsuite-webhook",
        action: "netsuite.webhook.delayed_status_failed",
        details: { netsuiteOrderId: id, orderType, tranid, error: error.message }
      }).catch(() => {});
    }
  }, delayMs);
  delayedTransactionStatusRefreshes.set(key, timer);
}

function scheduleSalesOrderStatusRefresh(orderId, options = {}) {
  scheduleTransactionStatusRefresh("sales_order", orderId, options);
}

function schedulePurchaseOrderStatusRefresh(orderId, options = {}) {
  scheduleTransactionStatusRefresh("purchase_order", orderId, options);
}

export async function processNetSuiteOrderWebhook(payload = {}, { scheduleDelayedStatus = true } = {}) {
  const type = webhookRecordType(payload.recordType || payload.type || payload.orderType);
  if (!type) throw new Error("Unsupported NetSuite webhook record type.");
  if (!payload.id || !payload.tranid) throw new Error("Webhook payload requires id and tranid.");
  if (type === "sales_order" && isExcludedSalesOrderRef(payload.tranid)) {
    await writeAudit({
      actorType: "system",
      source: "netsuite-webhook",
      action: "netsuite.webhook.sales_order_ignored_prefix",
      details: {
        netsuiteOrderId: payload.id,
        tranid: payload.tranid,
        excludedPrefixes: EXCLUDED_SALES_ORDER_PREFIXES
      }
    });
    return {
      ok: true,
      ignored: true,
      reason: "excluded_sales_order_prefix",
      orderId: payload.id,
      tranid: payload.tranid,
      recordType: type
    };
  }
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const results = [];

  if (type === "sales_order") {
    const locationId = lines.find((line) => line.locationId || line.location_id)?.locationId || payload.locationId;
    const locationText = lines.find((line) => line.locationText || line.location)?.locationText || payload.locationText;
    const order = normalizeWebhookDeliveryOrder(payload, { type, locationId, locationText });
    const normalizedLines = lines.map((line) => normalizeWebhookLine(line, {
      locationId: line.locationId || line.location_id || locationId,
      locationText: line.locationText || line.location || locationText,
      processedQuantity: line.quantityFulfilled ?? line.quantityShipRecv,
      remainingForDelivery: true
    }));
    await upsertSalesOrders([order]);
    await upsertSalesOrderLines(order.id, normalizedLines);
    await markMissingOutboundOrderLines(order.id, normalizedLines.map((line) => line.line_id));
    results.push({ target: "sales_orders", orderType: type, lines: normalizedLines.length });
    if (scheduleDelayedStatus) scheduleSalesOrderStatusRefresh(payload.id, { tranid: payload.tranid });
  } else if (type === "purchase_order") {
    const locationId = lines.find((line) => line.locationId || line.location_id)?.locationId || payload.locationId;
    const locationText = lines.find((line) => line.locationText || line.location)?.locationText || payload.locationText;
    const order = normalizeWebhookReceivingOrder(payload, { type, locationId, locationText });
    const normalizedLines = lines.map((line) => normalizeWebhookLine(line, {
      locationId: line.locationId || line.location_id || locationId,
      locationText: line.locationText || line.location || locationText,
      processedQuantity: line.quantityReceived ?? line.quantityShipRecv
    }));
    await upsertPurchaseOrders([order]);
    await upsertPurchaseOrderLines(order.id, normalizedLines);
    await markMissingInboundOrderLines(order.id, normalizedLines.map((line) => line.line_id));
    results.push({ target: "purchase_orders", orderType: type, lines: normalizedLines.length });
    if (scheduleDelayedStatus) schedulePurchaseOrderStatusRefresh(payload.id, { tranid: payload.tranid });
  } else if (type === "transfer_order") {
    const sourceLocationId = payload.sourceLocationId || payload.locationId;
    const sourceLocationText = payload.sourceLocationText || payload.locationText || webhookLocationText(sourceLocationId);
    const destinationLocationId = payload.destinationLocationId || payload.transferLocationId;
    const destinationLocationText = payload.destinationLocationText || payload.transferLocationText || webhookLocationText(destinationLocationId);
    const deliveryOrder = normalizeWebhookDeliveryOrder(payload, { type, locationId: sourceLocationId, locationText: sourceLocationText });
    const deliveryLines = lines.map((line) => normalizeWebhookLine(line, {
      locationId: sourceLocationId,
      locationText: sourceLocationText,
      processedQuantity: line.quantityFulfilled ?? line.quantityShipRecv,
      remainingForDelivery: true
    }));
    await upsertOutboundTransferOrders([deliveryOrder]);
    await upsertOutboundTransferOrderLines(deliveryOrder.id, deliveryLines);
    await markMissingOutboundOrderLines(deliveryOrder.id, deliveryLines.map((line) => line.line_id));
    results.push({ target: "transfer_orders.outbound", orderType: type, lines: deliveryLines.length });

    const receivingOrder = normalizeWebhookReceivingOrder(payload, { type, locationId: destinationLocationId, locationText: destinationLocationText });
    const receivingLines = lines.map((line) => normalizeWebhookLine(line, {
      locationId: destinationLocationId,
      locationText: destinationLocationText,
      processedQuantity: line.quantityReceived ?? line.quantityShipRecv
    }));
    await upsertInboundTransferOrders([receivingOrder]);
    await upsertInboundTransferOrderLines(receivingOrder.id, receivingLines);
    await markMissingInboundOrderLines(receivingOrder.id, receivingLines.map((line) => line.line_id));
    results.push({ target: "transfer_orders.receiving", orderType: type, lines: receivingLines.length });
  }

  await writeAudit({
    actorType: "system",
    source: "netsuite-webhook",
    action: "netsuite.webhook.order",
    details: { netsuiteOrderId: payload.id, recordType: type, tranid: payload.tranid, eventType: payload.eventType || "", results }
  });
  emitAppEvent("dispatch.orders.updated", { orderId: payload.id, tranid: payload.tranid, source: "netsuite-webhook" });
  emitAppEvent("delivery.order.updated", { orderId: payload.id, tranid: payload.tranid, source: "netsuite-webhook" });
  emitAppEvent("receiving.order.updated", { orderId: payload.id, tranid: payload.tranid, source: "netsuite-webhook" });
  return { ok: true, orderId: payload.id, tranid: payload.tranid, recordType: type, results };
}

app.use(express.json({ limit: "25mb" }));

app.use(async (req, res, next) => {
  if (process.env.MBBS_ENABLE_ROLLBACK_TESTS !== "1" || req.get("x-mbbs-rollback-test") !== "1") {
    return next();
  }
  let context;
  try {
    context = await beginRollbackContext();
  } catch (error) {
    return next(error);
  }

  let done = false;
  async function rollback() {
    if (done) return;
    done = true;
    await context.rollback().catch((error) => {
      console.error("Rollback test cleanup failed:", error);
    });
  }

  res.setHeader("x-mbbs-rollback-test", "true");
  res.on("finish", rollback);
  res.on("close", rollback);
  return context.run(() => next());
});

app.post("/api/webhooks/netsuite/order", async (req, res, next) => {
  try {
    const expectedSecret = config.netsuite.webhookSecret;
    if (!expectedSecret) return res.status(503).json({ error: "NETSUITE_WEBHOOK_SECRET is not configured on the server." });
    const providedSecret = req.get("x-mbbs-webhook-secret") || req.body?.secret || "";
    const providedBuffer = Buffer.from(String(providedSecret));
    const expectedBuffer = Buffer.from(String(expectedSecret));
    if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
      return res.status(401).json({ error: "Invalid webhook secret." });
    }
    res.json(await processNetSuiteOrderWebhook(req.body));
  } catch (error) {
    next(error);
  }
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const client = {
    id: crypto.randomUUID(),
    client: req.query.client || "unknown",
    res
  };
  eventClients.add(client);
  res.write(`retry: 3000\n`);
  res.write(`event: app-event\ndata: ${JSON.stringify({ id: eventSeq, type: "connected", at: new Date().toISOString(), payload: { client: client.client } })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      eventClients.delete(client);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(client);
  });
});

app.use((req, res, next) => {
  if (req.path === "/service-worker.js") {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Service-Worker-Allowed", "/");
  } else if (req.path.endsWith(".webmanifest") || ["/operator", "/driver", "/control", "/operator.html", "/driver.html", "/control.html"].includes(req.path)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});

app.use("/vendor/qr-scanner", express.static(qrScannerDir));
app.use(express.static(publicDir));

app.use("/api/dispatch", requireOperator, requireDispatcher);

app.get("/api/dispatch/config", (req, res) => {
  res.json({
    googleMapsApiKey: config.googleMapsApiKey
  });
});

app.get("/api/dispatch/monitor", async (req, res, next) => {
  try {
    const planDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : localDateDaysAgo(0);
    const setup = await readDispatchSetup();
    const plan = await getCurrentDispatchPlan({ planDate });
    const driverJobStatuses = plan?.id ? await listDriverJobStatuses({ planId: plan.id }) : [];
    const currentTruckMap = new Map();
    for (const truck of setup.trucks || []) {
      const plate = String(truck.plate || "").trim();
      if (plate) currentTruckMap.set(normalizedPlate(plate), { ...truck, plate });
    }
    const plates = [...currentTruckMap.values()].map((truck) => truck.plate).filter(Boolean);
    let locations = [];
    let samsaraError = "";
    try {
      locations = await listSamsaraVehicleLocations({ plates });
    } catch (error) {
      samsaraError = error.message;
    }
    const locationByPlate = new Map(locations.map((location) => [normalizedPlate(location.plate), location]));
    const planTruckByPlate = new Map((plan?.trucks || []).map((truck) => [normalizedPlate(truck.plate), truck]));
    let trucks = [...currentTruckMap.values()].map((truck) => {
      const planTruck = planTruckByPlate.get(normalizedPlate(truck.plate)) || truck;
      const location = locationByPlate.get(normalizedPlate(truck.plate)) || {};
      return {
        plate: truck.plate || "",
        vehicleId: location.vehicleId || "",
        vehicleName: location.vehicleName || "",
        latitude: location.latitude,
        longitude: location.longitude,
        headingDegrees: Number.isFinite(Number(location.headingDegrees)) ? Number(location.headingDegrees) : null,
        speedMilesPerHour: location.speedMilesPerHour || 0,
        formattedLocation: location.formattedLocation || "",
        locationTime: location.time || "",
        driver: planTruck.driver || "",
        driverLogin: planTruck.driverLogin || "",
        base: planTruck.base || truck.base || "",
        parkingSpot: planTruck.parkingSpot || "",
        activeLoad: monitorLoadForTruck(plan, planTruck, driverJobStatuses)
      };
    });
    await recordTruckLocationHistory(trucks).catch(() => null);
    const trails = await truckLocationTrails(plates);
    trucks = trucks.map((truck) => ({
      ...truck,
      estimatedKmh: Number.isFinite(Number(truck.speedMilesPerHour)) ? Number(truck.speedMilesPerHour) * 1.609344 : null
    }));
    const ownYards = uniqueYardLocations((setup.ownYards || []).map((yard) => ({ ...yard, type: "own", name: yard.name || yard.code })));
    const vendorYards = uniqueYardLocations((await listDispatchVendorYards()).map((yard) => ({ ...yard, type: "vendor" })));
    res.json({
      planDate,
      refreshSeconds: 10,
      plan: plan ? { id: plan.id, status: plan.status, planDate: plan.planDate } : null,
      trucks,
      trails,
      yards: [...ownYards, ...vendorYards],
      samsaraError,
      sources: {
        samsaraEndpoint: "/fleet/vehicles/locations",
        refreshRecommendation: "10 seconds"
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/dvir-records", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date)
      : localDateDaysAgo(0);
    const result = await pool.query(
      `SELECT id, driver_login, plan_id, plan_date::text AS plan_date,
              truck_id, truck_plate, samsara_username,
              COALESCE(pre_dvir_photo_data_urls, '[]'::jsonb) AS pre_photos,
              COALESCE(post_dvir_photo_data_urls, '[]'::jsonb) AS post_photos,
              pre_dvir_completed_at, post_dvir_completed_at,
              on_duty_at, off_duty_at,
              COALESCE(samsara_on_duty_response, '{}'::jsonb) AS samsara_on_response,
              COALESCE(samsara_off_duty_response, '{}'::jsonb) AS samsara_off_response,
              updated_at
         FROM driver_day_records
        WHERE plan_date = $1::date
        ORDER BY COALESCE(post_dvir_completed_at, pre_dvir_completed_at, updated_at) DESC,
                 driver_login ASC`,
      [date]
    );
    const records = result.rows.map((row) => {
      const prePhotos = Array.isArray(row.pre_photos) ? row.pre_photos.filter(Boolean) : [];
      const postPhotos = Array.isArray(row.post_photos) ? row.post_photos.filter(Boolean) : [];
      return {
        id: row.id,
        driverLogin: row.driver_login || "",
        planId: row.plan_id || null,
        planDate: row.plan_date || date,
        truckId: row.truck_id || "",
        truckPlate: row.truck_plate || "",
        samsaraUsername: row.samsara_username || "",
        prePhotos,
        postPhotos,
        prePhotoCount: prePhotos.length,
        postPhotoCount: postPhotos.length,
        preCompletedAt: row.pre_dvir_completed_at || "",
        postCompletedAt: row.post_dvir_completed_at || "",
        onDutyAt: row.on_duty_at || "",
        offDutyAt: row.off_duty_at || "",
        samsaraPreDvirId: row.samsara_on_response?.dvirId || row.samsara_on_response?.dvir?.id || row.samsara_on_response?.verifiedDvir?.id || "",
        samsaraPostDvirId: row.samsara_off_response?.dvirId || row.samsara_off_response?.dvir?.id || row.samsara_off_response?.verifiedDvir?.id || "",
        preError: row.samsara_on_response?.error || row.samsara_on_response?.clockError || "",
        postError: row.samsara_off_response?.error || row.samsara_off_response?.clockError || "",
        updatedAt: row.updated_at || ""
      };
    });
    res.json({ date, records });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/statistics", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json(await getDispatchStatistics({
      from: req.query.from || "",
      to: req.query.to || "",
      driver: req.query.driver || ""
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans", async (req, res, next) => {
  try {
    res.json(await listDispatchPlans({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plans", async (req, res, next) => {
  try {
    const plan = await createDispatchPlan({
      planDate: req.body?.planDate,
      note: req.body?.note || ""
    });
    await writeDispatchAudit({
      action: "dispatch_plan_created",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: { planDate: plan.planDate }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.created", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/current", async (req, res, next) => {
  try {
    const plan = await getCurrentDispatchPlan({ planDate: req.query.date });
    res.json(plan || { savedAt: "", orders: [], trucks: [], planDate: req.query.date || new Date().toISOString().slice(0, 10) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/:id/shipped-orders.csv", async (req, res, next) => {
  try {
    const plan = await getDispatchPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: "Dispatch plan not found" });
    const statuses = await listDriverJobStatuses({ planId: plan.id });
    const csv = shippedDispatchCsv(plan, statuses);
    const safeDate = String(plan.planDate || "dispatch").replaceAll(/[^0-9-]/g, "");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shipped-orders-${safeDate || plan.id}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plans/:id", async (req, res, next) => {
  try {
    const plan = await getDispatchPlan(req.params.id);
    if (!plan) return res.status(404).json({ error: "Dispatch plan not found" });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/plans/:id", async (req, res, next) => {
  try {
    const previousPlan = await getDispatchPlan(req.params.id);
    const cleanOrders = sanitizeDispatchPlanOrders(Array.isArray(req.body?.orders) ? req.body.orders : []);
    const plan = await saveDispatchPlanSnapshot(req.params.id, {
      orders: cleanOrders,
      trucks: Array.isArray(req.body?.trucks) ? req.body.trucks : [],
      summary: req.body?.summary || {}
    });
    const explicitOperatorAlertRefs = Array.isArray(req.body?.audit?.details?.operatorAlertRefs)
      ? req.body.audit.details.operatorAlertRefs.map((ref) => String(ref || "").trim()).filter(Boolean)
      : [];
    const changedOperatorRefs = [
      ...new Set([...changedDispatchOperatorRefs(previousPlan || {}, plan), ...explicitOperatorAlertRefs])
    ];
    let operatorFlags = null;
    if (plan.status === "confirmed") {
      operatorFlags = await applyConfirmedDispatchPlanToDelivery(plan, {
        forceOrderRefs: changedOperatorRefs
      });
    }
    if (req.body?.audit) {
      await writeDispatchAudit({
        ...req.body.audit,
        action: req.body.audit.action || "dispatch_plan_saved",
        entityType: "plan",
        entityId: String(plan.id),
        planId: plan.id,
        planDate: plan.planDate,
        details: {
          ...(req.body.audit.details || {}),
          orderCount: plan.orders.length,
          truckCount: plan.trucks.length,
          operatorFlags
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.plan.saved", { planId: plan.id, planDate: plan.planDate, savedAt: plan.savedAt, sourceSessionId: req.body?.audit?.sessionId, operatorFlags, changedOperatorRefs });
    res.json({ ...plan, operatorFlags });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plans/:id/confirm", async (req, res, next) => {
  try {
    const plan = await confirmDispatchPlan(req.params.id, { note: req.body?.note || "" });
    const changedOperatorRefs = [...dispatchOperatorAssignmentMap(plan).keys()];
    const operatorFlags = await applyConfirmedDispatchPlanToDelivery(plan, { forceOrderRefs: changedOperatorRefs });
    await writeDispatchAudit({
      action: "dispatch_plan_confirmed",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: { status: plan.status, operatorFlags }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.confirmed", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId, operatorFlags, changedOperatorRefs });
    res.json({ ...plan, operatorFlags });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plans/:id/reopen", async (req, res, next) => {
  try {
    const plan = await reopenDispatchPlan(req.params.id, { note: req.body?.note || "" });
    await writeDispatchAudit({
      action: "dispatch_plan_reopened",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      after: plan,
      details: { status: plan.status }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.reopened", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId });
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plan", async (req, res, next) => {
  try {
    const plan = await getCurrentDispatchPlan({ planDate: req.query.date });
    if (plan) return res.json(plan);
    const text = await fs.readFile(dispatchPlanPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!text) return res.json({ savedAt: "", orders: [], trucks: [] });
    res.json(JSON.parse(text));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/setup", async (req, res, next) => {
  try {
    res.json(await readDispatchSetup());
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/setup", async (req, res, next) => {
  try {
    const payload = await writeDispatchSetup({
      drivers: Array.isArray(req.body?.drivers) ? req.body.drivers : [],
      trucks: Array.isArray(req.body?.trucks) ? req.body.trucks : [],
      ownYards: Array.isArray(req.body?.ownYards) ? req.body.ownYards : undefined,
      samsara: req.body?.samsara || undefined
    });
    emitAppEvent("dispatch.setup.updated", { driverCount: payload.drivers.length, truckCount: payload.trucks.length });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/samsara/test", async (req, res, next) => {
  try {
    const setup = await readDispatchSetup();
    res.json(await testSamsaraConnection({ localTrucks: setup.trucks || [] }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/samsara/driver-login-test", async (req, res, next) => {
  try {
    const driverLogin = String(req.body?.driverLogin || "").trim().toLowerCase();
    const account = req.body?.account === "secondary" ? "secondary" : "primary";
    const setup = await readDispatchSetup();
    const driver = (setup.drivers || []).find((item) => String(item.login || "").trim().toLowerCase() === driverLogin);
    if (!driver) return res.status(404).json({ error: "Driver was not found in Dispatch Setup." });
    const username = samsaraUsernameForDriver(driver, account);
    if (!username) return res.status(400).json({ error: `No Samsara ${account} login ID is saved for this driver.` });
    const samsaraDriver = await findSamsaraDriverByUsername(username);
    if (!samsaraDriver) return res.status(404).json({ error: `Samsara driver username ${username} was not found.` });
    res.json({
      username,
      account,
      driverName: driver.name || "",
      samsaraDriver: {
        id: samsaraDriver.id,
        name: samsaraDriver.name,
        username: samsaraDriver.username,
        status: samsaraDriver.driverActivationStatus || ""
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/orders", async (req, res, next) => {
  try {
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    res.json(await listDispatchOrders({ type }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/sync", async (req, res, next) => {
  try {
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    res.json({
      localOnly: true,
      skipped: true,
      reason: "NetSuite order sync is admin-only. Dispatcher refresh reads local DB.",
      orders: await listDispatchOrders({ type })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/enrich", async (req, res, next) => {
  try {
    const enriched = await refreshDispatchEnrichment({ force: req.body?.force === true || req.query.force === "true" });
    emitAppEvent("dispatch.orders.updated", { source: "enrich", type: req.query.type ? String(req.query.type).toUpperCase() : null });
    res.json({ enriched, orders: await listDispatchOrders({ type: req.query.type ? String(req.query.type).toUpperCase() : null }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/vendor-yards", async (req, res, next) => {
  try {
    res.json(await listDispatchVendorYards());
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/parser-rules", async (req, res, next) => {
  try {
    res.json(await listDispatchParserRules());
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/parser-rules/:key", async (req, res, next) => {
  try {
    const updated = await updateDispatchParserRule(req.params.key, req.body?.value);
    if (!updated) return res.status(404).json({ error: "Parser rule not found" });
    emitAppEvent("dispatch.setup.updated", { parserRule: req.params.key });
    res.json({ updated });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/ollama-audit", async (req, res, next) => {
  try {
    res.json(await listOllamaAudit({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/audit", async (req, res, next) => {
  try {
    res.json(await listDispatchAudit({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/audit", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const written = await writeDispatchAudit({
      ...(req.body || {}),
      operatorId: operator?.id || req.body?.operatorId,
      operatorName: operator?.display_name || operator?.username || req.body?.operatorName,
      source: req.body?.source || "dispatch"
    });
    res.json({ written });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/vendor-yards/:id", async (req, res, next) => {
  try {
    const updated = await updateDispatchVendorYard(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Vendor yard row not found" });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    emitAppEvent("dispatch.vendor_yard.updated", { id: req.params.id });
    res.json({ updated, enriched });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/vendor-yards", async (req, res, next) => {
  try {
    const updated = await upsertDispatchVendorYard(req.body || {});
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    emitAppEvent("dispatch.vendor_yard.updated", { id: updated?.id });
    res.json({ updated, enriched });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/orders/:id/vendor-yard", async (req, res, next) => {
  try {
    const updated = await setPurchaseOrderVendorYard(req.params.id, req.body?.vendorYardId);
    await writeDispatchAudit({
      action: "po_vendor_yard_updated",
      entityType: "order",
      entityId: req.params.id,
      orderId: req.params.id,
      sessionId: req.body?.audit?.sessionId,
      before: req.body?.audit?.before,
      after: updated,
      details: { vendorYardId: req.body?.vendorYardId }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: req.params.id, type: "PO", change: "vendor_yard", sourceSessionId: req.body?.audit?.sessionId });
    res.json({ updated, orders: await listDispatchOrders({ type: "PO" }) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/orders/:id/details", async (req, res, next) => {
  try {
    const updated = await updateDispatchOrderDetails(req.params.id, req.body || {});
    await writeDispatchAudit({
      action: "dispatch_info_updated",
      entityType: "order",
      entityId: req.params.id,
      orderId: req.params.id,
      sessionId: req.body?.audit?.sessionId,
      before: req.body?.audit?.before,
      after: updated,
      details: {
        type: req.body?.type,
        sourceTable: req.body?.sourceTable,
        address: req.body?.address,
        expectedDeliveryDate: req.body?.expectedDeliveryDate,
        windowStart: req.body?.windowStart,
        windowEnd: req.body?.windowEnd
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: req.params.id, change: "details", sourceSessionId: req.body?.audit?.sessionId });
    res.json({ updated, orders: await listDispatchOrders() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/orders/:id/po-allocations", async (req, res, next) => {
  try {
    res.json(await getSalesOrderPoAllocationOptions(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/orders/:id/po-allocations", async (req, res, next) => {
  try {
    const allocations = Array.isArray(req.body?.lines)
      ? await createSalesOrderPoAllocations({
        salesOrderRef: req.params.id,
        poRef: req.body?.poRef,
        lines: req.body.lines,
        createdBy: req.body?.audit?.sessionId || ""
      })
      : [await createSalesOrderPoAllocation({
        salesOrderRef: req.params.id,
        salesLineId: req.body?.salesLineId,
        poLineId: req.body?.poLineId,
        poRef: req.body?.poRef,
        quantities: req.body?.quantities || req.body || {},
        createdBy: req.body?.audit?.sessionId || ""
      })];
    await writeDispatchAudit({
      action: "so_po_allocation_created",
      entityType: "so_po_allocation",
      entityId: allocations.map((allocation) => allocation.id).join(","),
      orderId: req.params.id,
      sessionId: req.body?.audit?.sessionId,
      after: allocations,
      details: {
        salesOrderRef: req.params.id,
        poRef: req.body?.poRef || allocations[0]?.poOrderRef || "",
        allocationIds: allocations.map((allocation) => allocation.id),
        salesLineIds: allocations.map((allocation) => allocation.salesLineId),
        poLineIds: allocations.map((allocation) => allocation.poLineId)
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: req.params.id, change: "so_po_allocation", sourceSessionId: req.body?.audit?.sessionId });
    emitAppEvent("delivery.order.updated", { orderRef: req.params.id, change: "so_po_allocation", sourceSessionId: req.body?.audit?.sessionId });
    res.json({ allocations, allocation: allocations[0] || null, options: await getSalesOrderPoAllocationOptions(req.params.id), orders: await listDispatchOrders() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/po-allocations/:allocationId", async (req, res, next) => {
  try {
    const cancelled = await cancelSalesOrderPoAllocation(req.params.allocationId, { cancelledBy: req.query.sessionId || "" });
    if (!cancelled) return res.status(404).json({ error: "Allocation not found or already cancelled." });
    await writeDispatchAudit({
      action: "so_po_allocation_cancelled",
      entityType: "so_po_allocation",
      entityId: String(cancelled.id),
      orderId: cancelled.salesOrderRef,
      sessionId: req.query.sessionId,
      after: cancelled
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: cancelled.salesOrderRef, change: "so_po_allocation_cancelled", sourceSessionId: req.query.sessionId });
    emitAppEvent("delivery.order.updated", { orderRef: cancelled.salesOrderRef, change: "so_po_allocation_cancelled", sourceSessionId: req.query.sessionId });
    res.json({ cancelled, options: await getSalesOrderPoAllocationOptions(cancelled.salesOrderRef), orders: await listDispatchOrders() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/co-orders", async (req, res, next) => {
  try {
    const co = await upsertLocalCoOrder({
      sourceOrderRef: req.body?.sourceOrderRef,
      fromYard: req.body?.fromYard,
      toYard: req.body?.toYard,
      order: req.body?.order || {},
      plan: {
        id: req.body?.planId,
        planDate: req.body?.planDate,
        truckPlate: req.body?.truckPlate,
        loadName: req.body?.loadName,
        parkingSpot: req.body?.parkingSpot
      },
      requestedBy: req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "co_saved_to_local_db",
      entityType: "order",
      entityId: co.co_ref,
      orderId: co.co_ref,
      sessionId: req.body?.audit?.sessionId,
      after: co,
      details: { sourceOrderRef: co.source_order_ref, fromYard: co.from_location, toYard: co.to_location }
    }).catch(() => null);
    emitAppEvent("dispatch.co.updated", { coRef: co.co_ref, sourceOrderRef: co.source_order_ref, sourceSessionId: req.body?.audit?.sessionId });
    emitAppEvent("delivery.order.updated", { orderRef: co.source_order_ref, coRef: co.co_ref, source: "dispatch-co" });
    res.json({ co, orders: await listDispatchOrders() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/co-orders/:coRef", async (req, res, next) => {
  try {
    const cancelled = await cancelLocalCoOrder(req.params.coRef, { requestedBy: req.query.sessionId || "" });
    if (!cancelled) return res.status(409).json({ error: "CO cannot be cancelled after it is received or loaded." });
    await writeDispatchAudit({
      action: "co_cancelled_in_local_db",
      entityType: "order",
      entityId: req.params.coRef,
      orderId: req.params.coRef,
      sessionId: req.query.sessionId,
      after: cancelled
    }).catch(() => null);
    emitAppEvent("dispatch.co.updated", { coRef: req.params.coRef, cancelled: true, sourceSessionId: req.query.sessionId });
    emitAppEvent("delivery.order.updated", { coRef: req.params.coRef, cancelled: true, source: "dispatch-co" });
    res.json({ cancelled, orders: await listDispatchOrders() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/operator-requests", async (req, res, next) => {
  try {
    const written = await createDispatchOperatorRequest({
      requestType: req.body?.requestType,
      orderRef: req.body?.orderRef,
      sourceOrderType: req.body?.sourceOrderType,
      requestedBy: req.body?.requestedBy || req.body?.audit?.sessionId || "",
      details: req.body?.details || {}
    });
    await writeDispatchAudit({
      action: "operator_request_created",
      entityType: "operator_request",
      entityId: String(written.id),
      orderId: written.order_ref,
      sessionId: req.body?.audit?.sessionId,
      after: written,
      details: { requestType: written.request_type, orderRef: written.order_ref }
    }).catch(() => null);
    emitAppEvent("dispatch.operator_request.created", { requestId: written.id, requestType: written.request_type, orderRef: written.order_ref, sourceSessionId: req.body?.audit?.sessionId });
    res.json({ written });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/plan", async (req, res, next) => {
  try {
    const cleanOrders = sanitizeDispatchPlanOrders(Array.isArray(req.body?.orders) ? req.body.orders : []);
    const payload = {
      savedAt: new Date().toISOString(),
      orders: cleanOrders,
      trucks: Array.isArray(req.body?.trucks) ? req.body.trucks : []
    };
    const planDate = req.body?.planDate || req.body?.date || new Date().toISOString().slice(0, 10);
    let plan = req.body?.planId ? await getDispatchPlan(req.body.planId) : await getCurrentDispatchPlan({ planDate });
    if (!plan) plan = await createDispatchPlan({ planDate });
    const savedPlan = await saveDispatchPlanSnapshot(plan.id, {
      orders: payload.orders,
      trucks: payload.trucks,
      summary: req.body?.summary || {}
    });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(dispatchPlanPath, JSON.stringify(payload, null, 2));
    if (req.body?.audit) {
      await writeDispatchAudit({
        ...req.body.audit,
        action: req.body.audit.action || "dispatch_plan_saved",
        entityType: "plan",
        entityId: String(savedPlan.id),
        planId: savedPlan.id,
        planDate: savedPlan.planDate,
        details: {
          ...(req.body.audit.details || {}),
          orderCount: payload.orders.length,
          truckCount: payload.trucks.length
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.plan.saved", { planId: savedPlan.id, planDate: savedPlan.planDate, savedAt: savedPlan.savedAt, sourceSessionId: req.body?.audit?.sessionId });
    res.json(savedPlan);
  } catch (error) {
    next(error);
  }
});

app.get("/delivery", (req, res) => {
  res.redirect("/operator");
});

app.get("/operator", (req, res) => {
  res.sendFile(path.join(publicDir, "operator.html"));
});

app.get("/driver", (req, res) => {
  res.sendFile(path.join(publicDir, "driver.html"));
});

app.get("/control", (req, res) => {
  res.sendFile(path.join(publicDir, "control.html"));
});

app.get("/dispatch", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-menu.html"));
});

app.get("/dispatch/planning", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch.html"));
});

app.get("/dispatch/setup", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-setup.html"));
});

app.get("/dispatch/dvir", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-dvir.html"));
});

app.get("/dispatch/monitor", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-monitor.html"));
});

app.get("/dispatch/statistics", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-statistics.html"));
});

app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>MBBS Yard Server</title>
        <style>
          :root { color-scheme: light; }
          * { box-sizing: border-box; }
          body {
            font-family: Arial, sans-serif;
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: #eef4f2;
            color: #12211f;
          }
          main {
            width: min(920px, calc(100vw - 32px));
            display: grid;
            gap: 18px;
          }
          h1 { margin: 0; font-size: 34px; }
          p { margin: 0; color: #53635f; font-weight: 700; }
          .routes {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px;
          }
          a {
            min-height: 112px;
            border: 2px solid #bfd0cb;
            border-radius: 10px;
            background: #fff;
            color: #12211f;
            text-decoration: none;
            padding: 18px;
            display: grid;
            align-content: center;
            gap: 8px;
            box-shadow: 0 12px 24px rgba(18, 33, 31, 0.08);
          }
          a:hover { border-color: #006f6b; }
          strong { font-size: 24px; }
          span { color: #53635f; font-weight: 800; }
          @media (max-width: 640px) {
            .routes { grid-template-columns: 1fr; }
          }
        </style>
      </head>
      <body>
        <main>
          <div>
            <h1>MBBS Operation</h1>
            <p>Select an application route.</p>
          </div>
          <section class="routes">
            <a href="/operator"><strong>/operator</strong><span>Yard operator tablet app</span></a>
            <a href="/control"><strong>/control</strong><span>Admin control panel</span></a>
            <a href="/dispatch"><strong>/dispatch</strong><span>Dispatch menu</span></a>
            <a href="/driver"><strong>/driver</strong><span>Driver phone PWA</span></a>
          </section>
        </main>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "MBBS Yard Server" });
});

app.get("/api/auth/bootstrap-needed", async (req, res, next) => {
  try {
    res.json({ needed: !(await hasOperators()) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/bootstrap", async (req, res, next) => {
  try {
    if (await hasOperators()) return res.status(409).json({ error: "Operator accounts already exist." });
    const operator = await createOperator({
      username: req.body?.username,
      displayName: req.body?.displayName,
      password: req.body?.password,
      role: "admin"
    });
    await writeAudit({
      actorType: "system",
      source: "control",
      action: "operator.bootstrap_admin",
      actorOperatorId: operator.id,
      details: { username: operator.username }
    });
    res.json({ operator });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const result = await loginOperator(req.body?.username, req.body?.password);
    await writeAudit({
      actorOperatorId: result.operator.id,
      source: "auth",
      action: "operator.login"
    });
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.get("/api/auth/me", requireOperator, (req, res) => {
  res.json({ operator: req.operator });
});

app.post("/api/auth/logout", requireOperator, async (req, res, next) => {
  try {
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "auth",
      action: "operator.logout"
    });
    await logoutToken(bearerToken(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/photo-upload/config", requireOperator, (req, res) => {
  res.json(publicPhotoUploadConfig());
});

app.get("/api/photo-upload/preview", requirePhotoPreviewViewer, async (req, res, next) => {
  try {
    const ref = String(req.query.ref || req.query.key || "");
    if (!isR2PhotoReference(ref) && !String(req.query.key || "")) {
      return res.status(400).json({ error: "R2 photo reference is required." });
    }
    const readTicket = createPhotoReadToken({
      actor: req.photoViewer,
      key: ref || req.query.key
    });
    const response = await fetch(readTicket.objectUrl, {
      headers: { Authorization: `Bearer ${readTicket.token}` }
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text || "R2 photo preview failed." });
    }
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      if (["content-type", "content-length", "cache-control", "etag"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    res.setHeader("Cache-Control", "private, max-age=300");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/photo-upload/token", requireOperator, async (req, res, next) => {
  try {
    const body = req.body || {};
    const token = createPhotoUploadToken({
      actor: {
        id: req.operator.id,
        username: req.operator.username,
        role: req.operator.role,
        operatorId: req.operator.id
      },
      source: body.source || "operator",
      recordType: body.recordType || "operator-load-photo",
      metadata: {
        orderType: body.orderType,
        orderId: body.orderId,
        orderRef: body.orderRef,
        lineId: body.lineId,
        stopId: body.stopId,
        planId: body.planId,
        loadId: body.loadId,
        jobId: body.jobId,
        dvirType: body.dvirType
      }
    });
    res.json(token);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operator/photo-upload-token", requireOperator, async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(createPhotoUploadToken({
      actor: {
        id: req.operator.id,
        username: req.operator.username,
        role: req.operator.role,
        operatorId: req.operator.id
      },
      source: "operator",
      recordType: body.recordType || "operator-load-photo",
      metadata: {
        orderType: body.orderType,
        orderId: body.orderId,
        orderRef: body.orderRef,
        lineId: body.lineId,
        stopId: body.stopId,
        planId: body.planId,
        loadId: body.loadId,
        jobId: body.jobId,
        dvirType: body.dvirType
      }
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/login", async (req, res, next) => {
  try {
    const login = String(req.body?.username || req.body?.login || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const setup = await readDispatchSetup();
    const driver = (setup.drivers || []).find((item) => String(item.login || "").trim().toLowerCase() === login);
    if (!driver) return res.status(401).json({ error: "Invalid driver login." });
    if (driver.password && String(driver.password) !== password) return res.status(401).json({ error: "Invalid driver login." });
    if (!driver.password && password) return res.status(401).json({ error: "Password is not set for this driver. Leave password blank or update it in Dispatch Setup." });
    const token = crypto.randomBytes(32).toString("base64url");
    driverSessions.set(token, { login, createdAt: new Date().toISOString() });
    const dayState = await getDriverDayState(login, { samsaraUsername: samsaraUsernameForDriver(driver, "primary") });
    res.json({ token, driver: publicDriver(driver), dayState });
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/me", requireDriver, (req, res) => {
  res.json({ driver: publicDriver(req.driver) });
});

app.post("/api/driver/photo-upload-token", requireDriver, async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(createPhotoUploadToken({
      actor: {
        id: req.driverLogin,
        login: req.driverLogin,
        driverId: req.driverLogin,
        role: "driver"
      },
      source: "driver",
      recordType: body.recordType || "driver-stop-photo",
      metadata: {
        orderType: body.orderType,
        orderId: body.orderId,
        orderRef: body.orderRef,
        lineId: body.lineId,
        stopId: body.stopId,
        planId: body.planId,
        loadId: body.loadId,
        jobId: body.jobId,
        dvirType: body.dvirType
      }
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/day-state", requireDriver, async (req, res, next) => {
  try {
    res.json({
      state: await getDriverDayState(req.driverLogin, {
        samsaraUsername: samsaraUsernameForDriver(req.driver, "primary")
      })
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/history", requireDriver, async (req, res, next) => {
  try {
    res.json({
      records: await listDriverHistory(req.driverLogin, {
        date: req.query.date || "",
        limit: req.query.limit || 100
      })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/logout", requireDriver, async (req, res, next) => {
  try {
    const state = await getDriverDayState(req.driverLogin, {
      samsaraUsername: samsaraUsernameForDriver(req.driver, "primary")
    });
    if (state.preDvirStatus === "complete" && state.postDvirStatus !== "complete") {
      return res.status(409).json({ error: "MBBS post-trip inspection is required before logout.", state });
    }
    driverSessions.delete(driverToken(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/dvir", requireDriver, async (req, res, next) => {
  try {
    const type = req.body?.type === "post" ? "post" : "pre";
    const samsaraUsername = samsaraUsernameForDriver(req.driver, "primary");
    const state = await getDriverDayState(req.driverLogin, { samsaraUsername });
    if (type === "post" && !state.allJobsComplete) {
      return res.status(409).json({ error: "MBBS post-trip inspection is only available after all assigned stops are complete.", state });
    }
    const result = await submitDriverDvir(req.driverLogin, {
      type,
      photoDataUrls: req.body?.photoDataUrls,
      samsaraUsername,
      samsaraDvirAuthorId: (await readDispatchSetup()).samsara?.dvirAuthorId || config.samsara.dvirAuthorId || ""
    });
    writeAudit({
      actorType: "driver",
      source: "samsara",
      action: type === "post" ? "driver.post_dvir.submitted" : "driver.pre_dvir.submitted",
      details: {
        driverLogin: req.driverLogin,
        samsaraUsername,
        truckPlate: result.state?.truckPlate || "",
        planDate: result.state?.planDate || "",
        samsaraError: result.samsaraError || ""
      }
    }).catch(() => {});
    emitAppEvent("driver.dvir.submitted", {
      driverLogin: req.driverLogin,
      type,
      truckPlate: result.state?.truckPlate || "",
      samsaraError: result.samsaraError || ""
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/dvir/skip", requireDriver, async (req, res, next) => {
  try {
    const type = req.body?.type === "post" ? "post" : "pre";
    const result = await skipDriverDvirForTesting(req.driverLogin, {
      type,
      samsaraUsername: samsaraUsernameForDriver(req.driver, "primary")
    });
    writeAudit({
      actorType: "driver",
      source: "driver-pwa",
      action: type === "post" ? "driver.post_dvir.skipped_for_testing" : "driver.pre_dvir.skipped_for_testing",
      details: {
        driverLogin: req.driverLogin,
        truckPlate: result.state?.truckPlate || "",
        planDate: result.state?.planDate || ""
      }
    }).catch(() => {});
    emitAppEvent("driver.dvir.skipped_for_testing", {
      driverLogin: req.driverLogin,
      type,
      truckPlate: result.state?.truckPlate || ""
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/samsara-auth-token", requireDriver, async (req, res, next) => {
  try {
    const account = req.body?.account === "secondary" ? "secondary" : "primary";
    const username = samsaraUsernameForDriver(req.driver, account);
    if (!username) return res.status(400).json({ error: `No Samsara ${account} login ID is saved for your driver profile.` });
    const result = await createSamsaraDriverAuthToken({ username });
    res.json({
      username,
      account,
      ...publicSamsaraAuthResult(result, { includeSecret: true })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/samsara-duty-status", requireDriver, async (req, res, next) => {
  try {
    const account = req.body?.account === "secondary" ? "secondary" : "primary";
    const username = samsaraUsernameForDriver(req.driver, account);
    if (!username) return res.status(400).json({ error: `No Samsara ${account} username is saved for your driver profile.` });
    const dutyStatus = req.body?.dutyStatus === "OFF_DUTY" ? "OFF_DUTY" : "ON_DUTY";
    const vehiclePlate = String(req.body?.vehiclePlate || "").trim();
    let assignment = null;
    if (dutyStatus === "ON_DUTY" && vehiclePlate) {
      assignment = await createSamsaraDriverVehicleAssignment({
        username,
        vehiclePlate
      });
    }
    const result = await setSamsaraDriverDutyStatus({
      username,
      dutyStatus,
      location: req.body?.location || "",
      remark: req.body?.remark || `Changed from MBBS Driver PWA${vehiclePlate ? ` with ${vehiclePlate}` : ""}`
    });
    writeAudit({
      actorType: "driver",
      source: "samsara",
      action: "samsara.duty_status.requested",
      details: {
        driverLogin: req.driverLogin,
        samsaraUsername: username,
        samsaraDriverId: result.driver.id,
        dutyStatus,
        vehiclePlate,
        assignmentResponseStatus: assignment?.responseStatus || null,
        assignmentVehicleId: assignment?.vehicle?.id || null,
        responseStatus: result.responseStatus,
        verificationError: result.clockError || "",
        currentHosClock: result.clock || null
      }
    }).catch(() => {});
    emitAppEvent("driver.samsara.duty_status", {
      driverLogin: req.driverLogin,
      samsaraUsername: username,
      samsaraDriverId: result.driver.id,
      dutyStatus
    });
    res.json({
      ok: true,
      account,
      username,
      dutyStatus,
      vehiclePlate,
      assignment: assignment ? {
        responseStatus: assignment.responseStatus,
        vehicle: {
          id: assignment.vehicle.id,
          name: assignment.vehicle.name || "",
          licensePlate: assignment.vehicle.licensePlate || vehiclePlate
        }
      } : null,
      responseStatus: result.responseStatus,
      currentHosClock: result.clock,
      verificationError: result.clockError,
      samsaraDriver: {
        id: result.driver.id,
        name: result.driver.name || "",
        username: result.driver.username || username
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/driver-job-statuses", async (req, res, next) => {
  try {
    res.json(await listDriverJobStatuses({
      planId: req.query.planId || null,
      planDate: req.query.planDate || null
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/driver/next-job", requireDriver, async (req, res, next) => {
  try {
    const state = await getDriverDayState(req.driverLogin, {
      samsaraUsername: samsaraUsernameForDriver(req.driver, "primary")
    });
    if (state.truckPlate && (state.preDvirStatus !== "complete" || !state.samsaraOnDutyConfirmed || !state.samsaraPreDvirConfirmed)) {
      const suffix = state.preDvirStatus === "complete"
        ? " Samsara DVIR and On Duty confirmation are required."
        : "";
      return res.status(428).json({ error: `MBBS pre-trip inspection must be received by Samsara before assigned jobs.${suffix}`, state });
    }
    res.json({ job: await getNextDriverJob(req.driverLogin) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/start", requireDriver, async (req, res, next) => {
  try {
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    const record = await startDriverJob(req.driverLogin, req.params.jobId, { job });
    emitAppEvent("driver.job.started", { driverLogin: req.driverLogin, jobId: req.params.jobId, stopType: job.stopType, orderRefs: job.orderRefs || [] });
    res.json({ record, job: await getNextDriverJob(req.driverLogin) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/location-check", requireDriver, async (req, res, next) => {
  try {
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    res.json(await checkDriverJobLocation(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/photos", requireDriver, async (req, res, next) => {
  try {
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    if (job.status !== "in_progress" || !job.startedAt) return res.status(409).json({ error: "Start this job before confirming it." });
    const secondsSinceStart = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
    if (!Number.isFinite(secondsSinceStart) || secondsSinceStart < 10) {
      return res.status(409).json({ error: "Please wait 10 seconds after starting the job before confirming it." });
    }
    const locationCheck = await checkDriverJobLocation(job);
    if (locationCheck.status !== "ok" && !req.body?.locationOverride) {
      return res.status(409).json({
        error: locationCheck.status === "warning"
          ? "Samsara truck location does not match the expected stop. Recheck or confirm override."
          : "Samsara truck location could not be verified. Recheck or confirm override.",
        locationCheck
      });
    }
    const record = await recordDriverJobPhotos(req.driverLogin, req.params.jobId, {
      photoDataUrls: req.body?.photoDataUrls,
      job
    });
    const nextJob = await getNextDriverJob(req.driverLogin);
    emitAppEvent("driver.job.completed", { driverLogin: req.driverLogin, jobId: req.params.jobId, stopType: job.stopType, nextJobId: nextJob?.jobId || null });
    res.json({ record, nextJob, locationCheck });
  } catch (error) {
    next(error);
  }
});

app.get("/api/operators", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listOperators());
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await createOperator({
      username: req.body?.username,
      displayName: req.body?.displayName,
      password: req.body?.password,
      role: req.body?.role || "operator"
    });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.create",
      details: { operatorId: operator.id, username: operator.username, role: operator.role }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators/:id/active", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await setOperatorActive(req.params.id, req.body?.active);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.set_active",
      details: { operatorId: req.params.id, active: Boolean(req.body?.active) }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

app.post("/api/operators/:id/password", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const operator = await updateOperatorPassword(req.params.id, req.body?.password);
    if (!operator) return res.status(404).json({ error: "Operator not found" });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "operator.password_reset",
      details: { operatorId: req.params.id, username: operator.username }
    });
    res.json(operator);
  } catch (error) {
    next(error);
  }
});

async function listOperatorOrderLocks() {
  const result = await query(
    `WITH lock_source AS (
       SELECT 'sales_order'::text AS order_type,
              o.netsuite_id,
              o.tranid,
              o.operator_status AS operator_status,
              o.local_yard_order_status,
              o.outbound_location,
              o.preparing_operator_id,
              o.preparing_started_at,
              op.username,
              op.display_name,
              (
                SELECT COUNT(*)::int
                  FROM sales_order_lines l
                 WHERE l.sales_order_id = o.netsuite_id
                   AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                   AND (
                     COALESCE(l.packed_pallet_qty, 0) > 0
                     OR COALESCE(l.packed_layer_qty, 0) > 0
                     OR COALESCE(l.packed_section_qty, 0) > 0
                     OR COALESCE(l.packed_piece_qty, 0) > 0
                   )
              ) AS draft_line_count
         FROM sales_orders o
         LEFT JOIN operators op ON op.id::text = o.preparing_operator_id::text
        WHERE o.preparing_operator_id IS NOT NULL
       UNION ALL
       SELECT 'transfer_order'::text AS order_type,
              o.netsuite_id,
              o.tranid,
              o.outbound_operator_status AS operator_status,
              o.local_yard_order_status,
              o.from_location AS outbound_location,
              o.preparing_operator_id,
              o.preparing_started_at,
              op.username,
              op.display_name,
              (
                SELECT COUNT(*)::int
                  FROM transfer_order_lines l
                 WHERE l.transfer_order_id = o.netsuite_id
                   AND l.line_stage = 'outbound'
                   AND COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')
                   AND (
                     COALESCE(l.packed_pallet_qty, 0) > 0
                     OR COALESCE(l.packed_layer_qty, 0) > 0
                     OR COALESCE(l.packed_section_qty, 0) > 0
                     OR COALESCE(l.packed_piece_qty, 0) > 0
                   )
              ) AS draft_line_count
         FROM transfer_orders o
         LEFT JOIN operators op ON op.id::text = o.preparing_operator_id::text
        WHERE o.preparing_operator_id IS NOT NULL
     )
     SELECT *
       FROM lock_source
      ORDER BY preparing_started_at DESC NULLS LAST, tranid`
  );
  return result.rows;
}

async function releaseOperatorOrderLock({ orderType, orderId, actorOperatorId }) {
  const isTransfer = orderType === "transfer_order";
  const targetTable = isTransfer ? "transfer_orders" : "sales_orders";
  const result = await query(
    `UPDATE ${targetTable}
        SET preparing_operator_id = null,
            preparing_started_at = null,
            status_updated_at = now()
      WHERE netsuite_id = $1
        AND preparing_operator_id IS NOT NULL
      RETURNING netsuite_id, tranid`,
    [orderId]
  );
  if (!result.rowCount) return null;
  await writeAudit({
    actorOperatorId,
    source: "control",
    action: "operator.order_lock.release",
    orderId,
    details: {
      orderType: isTransfer ? "transfer_order" : "sales_order",
      tranid: result.rows[0].tranid
    }
  });
  emitAppEvent("delivery.order.updated", { orderId, source: "control-lock-release" });
  return result.rows[0];
}

app.get("/api/control/order-locks", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listOperatorOrderLocks());
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/order-locks/release", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const releaseAll = Boolean(req.body?.all);
    const locks = releaseAll
      ? await listOperatorOrderLocks()
      : [{
          order_type: req.body?.orderType === "transfer_order" ? "transfer_order" : "sales_order",
          netsuite_id: req.body?.orderId
        }];
    const released = [];
    for (const lock of locks) {
      if (!lock.netsuite_id) continue;
      const row = await releaseOperatorOrderLock({
        orderType: lock.order_type,
        orderId: lock.netsuite_id,
        actorOperatorId: req.operator.id
      });
      if (row) released.push({ ...row, order_type: lock.order_type });
    }
    res.json({ released, locks: await listOperatorOrderLocks() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/loaded-orders", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listControlLoadedOrders({
      from: req.query.from,
      to: req.query.to,
      yard: req.query.yard,
      search: req.query.search
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/loaded-orders/detail", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const detail = await getControlLoadedOrderDetail({
      orderType: req.query.orderType,
      orderId: req.query.orderId,
      from: req.query.from,
      to: req.query.to
    });
    if (!detail) return res.status(404).json({ error: "Loaded order not found." });
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/loaded-orders/export.csv", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const rows = await listControlLoadedOrderCsvRows({
      from: req.query.from,
      to: req.query.to,
      yard: req.query.yard,
      search: req.query.search
    });
    const csv = [
      ["order", "item Name", "sales quantity", "sales UOM", "location"].map(csvCell).join(","),
      ...rows.map((row) => [
        row.order_ref,
        row.item_name,
        row.loaded_qty,
        row.loaded_uom,
        row.location
      ].map(csvCell).join(","))
    ].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="loaded-orders-${req.query.from || "from"}-${req.query.to || "to"}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/sync-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const setup = await readDispatchSetup();
    res.json(setup.sync);
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/env-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listEnvFiles());
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/env-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (syncRunning || activeSyncRun) return res.status(409).json({ error: "Stop the current sync before switching env file." });
    const settings = await selectEnvFile(req.body?.envFile, { applyNow: Boolean(req.body?.applyNow) });
    if (settings.appliedNow && settings.previousActiveEnvFile !== settings.activeEnvFile) {
      await pool.query("DELETE FROM netsuite_tokens");
    }
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "env.file_select",
      details: {
        activeEnvFile: settings.activeEnvFile,
        selectedEnvFile: settings.selectedEnvFile,
        restartRequired: settings.restartRequired,
        appliedNow: settings.appliedNow,
        applyError: settings.applyError || ""
      }
    });
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/sync-settings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const mode = req.body?.mode === "auto" ? "auto" : "manual";
    const syncPatch = { mode };
    if (Object.hasOwn(req.body || {}, "maxRunSeconds")) {
      syncPatch.maxRunSeconds = req.body.maxRunSeconds;
    }
    const setup = await writeDispatchSetup({ sync: syncPatch });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "sync.mode_update",
      details: syncPatch
    });
    emitAppEvent("dispatch.sync.settings.updated", { mode });
    res.json(setup.sync);
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/sync-now", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (syncRunning || activeSyncRun) {
      return res.status(202).json({
        started: false,
        skipped: true,
        reason: "sync_running",
        settings: (await readDispatchSetup()).sync
      });
    }
    const startedAt = new Date().toISOString();
    const runner = runDispatchSync({ source: "control_manual", actorOperatorId: req.operator.id });
    runner.catch((error) => {
      console.error("Background NetSuite sync failed:", error);
    });
    res.status(202).json({
      started: true,
      background: true,
      message: "Sync started.",
      settings: {
        ...(await readDispatchSetup()).sync,
        running: true,
        lastStartedAt: startedAt,
        lastSource: "control_manual",
        lastStatus: "running",
        lastError: ""
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/sync-stop", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const settings = await stopDispatchSync({ actorOperatorId: req.operator.id });
    emitAppEvent("dispatch.sync.settings.updated", { mode: settings.mode, status: settings.lastStatus });
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/order-data/clear", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    if (req.body?.confirmText !== "CLEAR ORDERS") {
      return res.status(400).json({ error: "Type CLEAR ORDERS to clear operational order data." });
    }
    const result = await clearOperationalOrderData({ actorOperatorId: req.operator.id });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/audit", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listAudit({
      limit: req.query.limit,
      orderId: req.query.orderId,
      operatorId: req.query.operatorId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/fulfillments", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listDeliveryFulfillments({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/operator/history", requireOperator, async (req, res, next) => {
  try {
    res.json(await listOperatorHistory({
      operatorId: req.operator.id,
      date: req.query.date || "",
      limit: req.query.limit || 100
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/operator/requests", requireOperator, async (req, res, next) => {
  try {
    res.json(await listDispatchOperatorRequests({
      status: req.query.status || "open",
      locationId: req.query.locationId || null,
      orderType: req.query.orderType || null
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/operator/history/report-error", requireOperator, async (req, res, next) => {
  try {
    res.json(await reportOperatorRecordError({
      operatorId: req.operator.id,
      recordId: req.body?.recordId,
      reason: req.body?.reason
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/control/record-warnings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listRecordWarnings({
      status: req.query.status || "",
      limit: req.query.limit || 100
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/record-warnings/:id/resolve", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await resolveRecordWarning({
      warningId: req.params.id,
      handledBy: req.operator.id,
      resolution: req.body?.resolution
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/netsuite/start", (req, res, next) => {
  try {
    const { url } = buildAuthorizationUrl();
    res.redirect(url);
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/netsuite/callback", async (req, res, next) => {
  try {
    if (req.query.error) {
      return res.status(400).send(`NetSuite authorization failed: ${req.query.error}`);
    }
    await exchangeCodeForToken(req.query.code);
    res.send("NetSuite connected. You can close this tab and return to the yard app.");
  } catch (error) {
    next(error);
  }
});

app.use("/api/delivery", requireOperator);
app.use("/api/customer-pickup", requireOperator);
app.use("/api/receiving", requireOperator);
app.use("/api/inventory", requireOperator);
app.use("/api/cycle-count", requireOperator);

app.post("/api/customer-pickup/lookup", async (req, res, next) => {
  try {
    const code = String(req.body?.code || "").trim();
    const locationId = Number(req.body?.locationId || req.query.locationId || 0) || null;
    if (!code) return res.status(400).json({ error: "Scan or enter a sales order number." });
    let orderId = await findCustomerPickupOrder(code, { locationId });
    if (!orderId) {
      const order = await fetchCustomerPickupOrderFromNetSuite(code, locationId);
      if (!order) return res.status(404).json({ error: "Pickup sales order not found for this location." });
      if (isPendingApprovalStatus(order.status, order.status_text)) {
        return res.status(409).json({ error: "This pickup sales order is still pending approval in NetSuite." });
      }
      await upsertSalesOrders([order]);
      const lines = await fetchDeliveryOrderDetailsFromNetSuite(order.id, locationId);
      await upsertSalesOrderLines(order.id, lines);
      await markMissingOutboundOrderLines(order.id, lines.map((line) => line.line_id));
      orderId = order.id;
    }
    const detail = await getDeliveryOrder(orderId);
    if (!detail || !isPickupDeliveryMethod(detail.delivery_method)) {
      return res.status(409).json({ error: "This sales order is not a customer pickup order." });
    }
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "customer_pickup",
      action: "customer_pickup.order.lookup",
      orderId,
      details: { code, locationId }
    });
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer-pickup/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    await confirmCustomerPickupLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("delivery.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, source: "customer-pickup", operatorId: operatorId(req) });
    res.json(await getDeliveryOrder(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer-pickup/orders/:id/clear-draft", async (req, res, next) => {
  try {
    const order = await clearCustomerPickupDraft(req.params.id, operatorId(req));
    emitAppEvent("delivery.line.updated", { orderId: req.params.id, source: "customer-pickup-clear", operatorId: operatorId(req) });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/customer-pickup/orders/:id/load", async (req, res, next) => {
  try {
    const result = await recordCustomerPickupLoad(req.params.id, operatorId(req), {
      photoDataUrl: req.body?.photoDataUrl
    });
    emitAppEvent("delivery.order.loaded", { orderId: req.params.id, source: "customer-pickup", operatorId: operatorId(req), result });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/sync", async (req, res, next) => {
  try {
    const locationId = Number(req.body?.locationId || req.query.locationId || 1);
    const orderType = normalizeOrderType(req.body?.orderType || req.query.orderType);
    const orders = await listDeliveryOrders({
      locationId,
      status: req.body?.status || req.query.status || null,
      orderType
    });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "delivery",
      action: "operator.local_order_refresh",
      details: { locationId, orderType, count: orders.length }
    });
    res.json({ localOnly: true, orders });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/sync", async (req, res, next) => {
  try {
    const orderType = normalizeOrderType(req.body?.orderType || req.query.orderType);
    const order = await getDeliveryOrder(req.params.id);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "delivery",
      action: "operator.local_order_detail_refresh",
      orderId: req.params.id,
      details: { orderType, found: Boolean(order), lines: order?.lines?.length || 0 }
    });
    res.json({ localOnly: true, order: Boolean(order), synced: 0, lines: order?.lines?.length || 0 });
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/orders", async (req, res, next) => {
  try {
    res.json(await listDeliveryOrders({
      locationId: req.query.locationId,
      status: req.query.status,
      orderType: normalizeOrderType(req.query.orderType)
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/notifications", async (req, res, next) => {
  try {
    res.json(await getDeliveryPrepNotifications({
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/orders/:id", async (req, res, next) => {
  try {
    const order = await getDeliveryOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Delivery order not found" });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/sync", async (req, res, next) => {
  try {
    const orderType = req.body?.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "receiving",
      action: "operator.receiving_local_refresh",
      details: {
        orderType: req.body?.orderType === "co_order" ? "co_order" : orderType,
        sourceLocationId: req.body?.sourceLocationId || null,
        destinationLocationId: req.body?.destinationLocationId || req.body?.locationId || null
      }
    });
    res.json({ localOnly: true, synced: 0 });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/vendors", async (req, res, next) => {
  try {
    res.json(await listReceivingVendors({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/sources", async (req, res, next) => {
  try {
    if (req.query.orderType === "co_order") {
      return res.json(await listLocalCoSources({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
    }
    res.json(await listReceivingSources({ destinationLocationId: req.query.destinationLocationId || req.query.locationId || null }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/orders", async (req, res, next) => {
  try {
    if (req.query.orderType === "co_order") {
      return res.json(await listLocalCoReceivingOrders({
        sourceLocationId: req.query.sourceLocationId || null,
        destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
        search: req.query.search || null,
        itemSearch: req.query.itemSearch || null
      }));
    }
    const orderType = req.query.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    res.json(await listReceivingOrders({
      orderType,
      vendor: req.query.vendor || null,
      sourceLocationId: req.query.sourceLocationId || null,
      destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
      search: req.query.search || null,
      itemSearch: req.query.itemSearch || null
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/items", async (req, res, next) => {
  try {
    if (req.query.orderType === "co_order") {
      return res.json(await searchLocalCoItems({
        sourceLocationId: req.query.sourceLocationId || null,
        destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
        search: req.query.search || ""
      }));
    }
    const orderType = req.query.orderType === "transfer_order" ? "transfer_order" : "purchase_order";
    res.json(await searchReceivingItems({
      orderType,
      vendor: req.query.vendor || null,
      sourceLocationId: req.query.sourceLocationId || null,
      destinationLocationId: req.query.destinationLocationId || req.query.locationId || null,
      search: req.query.search || ""
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/sync", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || req.query.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
      return res.json({ localOnly: true, synced: { order: true, orderType: "co_order", lines: 0 } });
    }
    const order = await getReceivingOrder(req.params.id);
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "receiving",
      action: "operator.receiving_order_local_refresh",
      details: { receivingOrderId: req.params.id, found: Boolean(order), lines: order?.lines?.length || 0 }
    });
    res.json({ localOnly: true, synced: { order: Boolean(order), lines: order?.lines?.length || 0 } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/orders/:id", async (req, res, next) => {
  try {
    if (String(req.params.id).startsWith("CO-") || Number(req.params.id) < 0) {
      const localOrder = await getLocalCoReceivingOrder(req.params.id);
      if (!localOrder) return res.status(404).json({ error: "Local CO not found" });
      return res.json(localOrder);
    }
    const order = await getReceivingOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Receiving order not found" });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-") || Number(req.params.id) < 0) {
      const result = await confirmLocalCoReceivingLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
      emitAppEvent("receiving.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: "co_order", operatorId: operatorId(req) });
      return res.json(result);
    }
    const result = await confirmReceivingLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("receiving.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: req.body?.orderType || null, operatorId: operatorId(req) });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/receive", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-") || Number(req.params.id) < 0) {
      const result = await receiveLocalCoOrder(req.params.id, operatorId(req), {
        photoDataUrls: req.body?.photoDataUrls
      });
      emitAppEvent("receiving.order.received", { orderId: req.params.id, orderType: "co_order", operatorId: operatorId(req) });
      emitAppEvent("delivery.order.updated", { orderId: result.deliveryOrderId, coOrderId: req.params.id, orderType: "co_order", source: "co-received" });
      emitAppEvent("dispatch.orders.updated", { orderId: result.deliveryOrderId, coOrderId: req.params.id, source: "co-received" });
      return res.json({ jobId: null, status: "complete", result });
    }
    const jobId = crypto.randomUUID();
    receivingJobs.set(jobId, {
      id: jobId,
      status: "running",
      orderId: req.params.id,
      stage: "queued",
      message: "Receiving request received.",
      startedAt: new Date().toISOString()
    });
    res.json({ jobId, status: "running" });
    Promise.resolve().then(async () => {
      const result = await runReceivingReceipt(req.params.id, req.body || {}, operatorId(req), jobId);
      updateReceivingJob(jobId, {
        status: "complete",
        stage: "complete",
        message: result.itemReceiptTranid ? `Created ${result.itemReceiptTranid}.` : "Item Receipt created.",
        result,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("receiving.order.received", { orderId: req.params.id, orderType: req.body?.orderType || null, operatorId: operatorId(req), jobId, itemReceiptTranid: result.itemReceiptTranid || null });
    }).catch(async (error) => {
      const job = receivingJobs.get(jobId);
      await recordReceivingReceiptFailure(req.params.id, operatorId(req), {
        photoDataUrls: req.body?.photoDataUrls,
        payload: job?.payload,
        error,
        stage: job?.stage
      });
      updateReceivingJob(jobId, {
        status: "error",
        stage: "error",
        message: error.message,
        error: error.message,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("receiving.order.receive_failed", { orderId: req.params.id, operatorId: operatorId(req), jobId, error: error.message });
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/receiving/receipt-jobs/:jobId", async (req, res, next) => {
  try {
    const job = receivingJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Receiving job not found" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/prepared", async (req, res, next) => {
  try {
    await markDeliveryPrepared(req.params.id, req.body || {});
    emitAppEvent("delivery.order.updated", { orderId: req.params.id, change: "prepared" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/status", async (req, res, next) => {
  try {
    await updateDeliveryStatus(req.params.id, req.body?.status, operatorId(req));
    emitAppEvent("delivery.order.updated", { orderId: req.params.id, status: req.body?.status, operatorId: operatorId(req) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    await confirmDeliveryLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("delivery.line.confirmed", { orderId: req.params.id, lineId: req.params.lineId, operatorId: operatorId(req) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/packed-quantity", async (req, res, next) => {
  try {
    await setDeliveryLinePackedQuantity(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    emitAppEvent("delivery.line.updated", { orderId: req.params.id, lineId: req.params.lineId, change: "packed_quantity", operatorId: operatorId(req) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/lines/:lineId/unpack", async (req, res, next) => {
  try {
    await unpackDeliveryLine(req.params.id, req.params.lineId, req.body || {}, operatorId(req));
    const resolvedRequests = await resolveDispatchOperatorRequestsForOrder(req.params.id, operatorId(req)).catch(() => []);
    emitAppEvent("delivery.order.unpacked", { orderId: req.params.id, lineId: req.params.lineId, operatorId: operatorId(req), resolvedRequestIds: resolvedRequests.map((request) => request.id) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/unpack", async (req, res, next) => {
  try {
    await unpackDeliveryOrder(req.params.id, operatorId(req));
    const resolvedRequests = await resolveDispatchOperatorRequestsForOrder(req.params.id, operatorId(req)).catch(() => []);
    emitAppEvent("delivery.order.unpacked", { orderId: req.params.id, operatorId: operatorId(req), resolvedRequestIds: resolvedRequests.map((request) => request.id) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/fulfill", async (req, res, next) => {
  try {
    const jobId = crypto.randomUUID();
    fulfillmentJobs.set(jobId, {
      id: jobId,
      status: "running",
      orderId: req.params.id,
      stage: "queued",
      message: "Fulfillment request received.",
      startedAt: new Date().toISOString()
    });
    res.json({ jobId, status: "running" });
    Promise.resolve().then(async () => {
      const result = await runDeliveryFulfillment(req.params.id, req.body || {}, operatorId(req), jobId);
      updateFulfillmentJob(jobId, {
        status: "complete",
        stage: "complete",
        message: result.itemFulfillmentTranid ? `Created ${result.itemFulfillmentTranid}.` : "Item Fulfillment created.",
        result,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("delivery.order.fulfilled", { orderId: req.params.id, operatorId: operatorId(req), jobId, itemFulfillmentTranid: result.itemFulfillmentTranid || null });
    }).catch(async (error) => {
      const job = fulfillmentJobs.get(jobId);
      await recordDeliveryFulfillmentFailure(req.params.id, operatorId(req), {
        photoDataUrl: req.body?.photoDataUrl,
        payload: job?.payload,
        error,
        stage: job?.stage
      });
      updateFulfillmentJob(jobId, {
        status: "error",
        stage: "error",
        message: error.message,
        error: error.message,
        completedAt: new Date().toISOString()
      });
      emitAppEvent("delivery.order.fulfill_failed", { orderId: req.params.id, operatorId: operatorId(req), jobId, error: error.message });
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/orders/:id/load", async (req, res, next) => {
  try {
    const result = await recordDeliveryLoad(req.params.id, operatorId(req), {
      photoDataUrl: req.body?.photoDataUrl
    });
    emitAppEvent("delivery.order.loaded", { orderId: req.params.id, operatorId: operatorId(req), resultId: result?.id || null });
    if (Array.isArray(result?.activatedCo) && result.activatedCo.length) {
      emitAppEvent("receiving.order.updated", { orderId: req.params.id, activatedCo: result.activatedCo, source: "delivery-load" });
      emitAppEvent("dispatch.co.updated", { orderId: req.params.id, activatedCo: result.activatedCo, source: "delivery-load" });
    }
    res.json(result);
  } catch (error) {
    if (error.code === "DELIVERY_LOAD_VALIDATION_FAILED") {
      return res.status(409).json({ error: error.message, validation: error.validation });
    }
    next(error);
  }
});

app.get("/api/delivery/fulfillment-jobs/:jobId", async (req, res, next) => {
  try {
    const job = fulfillmentJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Fulfillment job not found" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

async function runReceivingReceipt(orderId, body, currentOperatorId, jobId) {
  updateReceivingJob(jobId, { stage: "sync", message: "Checking latest received quantity from NetSuite." });
  await syncReceivingOrderDetails(orderId, {
    orderType: body?.orderType || null,
    locationId: body?.locationId || body?.destinationLocationId || null,
    sourceLocationId: body?.sourceLocationId || null
  });
  updateReceivingJob(jobId, { stage: "validating", message: "Checking confirmed receiving lines." });
  const order = await getReceivableReceivingOrder(orderId);
  updateReceivingJob(jobId, {
    stage: "payload",
    message: `Building item receipt for ${order.receivableLines.length} confirmed line(s).`
  });
  const payload = buildItemReceiptPayload(order, order.receivableLines);
  updateReceivingJob(jobId, {
    stage: "netsuite_post",
    message: "Posting Item Receipt to NetSuite.",
    payload,
    payloadSummary: {
      receiveLines: payload.item.items.filter((item) => item.itemReceive !== false).length,
      skipLines: payload.item.items.filter((item) => item.itemReceive === false).length
    }
  });
  const netSuiteResult = order.order_type === "transfer_order"
    ? await transformTransferOrderToItemReceipt(orderId, payload)
    : await transformPurchaseOrderToItemReceipt(orderId, payload);
  updateReceivingJob(jobId, {
    stage: "netsuite_read",
    message: "Reading IR number from NetSuite.",
    itemReceiptId: netSuiteResult.id
  });
  const receipt = netSuiteResult.id ? await fetchItemReceiptFromNetSuite(netSuiteResult.id) : null;
  const itemReceiptTranid = receipt?.tranId || receipt?.tranid || receipt?.id || null;
  updateReceivingJob(jobId, {
    stage: "recording",
    message: itemReceiptTranid ? `Recording ${itemReceiptTranid} locally.` : "Recording item receipt locally.",
    itemReceiptId: netSuiteResult.id,
    itemReceiptTranid
  });
  const record = await recordReceivingReceipt(orderId, currentOperatorId, {
    photoDataUrls: body?.photoDataUrls,
    payload,
    response: { netSuiteResult, receipt },
    itemReceiptId: netSuiteResult.id,
    itemReceiptTranid
  });
  updateReceivingJob(jobId, {
    stage: "sync_deferred",
    message: "Receipt recorded. Order sync is continuing in background.",
    itemReceiptId: record.itemReceiptId,
    itemReceiptTranid: record.itemReceiptTranid
  });
  Promise.resolve().then(async () => {
    await syncReceivingOrderDetails(orderId, {
      orderType: order.order_type,
      locationId: order.destination_location_id,
      sourceLocationId: order.source_location_id
    });
  }).catch((error) => {
    console.error("Receiving follow-up sync failed:", error.message);
  });
  return record;
}

async function runDeliveryFulfillment(orderId, body, currentOperatorId, jobId) {
    updateFulfillmentJob(jobId, { stage: "validating", message: "Checking packed lines." });
    let order;
    try {
      order = await getFulfillableDeliveryOrder(orderId);
    } catch (error) {
      if (!String(error.message).includes("No packed lines to fulfill.")) throw error;
      updateFulfillmentJob(jobId, {
        stage: "netsuite_check",
        message: "No local pack delta. Checking whether previous NetSuite IF still exists."
      });
      const currentOrder = await getDeliveryOrder(orderId);
      if (!currentOrder?.last_item_fulfillment_id) throw error;
      const existingFulfillment = await fetchItemFulfillmentFromNetSuite(currentOrder.last_item_fulfillment_id);
      if (existingFulfillment) {
        throw new Error(`Already fulfilled by ${existingFulfillment.tranId || existingFulfillment.tranid || currentOrder.last_item_fulfillment_tranid || currentOrder.last_item_fulfillment_id}.`);
      }
      updateFulfillmentJob(jobId, {
        stage: "resetting",
        message: "Previous IF is missing in NetSuite. Resetting local fulfilled qty for resend."
      });
      await resetDeliveryFulfillmentState(orderId, currentOperatorId, "netsuite_if_missing_before_resend");
      order = await getFulfillableDeliveryOrder(orderId);
    }
    updateFulfillmentJob(jobId, {
      stage: "payload",
      message: `Building payload for ${order.fulfillableLines.length} packed line(s).`
    });
    const payload = buildItemFulfillmentPayload(order, order.fulfillableLines);
    updateFulfillmentJob(jobId, {
      stage: "netsuite_post",
      message: "Posting Item Fulfillment to NetSuite.",
      payload,
      payloadSummary: {
        receiveLines: payload.item.items.filter((item) => item.itemReceive !== false && item.itemreceive !== false).length,
        skipLines: payload.item.items.filter((item) => item.itemReceive === false || item.itemreceive === false).length
      }
    });
    const netSuiteResult = order.order_type === "transfer_order"
      ? await transformTransferOrderToItemFulfillment(orderId, payload)
      : await transformSalesOrderToItemFulfillment(orderId, payload);
    updateFulfillmentJob(jobId, {
      stage: "netsuite_read",
      message: "Reading IF number from NetSuite.",
      itemFulfillmentId: netSuiteResult.id
    });
    const fulfillment = netSuiteResult.id ? await fetchItemFulfillmentFromNetSuite(netSuiteResult.id) : null;
    const itemFulfillmentTranid = fulfillment?.tranId || fulfillment?.tranid || fulfillment?.id || null;
    updateFulfillmentJob(jobId, {
      stage: "recording",
      message: itemFulfillmentTranid ? `Recording ${itemFulfillmentTranid} locally.` : "Recording fulfillment locally.",
      itemFulfillmentId: netSuiteResult.id,
      itemFulfillmentTranid
    });
    const record = await recordDeliveryFulfillment(orderId, currentOperatorId, {
      photoDataUrl: body?.photoDataUrl,
      payload,
      response: { netSuiteResult, fulfillment },
      itemFulfillmentId: netSuiteResult.id,
      itemFulfillmentTranid
    });
    const locationId = order.outbound_location_id || body?.locationId;
    updateFulfillmentJob(jobId, {
      stage: "sync_deferred",
      message: "Fulfillment recorded. Order sync is continuing in background.",
      itemFulfillmentId: record.itemFulfillmentId,
      itemFulfillmentTranid: record.itemFulfillmentTranid
    });
    Promise.resolve().then(async () => {
      const syncedOrder = order.order_type === "transfer_order"
        ? await fetchTransferDeliveryOrderFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderFromNetSuite(orderId, locationId);
      if (syncedOrder) {
        if (order.order_type === "transfer_order") await upsertOutboundTransferOrders([syncedOrder]);
        else await upsertSalesOrders([syncedOrder]);
      } else await markOutboundOrderMissing(orderId, { orderFamily: order.order_type });
      const syncedLines = order.order_type === "transfer_order"
        ? await fetchTransferOrderDetailsFromNetSuite(orderId, locationId)
        : await fetchDeliveryOrderDetailsFromNetSuite(orderId, locationId);
      if (order.order_type === "transfer_order") await upsertOutboundTransferOrderLines(orderId, syncedLines);
      else await upsertSalesOrderLines(orderId, syncedLines);
      await markMissingOutboundOrderLines(orderId, syncedLines.map((line) => line.line_id));
    }).catch((error) => {
      console.error("Delivery fulfillment follow-up sync failed:", error.message);
    });
    return record;
}

app.post("/api/inventory/sync", async (req, res, next) => {
  try {
    const locationIds = req.body?.locationIds || deliveryLocations;
    const rows = await fetchInventoryBalancesFromNetSuite(locationIds);
    const synced = await upsertInventoryBalances(rows);
    const classified = await applyInventoryClassificationRules();
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "inventory",
      action: "inventory.manual_sync",
      details: { locationIds, rows: rows.length, synced, classified }
    });
    res.json({ synced, classified });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/facets", async (req, res, next) => {
  try {
    res.json(await listInventoryFacets({
      locationId: req.query.locationId,
      productType: req.query.productType,
      brand: req.query.brand
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/items", async (req, res, next) => {
  try {
    res.json(await listInventoryItems({
      locationId: req.query.locationId,
      productType: req.query.productType,
      brand: req.query.brand,
      series: req.query.series,
      search: req.query.search
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/classifications", requireAdmin, async (req, res, next) => {
  try {
    res.json(await listInventoryClassifications({
      search: req.query.search,
      limit: req.query.limit
    }));
  } catch (error) {
    next(error);
  }
});

app.put("/api/inventory/classifications/:itemId", requireAdmin, async (req, res, next) => {
  try {
    res.json(await updateInventoryClassification(req.operator.id, req.params.itemId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/cycle-count/draft", async (req, res, next) => {
  try {
    res.json(await getCycleCountDraft(req.operator.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/cycle-count/records", requireAdmin, async (req, res, next) => {
  try {
    res.json(await listCycleCountRecords({ limit: req.query.limit }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cycle-count/lines", async (req, res, next) => {
  try {
    const locationId = Number(req.body?.locationId);
    const itemId = Number(req.body?.itemId);
    if (Number.isInteger(locationId) && locationId > 0 && Number.isInteger(itemId) && itemId > 0) {
      const syncPromise = fetchInventoryBalanceForItemFromNetSuite(itemId, locationId)
        .then(async (rows) => {
          const synced = await upsertInventoryBalances(rows);
          const classified = await applyInventoryClassificationRules();
          await writeAudit({
            actorOperatorId: req.operator.id,
            source: "cycle_count",
            action: "cycle_count.confirm_line_inventory_sync",
            details: { itemId, locationId, rows: rows.length, synced, classified, mode: "before_confirm" }
          });
          return rows;
        })
        .catch(async (error) => {
          await writeAudit({
            actorOperatorId: req.operator.id,
            source: "cycle_count",
            action: "cycle_count.confirm_line_inventory_sync_failed",
            details: { itemId, locationId, error: error.message }
          });
          return [];
        });
      const syncResult = await withTimeout(syncPromise, 2500);
      if (syncResult.timedOut) {
        syncPromise.catch(() => {});
        await writeAudit({
          actorOperatorId: req.operator.id,
          source: "cycle_count",
          action: "cycle_count.confirm_line_inventory_sync_deferred",
          details: { itemId, locationId, timeoutMs: 2500 }
        });
      }
    }
    res.json(await confirmCycleCountLine(req.operator.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cycle-count/submit", async (req, res, next) => {
  try {
    res.json(await submitCycleCount(req.operator.id));
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message });
});

export { app };

export async function startServer() {
  await recoverInterruptedSyncState();
  return app.listen(config.port, () => {
  console.log(`MBBS Yard Server listening on ${config.appBaseUrl}`);
  autoSyncTick();
  setInterval(autoSyncTick, 60000);
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await startServer();
}
