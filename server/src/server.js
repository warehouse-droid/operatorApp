import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config, listEnvFiles, selectEnvFile } from "./config.js";
import { beginRollbackContext, pool, query, withTransaction } from "./db.js";
import { buildAuthorizationUrl, exchangeCodeForToken, fetchDeliveryOrdersFromNetSuite, fetchDeliveryOrderFromNetSuite, fetchCustomerPickupOrderFromNetSuite, fetchDeliveryOrderDetailsFromNetSuite, fetchTransferDeliveryOrdersFromNetSuite, fetchTransferDeliveryOrderFromNetSuite, fetchTransferOrderDetailsFromNetSuite, fetchPurchaseOrdersFromNetSuite, fetchPurchaseOrderFromNetSuite, fetchPurchaseOrderDetailsFromNetSuite, fetchTransferReceivingOrdersFromNetSuite, fetchTransferReceivingOrderFromNetSuite, fetchInventoryBalanceForItemFromNetSuite, fetchInventoryBalancesFromNetSuite, fetchItemFulfillmentFromNetSuite, fetchItemReceiptFromNetSuite, fetchTransactionProgressFromNetSuite, fetchTransactionStatusFromNetSuite, transformSalesOrderToItemFulfillment, transformTransferOrderToItemFulfillment, transformPurchaseOrderToItemReceipt, transformTransferOrderToItemReceipt } from "./netsuite.js";
import { listDeliveryOrders, getDeliveryOrder, getFulfillableDeliveryOrder, buildItemFulfillmentPayload, markDeliveryPrepared, updateDeliveryStatus, confirmDeliveryLine, confirmDeliveryLines, setDeliveryLinePackedQuantity, unpackDeliveryLine, unpackDeliveryOrder, recordDeliveryFulfillment, recordDeliveryFulfillmentFailure, recordDeliveryLoad, listDeliveryFulfillments, listControlLoadedOrders, getControlLoadedOrderDetail, listControlLoadedOrderCsvRows, getDeliveryPrepNotifications, resetDeliveryFulfillmentState, applyConfirmedDispatchPlanToDelivery, deactivateUnplannedDispatchSplitOrders, getNextDispatchSplitSuffix, getCurrentOperatorDeliveryDraft, releaseCurrentDeliveryDraft, listSavedDeliveryOrdersForOperator, listSavedDeliveryOrderKeysForOperator, saveDeliveryOrderForOperator, removeSavedDeliveryOrderForOperator, listDeliveryLoadTrucks, listDeliveryLoadOrders } from "./delivery-repository.js";
import { clearCustomerPickupDraft, confirmCustomerPickupLine, findCustomerPickupOrder, isPendingApprovalStatus, isPickupDeliveryMethod, recordCustomerPickupLoad } from "./customer-pickup-repository.js";
import { createOperator, getOperatorByToken, hasOperators, listAudit, listAuditOptions, listOperators, loginOperator, logoutToken, setOperatorActive, updateOperatorPassword, writeAudit } from "./auth-repository.js";
import { applyInventoryClassificationRules, confirmCycleCountLine, getCycleCountDraft, listCycleCountRecords, listInventoryClassifications, listInventoryFacets, listInventoryItems, submitCycleCount, updateInventoryClassification, upsertInventoryBalances } from "./inventory-repository.js";
import { listReceivingVendors, listReceivingSources, listReceivingOrders, getReceivingOrder, searchReceivingItems, confirmReceivingLine, unconfirmReceivingLine, getReceivableReceivingOrder, buildItemReceiptPayload, recordReceivingReceipt, recordReceivingReceiptFailure, listReceivingReceipts, listLocalCoSources, listLocalCoReceivingOrders, searchLocalCoItems, getLocalCoReceivingOrder, confirmLocalCoReceivingLine, unconfirmLocalCoReceivingLine, receiveLocalCoOrder } from "./receiving-repository.js";
import { listExistingInboundOrderIds, listExistingOutboundOrderIds, markMissingInboundOrderLines, markMissingInboundOrders, markMissingOutboundOrderLines, markOutboundOrderMissing, updatePurchaseOrderNetSuiteStatus, updateSalesOrderNetSuiteStatus, upsertInboundTransferOrderLines, upsertInboundTransferOrders, upsertOutboundTransferOrderLines, upsertOutboundTransferOrders, upsertPurchaseOrderLines, upsertPurchaseOrders, upsertSalesOrderLines, upsertSalesOrders } from "./order-sync-repository.js";
import { listOperatorHistory, listRecordWarnings, reportOperatorRecordError, resolveRecordWarning } from "./history-repository.js";
import { listDispatchOrders, listScmPurchaseOrders, listScmSchedule, updateScmScheduleEntry, createScmScheduleGroup, cancelScmScheduleGroup, listScmViewPresets, upsertScmViewPreset, createScmVrmaOrder, syncScmScheduleFromDispatchPlan, createScmPurchaseOrderSplit, updateScmPurchaseOrderSplitRef, updateScmPurchaseOrderSplitDestination, updateScmPurchaseOrderSplitPickupYard, updatePurchaseOrderDispatchRef, cancelScmPurchaseOrderSplit, refreshDispatchEnrichment, reparseMissingSalesOrderDispatch, searchSalesOrderMethodOverrides, setPurchaseOrderVendorYard, updateDispatchOrderDetails, updateSalesOrderLocalMethod, getSalesOrderPoAllocationOptions, createSalesOrderPoAllocation, createSalesOrderPoAllocations, cancelSalesOrderPoAllocation, createDispatchOperatorRequest, upsertLocalCoOrder, cancelLocalCoOrder, listDispatchOperatorRequests, resolveDispatchOperatorRequestsForOrder } from "./dispatch-repository.js";
import { listDispatchVendorYards, updateDispatchVendorYard, upsertDispatchVendorYard, listDispatchParserRules, updateDispatchParserRule, listOllamaAudit, listDispatchVendorMappings, discoverDispatchVendorMappingsFromPurchaseOrders, updateDispatchVendorMapping, createDispatchLocalVendor, updateDispatchLocalVendor } from "./dispatch-enrichment.js";
import { listDispatchAudit, writeDispatchAudit } from "./dispatch-audit-repository.js";
import { DispatchPlanDateMismatchError, StaleDispatchPlanSaveError, confirmDispatchPlan, createDispatchPlan, getCurrentDispatchPlan, getDispatchPlan, getDispatchPlanRevision, getDispatchPlanSnapshot, listDispatchPlanSnapshots, listDispatchPlans, reopenDispatchPlan, restoreDispatchPlanSnapshot, saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import { DispatchPlanEditLeaseError, acquireDispatchPlanEditLease, assertDispatchPlanEditLease, getDispatchPlanEditLease, heartbeatDispatchPlanEditLease, releaseDispatchPlanEditLease } from "./dispatch-plan-lease-repository.js";
import { getDispatchStatistics } from "./dispatch-statistics-repository.js";
import { endDriverRest, ensureDriverSamsaraDutyForJob, getActiveDriverRest, getDriverDayState, getNextDriverJob, listDriverHistory, listDriverJobStatuses, recordDriverJobPhotos, skipDriverDvirForTesting, startDriverJob, startDriverRest, submitDriverDvir } from "./driver-repository.js";
import { createSamsaraDriverAuthToken, createSamsaraDriverVehicleAssignment, findSamsaraDriverByUsername, listSamsaraVehicleLocations, setSamsaraDriverDutyStatus, testSamsaraConnection } from "./samsara.js";
import { createPhotoReadToken, createPhotoUploadToken, isR2PhotoReference, publicPhotoUploadConfig } from "./photo-upload.js";

const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const qrScannerDir = path.resolve(dirname, "../node_modules/qr-scanner");
const dataDir = path.resolve(dirname, "../data");
const dispatchPlanPath = path.join(dataDir, "dispatch-plan.json");
const dispatchSetupPath = path.join(dataDir, "dispatch-setup.json");
const deliveryLocations = [1, 28, 15, 26];
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
    { plate: "MBBS-101", capacityLbs: 48000, travelTimePercent: 0 },
    { plate: "MBBS-205", capacityLbs: 44000, travelTimePercent: 0 },
    { plate: "MBBS-318", capacityLbs: 52000, travelTimePercent: 0 }
  ],
  ownYards: [
    { code: "3445", name: "3445", locationId: 1, address: "3445 Kennedy Road, Toronto, ON", lat: 43.8204306, lng: -79.3053423 },
    { code: "2967", name: "2967", locationId: 28, address: "2967 Kennedy Road, Toronto, ON", lat: 43.806119, lng: -79.2986377 },
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

function dispatchOperatorImpactSignature(plan = {}) {
  const assignmentEntries = [...dispatchOperatorAssignmentMap(plan).entries()].sort(([a], [b]) => a.localeCompare(b));
  const operatorOrders = (plan.orders || [])
    .filter((order) => ["SO", "TO", "CO"].includes(order?.type) || order?.originalOrderId || order?.transitCo)
    .map((order) => ({
      id: order.id || "",
      type: order.type || "",
      originalOrderId: order.originalOrderId || "",
      sourceYard: order.sourceYard || "",
      destinationYard: order.destinationYard || "",
      pickupLocations: order.pickupLocations || [],
      transitCo: order.transitCo
        ? {
            id: order.transitCo.id || "",
            fromYard: order.transitCo.fromYard || "",
            toYard: order.transitCo.toYard || ""
          }
        : null,
      childOrders: order.childOrders || [],
      items: (order.items || []).map((item) => ({
        id: item.id || item.lineRowId || item.lineId || item.sku || item.itemName || "",
        sku: item.sku || item.itemName || "",
        quantity: item.quantity ?? item.salesQty ?? "",
        pallets: item.pallets ?? item.pallet_qty ?? "",
        layers: item.layers ?? item.layer_qty ?? "",
        sections: item.sections ?? item.section_qty ?? "",
        pieces: item.pieces ?? item.piece_qty ?? "",
        splitQty: item.splitQty ?? "",
        splitParts: item.splitParts || null
      }))
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({
    planDate: plan.planDate || "",
    assignments: assignmentEntries,
    orders: operatorOrders
  });
}

function dispatchOperatorImpactChanged(beforePlan = {}, afterPlan = {}) {
  return dispatchOperatorImpactSignature(beforePlan || {}) !== dispatchOperatorImpactSignature(afterPlan || {});
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((memo, key) => {
      memo[key] = stableJsonValue(value[key]);
      return memo;
    }, {});
}

function dispatchPlanDataSignature({ orders = [], trucks = [] } = {}) {
  return JSON.stringify(stableJsonValue({ orders, trucks }));
}

function dispatchPlanDataChanged(previousPlan = {}, nextPlan = {}) {
  return dispatchPlanDataSignature(previousPlan || {}) !== dispatchPlanDataSignature(nextPlan || {});
}

function dispatchPlanSaveMode(body = {}) {
  return String(body?.saveMode || body?.audit?.details?.saveMode || "").trim();
}

function dispatchTruckDriverKey(truck = {}) {
  const key = String(truck.driverLogin || truck.driver_login || truck.driver || "").trim().toLowerCase();
  return key && key !== "unassigned" ? key : "";
}

function dispatchDuplicateDriverAssignments(trucks = []) {
  const seen = new Map();
  const duplicates = [];
  for (const truck of trucks || []) {
    const key = dispatchTruckDriverKey(truck);
    if (!key) continue;
    const assignment = {
      driver: truck.driver || truck.driverLogin || key,
      driverLogin: truck.driverLogin || truck.driver_login || "",
      truckId: truck.id || "",
      truckPlate: truck.plate || ""
    };
    if (seen.has(key)) {
      duplicates.push({ driverKey: key, trucks: [seen.get(key), assignment] });
      continue;
    }
    seen.set(key, assignment);
  }
  return duplicates;
}

function sendDispatchDuplicateDriverResponse(res, duplicates = []) {
  const preview = duplicates
    .slice(0, 3)
    .map((item) => `${item.driverKey}: ${item.trucks.map((truck) => truck.truckPlate || truck.truckId).filter(Boolean).join(", ")}`)
    .join("; ");
  res.status(409).json({
    code: "DISPATCH_DRIVER_DUPLICATE",
    error: `One driver can only be assigned to one truck${preview ? `: ${preview}` : "."}`,
    duplicates
  });
}

function dispatchTruckSequenceKey(truck = {}) {
  return String(truck.id || truck.plate || "").trim();
}

function mergeDispatchTruckSequence(latestTrucks = [], requestedTrucks = []) {
  const latestByKey = new Map((latestTrucks || [])
    .map((truck) => [dispatchTruckSequenceKey(truck), truck])
    .filter(([key]) => key));
  const requestedByKey = new Map((requestedTrucks || [])
    .map((truck) => [dispatchTruckSequenceKey(truck), truck])
    .filter(([key]) => key));
  const seen = new Set();
  const merged = [];
  for (const requested of requestedTrucks || []) {
    const key = dispatchTruckSequenceKey(requested);
    if (!key || seen.has(key)) continue;
    merged.push(latestByKey.get(key) || requested);
    seen.add(key);
  }
  for (const latest of latestTrucks || []) {
    const key = dispatchTruckSequenceKey(latest);
    if (!key || seen.has(key)) continue;
    merged.push(latest);
    seen.add(key);
  }
  for (const requested of requestedTrucks || []) {
    const key = dispatchTruckSequenceKey(requested);
    if (!key || seen.has(key) || latestByKey.has(key)) continue;
    merged.push(requestedByKey.get(key) || requested);
    seen.add(key);
  }
  return merged;
}

function dispatchPlannedOrderRefs(plan = {}) {
  const orderById = new Map((plan.orders || []).map((order) => [String(order?.id || ""), order]));
  const refs = new Set();
  const addRef = (value) => {
    const ref = String(value || "").trim();
    if (ref) refs.add(ref);
  };
  const addOrderRefs = (orderId) => {
    addRef(orderId);
    const order = orderById.get(String(orderId || ""));
    if (!order || order.type === "CO") return;
    addRef(order.originalOrderId);
    for (const childId of order.childOrders || []) addRef(childId);
    for (const child of order.childOrderDetails || []) {
      addRef(child?.id);
      addRef(child?.originalOrderId);
    }
  };
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop" || !stop.orderId) continue;
        addOrderRefs(stop.orderId);
      }
    }
  }
  return refs;
}

function dispatchPlannedAssignmentMap(plan = {}) {
  const orderById = new Map((plan.orders || []).map((order) => [String(order?.id || ""), order]));
  const assignments = new Map();
  const addRef = (value, details) => {
    const ref = String(value || "").trim();
    if (ref && !assignments.has(ref)) assignments.set(ref, details);
  };
  const addOrderRefs = (orderId, details) => {
    const order = orderById.get(String(orderId || ""));
    const plannedDetails = {
      ...details,
      plannedOrderRef: String(orderId || "").trim()
    };
    if (order?.childOrders?.length || order?.originalOrderId) {
      plannedDetails.plannedOrderSnapshot = order;
    }
    addRef(orderId, plannedDetails);
    if (!order || order.type === "CO") return;
    addRef(order.originalOrderId, plannedDetails);
    for (const childId of order.childOrders || []) addRef(childId, plannedDetails);
    for (const child of order.childOrderDetails || []) {
      addRef(child?.id, plannedDetails);
      addRef(child?.originalOrderId, plannedDetails);
    }
  };
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop" || !stop.orderId) continue;
        addOrderRefs(stop.orderId, {
          dispatchPlanned: true,
          dispatchPlanId: plan.id ? String(plan.id) : "",
          dispatchPlanDate: String(plan.planDate || "").slice(0, 10),
          dispatchTruckPlate: truck.plate || "",
          dispatchLoadName: load.name || "",
          dispatchParkingSpot: truck.parkingSpot || ""
        });
      }
    }
  }
  return assignments;
}

async function dispatchPlannedAssignmentsFromSnapshots() {
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status <> 'cancelled'
      ORDER BY p.plan_date DESC, p.updated_at DESC`
  );
  const assignments = new Map();
  for (const row of result.rows) {
    const planAssignments = dispatchPlannedAssignmentMap({
      id: row.id,
      planDate: row.plan_date,
      orders: row.orders || [],
      trucks: row.trucks || []
    });
    for (const [ref, details] of planAssignments.entries()) {
      if (!assignments.has(ref)) assignments.set(ref, details);
    }
  }
  await removeStaleCoPlannedAssignments(assignments);
  return assignments;
}

async function removeStaleCoPlannedAssignments(assignments) {
  const coRefs = [...assignments.keys()].filter((ref) => String(ref || "").startsWith("CO-"));
  if (!coRefs.length) return;
  const result = await query(
    `SELECT co_ref,
            dispatch_plan_id::text AS dispatch_plan_id,
            dispatch_plan_date::date::text AS dispatch_plan_date
       FROM co_orders
      WHERE co_ref = ANY($1)`,
    [coRefs]
  );
  const activeCo = new Map(result.rows.map((row) => [String(row.co_ref || ""), row]));
  for (const coRef of coRefs) {
    const row = activeCo.get(coRef);
    const details = assignments.get(coRef);
    const rowPlanId = String(row?.dispatch_plan_id || "");
    const rowPlanDate = String(row?.dispatch_plan_date || "").slice(0, 10);
    const assignmentPlanId = String(details?.dispatchPlanId || "");
    const assignmentPlanDate = String(details?.dispatchPlanDate || "").slice(0, 10);
    const matchesPlanId = rowPlanId && assignmentPlanId && rowPlanId === assignmentPlanId;
    const matchesPlanDate = rowPlanDate && assignmentPlanDate && rowPlanDate === assignmentPlanDate;
    if (!row || (!matchesPlanId && !matchesPlanDate)) assignments.delete(coRef);
  }
}

async function enrichDispatchOrdersWithPlanAssignments(orders = []) {
  const plannedAssignments = await dispatchPlannedAssignmentsFromSnapshots();
  return (orders || []).map((order) => {
    const planned = plannedAssignments.get(String(order.id || ""));
    if (!planned) return order;
    return {
      ...order,
      dispatchPlanned: true,
      dispatchPlanId: planned.dispatchPlanId || order.dispatchPlanId || "",
      dispatchPlanDate: planned.dispatchPlanDate || order.dispatchPlanDate || "",
      dispatchTruckPlate: planned.dispatchTruckPlate || order.dispatchTruckPlate || "",
      dispatchLoadName: planned.dispatchLoadName || order.dispatchLoadName || "",
      dispatchParkingSpot: planned.dispatchParkingSpot || order.dispatchParkingSpot || ""
    };
  });
}

async function listDispatchPlannedAssignments() {
  const plannedAssignments = await dispatchPlannedAssignmentsFromSnapshots();
  return [...plannedAssignments.entries()]
    .map(([orderRef, details]) => ({ orderRef, ...details }))
    .sort((a, b) => String(a.orderRef).localeCompare(String(b.orderRef)));
}

function isSnapshotDerivedDispatchOrder(order = {}) {
  if (!order?.id || order?.type === "CO") return false;
  return Boolean(
    (Array.isArray(order.childOrders) && order.childOrders.length)
    || String(order.originalOrderId || "").trim()
  );
}

async function listDispatchSnapshotDerivedOrders({ type = null } = {}) {
  const [result, inactiveSplits] = await Promise.all([
    query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.updated_at, s.orders
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status <> 'cancelled'
      ORDER BY p.updated_at DESC, p.plan_date DESC`
    ),
    query(
      `SELECT tranid FROM sales_orders WHERE tranid LIKE '%-S%' AND netsuite_active = false
       UNION
       SELECT tranid FROM transfer_orders WHERE tranid LIKE '%-S%' AND netsuite_active = false`
    )
  ]);
  const inactiveSplitRefs = new Set(inactiveSplits.rows.map((row) => String(row.tranid || "")));
  const derivedOrders = new Map();
  const wantedType = type ? String(type).toUpperCase() : "";
  for (const row of result.rows) {
    for (const order of row.orders || []) {
      if (!isSnapshotDerivedDispatchOrder(order)) continue;
      if (wantedType && String(order?.type || "").toUpperCase() !== wantedType) continue;
      const id = String(order?.id || "").trim();
      if (String(order?.originalOrderId || "").trim() && inactiveSplitRefs.has(id)) continue;
      if (!id || derivedOrders.has(id)) continue;
      derivedOrders.set(id, {
        ...order,
        childOrders: Array.isArray(order.childOrders) ? order.childOrders.filter(Boolean) : [],
        dispatchSnapshotSourcePlanId: String(row.id || ""),
        dispatchSnapshotSourcePlanDate: String(row.plan_date || "").slice(0, 10)
      });
    }
  }
  return [...derivedOrders.values()];
}

function mergeDispatchOrderFeedWithSnapshotDerivedOrders(orders = [], derivedOrders = []) {
  const byId = new Map((orders || []).map((order) => [String(order?.id || ""), order]));
  for (const derived of derivedOrders || []) {
    const id = String(derived?.id || "").trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, derived);
  }
  return [...byId.values()];
}

async function listDispatchOrdersForResponse({ type = null } = {}) {
  const orders = await listDispatchOrders({ type });
  const derivedOrders = await listDispatchSnapshotDerivedOrders({ type });
  return enrichDispatchOrdersWithPlanAssignments(mergeDispatchOrderFeedWithSnapshotDerivedOrders(orders, derivedOrders));
}

async function findDispatchPlanDateConflicts({ planId, planDate, orders = [], trucks = [] } = {}) {
  const currentRefs = dispatchPlannedOrderRefs({ orders, trucks });
  if (!currentRefs.size) return [];
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id <> $1
        AND p.status <> 'cancelled'
        AND p.plan_date <> $2::date`,
    [planId, planDate]
  );
  const conflicts = [];
  for (const row of result.rows) {
    const otherRefs = dispatchPlannedOrderRefs({ orders: row.orders || [], trucks: row.trucks || [] });
    for (const ref of currentRefs) {
      if (!otherRefs.has(ref)) continue;
      conflicts.push({
        orderRef: ref,
        planId: String(row.id),
        planDate: row.plan_date,
        status: row.status || ""
      });
    }
  }
  return conflicts.sort((a, b) => `${a.planDate}|${a.orderRef}`.localeCompare(`${b.planDate}|${b.orderRef}`));
}

function dispatchPlanDateConflictKey(conflict = {}) {
  return [
    String(conflict.orderRef || ""),
    String(conflict.planId || ""),
    String(conflict.planDate || "")
  ].join("|");
}

async function findNewDispatchPlanDateConflicts(previousPlan = {}, nextPlan = {}) {
  const previousConflicts = await findDispatchPlanDateConflicts({
    planId: previousPlan.id || nextPlan.id,
    planDate: previousPlan.planDate || nextPlan.planDate,
    orders: previousPlan.orders || [],
    trucks: previousPlan.trucks || []
  });
  const previousKeys = new Set(previousConflicts.map(dispatchPlanDateConflictKey));
  const nextConflicts = await findDispatchPlanDateConflicts({
    planId: nextPlan.id || previousPlan.id,
    planDate: nextPlan.planDate || previousPlan.planDate,
    orders: nextPlan.orders || [],
    trucks: nextPlan.trucks || []
  });
  return nextConflicts.filter((conflict) => !previousKeys.has(dispatchPlanDateConflictKey(conflict)));
}

function dispatchDateCompare(a, b) {
  const left = String(a || "").slice(0, 10);
  const right = String(b || "").slice(0, 10);
  if (!left || !right || left === right) return 0;
  return left < right ? -1 : 1;
}

function dispatchTimingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dispatchOrderDropOccurrences(plan = {}, orderRef = "") {
  const target = String(orderRef || "");
  const occurrences = [];
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop" || String(stop?.orderId || "") !== target) continue;
        occurrences.push({ truck, load, stop });
      }
    }
  }
  return occurrences;
}

function dispatchSourcePickupMinute(occurrence = {}) {
  const load = occurrence.load || {};
  const orderRef = String(occurrence.stop?.orderId || "");
  const pickup = (load.stops || []).find((stop) =>
    stop?.type === "pick" && String(stop?.orderId || "") === orderRef
  );
  return dispatchTimingNumber(pickup?.timing?.arrival) ?? dispatchTimingNumber(load.timing?.start);
}

function dispatchCoFinishMinute(occurrence = {}) {
  return dispatchTimingNumber(occurrence.load?.timing?.finish)
    ?? dispatchTimingNumber(occurrence.stop?.timing?.depart);
}

async function dispatchPlansForCoValidation(nextPlan = {}) {
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, s.orders, s.trucks
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.status <> 'cancelled'
        AND p.id <> $1`,
    [nextPlan.id || 0]
  );
  return [
    nextPlan,
    ...result.rows.map((row) => ({
      id: String(row.id || ""),
      planDate: row.plan_date,
      orders: row.orders || [],
      trucks: row.trucks || []
    }))
  ];
}

async function findDispatchCoSequenceConflicts(nextPlan = {}) {
  const sourcePlanDate = String(nextPlan.planDate || "").slice(0, 10);
  const candidatePlans = await dispatchPlansForCoValidation(nextPlan);
  const coOccurrences = new Map();
  for (const plan of candidatePlans) {
    const planDate = String(plan.planDate || "").slice(0, 10);
    const coRefs = new Set((plan.orders || [])
      .filter((order) => order?.type === "CO")
      .map((order) => String(order?.id || ""))
      .filter(Boolean));
    for (const truck of plan.trucks || []) {
      for (const load of truck.loads || []) {
        for (const stop of load.stops || []) {
          const ref = String(stop?.orderId || "");
          if (stop?.type === "drop" && ref.startsWith("CO-")) coRefs.add(ref);
        }
      }
    }
    for (const coRef of coRefs) {
      const occurrence = dispatchOrderDropOccurrences(plan, coRef)[0];
      if (!occurrence) continue;
      const finish = dispatchCoFinishMinute(occurrence);
      const current = coOccurrences.get(coRef);
      if (!current || dispatchDateCompare(planDate, current.planDate) < 0) {
        coOccurrences.set(coRef, { coRef, planDate, finish });
      }
    }
  }

  const conflicts = [];
  for (const source of nextPlan.orders || []) {
    const sourceRef = String(source?.id || "");
    const coRef = String(source?.transitCo?.id || "");
    if (!sourceRef || !coRef || source?.type === "CO") continue;
    const sourceOccurrences = dispatchOrderDropOccurrences(nextPlan, sourceRef);
    if (!sourceOccurrences.length) continue;
    const co = coOccurrences.get(coRef);
    if (!co) {
      conflicts.push({ orderRef: sourceRef, coRef, reason: `${sourceRef} requires ${coRef} to be planned first.` });
      continue;
    }
    const dateCompare = dispatchDateCompare(co.planDate, sourcePlanDate);
    if (dateCompare > 0) {
      conflicts.push({ orderRef: sourceRef, coRef, coPlanDate: co.planDate, sourcePlanDate, reason: `${coRef} is planned after ${sourceRef}.` });
      continue;
    }
    if (dateCompare < 0) continue;
    const sourcePickup = dispatchSourcePickupMinute(sourceOccurrences[0]);
    if (!Number.isFinite(Number(co.finish)) || !Number.isFinite(Number(sourcePickup))) {
      continue;
    }
    if (Number(co.finish) > Number(sourcePickup)) {
      conflicts.push({
        orderRef: sourceRef,
        coRef,
        coPlanDate: co.planDate,
        sourcePlanDate,
        coFinish: Number(co.finish),
        sourcePickup: Number(sourcePickup),
        reason: `${coRef} must finish before ${sourceRef} pickup.`
      });
    }
  }
  return conflicts;
}

function sendDispatchPlanDateConflictResponse(res, conflicts = []) {
  const preview = conflicts.slice(0, 5).map((item) => `${item.orderRef} on ${item.planDate}`).join(", ");
  res.status(409).json({
    code: "DISPATCH_ORDER_ALREADY_PLANNED",
    error: `Some orders are already planned on another date${preview ? `: ${preview}` : "."}`,
    conflicts
  });
}

function sendDispatchCoSequenceConflictResponse(res, conflicts = []) {
  const preview = conflicts.slice(0, 3).map((item) => item.reason).join(" ");
  res.status(409).json({
    code: "DISPATCH_CO_SEQUENCE_INVALID",
    error: preview || "CO must be planned before the original order pickup.",
    conflicts
  });
}

async function sendStaleDispatchPlanResponse(res, error) {
  const latest = await getDispatchPlan(error.planId).catch(() => null);
  res.status(409).json({
    error: error.message,
    code: error.code,
    planId: String(error.planId || ""),
    expectedRevision: error.expectedRevision,
    currentRevision: error.currentRevision,
    plan: latest
  });
}

function dispatchPlanStopIds(plan) {
  return new Set((plan?.trucks || []).flatMap((truck) =>
    (truck.loads || []).flatMap((load) => (load.stops || []).map((stop) => String(stop.id || "")))
  ));
}

function sanitizeDispatchPlanOrders(orders = []) {
  const groupedChildren = new Set();
  const splitParents = new Set();
  for (const order of orders || []) {
    for (const childId of order?.childOrders || []) {
      if (childId) groupedChildren.add(String(childId));
    }
    const originalOrderId = String(order?.originalOrderId || "").trim();
    if (originalOrderId) splitParents.add(originalOrderId);
  }
  return (orders || []).filter((order) => {
    const id = String(order?.id || "");
    return !groupedChildren.has(id) && !splitParents.has(id);
  });
}

function dispatchCoAssignments(plan = {}) {
  const assignments = new Map();
  for (const truck of plan.trucks || []) {
    for (const load of truck.loads || []) {
      if (load.returnOnly) continue;
      for (const stop of load.stops || []) {
        if (stop?.type !== "drop") continue;
        const coRef = String(stop.orderId || "").trim();
        if (!coRef.startsWith("CO-")) continue;
        assignments.set(coRef, {
          coRef,
          planId: plan.id || null,
          planDate: String(plan.planDate || "").slice(0, 10),
          truckPlate: truck.plate || "",
          loadName: load.name || "",
          parkingSpot: truck.parkingSpot || ""
        });
      }
    }
  }
  return assignments;
}

async function applyDispatchPlanCoAssignments(plan = {}) {
  if (!plan?.id || !plan?.planDate) return { planned: 0, cleared: 0 };
  const assignments = dispatchCoAssignments(plan);
  const refs = [...assignments.keys()];
  const cleared = await query(
    `UPDATE local_co_orders
        SET dispatch_plan_id = NULL,
            dispatch_plan_date = NULL,
            dispatch_truck_plate = '',
            dispatch_load_name = '',
            dispatch_parking_spot = '',
            updated_at = now()
      WHERE status NOT IN ('received', 'loaded')
        AND (
          dispatch_plan_id = $1
          OR dispatch_plan_date = $2::date
        )
        AND NOT (co_ref = ANY($3::text[]))
      RETURNING co_ref`,
    [plan.id, plan.planDate, refs]
  );
  for (const assignment of assignments.values()) {
    await query(
      `UPDATE local_co_orders
          SET dispatch_plan_id = $2,
              dispatch_plan_date = $3::date,
              dispatch_truck_plate = $4,
              dispatch_load_name = $5,
              dispatch_parking_spot = $6,
              updated_at = now()
        WHERE co_ref = $1
          AND status NOT IN ('received', 'loaded')`,
      [
        assignment.coRef,
        assignment.planId,
        assignment.planDate || null,
        assignment.truckPlate,
        assignment.loadName,
        assignment.parkingSpot
      ]
    );
  }
  return { planned: refs.length, cleared: cleared.rowCount };
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

function localDateDaysAgo(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
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

function auditOrderId(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : null;
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

function samsaraAccountsForDriver(driver) {
  return {
    primaryUsername: samsaraUsernameForDriver(driver, "primary"),
    secondaryUsername: samsaraUsernameForDriver(driver, "secondary")
  };
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

function dispatchEditLeaseInput(req, planDate = "") {
  return {
    planDate: planDate || req.body?.planDate || req.body?.date || req.query?.planDate || req.query?.date || "",
    operatorId: req.operator?.id || "",
    operatorName: req.operator?.display_name || req.operator?.username || "",
    sessionId: req.body?.sessionId || req.body?.audit?.sessionId || req.query?.sessionId || "",
    token: req.body?.editLeaseToken || req.get("x-dispatch-edit-lease") || req.query?.editLeaseToken || ""
  };
}

async function requireDispatchPlanEditLease(req, planDate = "") {
  const input = dispatchEditLeaseInput(req, planDate);
  if (process.env.MBBS_ENABLE_ROLLBACK_TESTS === "1" && req.get("x-mbbs-rollback-test") === "1" && !input.token) {
    input.planDate = input.planDate || "2099-12-31";
    const acquired = await acquireDispatchPlanEditLease(input);
    input.token = acquired.token;
  }
  return assertDispatchPlanEditLease(input);
}

function sendDispatchPlanEditLeaseError(res, error) {
  return res.status(error.status || 409).json({
    error: error.message,
    code: error.code || "DISPATCH_PLAN_EDIT_LEASE_REQUIRED",
    lease: error.lease || null
  });
}

function normalizedOperatorRole(operator) {
  return String(operator?.role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function requireDispatchAccess(req, res, next) {
  const role = normalizedOperatorRole(req.operator);
  if (String(req.path || "").startsWith("/scm")) {
    if (["admin", "dispatcher", "scm", "scm_staff"].includes(role)) return next();
    return res.status(403).json({ error: "SCM account required" });
  }
  if (!["dispatcher", "admin"].includes(role)) {
    return res.status(403).json({ error: "Dispatcher account required" });
  }
  next();
}

function requireScmAccess(req, res, next) {
  const role = normalizedOperatorRole(req.operator);
  if (["admin", "dispatcher", "scm", "scm_staff", "yard_manager"].includes(role)) return next();
  return res.status(403).json({ error: "SCM account required" });
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
  const intervalSeconds = Number(cleanSync.intervalSeconds ?? defaultDispatchSetup.sync.intervalSeconds);
  const maxRunSeconds = Number(cleanSync.maxRunSeconds ?? defaultDispatchSetup.sync.maxRunSeconds);
  return {
    ...defaultDispatchSetup.sync,
    ...cleanSync,
    mode,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds >= 30 ? Math.round(intervalSeconds) : defaultDispatchSetup.sync.intervalSeconds,
    maxRunSeconds: Number.isFinite(maxRunSeconds) && maxRunSeconds >= 60 ? Math.round(maxRunSeconds) : defaultDispatchSetup.sync.maxRunSeconds,
    running: Boolean(sync.running)
  };
}

function validateDispatchSetupDrivers(drivers = []) {
  const seen = new Map();
  for (const driver of drivers || []) {
    const login = String(driver?.login || "").trim();
    if (!login) continue;
    const key = login.toLowerCase();
    const previous = seen.get(key);
    if (previous) {
      const error = new Error(`Driver login must be unique. "${login}" is used by both ${previous} and ${driver?.name || login}.`);
      error.status = 400;
      throw error;
    }
    seen.set(key, driver?.name || login);
  }
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
  validateDispatchSetupDrivers(payload.drivers);
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

function syncAuditAction(source, { failed = false, stopped = false } = {}) {
  if (source === "auto") {
    if (stopped) return "netsuite.auto_sync_stopped";
    if (failed) return "netsuite.auto_sync_failed";
    return "netsuite.auto_sync";
  }
  if (source === "control_inbound_transfer_manual") {
    if (stopped) return "netsuite.to_po_sync_stopped";
    if (failed) return "netsuite.to_po_sync_failed";
    return "netsuite.to_po_sync";
  }
  if (stopped) return "netsuite.manual_sync_stopped";
  if (failed) return "netsuite.manual_sync_failed";
  return "netsuite.manual_sync";
}

async function runDispatchSync({ source = "manual", actorOperatorId = null, orderScope = "all" } = {}) {
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
    const synced = orderScope === "transfer_purchase_order"
      ? await syncTransferPurchaseOrderFeed()
      : await syncDispatchOrderFeed();
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
      action: syncAuditAction(source),
      details: { orderScope, synced, enriched }
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
      action: syncAuditAction(source, { failed: !stopped, stopped }),
      details: { orderScope, error: error.message }
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
    "driver_rest_records",
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

function progressNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? Math.abs(number) : 0;
}

function roundProgressQuantity(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function progressHasConversion(line) {
  return progressNumber(line.to_plt) > 0
    || progressNumber(line.to_lyr) > 0
    || progressNumber(line.to_sec) > 0
    || progressNumber(line.to_pcs) > 0;
}

function deriveProgressUnits(line, salesQuantity) {
  const quantity = progressNumber(salesQuantity);
  if (!progressHasConversion(line)) {
    return { pallet_qty: 0, layer_qty: 0, section_qty: 0, piece_qty: quantity };
  }
  const explicit = {
    pallet_qty: progressNumber(line.pallet_qty),
    layer_qty: progressNumber(line.layer_qty),
    section_qty: progressNumber(line.section_qty),
    piece_qty: progressNumber(line.piece_qty)
  };
  if (progressNumber(line.quantity) === quantity && Object.values(explicit).some((item) => item > 0)) {
    return explicit;
  }
  let remaining = quantity;
  const next = { pallet_qty: 0, layer_qty: 0, section_qty: 0, piece_qty: 0 };
  const conversions = [
    ["pallet_qty", "to_plt"],
    ["layer_qty", "to_lyr"],
    ["section_qty", "to_sec"],
    ["piece_qty", "to_pcs"]
  ];
  for (const [qtyField, conversionField] of conversions) {
    const conversion = progressNumber(line[conversionField]);
    if (!conversion || remaining <= 0) continue;
    const units = Math.floor((remaining / conversion) + 0.000001);
    next[qtyField] = units;
    remaining = roundProgressQuantity(remaining - (units * conversion));
  }
  return next;
}

function progressLinePatch(line) {
  const orderedQty = progressNumber(line.quantity);
  const processedQty = Math.min(progressNumber(line.netsuite_received_qty), orderedQty);
  const totalUnits = deriveProgressUnits(line, orderedQty);
  const processedUnits = deriveProgressUnits(line, processedQty);
  return {
    orderedQty,
    processedQty,
    totalUnits,
    processedUnits,
    unit: line.unit || "",
    itemWeight: progressNumber(line.item_weight) || null,
    locationId: line.location_id || null,
    location: line.location || "",
    toPlt: line.to_plt || null,
    toLyr: line.to_lyr || null,
    toSec: line.to_sec || null,
    toPcs: line.to_pcs || null
  };
}

function progressSummary(lines = []) {
  return lines.reduce((sum, line) => {
    const ordered = progressNumber(line.quantity);
    const processed = Math.min(progressNumber(line.netsuite_received_qty), ordered);
    return {
      total: sum.total + ordered,
      processed: sum.processed + processed,
      open: sum.open + Math.max(ordered - processed, 0)
    };
  }, { total: 0, processed: 0, open: 0 });
}

function isPickableProgressLine(line) {
  return ["InvtPart", "NonInvtPart"].includes(String(line.item_type || ""));
}

function statusTextIsComplete(statusText = "", orderType = "sales_order") {
  const text = String(statusText || "").toLowerCase();
  if (orderType === "purchase_order") return text.includes("received") || text.includes("billed");
  return text.includes("fulfilled") || text.includes("pending billing") || text.includes("billed");
}

async function updateSalesOrderLineFromProgress(orderId, line) {
  const patch = progressLinePatch(line);
  await query(
    `UPDATE sales_order_lines
        SET quantity = $3,
            unit = COALESCE(NULLIF($4, ''), unit),
            item_weight = COALESCE($5, item_weight),
            location_id = COALESCE($6::bigint, location_id),
            location = COALESCE(NULLIF($7, ''), location),
            pallet_qty = $8,
            layer_qty = $9,
            piece_qty = $10,
            section_qty = $11,
            to_plt = COALESCE($12::numeric, to_plt),
            to_lyr = COALESCE($13::numeric, to_lyr),
            to_sec = COALESCE($14::numeric, to_sec),
            to_pcs = COALESCE($15::numeric, to_pcs),
            loaded_qty = $16,
            loaded_uom = COALESCE(NULLIF($4, ''), loaded_uom),
            packed_pallet_qty = 0,
            packed_layer_qty = 0,
            packed_piece_qty = 0,
            packed_section_qty = 0,
            fulfilled_pallet_qty = $17,
            fulfilled_layer_qty = $18,
            fulfilled_piece_qty = $19,
            fulfilled_section_qty = $20,
            confirmed = false,
            confirmed_at = null,
            netsuite_active = true,
            sync_exception = null,
            sync_exception_at = null,
            synced_at = now()
      WHERE sales_order_id = $1
        AND line_id = $2`,
    [
      orderId,
      line.line_id,
      patch.orderedQty,
      patch.unit,
      patch.itemWeight,
      patch.locationId,
      patch.location,
      patch.totalUnits.pallet_qty,
      patch.totalUnits.layer_qty,
      patch.totalUnits.piece_qty,
      patch.totalUnits.section_qty,
      patch.toPlt,
      patch.toLyr,
      patch.toSec,
      patch.toPcs,
      patch.processedQty,
      patch.processedUnits.pallet_qty,
      patch.processedUnits.layer_qty,
      patch.processedUnits.piece_qty,
      patch.processedUnits.section_qty
    ]
  );
  return patch;
}

async function updateTransferOrderLineFromProgress(orderId, line, stage) {
  const patch = progressLinePatch(line);
  const isOutbound = stage === "outbound";
  await query(
    `UPDATE transfer_order_lines
        SET quantity = $4,
            unit = COALESCE(NULLIF($5, ''), unit),
            item_weight = COALESCE($6, item_weight),
            location_id = COALESCE($7::bigint, location_id),
            location = COALESCE(NULLIF($8, ''), location),
            pallet_qty = $9,
            layer_qty = $10,
            piece_qty = $11,
            section_qty = $12,
            to_plt = COALESCE($13::numeric, to_plt),
            to_lyr = COALESCE($14::numeric, to_lyr),
            to_sec = COALESCE($15::numeric, to_sec),
            to_pcs = COALESCE($16::numeric, to_pcs),
            loaded_qty = CASE WHEN $17::boolean THEN $18 ELSE loaded_qty END,
            loaded_uom = CASE WHEN $17::boolean THEN COALESCE(NULLIF($5, ''), loaded_uom) ELSE loaded_uom END,
            packed_pallet_qty = CASE WHEN $17::boolean THEN 0 ELSE packed_pallet_qty END,
            packed_layer_qty = CASE WHEN $17::boolean THEN 0 ELSE packed_layer_qty END,
            packed_piece_qty = CASE WHEN $17::boolean THEN 0 ELSE packed_piece_qty END,
            packed_section_qty = CASE WHEN $17::boolean THEN 0 ELSE packed_section_qty END,
            fulfilled_pallet_qty = CASE WHEN $17::boolean THEN $19 ELSE fulfilled_pallet_qty END,
            fulfilled_layer_qty = CASE WHEN $17::boolean THEN $20 ELSE fulfilled_layer_qty END,
            fulfilled_piece_qty = CASE WHEN $17::boolean THEN $21 ELSE fulfilled_piece_qty END,
            fulfilled_section_qty = CASE WHEN $17::boolean THEN $22 ELSE fulfilled_section_qty END,
            netsuite_received_qty = CASE WHEN $17::boolean THEN netsuite_received_qty ELSE $18 END,
            received_pallet_qty = CASE WHEN $17::boolean THEN received_pallet_qty ELSE 0 END,
            received_layer_qty = CASE WHEN $17::boolean THEN received_layer_qty ELSE 0 END,
            received_piece_qty = CASE WHEN $17::boolean THEN received_piece_qty ELSE 0 END,
            received_section_qty = CASE WHEN $17::boolean THEN received_section_qty ELSE 0 END,
            confirmed = false,
            confirmed_at = null,
            netsuite_active = true,
            sync_exception = null,
            sync_exception_at = null,
            synced_at = now()
      WHERE transfer_order_id = $1
        AND line_stage = $2
        AND line_id = $3`,
    [
      orderId,
      stage,
      line.line_id,
      patch.orderedQty,
      patch.unit,
      patch.itemWeight,
      patch.locationId,
      patch.location,
      patch.totalUnits.pallet_qty,
      patch.totalUnits.layer_qty,
      patch.totalUnits.piece_qty,
      patch.totalUnits.section_qty,
      patch.toPlt,
      patch.toLyr,
      patch.toSec,
      patch.toPcs,
      isOutbound,
      patch.processedQty,
      patch.processedUnits.pallet_qty,
      patch.processedUnits.layer_qty,
      patch.processedUnits.piece_qty,
      patch.processedUnits.section_qty
    ]
  );
  return patch;
}

async function updatePurchaseOrderLineFromProgress(orderId, line) {
  const patch = progressLinePatch(line);
  await query(
    `UPDATE purchase_order_lines
        SET quantity = $3,
            unit = COALESCE(NULLIF($4, ''), unit),
            item_weight = COALESCE($5, item_weight),
            location_id = COALESCE($6::bigint, location_id),
            location = COALESCE(NULLIF($7, ''), location),
            pallet_qty = $8,
            layer_qty = $9,
            piece_qty = $10,
            section_qty = $11,
            to_plt = COALESCE($12::numeric, to_plt),
            to_lyr = COALESCE($13::numeric, to_lyr),
            to_sec = COALESCE($14::numeric, to_sec),
            to_pcs = COALESCE($15::numeric, to_pcs),
            netsuite_received_qty = $16,
            received_pallet_qty = 0,
            received_layer_qty = 0,
            received_piece_qty = 0,
            received_section_qty = 0,
            netsuite_active = true,
            sync_exception = null,
            sync_exception_at = null,
            synced_at = now()
      WHERE purchase_order_id = $1
        AND line_id = $2`,
    [
      orderId,
      line.line_id,
      patch.orderedQty,
      patch.unit,
      patch.itemWeight,
      patch.locationId,
      patch.location,
      patch.totalUnits.pallet_qty,
      patch.totalUnits.layer_qty,
      patch.totalUnits.piece_qty,
      patch.totalUnits.section_qty,
      patch.toPlt,
      patch.toLyr,
      patch.toSec,
      patch.toPcs,
      patch.processedQty
    ]
  );
  return patch;
}

function localOutboundStatusFromSummary(summary, statusText) {
  if (summary.processed <= 0 && !statusTextIsComplete(statusText, "sales_order")) {
    return { operatorStatus: "open", yardStatus: "Open", fulfillmentStatus: "not_fulfilled" };
  }
  if (summary.open <= 0.000001 || statusTextIsComplete(statusText, "sales_order")) {
    return { operatorStatus: "loaded", yardStatus: "Loaded", fulfillmentStatus: "fulfilled" };
  }
  return { operatorStatus: "partial_loaded", yardStatus: "Partial Loaded", fulfillmentStatus: "partial_fulfilled" };
}

function localReceiptStatusFromSummary(summary, statusText, orderType) {
  if (summary.processed <= 0 && !statusTextIsComplete(statusText, orderType)) return "not_received";
  if (summary.open <= 0.000001 || statusTextIsComplete(statusText, orderType)) return "received";
  return "partial_received";
}

function transferProgressLineKey(line) {
  return [
    line.item_id || "",
    line.location_id || "",
    progressNumber(line.quantity),
    line.item_description || "",
    progressNumber(line.pallet_qty),
    progressNumber(line.layer_qty),
    progressNumber(line.section_qty),
    progressNumber(line.piece_qty)
  ].join("|");
}

function dedupeTransferProgressLines(lines = []) {
  const best = new Map();
  for (const line of lines || []) {
    const key = transferProgressLineKey(line);
    const current = best.get(key);
    if (!current || progressNumber(line.netsuite_received_qty) >= progressNumber(current.netsuite_received_qty)) {
      best.set(key, line);
    }
  }
  return [...best.values()];
}

function transferProgressLinesForStage(progress, stage) {
  const locationId = stage === "outbound" ? progress.source_location_id : progress.destination_location_id;
  const lines = (progress.lines || []).filter(isPickableProgressLine);
  if (!locationId && stage === "outbound" && progress.destination_location_id) {
    return dedupeTransferProgressLines(lines.filter((line) => String(line.location_id || "") !== String(progress.destination_location_id)));
  }
  if (!locationId) return dedupeTransferProgressLines(lines);
  return dedupeTransferProgressLines(lines.filter((line) => String(line.location_id || "") === String(locationId)));
}

async function reconcileSalesOrderProgress(progress) {
  const lines = (progress.lines || []).filter(isPickableProgressLine);
  for (const line of lines) await updateSalesOrderLineFromProgress(progress.id, line);
  const summary = progressSummary(lines);
  const status = localOutboundStatusFromSummary(summary, progress.status_text);
  await query(
    `UPDATE sales_orders
        SET status = COALESCE($2, status),
            status_text = COALESCE($3, status_text),
            operator_status = $4,
            local_yard_order_status = $5,
            fulfillment_status = $6,
            fulfilled_at = CASE WHEN $6 IN ('fulfilled', 'partial_fulfilled') THEN COALESCE(fulfilled_at, now()) ELSE fulfilled_at END,
            status_updated_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1`,
    [progress.id, progress.status || null, progress.status_text || null, status.operatorStatus, status.yardStatus, status.fulfillmentStatus]
  );
  return { lines: lines.length, ...summary, ...status };
}

async function reconcilePurchaseOrderProgress(progress) {
  const lines = (progress.lines || []).filter(isPickableProgressLine);
  for (const line of lines) await updatePurchaseOrderLineFromProgress(progress.id, line);
  const summary = progressSummary(lines);
  const receiptStatus = localReceiptStatusFromSummary(summary, progress.status_text, "purchase_order");
  await query(
    `UPDATE purchase_orders
        SET status = COALESCE($2, status),
            status_text = COALESCE($3, status_text),
            receipt_status = $4,
            received_at = CASE WHEN $4 IN ('received', 'partial_received') THEN COALESCE(received_at, now()) ELSE received_at END,
            status_updated_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1`,
    [progress.id, progress.status || null, progress.status_text || null, receiptStatus]
  );
  return { lines: lines.length, ...summary, receiptStatus };
}

async function reconcileTransferOrderProgress(progress) {
  const outboundLines = transferProgressLinesForStage(progress, "outbound");
  const receivingLines = transferProgressLinesForStage(progress, "receiving");
  for (const line of outboundLines) await updateTransferOrderLineFromProgress(progress.id, line, "outbound");
  for (const line of receivingLines) await updateTransferOrderLineFromProgress(progress.id, line, "receiving");
  const outboundSummary = progressSummary(outboundLines);
  const receivingSummary = progressSummary(receivingLines);
  const outboundStatus = localOutboundStatusFromSummary(outboundSummary, progress.status_text);
  const receiptStatus = localReceiptStatusFromSummary(receivingSummary, progress.status_text, "purchase_order");
  await query(
    `UPDATE transfer_orders
        SET status = COALESCE($2, status),
            status_text = COALESCE($3, status_text),
            outbound_operator_status = $4,
            local_yard_order_status = $5,
            fulfillment_status = $6,
            receiving_status = $7,
            fulfilled_at = CASE WHEN $6 IN ('fulfilled', 'partial_fulfilled') THEN COALESCE(fulfilled_at, now()) ELSE fulfilled_at END,
            received_at = CASE WHEN $7 IN ('received', 'partial_received') THEN COALESCE(received_at, now()) ELSE received_at END,
            status_updated_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1`,
    [
      progress.id,
      progress.status || null,
      progress.status_text || null,
      outboundStatus.operatorStatus,
      outboundStatus.yardStatus,
      outboundStatus.fulfillmentStatus,
      receiptStatus
    ]
  );
  return {
    outbound: { lines: outboundLines.length, ...outboundSummary, ...outboundStatus },
    receiving: { lines: receivingLines.length, ...receivingSummary, receiptStatus }
  };
}

async function reconcileNetSuiteProgress({ actorOperatorId = null } = {}) {
  const summary = {
    salesOrders: { checked: 0, updated: 0, failed: 0 },
    purchaseOrders: { checked: 0, updated: 0, failed: 0 },
    transferOrders: { checked: 0, updated: 0, failed: 0 },
    failures: []
  };
  const targets = [
    {
      key: "salesOrders",
      table: "sales_orders",
      recordType: "SalesOrd",
      apply: reconcileSalesOrderProgress,
      where: `
        netsuite_id > 0
        AND tranid NOT LIKE '%-S%'
        AND NOT EXISTS (
          SELECT 1
            FROM sales_orders split_child
           WHERE split_child.tranid LIKE sales_orders.tranid || '-S%'
             AND split_child.netsuite_active = true
        )`
    },
    {
      key: "purchaseOrders",
      table: "purchase_orders",
      recordType: "PurchOrd",
      apply: reconcilePurchaseOrderProgress,
      where: "netsuite_id > 0"
    },
    {
      key: "transferOrders",
      table: "transfer_orders",
      recordType: "TrnfrOrd",
      apply: reconcileTransferOrderProgress,
      where: `
        netsuite_id > 0
        AND tranid NOT LIKE '%-S%'
        AND NOT EXISTS (
          SELECT 1
            FROM transfer_orders split_child
           WHERE split_child.tranid LIKE transfer_orders.tranid || '-S%'
             AND split_child.netsuite_active = true
        )`
    }
  ];
  for (const target of targets) {
    const ids = await query(`SELECT netsuite_id, tranid FROM ${target.table} WHERE ${target.where} ORDER BY synced_at ASC NULLS FIRST, netsuite_id`);
    for (const row of ids.rows) {
      assertDispatchSyncCanContinue(`progress reconcile ${row.tranid || row.netsuite_id}`);
      summary[target.key].checked += 1;
      try {
        const progress = await fetchTransactionProgressFromNetSuite(row.netsuite_id, target.recordType);
        if (!progress) continue;
        const result = await target.apply(progress);
        summary[target.key].updated += 1;
        await writeAudit({
          actorType: actorOperatorId ? "operator" : "system",
          actorOperatorId,
          source: "netsuite",
          action: "netsuite.progress_reconcile.order",
          orderId: row.netsuite_id,
          details: { table: target.table, tranid: row.tranid, result }
        });
      } catch (error) {
        summary[target.key].failed += 1;
        summary.failures.push({ orderType: target.key, netsuiteId: row.netsuite_id, tranid: row.tranid, error: error.message });
      }
    }
  }
  await writeAudit({
    actorType: actorOperatorId ? "operator" : "system",
    actorOperatorId,
    source: "netsuite",
    action: "netsuite.progress_reconcile",
    details: summary
  });
  emitAppEvent("dispatch.orders.updated", { source: "netsuite-progress-reconcile" });
  emitAppEvent("delivery.order.updated", { source: "netsuite-progress-reconcile" });
  emitAppEvent("receiving.order.updated", { source: "netsuite-progress-reconcile" });
  return summary;
}

async function runNetSuiteProgressReconcile({ source = "control_reconcile", actorOperatorId = null } = {}) {
  if (syncRunning) return { skipped: true, reason: "sync_running" };
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
    const reconciled = await reconcileNetSuiteProgress({ actorOperatorId });
    const finishedAt = new Date().toISOString();
    await writeDispatchSetup({
      sync: {
        running: false,
        lastFinishedAt: finishedAt,
        lastSource: source,
        lastStatus: reconciled.failures.length ? "warning" : "success",
        lastError: reconciled.failures.length ? `${reconciled.failures.length} order(s) could not be reconciled. Check audit log.` : ""
      }
    });
    return { reconciled, startedAt, finishedAt };
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
    if (stopped) return { stopped: true, startedAt, finishedAt, error: error.message };
    throw error;
  } finally {
    if (activeSyncRun?.id === runId) activeSyncRun = null;
    syncRunning = false;
  }
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

async function syncTransferPurchaseOrderFeed() {
  const deliveryResults = [];
  const receivingResults = [];
  for (const locationId of deliveryLocations) {
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

function webhookSignedNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : 0;
}

function webhookString(value) {
  return String(value ?? "").trim();
}

function webhookDate(value) {
  const text = webhookString(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return text;
}

function webhookLocationText(value) {
  const text = webhookString(value);
  if (text === "1") return "3445";
  if (text === "13" || text === "28") return "2967";
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

const EXCLUDED_SALES_ORDER_PREFIXES = ["SOT"];

function isExcludedSalesOrderRef(value) {
  const text = webhookString(value).toUpperCase();
  return EXCLUDED_SALES_ORDER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function webhookLineHasConversion(line) {
  return webhookNumber(line.to_plt ?? line.toPlt ?? line.custitem_toplt) > 0
    || webhookNumber(line.to_lyr ?? line.toLyr ?? line.custitem_tolyr) > 0
    || webhookNumber(line.to_sec ?? line.toSec ?? line.custitem_tosec) > 0
    || webhookNumber(line.to_pcs ?? line.toPcs ?? line.custitem_topcs) > 0;
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
    ["pallet_qty", "to_plt", "toPlt", "custitem_toplt"],
    ["layer_qty", "to_lyr", "toLyr", "custitem_tolyr"],
    ["section_qty", "to_sec", "toSec", "custitem_tosec"],
    ["piece_qty", "to_pcs", "toPcs", "custitem_topcs"]
  ];
  for (const [qtyField, snake, camel, netsuiteField] of conversions) {
    const conversion = webhookNumber(line[snake] ?? line[camel] ?? line[netsuiteField]);
    if (!conversion || remaining <= 0) continue;
    const units = Math.floor((remaining / conversion) + 0.000001);
    next[qtyField] = units;
    remaining = Number((remaining - (units * conversion)).toFixed(6));
  }
  return next;
}

function webhookLineLocationId(line, fallback = null) {
  const value = line.location_id ?? line.locationId ?? fallback;
  return value === null || value === undefined || value === "" ? "" : String(value);
}

function webhookProcessedQuantity(line, preferred = null, { fallbackOnZero = false } = {}) {
  const preferredNumber = webhookNumber(preferred);
  if (preferred !== null && preferred !== undefined && preferred !== "" && (preferredNumber > 0 || !fallbackOnZero)) {
    return preferredNumber;
  }
  return webhookNumber(
    line.netsuite_received_qty
    ?? line.quantityShipRecv
    ?? line.quantityshiprecv
    ?? line.quantityFulfilled
    ?? line.quantityReceived
    ?? line.quantityreceived
  );
}

function webhookLineSignedQuantity(line) {
  const signed = webhookSignedNumber(line.signedQuantity ?? line.signed_quantity ?? line.quantitySigned ?? line.quantity_signed);
  if (signed) return signed;
  return webhookSignedNumber(line.quantity);
}

function webhookLineDuplicateKey(line, fallbackLocationId = null) {
  return [
    line.item_id ?? line.itemId ?? "",
    webhookLineLocationId(line, fallbackLocationId),
    webhookNumber(line.quantity),
    line.item_description ?? line.itemDescription ?? line.description ?? "",
    webhookNumber(line.pallet_qty ?? line.pallets ?? line.custcol_plt ?? line.plt),
    webhookNumber(line.layer_qty ?? line.layers ?? line.custcol_lyr ?? line.lyr),
    webhookNumber(line.section_qty ?? line.sections ?? line.custcol_sec ?? line.sec),
    webhookNumber(line.piece_qty ?? line.pieces ?? line.custcol_pcs ?? line.pcs)
  ].join("|");
}

function dedupeWebhookTransferLines(lines, { locationId = null, direction = "source", processedField = null } = {}) {
  const targetLocation = locationId === null || locationId === undefined || locationId === "" ? "" : String(locationId);
  const filtered = lines.filter((line) => {
    const lineLocation = webhookLineLocationId(line);
    if (targetLocation && lineLocation) return lineLocation === targetLocation;
    if (targetLocation && !lineLocation) return true;
    const signedQuantity = webhookLineSignedQuantity(line);
    if (direction === "source") return signedQuantity < 0;
    if (direction === "destination") return signedQuantity > 0;
    return true;
  });

  const bestByDuplicateKey = new Map();
  for (const line of filtered) {
    const key = webhookLineDuplicateKey(line, locationId);
    const current = bestByDuplicateKey.get(key);
    if (
      !current
      || webhookProcessedQuantity(line, line[processedField], { fallbackOnZero: true })
        > webhookProcessedQuantity(current, current[processedField], { fallbackOnZero: true })
    ) {
      bestByDuplicateKey.set(key, line);
    }
  }
  return [...bestByDuplicateKey.values()];
}

function normalizeWebhookLine(line, { locationId = null, locationText = "", processedQuantity = null, remainingForDelivery = false } = {}) {
  const quantity = webhookNumber(line.quantity);
  const processed = webhookProcessedQuantity(line, processedQuantity);
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
    to_plt: line.to_plt ?? line.toPlt ?? line.custitem_toplt,
    to_lyr: line.to_lyr ?? line.toLyr ?? line.custitem_tolyr,
    to_sec: line.to_sec ?? line.toSec ?? line.custitem_tosec,
    to_pcs: line.to_pcs ?? line.toPcs ?? line.custitem_topcs,
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
    const deliveryLines = dedupeWebhookTransferLines(lines, {
      locationId: sourceLocationId,
      direction: "source",
      processedField: "quantityShipRecv"
    }).map((line) => normalizeWebhookLine(line, {
      locationId: sourceLocationId,
      locationText: sourceLocationText,
      processedQuantity: line.quantityShipRecv ?? line.quantityFulfilled,
      remainingForDelivery: true
    })).filter((line) => webhookNumber(line.quantity) > 0);
    await upsertOutboundTransferOrders([deliveryOrder]);
    await upsertOutboundTransferOrderLines(deliveryOrder.id, deliveryLines);
    await markMissingOutboundOrderLines(deliveryOrder.id, deliveryLines.map((line) => line.line_id));
    results.push({ target: "transfer_orders.outbound", orderType: type, lines: deliveryLines.length });

    const receivingOrder = normalizeWebhookReceivingOrder(payload, { type, locationId: destinationLocationId, locationText: destinationLocationText });
    const receivingLines = dedupeWebhookTransferLines(lines, {
      locationId: destinationLocationId,
      direction: "destination",
      processedField: "quantityShipRecv"
    }).map((line) => normalizeWebhookLine(line, {
      locationId: destinationLocationId,
      locationText: destinationLocationText,
      processedQuantity: line.quantityReceived ?? line.quantityShipRecv,
      remainingForDelivery: true
    })).filter((line) => webhookNumber(line.quantity) > 0);
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
    await writeAudit({
      actorType: "system",
      source: "netsuite-webhook",
      action: "netsuite.webhook.failed",
      details: {
        error: error.message,
        netsuiteOrderId: req.body?.id || null,
        tranid: req.body?.tranid || "",
        recordType: req.body?.recordType || req.body?.type || req.body?.orderType || "",
        eventType: req.body?.eventType || ""
      }
    }).catch(() => {});
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
  } else if (req.path.endsWith(".webmanifest") || ["/", "/operator", "/driver", "/control", "/operator.html", "/driver.html", "/control.html"].includes(req.path)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});

app.use("/vendor/qr-scanner", express.static(qrScannerDir));
app.use(express.static(publicDir));

app.use("/api/scm", requireOperator, requireScmAccess);
app.use("/api/dispatch", requireOperator, requireDispatchAccess);

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

app.get("/api/dispatch/plan-edit-lease", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json({ lease: await getDispatchPlanEditLease(req.query.planDate || req.query.date || "") });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plan-edit-lease/acquire", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const acquired = await acquireDispatchPlanEditLease(dispatchEditLeaseInput(req));
    await writeDispatchAudit({
      action: acquired.replacedExpired ? "dispatch_plan_edit_lease_expired_takeover" : acquired.renewed ? "dispatch_plan_edit_lease_renewed" : "dispatch_plan_edit_lease_acquired",
      entityType: "plan",
      entityId: acquired.lease.planDate,
      planDate: acquired.lease.planDate,
      operatorId: req.operator.id,
      operatorName: req.operator.display_name || req.operator.username,
      sessionId: acquired.lease.sessionId,
      details: { expiresAt: acquired.lease.expiresAt }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.edit_lease_changed", {
      planDate: acquired.lease.planDate,
      lease: acquired.lease,
      sourceSessionId: acquired.lease.sessionId
    });
    res.json({ lease: acquired.lease, editLeaseToken: acquired.token });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.post("/api/dispatch/plan-edit-lease/heartbeat", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json({ lease: await heartbeatDispatchPlanEditLease(dispatchEditLeaseInput(req)) });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.post("/api/dispatch/plan-edit-lease/release", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const released = await releaseDispatchPlanEditLease(dispatchEditLeaseInput(req));
    if (released) {
      await writeDispatchAudit({
        action: "dispatch_plan_edit_lease_released",
        entityType: "plan",
        entityId: released.planDate,
        planDate: released.planDate,
        operatorId: req.operator.id,
        operatorName: req.operator.display_name || req.operator.username,
        sessionId: released.sessionId
      }).catch(() => null);
      emitAppEvent("dispatch.plan.edit_lease_changed", {
        planDate: released.planDate,
        lease: null,
        sourceSessionId: released.sessionId
      });
    }
    res.json({ released: Boolean(released) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plans", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req, req.body?.planDate);
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
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.get("/api/dispatch/plan-snapshots", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    res.json(await listDispatchPlanSnapshots({ planDate: req.query.date }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/plan-snapshots/:snapshotId", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const snapshot = await getDispatchPlanSnapshot(req.params.snapshotId);
    if (!snapshot) return res.status(404).json({ error: "Dispatch snapshot not found" });
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/plan-snapshots/:snapshotId/restore", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    if (String(req.params.snapshotId || "").startsWith("current-")) {
      return res.status(409).json({ error: "The current active version is already active." });
    }
    const beforePlan = await getDispatchPlanSnapshot(req.params.snapshotId);
    if (!beforePlan) return res.status(404).json({ error: "Dispatch snapshot not found" });
    await requireDispatchPlanEditLease(req, beforePlan.planDate);
    const restored = await restoreDispatchPlanSnapshot(req.params.snapshotId, {
      sessionId: req.body?.audit?.sessionId || ""
    });
    const plan = restored.plan;
    const coAssignments = await applyDispatchPlanCoAssignments(plan);
    const scmSchedule = await syncScmScheduleFromDispatchPlan(plan, { updatedBy: req.body?.audit?.sessionId || "dispatch-plan-save" }).catch(() => null);
    const changedOperatorRefs = [...dispatchOperatorAssignmentMap(plan).keys()];
    const operatorFlags = plan.status === "confirmed"
      ? await applyConfirmedDispatchPlanToDelivery(plan, { forceOrderRefs: changedOperatorRefs })
      : null;
    await writeDispatchAudit({
      action: "dispatch_plan_snapshot_restored",
      entityType: "plan",
      entityId: String(plan.id),
      planId: plan.id,
      planDate: plan.planDate,
      sessionId: req.body?.audit?.sessionId,
      before: {
        snapshotId: req.params.snapshotId,
        revision: restored.previousRevision
      },
      after: plan,
      details: {
        restoredSnapshotId: req.params.snapshotId,
        previousRevision: restored.previousRevision,
        restoredRevision: plan.revision,
        restoredOrderCount: plan.orders.length,
        restoredTruckCount: plan.trucks.length,
        restoredLoadCount: (plan.trucks || []).reduce((sum, truck) => sum + (truck.loads || []).length, 0),
        restoredStopCount: (plan.trucks || []).reduce((sum, truck) => sum + (truck.loads || []).reduce((loadSum, load) => loadSum + (load.stops || []).length, 0), 0),
        sourceArchivedAt: beforePlan.archivedAt,
        coAssignments,
        operatorFlags
      }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.saved", {
      planId: plan.id,
      planDate: plan.planDate,
      savedAt: plan.savedAt,
      sourceSessionId: req.body?.audit?.sessionId,
      operatorFlags,
      changedOperatorRefs,
      refreshOrderPool: true,
      restoredSnapshotId: req.params.snapshotId
    });
    res.json({ plan, restoredSnapshot: restored.restoredSnapshot, operatorFlags, coAssignments });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
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

app.get("/api/dispatch/plans/:id/revision", async (req, res, next) => {
  try {
    const revision = await getDispatchPlanRevision(req.params.id);
    if (!revision) return res.status(404).json({ error: "Dispatch plan not found" });
    res.json(revision);
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/plans/:id", requireOperator, requireDispatcher, async (req, res, next) => {
  let previousPlan = null;
  try {
    previousPlan = await getDispatchPlan(req.params.id);
    if (!previousPlan) return res.status(404).json({ error: "Dispatch plan not found" });
    await requireDispatchPlanEditLease(req, previousPlan.planDate);
    const forceSave = req.body?.forceSave === true;
    const requestedPlanDate = String(req.body?.planDate || req.body?.date || previousPlan?.planDate || "").slice(0, 10);
    const existingPlanDate = String(previousPlan?.planDate || "").slice(0, 10);
    if (previousPlan && requestedPlanDate && existingPlanDate && requestedPlanDate !== existingPlanDate) {
      throw new DispatchPlanDateMismatchError({
        planId: req.params.id,
        expectedPlanDate: existingPlanDate,
        payloadPlanDate: requestedPlanDate
      });
    }
    const saveMode = dispatchPlanSaveMode(req.body);
    const requestedOrders = sanitizeDispatchPlanOrders(Array.isArray(req.body?.orders) ? req.body.orders : []);
    const requestedTrucks = Array.isArray(req.body?.trucks) ? req.body.trucks : [];
    const cleanOrders = saveMode === "truck_sequence" && previousPlan
      ? sanitizeDispatchPlanOrders(previousPlan.orders || [])
      : requestedOrders;
    const cleanTrucks = saveMode === "truck_sequence" && previousPlan
      ? mergeDispatchTruckSequence(previousPlan.trucks || [], requestedTrucks)
      : requestedTrucks;
    const duplicateDrivers = dispatchDuplicateDriverAssignments(cleanTrucks);
    if (duplicateDrivers.length) return sendDispatchDuplicateDriverResponse(res, duplicateDrivers);
    const explicitOperatorAlertRefs = Array.isArray(req.body?.audit?.details?.operatorAlertRefs)
      ? req.body.audit.details.operatorAlertRefs.map((ref) => String(ref || "").trim()).filter(Boolean)
      : [];
    const refreshOrderPool = req.body?.audit?.details?.refreshOrderPool === true;
    if (
      previousPlan
      && !explicitOperatorAlertRefs.length
      && !dispatchPlanDataChanged(
        { orders: previousPlan.orders || [], trucks: previousPlan.trucks || [] },
        { orders: cleanOrders, trucks: cleanTrucks }
      )
    ) {
      return res.json({ ...previousPlan, operatorFlags: null, noChange: true });
    }
    const dateConflicts = await findNewDispatchPlanDateConflicts(previousPlan || {}, {
      id: req.params.id,
      planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
      orders: cleanOrders,
      trucks: cleanTrucks
    });
    if (dateConflicts.length) return sendDispatchPlanDateConflictResponse(res, dateConflicts);
    const coSequenceConflicts = await findDispatchCoSequenceConflicts({
      id: req.params.id,
      planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
      orders: cleanOrders,
      trucks: cleanTrucks
    });
    if (coSequenceConflicts.length) return sendDispatchCoSequenceConflictResponse(res, coSequenceConflicts);
    const plan = await saveDispatchPlanSnapshot(req.params.id, {
      orders: cleanOrders,
      trucks: cleanTrucks,
      summary: req.body?.summary || {},
      baseRevision: forceSave || saveMode === "truck_sequence" ? null : req.body?.baseRevision,
      planDate: req.body?.planDate || req.body?.date || "",
      sessionId: req.body?.audit?.sessionId || ""
    });
    const coAssignments = await applyDispatchPlanCoAssignments(plan);
    const scmSchedule = await syncScmScheduleFromDispatchPlan(plan, {
      updatedBy: req.body?.audit?.sessionId || "dispatch-plan-save"
    }).catch(() => null);
    const changedOperatorRefs = [
      ...new Set([...changedDispatchOperatorRefs(previousPlan || {}, plan), ...explicitOperatorAlertRefs])
    ];
    let operatorFlags = null;
    const shouldApplyOperatorFlags = plan.status === "confirmed"
      && (changedOperatorRefs.length > 0 || dispatchOperatorImpactChanged(previousPlan || {}, plan));
    if (shouldApplyOperatorFlags) {
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
          saveMode,
          forceSave,
          coAssignments,
          scmSchedule,
          operatorFlags,
          operatorFlagsSkipped: plan.status === "confirmed" && !shouldApplyOperatorFlags
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.plan.saved", { planId: plan.id, planDate: plan.planDate, savedAt: plan.savedAt, sourceSessionId: req.body?.audit?.sessionId, operatorFlags, changedOperatorRefs, refreshOrderPool, scmSchedule, forceSave });
    res.json({ ...plan, operatorFlags, scmSchedule });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    if (error instanceof DispatchPlanDateMismatchError) {
      await writeDispatchAudit({
        action: "dispatch.plan.date_mismatch_blocked",
        entityType: "plan",
        entityId: String(req.params.id),
        planId: req.params.id,
        planDate: error.expectedPlanDate || previousPlan?.planDate || "",
        actorType: "system",
        source: "dispatch",
        sessionId: req.body?.audit?.sessionId || "",
        details: {
          expectedPlanDate: error.expectedPlanDate,
          payloadPlanDate: error.payloadPlanDate,
          saveMode: dispatchPlanSaveMode(req.body),
          orderCount: Array.isArray(req.body?.orders) ? req.body.orders.length : 0,
          truckCount: Array.isArray(req.body?.trucks) ? req.body.trucks.length : 0
        }
      }).catch(() => null);
      return res.status(409).json({
        error: error.message,
        code: error.code,
        expectedPlanDate: error.expectedPlanDate,
        payloadPlanDate: error.payloadPlanDate
      });
    }
    if (error instanceof StaleDispatchPlanSaveError) {
      await writeDispatchAudit({
        action: "dispatch.plan.stale_save_debug",
        entityType: "plan",
        entityId: String(req.params.id),
        planId: req.params.id,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date || "",
        actorType: "system",
        source: "dispatch",
        sessionId: req.body?.audit?.sessionId || "",
        details: {
          expectedRevision: error.expectedRevision,
          currentRevision: error.currentRevision,
          saveMode: dispatchPlanSaveMode(req.body),
          orderCount: Array.isArray(req.body?.orders) ? req.body.orders.length : 0,
          truckCount: Array.isArray(req.body?.trucks) ? req.body.trucks.length : 0
        }
      }).catch(() => null);
      return sendStaleDispatchPlanResponse(res, error);
    }
    next(error);
  }
});

app.post("/api/dispatch/plans/:id/confirm", requireOperator, requireDispatcher, async (req, res, next) => {
  let previousPlan = null;
  try {
    previousPlan = await getDispatchPlan(req.params.id);
    if (!previousPlan) return res.status(404).json({ error: "Dispatch plan not found" });
    await requireDispatchPlanEditLease(req, previousPlan.planDate);
    const hasSubmittedSnapshot = Array.isArray(req.body?.orders) || Array.isArray(req.body?.trucks);
    let planForConfirm = previousPlan;
    if (hasSubmittedSnapshot) {
      const requestedPlanDate = String(req.body?.planDate || req.body?.date || previousPlan?.planDate || "").slice(0, 10);
      const existingPlanDate = String(previousPlan?.planDate || "").slice(0, 10);
      if (requestedPlanDate && existingPlanDate && requestedPlanDate !== existingPlanDate) {
        throw new DispatchPlanDateMismatchError({
          planId: req.params.id,
          expectedPlanDate: existingPlanDate,
          payloadPlanDate: requestedPlanDate
        });
      }
      const requestedOrders = sanitizeDispatchPlanOrders(Array.isArray(req.body?.orders) ? req.body.orders : previousPlan.orders || []);
      const requestedTrucks = Array.isArray(req.body?.trucks) ? req.body.trucks : previousPlan.trucks || [];
      const duplicateDrivers = dispatchDuplicateDriverAssignments(requestedTrucks);
      if (duplicateDrivers.length) return sendDispatchDuplicateDriverResponse(res, duplicateDrivers);
      const dateConflicts = await findNewDispatchPlanDateConflicts(previousPlan || {}, {
        id: req.params.id,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
        orders: requestedOrders,
        trucks: requestedTrucks
      });
      if (dateConflicts.length) return sendDispatchPlanDateConflictResponse(res, dateConflicts);
      const coSequenceConflicts = await findDispatchCoSequenceConflicts({
        id: req.params.id,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date,
        orders: requestedOrders,
        trucks: requestedTrucks
      });
      if (coSequenceConflicts.length) return sendDispatchCoSequenceConflictResponse(res, coSequenceConflicts);
      if (dispatchPlanDataChanged(
        { orders: previousPlan.orders || [], trucks: previousPlan.trucks || [] },
        { orders: requestedOrders, trucks: requestedTrucks }
      )) {
        planForConfirm = await saveDispatchPlanSnapshot(req.params.id, {
          orders: requestedOrders,
          trucks: requestedTrucks,
          summary: req.body?.summary || {},
          baseRevision: req.body?.baseRevision,
          planDate: req.body?.planDate || req.body?.date || "",
          sessionId: req.body?.audit?.sessionId || ""
        });
      }
    }
    const duplicateDrivers = dispatchDuplicateDriverAssignments(planForConfirm?.trucks || []);
    if (duplicateDrivers.length) return sendDispatchDuplicateDriverResponse(res, duplicateDrivers);
    const plan = await confirmDispatchPlan(req.params.id, { note: req.body?.note || "" });
    const coAssignments = await applyDispatchPlanCoAssignments(plan);
    const scmSchedule = await syncScmScheduleFromDispatchPlan(plan, { updatedBy: req.body?.audit?.sessionId || "dispatch-plan-confirm" }).catch(() => null);
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
      details: {
        ...(req.body?.audit?.details || {}),
        status: plan.status,
        submittedSnapshot: hasSubmittedSnapshot,
        savedSnapshotBeforeConfirm: String(planForConfirm?.revision || "") !== String(previousPlan?.revision || ""),
        coAssignments,
        scmSchedule,
        operatorFlags
      }
    }).catch(() => null);
    emitAppEvent("dispatch.plan.confirmed", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId, operatorFlags, changedOperatorRefs, refreshOrderPool: true, scmSchedule });
    res.json({ ...plan, operatorFlags, scmSchedule });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    if (error instanceof DispatchPlanDateMismatchError) {
      await writeDispatchAudit({
        action: "dispatch.plan.date_mismatch_blocked",
        entityType: "plan",
        entityId: String(req.params.id),
        planId: req.params.id,
        planDate: error.expectedPlanDate || previousPlan?.planDate || "",
        actorType: "system",
        source: "dispatch",
        sessionId: req.body?.audit?.sessionId || "",
        details: {
          expectedPlanDate: error.expectedPlanDate,
          payloadPlanDate: error.payloadPlanDate,
          saveMode: "confirm",
          orderCount: Array.isArray(req.body?.orders) ? req.body.orders.length : 0,
          truckCount: Array.isArray(req.body?.trucks) ? req.body.trucks.length : 0
        }
      }).catch(() => null);
      return res.status(409).json({
        error: error.message,
        code: error.code,
        expectedPlanDate: error.expectedPlanDate,
        payloadPlanDate: error.payloadPlanDate
      });
    }
    if (error instanceof StaleDispatchPlanSaveError) {
      await writeDispatchAudit({
        action: "dispatch.plan.stale_save_debug",
        entityType: "plan",
        entityId: String(req.params.id),
        planId: req.params.id,
        planDate: previousPlan?.planDate || req.body?.planDate || req.body?.date || "",
        actorType: "system",
        source: "dispatch",
        sessionId: req.body?.audit?.sessionId || "",
        details: {
          expectedRevision: error.expectedRevision,
          currentRevision: error.currentRevision,
          saveMode: "confirm",
          orderCount: Array.isArray(req.body?.orders) ? req.body.orders.length : 0,
          truckCount: Array.isArray(req.body?.trucks) ? req.body.trucks.length : 0
        }
      }).catch(() => null);
      return sendStaleDispatchPlanResponse(res, error);
    }
    next(error);
  }
});

app.post("/api/dispatch/plans/:id/reopen", requireOperator, requireDispatcher, async (req, res, next) => {
  try {
    const existingPlan = await getDispatchPlan(req.params.id);
    if (!existingPlan) return res.status(404).json({ error: "Dispatch plan not found" });
    await requireDispatchPlanEditLease(req, existingPlan.planDate);
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
    emitAppEvent("dispatch.plan.reopened", { planId: plan.id, planDate: plan.planDate, sourceSessionId: req.body?.audit?.sessionId, refreshOrderPool: true });
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
    res.json(await listDispatchOrdersForResponse({ type }));
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    next(error);
  }
});

app.get("/api/dispatch/sales-order-methods", async (req, res, next) => {
  try {
    res.json(await searchSalesOrderMethodOverrides({
      search: req.query.search || "",
      limit: req.query.limit || 30
    }));
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/sales-order-methods/:tranid", async (req, res, next) => {
  try {
    const before = (await searchSalesOrderMethodOverrides({ search: req.params.tranid, limit: 1 }))[0] || null;
    const updated = await updateSalesOrderLocalMethod(req.params.tranid, {
      method: req.body?.method,
      updatedBy: operatorId(req)
    });
    if (!updated) return res.status(404).json({ error: "Sales order not found in local DB. Sync the order first, then update local method." });
    await writeDispatchAudit({
      action: "sales_order_local_method_updated",
      entityType: "sales_order",
      entityId: updated.netsuiteId,
      orderId: updated.tranid,
      operatorId: req.operator?.id,
      operatorName: req.operator?.display_name || req.operator?.username,
      before,
      after: updated,
      details: {
        requestedMethod: req.body?.method,
        netSuiteMethod: updated.netsuiteMethod,
        overrideActive: updated.overrideActive
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { orderId: updated.tranid, change: "sales_order_local_method" });
    res.json({ updated, orders: await listDispatchOrdersForResponse({ type: "SO" }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/schedule", async (req, res, next) => {
  try {
    res.json(await listScmSchedule({
      search: req.query.search || "",
      status: req.query.status || "",
      method: req.query.method || "",
      kind: req.query.kind || "",
      yard: req.query.dropoffPoint || req.query.yard || "",
      brand: req.query.brand || "",
      from: req.query.from || "",
      to: req.query.to || "",
      view: req.query.view || ""
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/schedule", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const updated = await updateScmScheduleEntry({
      orderKind: req.body?.orderKind || req.body?.order_kind,
      orderRef: req.body?.orderRef || req.body?.order_ref,
      patch: req.body || {},
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.schedule.updated",
      entityType: "scm_schedule",
      entityId: `${updated.order_kind}:${updated.order_ref}`,
      orderId: updated.order_ref,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      after: updated
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-schedule", orderId: updated.order_ref });
    res.json({ updated, schedule: await listScmSchedule() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/schedule/:id", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const updated = await updateScmScheduleEntry({
      orderKind: req.body?.orderKind || req.body?.order_kind,
      orderRef: req.params.id,
      patch: req.body || {},
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.schedule.updated",
      entityType: "scm_schedule",
      entityId: `${updated.order_kind}:${updated.order_ref}`,
      orderId: updated.order_ref,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      after: updated
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-schedule", orderId: updated.order_ref });
    res.json({ updated, schedule: await listScmSchedule() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/schedule-groups", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const grouped = await createScmScheduleGroup({
      refs: req.body?.refs || [],
      createdBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.schedule_group.created",
      entityType: "scm_schedule_group",
      entityId: grouped.groupRef,
      orderId: grouped.groupRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      after: grouped
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-group", orderId: grouped.groupRef });
    res.json({ grouped, schedule: await listScmSchedule() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scm/schedule-groups/:groupRef", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const cancelled = await cancelScmScheduleGroup({
      groupRef: req.params.groupRef,
      cancelledBy: operator?.id || req.query.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.schedule_group.cancelled",
      entityType: "scm_schedule_group",
      entityId: cancelled.groupRef,
      orderId: cancelled.groupRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.query.sessionId,
      source: "scm",
      after: cancelled
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-group-cancel", orderId: cancelled.groupRef });
    res.json({ cancelled, schedule: await listScmSchedule() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scm/view-presets", async (req, res, next) => {
  try {
    res.json(await listScmViewPresets());
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/view-presets", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const preset = await upsertScmViewPreset({
      id: req.body?.id || null,
      name: req.body?.name,
      description: req.body?.description,
      config: req.body?.config || {},
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    res.json({ preset, presets: await listScmViewPresets() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/view-presets/:id", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const preset = await upsertScmViewPreset({
      id: req.params.id,
      name: req.body?.name,
      description: req.body?.description,
      config: req.body?.config || {},
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    res.json({ preset, presets: await listScmViewPresets() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scm/vrma-orders", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const created = await createScmVrmaOrder({
      vrmaRef: req.body?.vrmaRef || req.body?.vrma_ref,
      vendor: req.body?.vendor,
      localVendor: req.body?.localVendor || req.body?.local_vendor,
      pickupLocation: req.body?.pickupLocation || req.body?.pickup_location,
      dropoffLocation: req.body?.dropoffLocation || req.body?.dropoff_location,
      status: req.body?.status,
      method: req.body?.method,
      notes: req.body?.notes,
      lines: req.body?.lines || [],
      createdBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "scm.vrma_order.upserted",
      entityType: "scm_vrma_order",
      entityId: req.body?.vrmaRef || req.body?.vrma_ref,
      orderId: req.body?.vrmaRef || req.body?.vrma_ref,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "scm",
      after: created
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-vrma", type: "PO", orderId: req.body?.vrmaRef || req.body?.vrma_ref });
    res.json({ created, schedule: await listScmSchedule() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/scm/vrma-orders/:id", async (req, res, next) => {
  try {
    req.body.vrmaRef = req.params.id;
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const updated = await createScmVrmaOrder({
      vrmaRef: req.params.id,
      vendor: req.body?.vendor,
      localVendor: req.body?.localVendor || req.body?.local_vendor,
      pickupLocation: req.body?.pickupLocation || req.body?.pickup_location,
      dropoffLocation: req.body?.dropoffLocation || req.body?.dropoff_location,
      status: req.body?.status,
      method: req.body?.method,
      notes: req.body?.notes,
      lines: req.body?.lines || [],
      createdBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    emitAppEvent("dispatch.orders.updated", { source: "scm-vrma", type: "PO", orderId: req.params.id });
    res.json({ updated, schedule: await listScmSchedule() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/scm/purchase-orders", async (req, res, next) => {
  try {
    res.json(await listScmPurchaseOrders({
      search: req.query.search || "",
      dropoff: req.query.dropoff || "",
      vendor: req.query.vendor || "",
      pickupPoint: req.query.pickupPoint || ""
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/scm/purchase-order-splits", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const created = await createScmPurchaseOrderSplit({
      sourcePoRef: req.body?.sourcePoRef,
      newPoRef: req.body?.newPoRef,
      pickupPoint: req.body?.pickupPoint,
      destinationLocationId: req.body?.destinationLocationId,
      lines: req.body?.lines,
      createdBy: operator?.id || req.body?.audit?.sessionId || "",
      details: {
        sessionId: req.body?.audit?.sessionId || "",
        source: "dispatch-scm"
      }
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_created",
      entityType: "purchase_order",
      entityId: created.split?.splitPoRef,
      orderId: created.split?.splitPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      after: created.split,
      details: {
        sourcePoRef: created.split?.sourcePoRef,
        splitPoRef: created.split?.splitPoRef,
        lineCount: created.lines?.length || 0
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split", type: "PO", orderId: created.split?.splitPoRef });
    res.json({ created, orders: await listScmPurchaseOrders() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/scm/purchase-orders/:ref/ref", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const updated = await updatePurchaseOrderDispatchRef({
      poRef: req.params.ref,
      newRef: req.body?.newRef,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.purchase_order_ref_updated",
      entityType: "purchase_order",
      entityId: updated.displayRef,
      orderId: updated.displayRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      before: { displayRef: updated.oldDisplayRef },
      after: { displayRef: updated.displayRef, dispatchRef: updated.dispatchRef },
      details: {
        poRef: updated.poRef,
        updatedPlans: updated.updatedPlans
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-ref", type: "PO", orderId: updated.displayRef });
    emitAppEvent("receiving.order.updated", { source: "scm-po-ref", type: "PO", orderId: updated.poId });
    res.json({ updated, orders: await listScmPurchaseOrders() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/scm/purchase-order-splits/:ref", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const updated = await updateScmPurchaseOrderSplitRef({
      splitPoRef: req.params.ref,
      newPoRef: req.body?.newPoRef,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_ref_updated",
      entityType: "purchase_order",
      entityId: updated.newPoRef,
      orderId: updated.newPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      before: { splitPoRef: updated.oldPoRef },
      after: { splitPoRef: updated.newPoRef },
      details: {
        sourcePoRef: updated.sourcePoRef,
        updatedPlans: updated.updatedPlans
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split-rename", type: "PO", orderId: updated.newPoRef });
    res.json({ updated, orders: await listScmPurchaseOrders() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/scm/purchase-order-splits/:ref/destination", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const updated = await updateScmPurchaseOrderSplitDestination({
      splitPoRef: req.params.ref,
      destinationLocationId: req.body?.destinationLocationId,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_destination_updated",
      entityType: "purchase_order",
      entityId: updated.splitPoRef,
      orderId: updated.splitPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      before: {
        destinationLocationId: updated.oldDestinationLocationId,
        destinationLocation: updated.oldDestinationLocation
      },
      after: {
        destinationLocationId: updated.destinationLocationId,
        destinationLocation: updated.destinationLocation
      },
      details: {
        sourcePoRef: updated.sourcePoRef
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split-destination", type: "PO", orderId: updated.splitPoRef });
    emitAppEvent("receiving.order.updated", { source: "scm-po-split-destination", type: "PO", orderId: updated.splitPoId });
    res.json({ updated, orders: await listScmPurchaseOrders() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/scm/purchase-order-splits/:ref/pickup", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const updated = await updateScmPurchaseOrderSplitPickupYard({
      splitPoRef: req.params.ref,
      pickupPoint: req.body?.pickupPoint,
      updatedBy: operator?.id || req.body?.audit?.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_pickup_updated",
      entityType: "purchase_order",
      entityId: updated.splitPoRef,
      orderId: updated.splitPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.body?.audit?.sessionId,
      source: "dispatch-scm",
      before: { pickupPoint: updated.oldPickupPoint },
      after: { pickupPoint: updated.pickupPoint, pickupAddress: updated.pickupAddress },
      details: {
        sourcePoRef: updated.sourcePoRef
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split-pickup", type: "PO", orderId: updated.splitPoRef });
    emitAppEvent("receiving.order.updated", { source: "scm-po-split-pickup", type: "PO", orderId: updated.splitPoId });
    res.json({ updated, orders: await listScmPurchaseOrders() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/scm/purchase-order-splits/:ref", async (req, res, next) => {
  try {
    const operator = await getOperatorByToken(bearerToken(req)).catch(() => null);
    const cancelled = await cancelScmPurchaseOrderSplit({
      splitPoRef: req.params.ref,
      cancelledBy: operator?.id || req.query.sessionId || ""
    });
    await writeDispatchAudit({
      action: "dispatch.scm_po_split_cancelled",
      entityType: "purchase_order",
      entityId: cancelled.splitPoRef,
      orderId: cancelled.splitPoRef,
      operatorId: operator?.id,
      operatorName: operator?.display_name || operator?.username,
      sessionId: req.query.sessionId,
      source: "dispatch-scm",
      before: { splitPoRef: cancelled.splitPoRef },
      after: { status: "cancelled" },
      details: {
        sourcePoRef: cancelled.sourcePoRef,
        updatedPlans: cancelled.updatedPlans
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", { source: "scm-po-split-cancelled", type: "PO", orderId: cancelled.splitPoRef });
    res.json({ cancelled, orders: await listScmPurchaseOrders() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/planned-assignments", async (req, res, next) => {
  try {
    res.json(await listDispatchPlannedAssignments());
  } catch (error) {
    next(error);
  }
});

app.get("/api/dispatch/orders/:id/split-seed", async (req, res, next) => {
  try {
    res.json(await getNextDispatchSplitSuffix({
      originalOrderId: req.params.id,
      orderType: req.query.type
    }));
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
      orders: await listDispatchOrdersForResponse({ type })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/enrich", async (req, res, next) => {
  try {
    const enriched = await refreshDispatchEnrichment({ force: req.body?.force === true || req.query.force === "true" });
    emitAppEvent("dispatch.orders.updated", { source: "enrich", type: req.query.type ? String(req.query.type).toUpperCase() : null });
    res.json({ enriched, orders: await listDispatchOrdersForResponse({ type: req.query.type ? String(req.query.type).toUpperCase() : null }) });
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

app.post("/api/dispatch/reparse-missing-delivery-time", async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === "true";
    const scope = req.body?.scope || req.query.scope || "missing";
    const result = await reparseMissingSalesOrderDispatch({
      limit: req.body?.limit || req.query.limit || 200,
      dryRun,
      scope
    });
    const allNonShipped = result.scope === "non_shipped";
    await writeDispatchAudit({
      action: dryRun
        ? (allNonShipped ? "dry_run_reparse_non_shipped_delivery_orders" : "dry_run_reparse_missing_delivery_time")
        : (allNonShipped ? "reparse_non_shipped_delivery_orders" : "reparse_missing_delivery_time"),
      entityType: "sales_orders",
      entityId: allNonShipped ? "non-shipped-sales-delivery-orders" : "missing-dispatch-parser-fields",
      source: "dispatch-setup",
      after: {
        matched: result.matched,
        updated: result.updated,
        failed: result.failed,
        resolvedTime: result.resolvedTime,
        resolvedAddress: result.resolvedAddress
      },
      details: {
        limit: result.limit,
        dryRun
      }
    });
    if (!dryRun) emitAppEvent("dispatch.orders.updated", { source: allNonShipped ? "reparse-non-shipped-delivery-orders" : "reparse-missing-delivery-time", result });
    res.json(result);
  } catch (error) {
    if (error instanceof StaleDispatchPlanSaveError) return sendStaleDispatchPlanResponse(res, error);
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
    await requireDispatchPlanEditLease(req);
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
    res.json({ updated, orders: await listDispatchOrdersForResponse({ type: "PO" }) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/dispatch/orders/:id/details", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
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
    res.json({ updated, orders: await listDispatchOrdersForResponse() });
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
    await requireDispatchPlanEditLease(req);
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
    res.json({ allocations, allocation: allocations[0] || null, options: await getSalesOrderPoAllocationOptions(req.params.id), orders: await listDispatchOrdersForResponse() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/po-allocations/:allocationId", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
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
    res.json({ cancelled, options: await getSalesOrderPoAllocationOptions(cancelled.salesOrderRef), orders: await listDispatchOrdersForResponse() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/split-orders/unsplit", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
    const result = await deactivateUnplannedDispatchSplitOrders({
      originalOrderId: req.body?.originalOrderId,
      orderType: req.body?.orderType,
      splitOrderIds: req.body?.splitOrderIds
    });
    await writeDispatchAudit({
      action: "dispatch_split_orders_deactivated",
      entityType: "order",
      entityId: req.body?.originalOrderId || "",
      orderId: req.body?.originalOrderId || "",
      sessionId: req.body?.audit?.sessionId,
      after: result,
      details: {
        originalOrderId: req.body?.originalOrderId || "",
        orderType: req.body?.orderType || "",
        splitOrderIds: req.body?.splitOrderIds || []
      }
    }).catch(() => null);
    emitAppEvent("dispatch.orders.updated", {
      orderId: req.body?.originalOrderId || "",
      change: "order_unsplit",
      sourceSessionId: req.body?.audit?.sessionId,
      refreshOrderPool: true
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/co-orders", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
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
    res.json({ co });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dispatch/co-orders/:coRef", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
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
    res.json({ cancelled, orders: await listDispatchOrdersForResponse() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dispatch/operator-requests", async (req, res, next) => {
  try {
    await requireDispatchPlanEditLease(req);
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
    const saveMode = dispatchPlanSaveMode(req.body);
    const requestedOrders = sanitizeDispatchPlanOrders(Array.isArray(req.body?.orders) ? req.body.orders : []);
    const requestedTrucks = Array.isArray(req.body?.trucks) ? req.body.trucks : [];
    const planDate = req.body?.planDate || req.body?.date || new Date().toISOString().slice(0, 10);
    await requireDispatchPlanEditLease(req, planDate);
    let plan = req.body?.planId ? await getDispatchPlan(req.body.planId) : await getCurrentDispatchPlan({ planDate });
    if (!plan) plan = await createDispatchPlan({ planDate });
    const previousPlan = plan;
    const cleanOrders = saveMode === "truck_sequence" && previousPlan
      ? sanitizeDispatchPlanOrders(previousPlan.orders || [])
      : requestedOrders;
    const cleanTrucks = saveMode === "truck_sequence" && previousPlan
      ? mergeDispatchTruckSequence(previousPlan.trucks || [], requestedTrucks)
      : requestedTrucks;
    const duplicateDrivers = dispatchDuplicateDriverAssignments(cleanTrucks);
    if (duplicateDrivers.length) return sendDispatchDuplicateDriverResponse(res, duplicateDrivers);
    const payload = {
      savedAt: new Date().toISOString(),
      orders: cleanOrders,
      trucks: cleanTrucks
    };
    const explicitOperatorAlertRefs = Array.isArray(req.body?.audit?.details?.operatorAlertRefs)
      ? req.body.audit.details.operatorAlertRefs.map((ref) => String(ref || "").trim()).filter(Boolean)
      : [];
    const refreshOrderPool = req.body?.audit?.details?.refreshOrderPool === true;
    if (
      previousPlan
      && !explicitOperatorAlertRefs.length
      && !dispatchPlanDataChanged(
        { orders: previousPlan.orders || [], trucks: previousPlan.trucks || [] },
        { orders: payload.orders, trucks: payload.trucks }
      )
    ) {
      return res.json({ ...previousPlan, operatorFlags: null, noChange: true });
    }
    const dateConflicts = await findNewDispatchPlanDateConflicts(previousPlan || {}, {
      id: plan.id,
      planDate: plan.planDate || planDate,
      orders: payload.orders,
      trucks: payload.trucks
    });
    if (dateConflicts.length) return sendDispatchPlanDateConflictResponse(res, dateConflicts);
    const coSequenceConflicts = await findDispatchCoSequenceConflicts({
      id: plan.id,
      planDate: plan.planDate || planDate,
      orders: payload.orders,
      trucks: payload.trucks
    });
    if (coSequenceConflicts.length) return sendDispatchCoSequenceConflictResponse(res, coSequenceConflicts);
    const savedPlan = await saveDispatchPlanSnapshot(plan.id, {
      orders: payload.orders,
      trucks: payload.trucks,
      summary: req.body?.summary || {},
      baseRevision: saveMode === "truck_sequence" ? null : req.body?.baseRevision
    });
    const coAssignments = await applyDispatchPlanCoAssignments(savedPlan);
    const changedOperatorRefs = [
      ...new Set([...changedDispatchOperatorRefs(previousPlan || {}, savedPlan), ...explicitOperatorAlertRefs])
    ];
    let operatorFlags = null;
    const shouldApplyOperatorFlags = savedPlan.status === "confirmed"
      && (changedOperatorRefs.length > 0 || dispatchOperatorImpactChanged(previousPlan || {}, savedPlan));
    if (shouldApplyOperatorFlags) {
      operatorFlags = await applyConfirmedDispatchPlanToDelivery(savedPlan, { forceOrderRefs: changedOperatorRefs });
    }
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
          truckCount: payload.trucks.length,
          saveMode,
          coAssignments,
          operatorFlags,
          operatorFlagsSkipped: savedPlan.status === "confirmed" && !shouldApplyOperatorFlags
        }
      }).catch(() => null);
    }
    emitAppEvent("dispatch.plan.saved", { planId: savedPlan.id, planDate: savedPlan.planDate, savedAt: savedPlan.savedAt, sourceSessionId: req.body?.audit?.sessionId, operatorFlags, changedOperatorRefs, refreshOrderPool });
    res.json({ ...savedPlan, operatorFlags });
  } catch (error) {
    if (error instanceof DispatchPlanEditLeaseError) return sendDispatchPlanEditLeaseError(res, error);
    if (error instanceof StaleDispatchPlanSaveError) return sendStaleDispatchPlanResponse(res, error);
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

app.get("/dispatch/sales-order-methods", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-sales-order-methods.html"));
});

app.get("/dispatch/scm", (req, res) => {
  res.redirect("/scm/POsplit");
});

app.get("/scm", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-menu.html"));
});

app.get("/scm/POsplit", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-scm.html"));
});

app.get("/scm/POTOschedule", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-schedule.html"));
});

app.get("/scm/VRMA", (req, res) => {
  res.sendFile(path.join(publicDir, "scm-vrma.html"));
});

app.get("/dispatch/dvir", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-dvir.html"));
});

app.get("/dispatch/snapshot", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-snapshot.html"));
});

app.get("/dispatch/monitor", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-monitor.html"));
});

app.get("/dispatch/statistics", (req, res) => {
  res.sendFile(path.join(publicDir, "dispatch-statistics.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
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
    const dayState = await getDriverDayState(login, { samsaraAccounts: samsaraAccountsForDriver(driver) });
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
        samsaraAccounts: samsaraAccountsForDriver(req.driver)
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
      samsaraAccounts: samsaraAccountsForDriver(req.driver)
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
    const samsaraAccounts = samsaraAccountsForDriver(req.driver);
    const state = await getDriverDayState(req.driverLogin, { samsaraAccounts });
    if (type === "post" && !state.allJobsComplete) {
      return res.status(409).json({ error: "MBBS post-trip inspection is only available after all assigned stops are complete.", state });
    }
    const result = await submitDriverDvir(req.driverLogin, {
      type,
      photoDataUrls: req.body?.photoDataUrls,
      samsaraAccounts,
      samsaraDvirAuthorId: (await readDispatchSetup()).samsara?.dvirAuthorId || config.samsara.dvirAuthorId || ""
    });
    writeAudit({
      actorType: "driver",
      source: "samsara",
      action: type === "post" ? "driver.post_dvir.submitted" : "driver.pre_dvir.submitted",
      details: {
        driverLogin: req.driverLogin,
        samsaraUsername: result.samsaraUsername || "",
        samsaraAccount: result.samsaraAccount || "",
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
      samsaraAccounts: samsaraAccountsForDriver(req.driver)
    });
    if (state.truckPlate && (state.preDvirStatus !== "complete" || !state.samsaraOnDutyConfirmed || !state.samsaraPreDvirConfirmed)) {
      const suffix = state.preDvirStatus === "complete"
        ? " Samsara DVIR and On Duty confirmation are required."
        : "";
      return res.status(428).json({ error: `MBBS pre-trip inspection must be received by Samsara before assigned jobs.${suffix}`, state });
    }
    res.json({ job: await getNextDriverJob(req.driverLogin), rest: await getActiveDriverRest(req.driverLogin) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/rest/start", requireDriver, async (req, res, next) => {
  try {
    const nextJob = await getNextDriverJob(req.driverLogin);
    const rest = await startDriverRest(req.driverLogin, { nextJob });
    emitAppEvent("driver.rest.started", { driverLogin: req.driverLogin, restId: rest.restId, nextJobId: rest.nextJobId || null });
    res.json({ rest, job: nextJob });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/rest/end", requireDriver, async (req, res, next) => {
  try {
    const rest = await endDriverRest(req.driverLogin);
    const job = await getNextDriverJob(req.driverLogin);
    emitAppEvent("driver.rest.ended", { driverLogin: req.driverLogin, restId: rest?.restId || null, nextJobId: job?.jobId || null });
    res.json({ rest, job });
  } catch (error) {
    next(error);
  }
});

app.post("/api/driver/jobs/:jobId/start", requireDriver, async (req, res, next) => {
  try {
    const activeRest = await getActiveDriverRest(req.driverLogin);
    if (activeRest) return res.status(409).json({ error: "End rest time before starting the next job.", rest: activeRest });
    const job = await getNextDriverJob(req.driverLogin);
    if (!job || job.jobId !== req.params.jobId) return res.status(409).json({ error: "This is no longer the next assigned job. Refresh and try again." });
    const samsaraHandoff = await ensureDriverSamsaraDutyForJob(req.driverLogin, {
      samsaraAccounts: samsaraAccountsForDriver(req.driver)
    });
    const record = await startDriverJob(req.driverLogin, req.params.jobId, { job });
    emitAppEvent("driver.job.started", { driverLogin: req.driverLogin, jobId: req.params.jobId, stopType: job.stopType, orderRefs: job.orderRefs || [], samsaraHandoff });
    res.json({ record, job: await getNextDriverJob(req.driverLogin), samsaraHandoff });
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
    let nextJob = await getNextDriverJob(req.driverLogin);
    let rest = null;
    if (nextJob && req.body?.autoStartRest === true) {
      rest = await startDriverRest(req.driverLogin, { nextJob });
      emitAppEvent("driver.rest.started", { driverLogin: req.driverLogin, restId: rest.restId, nextJobId: rest.nextJobId || null });
    } else if (nextJob && req.body?.autoStartNext !== false) {
      await ensureDriverSamsaraDutyForJob(req.driverLogin, {
        samsaraAccounts: samsaraAccountsForDriver(req.driver)
      });
      await startDriverJob(req.driverLogin, nextJob.jobId, { job: nextJob });
      nextJob = await getNextDriverJob(req.driverLogin);
    }
    emitAppEvent("driver.job.completed", { driverLogin: req.driverLogin, jobId: req.params.jobId, stopType: job.stopType, nextJobId: nextJob?.jobId || null });
    res.json({ record, nextJob, rest, locationCheck });
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

app.get("/api/control/vendor-mappings", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listDispatchVendorMappings());
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/vendor-mappings/discover", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const result = await discoverDispatchVendorMappingsFromPurchaseOrders();
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "vendor_mapping.discover",
      details: { scanned: result.scanned, inserted: result.inserted, updated: result.updated, enriched }
    });
    emitAppEvent("dispatch.orders.updated", { source: "vendor-mapping-discover", enriched });
    res.json({ ...result, enriched });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/local-vendors", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const created = await createDispatchLocalVendor({
      name: req.body?.name,
      updatedBy: req.operator.display_name || req.operator.username || req.operator.id
    });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "local_vendor.create",
      details: { localVendor: created }
    });
    res.json({ created, ...(await listDispatchVendorMappings()) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/local-vendors/:id", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const updated = await updateDispatchLocalVendor(req.params.id, {
      name: req.body?.name,
      active: req.body?.active,
      updatedBy: req.operator.display_name || req.operator.username || req.operator.id
    });
    if (!updated) return res.status(404).json({ error: "Local vendor not found." });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "local_vendor.update",
      details: { localVendor: updated, enriched }
    });
    emitAppEvent("dispatch.vendor_mapping.updated", { localVendorId: req.params.id });
    emitAppEvent("dispatch.orders.updated", { source: "local-vendor-update", enriched });
    res.json({ updated, enriched, ...(await listDispatchVendorMappings()) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/control/vendor-mappings/:id", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    const updated = await updateDispatchVendorMapping(req.params.id, {
      ...req.body,
      updatedBy: req.operator.display_name || req.operator.username || req.operator.id
    });
    if (!updated) return res.status(404).json({ error: "Vendor mapping not found." });
    const enriched = await refreshDispatchEnrichment({ force: true, delivery: false, receiving: true });
    await writeAudit({
      actorOperatorId: req.operator.id,
      source: "control",
      action: "vendor_mapping.update",
      details: { mapping: updated, enriched }
    });
    emitAppEvent("dispatch.vendor_mapping.updated", { id: req.params.id });
    emitAppEvent("dispatch.orders.updated", { source: "vendor-mapping", enriched });
    res.json({ updated, enriched, ...(await listDispatchVendorMappings()) });
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

app.post("/api/control/sync-transfer-orders", requireOperator, requireAdmin, async (req, res, next) => {
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
    const source = "control_inbound_transfer_manual";
    const runner = runDispatchSync({ source, actorOperatorId: req.operator.id, orderScope: "transfer_purchase_order" });
    runner.catch((error) => {
      console.error("Background NetSuite TO/PO sync failed:", error);
    });
    res.status(202).json({
      started: true,
      background: true,
      message: "Transfer/Purchase Order sync started.",
      settings: {
        ...(await readDispatchSetup()).sync,
        running: true,
        lastStartedAt: startedAt,
        lastSource: source,
        lastStatus: "running",
        lastError: ""
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/control/netsuite-progress/reconcile", requireOperator, requireAdmin, async (req, res, next) => {
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
    const runner = runNetSuiteProgressReconcile({ source: "control_progress_reconcile", actorOperatorId: req.operator.id });
    runner.catch((error) => {
      console.error("Background NetSuite progress reconcile failed:", error);
    });
    res.status(202).json({
      started: true,
      background: true,
      message: "NetSuite progress reconcile started.",
      settings: {
        ...(await readDispatchSetup()).sync,
        running: true,
        lastStartedAt: startedAt,
        lastSource: "control_progress_reconcile",
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
      operatorId: req.query.operatorId,
      from: req.query.from,
      to: req.query.to,
      actor: req.query.actor,
      action: req.query.action,
      tranid: req.query.tranid
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/audit/options", requireOperator, requireAdmin, async (req, res, next) => {
  try {
    res.json(await listAuditOptions({
      from: req.query.from,
      to: req.query.to,
      tranid: req.query.tranid
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
      orderId: auditOrderId(req.params.id),
      details: { orderRef: req.params.id, orderType, found: Boolean(order), lines: order?.lines?.length || 0 }
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

app.get("/api/delivery/load-trucks", async (req, res, next) => {
  try {
    res.json(await listDeliveryLoadTrucks({
      locationId: req.query.locationId,
      planDate: req.query.planDate
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/load-orders", async (req, res, next) => {
  try {
    res.json(await listDeliveryLoadOrders({
      locationId: req.query.locationId,
      status: req.query.status,
      planDate: req.query.planDate,
      truckPlate: req.query.truckPlate
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/saved-orders", async (req, res, next) => {
  try {
    res.json(await listSavedDeliveryOrdersForOperator(operatorId(req), {
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/delivery/saved-order-keys", async (req, res, next) => {
  try {
    res.json(await listSavedDeliveryOrderKeysForOperator(operatorId(req), {
      locationId: req.query.locationId
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/delivery/saved-orders", async (req, res, next) => {
  try {
    res.json(await saveDeliveryOrderForOperator(operatorId(req), {
      locationId: req.body?.locationId || req.query.locationId,
      orderId: req.body?.orderId
    }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/delivery/saved-orders/:id", async (req, res, next) => {
  try {
    res.json(await removeSavedDeliveryOrderForOperator(operatorId(req), {
      locationId: req.query.locationId || req.body?.locationId,
      orderId: req.params.id
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

app.get("/api/delivery/current-draft", async (req, res, next) => {
  try {
    res.json(await getCurrentOperatorDeliveryDraft(operatorId(req), {
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
    if (req.query.orderType === "all") {
      const destinationLocationId = req.query.destinationLocationId || req.query.locationId || null;
      const [purchaseOrders, transferOrders, coOrders] = await Promise.all([
        listReceivingOrders({
          orderType: "purchase_order",
          destinationLocationId,
          search: req.query.search || null,
          itemSearch: req.query.itemSearch || null
        }),
        listReceivingOrders({
          orderType: "transfer_order",
          destinationLocationId,
          search: req.query.search || null,
          itemSearch: req.query.itemSearch || null
        }),
        listLocalCoReceivingOrders({
          destinationLocationId,
          search: req.query.search || null,
          itemSearch: req.query.itemSearch || null
        })
      ]);
      return res.json([...purchaseOrders, ...transferOrders, ...coOrders].sort((a, b) => {
        const dateCompare = String(b.trandate || "").localeCompare(String(a.trandate || ""));
        if (dateCompare) return dateCompare;
        return String(b.tranid || "").localeCompare(String(a.tranid || ""));
      }).slice(0, 200));
    }
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
    if (req.query.orderType === "all") {
      const destinationLocationId = req.query.destinationLocationId || req.query.locationId || null;
      const [purchaseItems, transferItems, coItems] = await Promise.all([
        searchReceivingItems({ orderType: "purchase_order", destinationLocationId, search: req.query.search || "" }),
        searchReceivingItems({ orderType: "transfer_order", destinationLocationId, search: req.query.search || "" }),
        searchLocalCoItems({ destinationLocationId, search: req.query.search || "" })
      ]);
      const byName = new Map();
      for (const item of [...purchaseItems, ...transferItems, ...coItems]) {
        const key = String(item.item_name || item.item_id || "").toLowerCase();
        const current = byName.get(key) || { ...item, order_count: 0 };
        current.order_count = Number(current.order_count || 0) + Number(item.order_count || 0);
        current.item_description = current.item_description || item.item_description || "";
        byName.set(key, current);
      }
      return res.json([...byName.values()].sort((a, b) => Number(b.order_count || 0) - Number(a.order_count || 0)).slice(0, 12));
    }
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
    const requestedType = req.query.orderType || "";
    if (requestedType !== "co_order") {
      const order = await getReceivingOrder(req.params.id);
      if (order) return res.json(order);
    }
    if (requestedType === "co_order" || String(req.params.id).startsWith("CO-") || Number(req.params.id) < 0) {
      const localOrder = await getLocalCoReceivingOrder(req.params.id);
      if (!localOrder) return res.status(404).json({ error: "Local CO not found" });
      return res.json(localOrder);
    }
    return res.status(404).json({ error: "Receiving order not found" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/lines/:lineId/confirm", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
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

app.post("/api/receiving/orders/:id/lines/:lineId/unconfirm", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
      const result = await unconfirmLocalCoReceivingLine(req.params.id, req.params.lineId, operatorId(req));
      emitAppEvent("receiving.line.unconfirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: "co_order", operatorId: operatorId(req) });
      return res.json(result);
    }
    const result = await unconfirmReceivingLine(req.params.id, req.params.lineId, operatorId(req));
    emitAppEvent("receiving.line.unconfirmed", { orderId: req.params.id, lineId: req.params.lineId, orderType: req.body?.orderType || null, operatorId: operatorId(req) });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/receiving/orders/:id/receive", async (req, res, next) => {
  try {
    if (req.body?.orderType === "co_order" || String(req.params.id).startsWith("CO-")) {
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

app.post("/api/delivery/orders/:id/release-draft", async (req, res, next) => {
  try {
    const order = await releaseCurrentDeliveryDraft(req.params.id, operatorId(req));
    emitAppEvent("delivery.order.updated", {
      orderId: req.params.id,
      status: order?.operator_status || null,
      change: "draft_released",
      operatorId: operatorId(req)
    });
    res.json({ ok: true, order });
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

app.post("/api/delivery/orders/:id/lines/confirm-page", async (req, res, next) => {
  try {
    const result = await confirmDeliveryLines(req.params.id, req.body?.lines || [], operatorId(req));
    emitAppEvent("delivery.line.confirmed", { orderId: req.params.id, count: result.confirmed, operatorId: operatorId(req), bulk: true });
    res.json({ ok: true, ...result });
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
  updateReceivingJob(jobId, { stage: "validating", message: "Checking confirmed receiving lines." });
  const order = await getReceivableReceivingOrder(orderId);
  updateReceivingJob(jobId, {
    stage: "payload",
    message: `Recording ${order.receivableLines.length} confirmed line(s) locally.`
  });
  const payload = buildItemReceiptPayload(order, order.receivableLines);
  updateReceivingJob(jobId, {
    stage: "local_record",
    message: "Saving local receiving record.",
    payload,
    payloadSummary: {
      receiveLines: payload.item.items.filter((item) => item.itemReceive !== false).length,
      skipLines: payload.item.items.filter((item) => item.itemReceive === false).length
    }
  });
  updateReceivingJob(jobId, {
    stage: "recording",
    message: "Recording receipt locally.",
    itemReceiptId: null,
    itemReceiptTranid: null
  });
  const record = await recordReceivingReceipt(orderId, currentOperatorId, {
    photoDataUrls: body?.photoDataUrls,
    payload,
    response: { localOnly: true },
    itemReceiptId: null,
    itemReceiptTranid: null
  });
  updateReceivingJob(jobId, {
    stage: "complete",
    message: "Receipt recorded locally.",
    itemReceiptId: record.itemReceiptId,
    itemReceiptTranid: record.itemReceiptTranid
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
  if (error instanceof DispatchPlanEditLeaseError) {
    return sendDispatchPlanEditLeaseError(res, error);
  }
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
