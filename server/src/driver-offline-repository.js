import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { normalizeDispatchPlanLoadAssignments } from "./dispatch-load-assignment.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { planJobsForDriver } from "./driver-repository.js";
import {
  MBT_DRIVER_BIN_JOB_SCHEMA,
  normalizeMbtDriverEventDetails
} from "./mbt/driver-bin-contract.js";

export const DRIVER_OFFLINE_SCHEMA_VERSION = 1;
export const DRIVER_OFFLINE_FINGERPRINT_VERSION = 1;
export const DRIVER_OFFLINE_ROUTE_START = "route-start:v1";
export const DRIVER_OFFLINE_EVENT_TYPES = Object.freeze([
  "job_started",
  "job_completed",
  "rest_started",
  "rest_ended",
  "truck_switched_physical",
  "dvir_captured"
]);
export const DRIVER_OFFLINE_LOCATION_STATUSES = Object.freeze([
  "not_checked_offline",
  "verified",
  "warning_overridden",
  "not_required"
]);

const EVENT_TYPES = new Set(DRIVER_OFFLINE_EVENT_TYPES);
const LOCATION_STATUSES = new Set(DRIVER_OFFLINE_LOCATION_STATUSES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const DRIVER_SESSION_DAYS = 14;
const DRIVER_CLIENT_SYNC_ISSUE_DAYS = 7;
const TORONTO_TIME_ZONE = "America/Toronto";
const MAX_FUTURE_OCCURRENCE_SKEW_MS = 5 * 60 * 1000;
const EVIDENCE_ONLY_STALE_MS = 5 * 60 * 1000;
const EVIDENCE_ONLY_RESOLVABLE_STATUSES = new Set([
  "registered",
  "waiting_photos",
  "pending",
  "review_required",
  "blocked"
]);
const RETRYABLE_OFFLINE_STATUSES = new Set([
  "registered",
  "waiting_photos",
  "pending",
  "blocked"
]);

function repositoryError(message, status = 400, code = "DRIVER_OFFLINE_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function requiredText(value, label, { maxLength = 512 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) throw repositoryError(`${label} is required.`);
  if (text.length > maxLength) throw repositoryError(`${label} is too long.`);
  return text;
}

function optionalText(value, { maxLength = 2048 } = {}) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw repositoryError("A submitted value is too long.");
  return text;
}

function uuidValue(value, label) {
  const text = requiredText(value, label, { maxLength: 64 }).toLowerCase();
  if (!UUID_PATTERN.test(text)) throw repositoryError(`${label} must be a UUID.`);
  return text;
}

function sha256Value(value, label = "SHA-256") {
  const text = requiredText(value, label, { maxLength: 64 }).toLowerCase();
  if (!SHA256_PATTERN.test(text)) throw repositoryError(`${label} is invalid.`);
  return text;
}

function integerValue(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw repositoryError(`${label} is invalid.`);
  }
  return number;
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw repositoryError(`${label} is invalid.`);
  return date.toISOString();
}

function occurrenceTimestamp(value) {
  const raw = requiredText(
    value instanceof Date ? value.toISOString() : value,
    "Event occurrence time",
    { maxLength: 160 }
  );
  const date = new Date(raw);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp)
    ? {
        occurredAt: date.toISOString(),
        occurredAtRaw: raw,
        occurrenceTimeValid: timestamp <= Date.now() + MAX_FUTURE_OCCURRENCE_SKEW_MS
      }
    : { occurredAt: new Date().toISOString(), occurredAtRaw: raw, occurrenceTimeValid: false };
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashCanonical(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function pick(source, keys) {
  const output = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) output[key] = source[key];
  }
  return output;
}

function normalizeScalar(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return String(value).trim();
}

export function stableJson(value) {
  const normalize = (item) => {
    if (item === null || item === undefined) return null;
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key])])
      );
    }
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function normalizeDriverLogin(value) {
  return requiredText(value, "Driver login", { maxLength: 160 }).toLowerCase();
}

export function normalizeDriverDeviceId(value) {
  const deviceId = requiredText(value, "Driver device ID", { maxLength: 160 });
  if (deviceId.length < 8) throw repositoryError("Driver device ID is too short.");
  return deviceId;
}

export function normalizePlanDate(value) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || "").slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw repositoryError("Plan date must use YYYY-MM-DD.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) {
    throw repositoryError("Plan date is invalid.");
  }
  return text;
}

function timeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function zonedDateTimeUtc(year, month, day, hour, minute = 0, second = 0, timeZone = TORONTO_TIME_ZONE) {
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desiredAsUtc;
  for (let index = 0; index < 3; index += 1) {
    const parts = timeZoneParts(new Date(guess), timeZone);
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    guess = desiredAsUtc - (representedAsUtc - guess);
  }
  return new Date(guess);
}

export function torontoManifestExpiry(planDate) {
  const date = normalizePlanDate(planDate);
  const [year, month, day] = date.split("-").map(Number);
  const following = new Date(Date.UTC(year, month - 1, day + 1));
  return zonedDateTimeUtc(
    following.getUTCFullYear(),
    following.getUTCMonth() + 1,
    following.getUTCDate(),
    12
  );
}

function sanitizeItem(item = {}) {
  return compactObject({
    itemName: optionalText(item.itemName ?? item.name ?? item.sku, { maxLength: 300 }),
    sku: optionalText(item.sku ?? item.itemName ?? item.name, { maxLength: 160 }),
    description: optionalText(item.description ?? item.itemDescription, { maxLength: 1000 }),
    units: Array.isArray(item.units)
      ? item.units.slice(0, 12).map((entry) => {
          const unit = optionalText(entry?.unit ?? entry?.label ?? entry?.uom, { maxLength: 80 });
          return compactObject({
            unit,
            label: unit,
            value: normalizeScalar(entry?.value ?? entry?.quantity),
            fallback: entry?.fallback === true ? true : undefined
          });
        })
      : undefined,
    quantity: normalizeScalar(item.quantity),
    unit: optionalText(item.unit, { maxLength: 80 }),
    palletQty: normalizeScalar(item.palletQty ?? item.pallets),
    layerQty: normalizeScalar(item.layerQty ?? item.layers),
    sectionQty: normalizeScalar(item.sectionQty ?? item.sections),
    pieceQty: normalizeScalar(item.pieceQty ?? item.pieces)
  });
}

function sanitizeOrder(order = {}) {
  return compactObject({
    orderRef: optionalText(order.orderRef ?? order.id, { maxLength: 180 }),
    orderType: optionalText(order.orderType ?? order.type, { maxLength: 40 }),
    party: optionalText(order.party ?? order.customer ?? order.vendor, { maxLength: 300 }),
    source: optionalText(order.source, { maxLength: 80 }),
    items: Array.isArray(order.items) ? order.items.slice(0, 500).map(sanitizeItem) : []
  });
}

function sanitizeDeliveryInstructions(value = {}) {
  return compactObject({
    revision: Number.isSafeInteger(Number(value.revision)) ? Number(value.revision) : 0,
    orders: Array.isArray(value.orders) ? value.orders.slice(0, 500).map((order) => compactObject({
      orderId: normalizeScalar(order?.orderId),
      orderRef: optionalText(order?.orderRef, { maxLength: 180 }),
      customer: optionalText(order?.customer, { maxLength: 300 }),
      automaticText: optionalText(order?.automaticText, { maxLength: 20000 }),
      fallbackUsed: order?.fallbackUsed === true ? true : undefined,
      phones: Array.isArray(order?.phones) ? order.phones.slice(0, 30).map((phone) => compactObject({
        display: optionalText(phone?.display, { maxLength: 80 }),
        href: optionalText(phone?.href, { maxLength: 100 })
      })) : [],
      additionalText: optionalText(order?.additionalText, { maxLength: 5000 }),
      media: Array.isArray(order?.media) ? order.media.slice(0, 5).map((media) => compactObject({
        id: optionalText(media?.id, { maxLength: 80 }),
        mediaKind: optionalText(media?.mediaKind, { maxLength: 20 }),
        mimeType: optionalText(media?.mimeType, { maxLength: 120 }),
        fileName: optionalText(media?.fileName, { maxLength: 255 }),
        byteSize: Number.isSafeInteger(Number(media?.byteSize)) ? Number(media.byteSize) : 0,
        position: Number.isSafeInteger(Number(media?.position)) ? Number(media.position) : 0,
        revision: Number.isSafeInteger(Number(media?.revision)) ? Number(media.revision) : 0,
        updatedAt: optionalText(media?.updatedAt, { maxLength: 80 }),
        contentUrl: optionalText(media?.contentUrl, { maxLength: 500 }),
        onlineOnly: media?.onlineOnly === true ? true : undefined
      })) : []
    })) : []
  });
}

function stripEmptyMbtValues(value) {
  if (Array.isArray(value)) return value.map(stripEmptyMbtValues);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== "")
    .map(([key, item]) => [key, stripEmptyMbtValues(item)]));
}

function sanitizeMbtDriverAsset(asset) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return null;
  return stripEmptyMbtValues(compactObject({
    assetId: optionalText(asset.assetId, { maxLength: 64 }),
    assetCode: optionalText(asset.assetCode, { maxLength: 200 }),
    qrCode: optionalText(asset.qrCode, { maxLength: 500 }),
    binTypeId: optionalText(asset.binTypeId, { maxLength: 64 }),
    binTypeCode: optionalText(asset.binTypeCode, { maxLength: 80 }),
    lifecycleStatus: optionalText(asset.lifecycleStatus, { maxLength: 80 }),
    locationKind: optionalText(asset.locationKind, { maxLength: 80 }),
    locationReference: optionalText(asset.locationReference, { maxLength: 500 }),
    stateRevision: Number.isSafeInteger(Number(asset.stateRevision))
      ? Number(asset.stateRevision)
      : undefined
  }));
}

function sanitizeMbtOperationalParty(value = {}) {
  return stripEmptyMbtValues(compactObject({
    displayName: optionalText(value.displayName, { maxLength: 300 }),
    name: optionalText(value.name, { maxLength: 300 }),
    customerNumber: optionalText(value.customerNumber, { maxLength: 120 }),
    contactName: optionalText(value.contactName, { maxLength: 300 }),
    phone: optionalText(value.phone, { maxLength: 100 }),
    email: optionalText(value.email, { maxLength: 320 })
  }));
}

function sanitizeMbtOperationalSite(value = {}) {
  return stripEmptyMbtValues(compactObject({
    siteProfileId: optionalText(value.siteProfileId, { maxLength: 64 }),
    displayName: optionalText(value.displayName, { maxLength: 300 }),
    addressLine1: optionalText(value.addressLine1, { maxLength: 500 }),
    addressLine2: optionalText(value.addressLine2, { maxLength: 500 }),
    city: optionalText(value.city, { maxLength: 200 }),
    province: optionalText(value.province, { maxLength: 100 }),
    state: optionalText(value.state, { maxLength: 100 }),
    postalCode: optionalText(value.postalCode, { maxLength: 40 }),
    country: optionalText(value.country, { maxLength: 100 }),
    accessInstructions: optionalText(value.accessInstructions, { maxLength: 2000 }),
    contactName: optionalText(value.contactName, { maxLength: 300 }),
    contactPhone: optionalText(value.contactPhone, { maxLength: 100 }),
    latitude: Number.isFinite(Number(value.latitude)) ? Number(value.latitude) : undefined,
    longitude: Number.isFinite(Number(value.longitude)) ? Number(value.longitude) : undefined
  }));
}

function sanitizeMbtDumpSite(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return stripEmptyMbtValues({
    dumpSiteId: optionalText(value.dumpSiteId, { maxLength: 64 }),
    code: optionalText(value.code, { maxLength: 120 }),
    displayName: optionalText(value.displayName, { maxLength: 300 }),
    address: optionalText(value.address, { maxLength: 1000 })
  });
}

function sanitizeMbtMaterial(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return stripEmptyMbtValues({
    materialId: optionalText(value.materialId, { maxLength: 64 }),
    code: optionalText(value.code, { maxLength: 120 }),
    displayName: optionalText(value.displayName, { maxLength: 300 }),
    description: optionalText(value.description, { maxLength: 1000 })
  });
}

function sanitizeMbtDriverJob(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (String(value.schemaVersion || "") !== MBT_DRIVER_BIN_JOB_SCHEMA) {
    throw repositoryError("The BIN Driver job schema is unsupported.", 409, "MBT_DRIVER_BIN_JOB_INVALID");
  }
  const requirements = Array.isArray(value.evidenceRequirements)
    ? value.evidenceRequirements.slice(0, 100).map((requirement) => compactObject({
        requirementId: optionalText(requirement?.requirementId, { maxLength: 64 }),
        evidenceCode: optionalText(requirement?.evidenceCode, { maxLength: 80 }),
        evidenceType: optionalText(requirement?.evidenceType, { maxLength: 40 }),
        minimumCount: Number.isSafeInteger(Number(requirement?.minimumCount))
          ? Number(requirement.minimumCount)
          : undefined,
        required: requirement?.required === true
      }))
    : [];
  return stripEmptyMbtValues(compactObject({
    schemaVersion: MBT_DRIVER_BIN_JOB_SCHEMA,
    minimumClientVersion: optionalText(value.minimumClientVersion, { maxLength: 80 }),
    contractId: optionalText(value.contractId, { maxLength: 64 }),
    contractNumber: optionalText(value.contractNumber, { maxLength: 180 }),
    visitId: optionalText(value.visitId, { maxLength: 64 }),
    visitReference: optionalText(value.visitReference, { maxLength: 180 }),
    visitNumber: Number.isSafeInteger(Number(value.visitNumber)) ? Number(value.visitNumber) : undefined,
    issuedVisitRevision: Number.isSafeInteger(Number(value.issuedVisitRevision))
      ? Number(value.issuedVisitRevision)
      : undefined,
    serviceAction: optionalText(value.serviceAction, { maxLength: 80 }),
    actionCode: optionalText(value.actionCode, { maxLength: 80 }),
    visitStepId: optionalText(value.visitStepId, { maxLength: 64 }),
    stepSequence: Number.isSafeInteger(Number(value.stepSequence)) ? Number(value.stepSequence) : undefined,
    stopGroupId: optionalText(value.stopGroupId, { maxLength: 180 }),
    stopSequence: Number.isSafeInteger(Number(value.stopSequence)) ? Number(value.stopSequence) : undefined,
    mandatory: value.mandatory === true,
    serviceTemplateVersionId: optionalText(value.serviceTemplateVersionId, { maxLength: 64 }),
    templateRevision: Number.isSafeInteger(Number(value.templateRevision))
      ? Number(value.templateRevision)
      : undefined,
    binTypeId: optionalText(value.binTypeId, { maxLength: 64 }),
    binTypeCode: optionalText(value.binTypeCode, { maxLength: 80 }),
    exactAssets: {
      expected: sanitizeMbtDriverAsset(value.exactAssets?.expected),
      outgoing: sanitizeMbtDriverAsset(value.exactAssets?.outgoing),
      incoming: sanitizeMbtDriverAsset(value.exactAssets?.incoming)
    },
    dumpSiteId: value.dumpSiteId ? optionalText(value.dumpSiteId, { maxLength: 64 }) : null,
    materialId: value.materialId ? optionalText(value.materialId, { maxLength: 64 }) : null,
    dumpSite: value.dumpSite === undefined ? undefined : sanitizeMbtDumpSite(value.dumpSite),
    material: value.material === undefined ? undefined : sanitizeMbtMaterial(value.material),
    customerSiteProfileId: optionalText(value.customerSiteProfileId, { maxLength: 64 }),
    customer: sanitizeMbtOperationalParty(value.customer),
    site: sanitizeMbtOperationalSite(value.site),
    evidenceRequirements: requirements,
    movementExpectation: compactObject({
      beforeStatus: value.movementExpectation?.beforeStatus === null
        ? null
        : optionalText(value.movementExpectation?.beforeStatus, { maxLength: 80 }),
      afterStatus: value.movementExpectation?.afterStatus === null
        ? null
        : optionalText(value.movementExpectation?.afterStatus, { maxLength: 80 })
    }),
    capabilitySnapshot: compactObject({
      truckType: optionalText(value.capabilitySnapshot?.truckType, { maxLength: 40 }),
      binTypeCode: optionalText(value.capabilitySnapshot?.binTypeCode, { maxLength: 80 }),
      baseYardId: optionalText(value.capabilitySnapshot?.baseYardId, { maxLength: 64 }),
      baseYardCode: optionalText(value.capabilitySnapshot?.baseYardCode, { maxLength: 80 })
    }),
    assignment: compactObject({
      planId: value.assignment?.planId === null
        ? null
        : optionalText(value.assignment?.planId, { maxLength: 180 }),
      planRevision: Number.isSafeInteger(Number(value.assignment?.planRevision))
        ? Number(value.assignment.planRevision)
        : undefined,
      loadId: value.assignment?.loadId === null
        ? null
        : optionalText(value.assignment?.loadId, { maxLength: 180 }),
      truckId: value.assignment?.truckId === null
        ? null
        : optionalText(value.assignment?.truckId, { maxLength: 180 }),
      driverId: value.assignment?.driverId === null
        ? null
        : optionalText(value.assignment?.driverId, { maxLength: 180 })
    }),
    executionSnapshotHash: optionalText(value.executionSnapshotHash, { maxLength: 64 })
  }));
}

export function sanitizeDriverOfflineJob(job = {}) {
  const sanitized = pick(job, [
    "jobId",
    "planId",
    "planDate",
    "driverLogin",
    "driverName",
    "truckId",
    "truckPlate",
    "fromTruckId",
    "fromTruckPlate",
    "nextTruckId",
    "nextTruckPlate",
    "parkingSpot",
    "switchYard",
    "plannedSwitchMinute",
    "truckSwitchMinutes",
    "loadId",
    "loadName",
    "stopId",
    "stopType",
    "location",
    "pickupLocation",
    "dropLocation",
    "address",
    "dropAddress",
    "fromLocation",
    "fromJobLocation",
    "fromAddress",
    "toLocation",
    "toAddress",
    "toPickupLocation",
    "destinationLocationId",
    "lineRowIds",
    "physicalVisitJobIds",
    "physicalVisitStopIds",
    "consolidatedPhysicalVisit",
    "windowStart",
    "windowEnd",
    "instructions",
    "deliveryInstructions",
    "orderRefs",
    "orderTypes",
    "dependencyPickupManifests",
    "requiredPhotos",
    "plannedStartMinute",
    "plannedFinishMinute",
    "sequence",
    "status",
    "startedAt",
    "completedAt"
  ]);
  sanitized.jobId = requiredText(sanitized.jobId, "Job ID", { maxLength: 1000 });
  sanitized.driverLogin = normalizeDriverLogin(sanitized.driverLogin);
  sanitized.stopType = optionalText(sanitized.stopType, { maxLength: 80 });
  sanitized.orderRefs = Array.isArray(sanitized.orderRefs)
    ? sanitized.orderRefs.slice(0, 500).map((value) => optionalText(value, { maxLength: 180 })).filter(Boolean)
    : [];
  sanitized.orderTypes = Array.isArray(sanitized.orderTypes)
    ? sanitized.orderTypes.slice(0, 30).map((value) => optionalText(value, { maxLength: 40 })).filter(Boolean)
    : [];
  sanitized.lineRowIds = Array.isArray(sanitized.lineRowIds)
    ? sanitized.lineRowIds.slice(0, 1000).map((value) => optionalText(value, { maxLength: 180 })).filter(Boolean)
    : [];
  sanitized.physicalVisitJobIds = Array.isArray(sanitized.physicalVisitJobIds)
    ? sanitized.physicalVisitJobIds.slice(0, 500).map((value) => optionalText(value, { maxLength: 1000 })).filter(Boolean)
    : [sanitized.jobId];
  if (!sanitized.physicalVisitJobIds.includes(sanitized.jobId)) {
    sanitized.physicalVisitJobIds.push(sanitized.jobId);
  }
  sanitized.physicalVisitStopIds = Array.isArray(sanitized.physicalVisitStopIds)
    ? sanitized.physicalVisitStopIds.slice(0, 500).map((value) => optionalText(value, { maxLength: 180 })).filter(Boolean)
    : [sanitized.stopId].filter(Boolean);
  sanitized.consolidatedPhysicalVisit = sanitized.consolidatedPhysicalVisit === true
    && sanitized.physicalVisitJobIds.length > 1;
  sanitized.dependencyPickupManifests = Array.isArray(sanitized.dependencyPickupManifests)
    ? sanitized.dependencyPickupManifests.slice(0, 500).map((entry) => compactObject({
        transferOrderRef: optionalText(entry?.transferOrderRef, { maxLength: 180 }),
        salesOrderRef: optionalText(entry?.salesOrderRef, { maxLength: 180 }),
        location: optionalText(entry?.location, { maxLength: 300 }),
        items: Array.isArray(entry?.items) ? entry.items.slice(0, 500).map(sanitizeItem) : []
      }))
    : [];
  sanitized.sequence = compactObject({
    truckIndex: Number.isFinite(Number(sanitized.sequence?.truckIndex))
      ? Number(sanitized.sequence.truckIndex)
      : undefined,
    loadIndex: Number.isFinite(Number(sanitized.sequence?.loadIndex))
      ? Number(sanitized.sequence.loadIndex)
      : undefined,
    stopIndex: Number.isFinite(Number(sanitized.sequence?.stopIndex))
      ? Number(sanitized.sequence.stopIndex)
      : undefined
  });
  sanitized.orders = Array.isArray(job.orders) ? job.orders.slice(0, 500).map(sanitizeOrder) : [];
  if (job.deliveryInstructions && typeof job.deliveryInstructions === "object") {
    sanitized.deliveryInstructions = sanitizeDeliveryInstructions(job.deliveryInstructions);
  }
  sanitized.requiredPhotos = Math.max(0, Math.min(100, Number(sanitized.requiredPhotos) || 0));
  if (job.mbt !== undefined && job.mbt !== null) sanitized.mbt = sanitizeMbtDriverJob(job.mbt);
  return sanitized;
}

/**
 * Asset lifecycle/location/revision fields are execution progress, not route
 * identity. Keep the complete values in the manifest for offline display, but
 * exclude only those mutable fields when comparing a later stop against the
 * current server projection. Asset IDs, codes, visit/template/assignment
 * identity, and the server execution snapshot hash remain protected.
 * @param {Record<string, any>} mbt
 */
function stableMbtOfflineFingerprint(mbt) {
  const stable = structuredClone(mbt);
  const exactAssets = stable.exactAssets && typeof stable.exactAssets === "object"
    ? stable.exactAssets
    : {};
  for (const role of ["expected", "outgoing", "incoming"]) {
    const asset = exactAssets[role];
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) continue;
    delete asset.lifecycleStatus;
    delete asset.locationKind;
    delete asset.locationReference;
    delete asset.stateRevision;
  }
  return stable;
}

export function canonicalDriverOfflineJobIdentity(job = {}) {
  const snapshot = sanitizeDriverOfflineJob(job);
  return {
    version: DRIVER_OFFLINE_FINGERPRINT_VERSION,
    stopType: normalizeScalar(snapshot.stopType),
    stopId: normalizeScalar(snapshot.stopId),
    loadId: normalizeScalar(snapshot.loadId),
    truckId: normalizeScalar(snapshot.truckId),
    truckPlate: normalizeScalar(snapshot.truckPlate)?.toUpperCase?.() || "",
    fromTruckId: normalizeScalar(snapshot.fromTruckId),
    fromTruckPlate: normalizeScalar(snapshot.fromTruckPlate)?.toUpperCase?.() || "",
    nextTruckId: normalizeScalar(snapshot.nextTruckId),
    nextTruckPlate: normalizeScalar(snapshot.nextTruckPlate)?.toUpperCase?.() || "",
    switchYard: normalizeScalar(snapshot.switchYard),
    orderRefs: snapshot.orderRefs.map(normalizeScalar),
    lineRowIds: snapshot.lineRowIds.map(normalizeScalar),
    physicalVisitJobIds: snapshot.physicalVisitJobIds.map(normalizeScalar),
    physicalVisitStopIds: snapshot.physicalVisitStopIds.map(normalizeScalar),
    pickupLocation: normalizeScalar(snapshot.pickupLocation),
    dropLocation: normalizeScalar(snapshot.dropLocation),
    fromLocation: normalizeScalar(snapshot.fromJobLocation || snapshot.fromLocation),
    toLocation: normalizeScalar(snapshot.toPickupLocation || snapshot.toLocation),
    requiredPhotos: snapshot.requiredPhotos,
    ...(snapshot.mbt ? { mbt: stableMbtOfflineFingerprint(snapshot.mbt) } : {})
  };
}

export function fingerprintDriverOfflineJob(job = {}) {
  return hashCanonical(canonicalDriverOfflineJobIdentity(job));
}

export function fingerprintDriverOfflineJobContent(job = {}) {
  const snapshot = sanitizeDriverOfflineJob(job);
  // Execution state is projected from the durable event ledger. Keep it out of
  // the route-content digest so a normal Start/Complete does not look like a
  // dispatch edit, while every driver-facing stop field remains covered.
  delete snapshot.status;
  delete snapshot.startedAt;
  delete snapshot.completedAt;
  if (snapshot.mbt) snapshot.mbt = stableMbtOfflineFingerprint(snapshot.mbt);
  return hashCanonical(snapshot);
}

export function materializeDriverOfflineJobs(jobs = [], driverLogin = "") {
  const login = normalizeDriverLogin(driverLogin);
  let predecessorFingerprint = DRIVER_OFFLINE_ROUTE_START;
  return jobs.map((job, sequenceIndex) => {
    const snapshot = sanitizeDriverOfflineJob({ ...job, driverLogin: job.driverLogin || login });
    if (normalizeDriverLogin(snapshot.driverLogin) !== login) {
      throw repositoryError("A day plan contains a job assigned to another driver.", 403, "DRIVER_OFFLINE_CROSS_DRIVER");
    }
    const fingerprint = fingerprintDriverOfflineJob(snapshot);
    const result = {
      sequenceIndex,
      fingerprint,
      contentFingerprint: fingerprintDriverOfflineJobContent(snapshot),
      predecessorFingerprint,
      snapshot
    };
    predecessorFingerprint = fingerprint;
    return result;
  });
}

export function driverOfflineManifestMatchesJobs(manifest, jobs = [], driverLogin = "", {
  requireComplete = true,
  requiredJobId = ""
} = {}) {
  if (!manifest?.manifestId || !Array.isArray(manifest.jobs)) return false;
  const materialized = materializeDriverOfflineJobs(jobs, driverLogin);
  const currentById = new Map(materialized.map((entry) => [String(entry.snapshot.jobId), entry]));
  const storedJobs = manifest.jobs || [];

  const matches = (stored, current) => Boolean(
    stored
    && current
    && String(stored.jobId || "") === String(current.snapshot.jobId || "")
    && String(stored.fingerprint || "") === String(current.fingerprint || "")
    && String(stored.predecessorFingerprint || "") === String(current.predecessorFingerprint || "")
    && String(
      stored.contentFingerprint || fingerprintDriverOfflineJobContent(stored)
    ) === String(current.contentFingerprint || "")
  );

  if (requireComplete) {
    if (!manifest.complete || storedJobs.length !== materialized.length) return false;
    return storedJobs.every((stored, index) => matches(stored, materialized[index]));
  }

  const wantedId = String(requiredJobId || "");
  if (!wantedId) return false;
  const stored = storedJobs.find((job) => String(job.jobId || "") === wantedId);
  return matches(stored, currentById.get(wantedId));
}

function sanitizeDriverProfile(profile = {}, driverLogin = "") {
  const login = normalizeDriverLogin(driverLogin);
  const profileLogin = normalizeDriverLogin(profile.login || login);
  if (profileLogin !== login) {
    throw repositoryError(
      "The cached Driver profile belongs to another driver.",
      403,
      "DRIVER_OFFLINE_CROSS_DRIVER"
    );
  }
  return compactObject({
    login,
    name: optionalText(profile.name, { maxLength: 240 }),
    license: optionalText(profile.license, { maxLength: 120 }),
    number: optionalText(profile.number, { maxLength: 120 }),
    samsaraEnabled: profile.samsaraEnabled === true,
    hasSamsaraPrimary: profile.hasSamsaraPrimary === true,
    hasSamsaraSecondary: profile.hasSamsaraSecondary === true
  });
}

function sanitizeDayState(state = {}) {
  const safe = pick(state, [
    "planId",
    "planDate",
    "truckId",
    "truckPlate",
    "parkingSpot",
    "initialTruck",
    "currentTruck",
    "nextTruck",
    "truckSegments",
    "truckSwitchAttention",
    "samsaraEnabled",
    "samsaraActiveAccount",
    "preDvirRequired",
    "postDvirRequired",
    "preDvirStatus",
    "postDvirStatus",
    "preDvirCompletedAt",
    "postDvirCompletedAt",
    "onDutyAt",
    "offDutyAt",
    "primaryOffDutyAt",
    "secondaryOnDutyAt",
    "secondaryOffDutyAt",
    "samsaraOnDutyConfirmed",
    "samsaraOffDutyConfirmed",
    "samsaraPreDvirConfirmed",
    "samsaraPostDvirConfirmed",
    "allJobsComplete",
    "jobCount",
    "completedJobCount"
  ]);
  return JSON.parse(stableJson(safe));
}

function mapSession(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    driverLogin: row.driver_login,
    deviceId: row.device_id || "",
    metadata: row.metadata || {},
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}

export async function createDriverSession(driverLogin, {
  deviceId = "",
  metadata = {}
} = {}) {
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDevice = deviceId ? normalizeDriverDeviceId(deviceId) : "";
  const token = crypto.randomBytes(32).toString("base64url");
  const sessionId = crypto.randomUUID();
  const result = await query(
    `INSERT INTO driver_sessions (
       session_id, token_hash, driver_login, device_id, metadata, expires_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::jsonb, now() + ($6 || ' days')::interval
     )
     RETURNING *`,
    [sessionId, hashToken(token), login, normalizedDevice, JSON.stringify(metadata || {}), DRIVER_SESSION_DAYS]
  );
  return { token, session: mapSession(result.rows[0]) };
}

export async function getDriverSession(token, { touch = true } = {}) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const result = await query(
    `SELECT *
       FROM driver_sessions
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      LIMIT 1`,
    [tokenHash]
  );
  if (!result.rowCount) return null;
  if (!touch) return mapSession(result.rows[0]);
  const touched = await query(
    `UPDATE driver_sessions
        SET last_seen_at = now()
      WHERE session_id = $1::uuid
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING *`,
    [result.rows[0].session_id]
  );
  return mapSession(touched.rows[0]);
}

function normalizeDriverClientSyncStatus(value = {}) {
  const state = requiredText(value.state, "Driver sync state", { maxLength: 20 }).toLowerCase();
  if (!["ok", "error"].includes(state)) {
    throw repositoryError("Driver sync state is invalid.");
  }
  const errorMessage = state === "error"
    ? optionalText(value.errorMessage || value.message || "Driver synchronization failed.", { maxLength: 2000 })
    : "";
  return {
    state,
    errorName: state === "error" ? optionalText(value.errorName, { maxLength: 160 }) : "",
    errorCode: state === "error" ? optionalText(value.errorCode, { maxLength: 160 }) : "",
    errorMessage,
    manifestId: optionalText(value.manifestId, { maxLength: 160 }),
    planDate: value.planDate ? normalizePlanDate(value.planDate) : "",
    pendingEventCount: integerValue(value.pendingEventCount ?? 0, "Pending event count", { min: 0, max: 1000000 }),
    reviewRequiredCount: integerValue(value.reviewRequiredCount ?? 0, "Review-required event count", { min: 0, max: 1000000 }),
    unsyncedPhotoCount: integerValue(value.unsyncedPhotoCount ?? 0, "Unsynchronized photo count", { min: 0, max: 1000000 }),
    photoFailures: state === "error" ? normalizeDriverClientPhotoFailures(value.photoFailures) : [],
    clientOccurredAt: value.clientOccurredAt ? isoTimestamp(value.clientOccurredAt, "Client sync status time") : "",
    serverReceivedAt: new Date().toISOString()
  };
}

function boundedDriverDiagnosticText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function boundedDriverDiagnosticInteger(value, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(max, Math.floor(number));
}

function normalizeDriverClientPhotoFailures(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10)
    .filter((failure) => failure && typeof failure === "object" && !Array.isArray(failure))
    .map((failure) => ({
      photoId: boundedDriverDiagnosticText(failure.photoId ?? failure.photo_id, 160),
      eventId: boundedDriverDiagnosticText(failure.eventId ?? failure.event_id, 160),
      phase: boundedDriverDiagnosticText(failure.phase, 80),
      byteSize: boundedDriverDiagnosticInteger(
        failure.byteSize ?? failure.byteCount ?? failure.byte_size ?? failure.bytes
      ),
      attemptCount: boundedDriverDiagnosticInteger(
        failure.attemptCount ?? failure.attempts ?? failure.attempt_count,
        { max: 1000000 }
      ),
      retryable: failure.retryable === true
        || failure.retryable === 1
        || String(failure.retryable || "").trim().toLowerCase() === "true",
      errorCode: boundedDriverDiagnosticText(failure.errorCode ?? failure.error_code ?? failure.code, 160),
      httpStatus: boundedDriverDiagnosticInteger(
        failure.httpStatus ?? failure.http_status ?? failure.status,
        { max: 599 }
      ),
      message: boundedDriverDiagnosticText(
        failure.message ?? failure.errorMessage ?? failure.error_message ?? failure.error,
        1000
      )
    }));
}

export async function recordDriverClientSyncStatus({
  sessionId,
  driverLogin,
  deviceId,
  status = {}
}) {
  const id = uuidValue(sessionId, "Driver session ID");
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDeviceId = normalizeDriverDeviceId(deviceId);
  const syncStatus = normalizeDriverClientSyncStatus(status);
  const result = await query(
    `UPDATE driver_sessions
        SET device_id = CASE WHEN device_id = '' THEN $3 ELSE device_id END,
            metadata = jsonb_set(
              CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
              '{offlineSync}',
              $4::jsonb,
              true
            ),
            last_seen_at = now()
      WHERE session_id = $1::uuid
        AND lower(driver_login) = $2
        AND (device_id = '' OR device_id = $3)
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING *`,
    [id, login, normalizedDeviceId, JSON.stringify(syncStatus)]
  );
  if (!result.rowCount) {
    throw repositoryError("The Driver session does not match this device.", 401, "DRIVER_SESSION_DEVICE_MISMATCH");
  }
  return {
    session: mapSession(result.rows[0]),
    syncStatus
  };
}

export async function listDriverClientSyncIssues({
  planDate = "",
  driverLogin = "",
  limit = 100,
  now = new Date()
} = {}) {
  const login = driverLogin ? normalizeDriverLogin(driverLogin) : "";
  const normalizedPlanDate = planDate ? normalizePlanDate(planDate) : "";
  const normalizedLimit = integerValue(limit, "Driver sync issue limit", { min: 1, max: 500 });
  const cutoff = new Date(
    new Date(isoTimestamp(now, "Driver sync issue query time")).getTime()
      - DRIVER_CLIENT_SYNC_ISSUE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const result = await query(
    `WITH ranked_sessions AS (
       SELECT session_id,
              driver_login,
              device_id,
              metadata->'offlineSync' AS sync_status,
              created_at,
              revoked_at,
              ROW_NUMBER() OVER (
                PARTITION BY lower(driver_login), device_id
                ORDER BY created_at DESC,
                         session_id DESC
              ) AS session_rank
         FROM driver_sessions
        WHERE device_id <> ''
          AND revoked_at IS NULL
          AND expires_at > now()
          AND ($1 = '' OR lower(driver_login) = $1)
     )
     SELECT session_id,
            driver_login,
            device_id,
            sync_status,
            created_at,
            revoked_at
       FROM ranked_sessions
      WHERE session_rank = 1
        AND jsonb_typeof(sync_status) = 'object'
        AND sync_status->>'state' = 'error'
        AND sync_status->>'serverReceivedAt' >= $3
        AND COALESCE(sync_status->'dispatchDismissal'->>'reportReceivedAt', '')
              <> sync_status->>'serverReceivedAt'
        AND ($2 = '' OR sync_status->>'planDate' = $2)
      ORDER BY sync_status->>'serverReceivedAt' DESC, driver_login, device_id
      LIMIT $4::int`,
    [login, normalizedPlanDate, cutoff, normalizedLimit]
  );
  return result.rows.map(mapDriverClientSyncIssue);
}

function mapDriverClientSyncIssue(row) {
  const status = row.sync_status || {};
  const dismissal = status.dispatchDismissal && typeof status.dispatchDismissal === "object"
    ? status.dispatchDismissal
    : null;
  return {
    sessionId: row.session_id,
    driverLogin: row.driver_login,
    deviceId: row.device_id,
    state: status.state || "error",
    errorName: status.errorName || "",
    errorCode: status.errorCode || "",
    errorMessage: status.errorMessage || "Driver synchronization failed.",
    manifestId: status.manifestId || "",
    planDate: status.planDate || "",
    pendingEventCount: Number(status.pendingEventCount || 0),
    reviewRequiredCount: Number(status.reviewRequiredCount || 0),
    unsyncedPhotoCount: Number(status.unsyncedPhotoCount || 0),
    photoFailures: normalizeDriverClientPhotoFailures(status.photoFailures),
    clientOccurredAt: status.clientOccurredAt || "",
    reportedAt: status.serverReceivedAt || "",
    sessionCreatedAt: row.created_at,
    sessionRevokedAt: row.revoked_at,
    dismissal: dismissal
      ? {
          reportReceivedAt: dismissal.reportReceivedAt || "",
          dismissedAt: dismissal.dismissedAt || "",
          dismissedBy: dismissal.dismissedBy || "",
          auditNote: dismissal.auditNote || ""
        }
      : null
  };
}

export async function dismissDriverClientSyncIssue({
  sessionId,
  expectedReportedAt,
  auditNote,
  dismissedBy,
  now = new Date()
}) {
  const id = uuidValue(sessionId, "Driver session ID");
  const expectedTimestamp = isoTimestamp(expectedReportedAt, "Expected device report time");
  const note = requiredText(auditNote, "Audit note", { maxLength: 4000 });
  const operatorName = requiredText(dismissedBy, "Dispatcher name", { maxLength: 256 });
  const dismissedAt = isoTimestamp(now, "Device issue dismissal time");
  const dismissal = {
    reportReceivedAt: expectedTimestamp,
    dismissedAt,
    dismissedBy: operatorName,
    auditNote: note
  };
  const updated = await query(
    `UPDATE driver_sessions
        SET metadata = jsonb_set(
              CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
              '{offlineSync,dispatchDismissal}',
              $3::jsonb,
              true
            )
      WHERE session_id = $1::uuid
        AND revoked_at IS NULL
        AND expires_at > now()
        AND jsonb_typeof(metadata->'offlineSync') = 'object'
        AND metadata->'offlineSync'->>'state' = 'error'
        AND metadata->'offlineSync'->>'serverReceivedAt' = $2
        AND COALESCE(metadata->'offlineSync'->'dispatchDismissal'->>'reportReceivedAt', '') <> $2
      RETURNING session_id, driver_login, device_id,
                metadata->'offlineSync' AS sync_status, created_at, revoked_at`,
    [id, expectedTimestamp, JSON.stringify(dismissal)]
  );
  if (updated.rowCount) {
    return {
      dismissed: true,
      idempotentReplay: false,
      issue: mapDriverClientSyncIssue(updated.rows[0])
    };
  }

  const current = await query(
    `SELECT session_id, driver_login, device_id,
            metadata->'offlineSync' AS sync_status, created_at, revoked_at,
            expires_at
       FROM driver_sessions
      WHERE session_id = $1::uuid`,
    [id]
  );
  if (!current.rowCount) {
    throw repositoryError("The Driver device sync issue was not found.", 404, "DRIVER_SYNC_ISSUE_NOT_FOUND");
  }
  const row = current.rows[0];
  const status = row.sync_status && typeof row.sync_status === "object" ? row.sync_status : {};
  const existingDismissal = status.dispatchDismissal && typeof status.dispatchDismissal === "object"
    ? status.dispatchDismissal
    : {};
  if (
    status.serverReceivedAt === expectedTimestamp
    && existingDismissal.reportReceivedAt === expectedTimestamp
  ) {
    return {
      dismissed: true,
      idempotentReplay: true,
      issue: mapDriverClientSyncIssue(row)
    };
  }
  if (status.serverReceivedAt && status.serverReceivedAt !== expectedTimestamp) {
    throw repositoryError(
      "The Driver device has reported a newer synchronization status. Refresh before dismissing it.",
      409,
      "DRIVER_SYNC_ISSUE_CHANGED"
    );
  }
  throw repositoryError(
    "The Driver device sync issue is no longer active.",
    409,
    "DRIVER_SYNC_ISSUE_NOT_ACTIVE"
  );
}

export async function revokeDriverSession(token) {
  if (!token) return false;
  const result = await query(
    `UPDATE driver_sessions
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE token_hash = $1
      RETURNING session_id`,
    [hashToken(token)]
  );
  return result.rowCount > 0;
}

export async function revokeDriverSessionsForLogin(driverLogin, { deviceId = "" } = {}) {
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDevice = deviceId ? normalizeDriverDeviceId(deviceId) : "";
  const result = await query(
    `UPDATE driver_sessions
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE lower(driver_login) = $1
        AND ($2 = '' OR device_id = $2)
        AND revoked_at IS NULL
      RETURNING session_id`,
    [login, normalizedDevice]
  );
  return result.rowCount;
}

export async function pruneExpiredDriverSessions({ before = new Date() } = {}) {
  const result = await query(
    `DELETE FROM driver_sessions
      WHERE expires_at < $1::timestamptz
         OR (revoked_at IS NOT NULL AND revoked_at < $1::timestamptz - interval '48 hours')`,
    [isoTimestamp(before, "Session cleanup time")]
  );
  return result.rowCount;
}

export async function loadConfirmedDriverPlan(driverLogin, planDate) {
  const login = normalizeDriverLogin(driverLogin);
  const date = normalizePlanDate(planDate);
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, p.status, p.revision,
            s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.plan_date = $1::date
        AND p.status = 'confirmed'
      ORDER BY p.updated_at DESC, p.id DESC`,
    [date]
  );
  for (const row of result.rows) {
    const plan = normalizeDispatchPlanLoadAssignments({
      id: row.id,
      planDate: row.plan_date,
      status: row.status,
      revision: Number(row.revision || 0),
      orders: Array.isArray(row.orders) ? row.orders : [],
      trucks: Array.isArray(row.trucks) ? row.trucks : [],
      summary: row.summary || {}
    });
    const jobs = planJobsForDriver(plan, login);
    if (jobs.length) return { plan, jobs };
  }
  return null;
}

function mapManifest(row, jobs = []) {
  if (!row) return null;
  return {
    schemaVersion: Number(row.schema_version),
    fingerprintVersion: Number(row.fingerprint_version),
    manifestId: row.manifest_id,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    planId: row.plan_id,
    planDate: row.plan_date instanceof Date ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date),
    planRevision: Number(row.plan_revision || 0),
    driver: row.driver_profile || { login: row.driver_login },
    dayState: row.day_state || {},
    samsaraWorkflowEnabled: row.samsara_workflow_enabled === true,
    complete: row.complete === true,
    supersededAt: row.superseded_at || null,
    supersededByRequestId: row.superseded_by_request_id || null,
    supersededReason: row.superseded_reason || "",
    jobs
  };
}

function mapManifestJob(row) {
  const snapshot = row.job_snapshot || {};
  return {
    ...snapshot,
    sequenceIndex: Number(row.sequence_index),
    fingerprint: row.job_fingerprint,
    contentFingerprint: fingerprintDriverOfflineJobContent(snapshot),
    predecessorFingerprint: row.predecessor_fingerprint
  };
}

async function lockDriverDay(driverLogin, planDate) {
  await query(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    [normalizeDriverLogin(driverLogin), normalizePlanDate(planDate)]
  );
}

async function issueGrantInsideTransaction({ manifestId, driverLogin, deviceId, planDate, expiresAt }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const grantId = crypto.randomUUID();
  const result = await query(
    `INSERT INTO driver_offline_sync_grants (
       grant_id, manifest_id, token_hash, driver_login, device_id, plan_date, expires_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::timestamptz)
     RETURNING grant_id, expires_at`,
    [grantId, manifestId, hashToken(token), driverLogin, deviceId, planDate, expiresAt]
  );
  return { token, grantId: result.rows[0].grant_id, expiresAt: result.rows[0].expires_at };
}

export async function persistDriverOfflineManifest({
  manifestId = crypto.randomUUID(),
  driverLogin,
  deviceId,
  plan = null,
  planMetadata = {},
  jobs = null,
  driverProfile = {},
  dayState = {},
  samsaraWorkflowEnabled = false,
  complete = true
}) {
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDevice = normalizeDriverDeviceId(deviceId);
  let resolvedPlan = plan;
  let resolvedJobs = jobs;
  const requestedDate = normalizePlanDate(
    planMetadata.planDate || planMetadata.date || resolvedPlan?.planDate || resolvedPlan?.plan_date
  );
  if (!Array.isArray(resolvedJobs)) {
    const loaded = await loadConfirmedDriverPlan(login, requestedDate);
    if (!loaded) throw repositoryError("No confirmed plan is assigned to this driver for that date.", 404, "DRIVER_PLAN_NOT_FOUND");
    resolvedPlan ||= loaded.plan;
    resolvedJobs ||= loaded.jobs;
  }
  const planId = planMetadata.planId ?? planMetadata.id ?? resolvedPlan?.id ?? resolvedPlan?.planId ?? null;
  const planRevision = integerValue(
    planMetadata.planRevision ?? planMetadata.revision ?? resolvedPlan?.revision ?? 0,
    "Plan revision",
    { min: 0 }
  );
  const id = uuidValue(manifestId, "Manifest ID");
  const materialized = materializeDriverOfflineJobs(resolvedJobs, login);
  for (const job of materialized) {
    if (job.snapshot.planDate && normalizePlanDate(job.snapshot.planDate) !== requestedDate) {
      throw repositoryError(
        "A manifest job belongs to another plan date.",
        409,
        "MANIFEST_JOB_PLAN_CONFLICT"
      );
    }
    if (
      planId !== null
      && planId !== undefined
      && job.snapshot.planId !== null
      && job.snapshot.planId !== undefined
      && String(job.snapshot.planId) !== String(planId)
    ) {
      throw repositoryError(
        "A manifest job belongs to another dispatch plan.",
        409,
        "MANIFEST_JOB_PLAN_CONFLICT"
      );
    }
  }
  const expiresAt = torontoManifestExpiry(requestedDate);
  const safeProfile = sanitizeDriverProfile(driverProfile, login);
  const safeDayState = sanitizeDayState(dayState);

  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    if (planId !== null && planId !== undefined && planId !== "") {
      const currentPlan = await query(
        `SELECT revision, status, plan_date::text AS plan_date
           FROM dispatch_plans
          WHERE id = $1
          LIMIT 1`,
        [planId]
      );
      const row = currentPlan.rows[0];
      if (
        !row
        || row.status !== "confirmed"
        || String(row.plan_date) !== requestedDate
        || Number(row.revision || 0) !== planRevision
      ) {
        throw repositoryError(
          "The dispatch plan changed while the offline route was being prepared. Refresh and try again.",
          409,
          "DRIVER_OFFLINE_PLAN_CHANGED"
        );
      }
    }
    await lockDriverDay(login, requestedDate);
    let manifestResult = await query(
      `SELECT *
         FROM driver_offline_manifests
        WHERE manifest_id = $1::uuid
        FOR UPDATE`,
      [id]
    );
    if (!manifestResult.rowCount) {
      manifestResult = await query(
        `INSERT INTO driver_offline_manifests (
           manifest_id, schema_version, fingerprint_version, driver_login, device_id,
           plan_id, plan_date, plan_revision, driver_profile, day_state,
           samsara_workflow_enabled, complete, job_count, expires_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $7::date, $8, $9::jsonb, $10::jsonb,
           $11, $12, $13, $14::timestamptz
         )
         RETURNING *`,
        [
          id,
          DRIVER_OFFLINE_SCHEMA_VERSION,
          DRIVER_OFFLINE_FINGERPRINT_VERSION,
          login,
          normalizedDevice,
          planId,
          requestedDate,
          planRevision,
          JSON.stringify(safeProfile),
          JSON.stringify(safeDayState),
          samsaraWorkflowEnabled === true,
          complete === true,
          materialized.length,
          expiresAt.toISOString()
        ]
      );
    } else {
      const existing = manifestResult.rows[0];
      const existingDate = existing.plan_date instanceof Date
        ? existing.plan_date.toISOString().slice(0, 10)
        : String(existing.plan_date);
      if (
        normalizeDriverLogin(existing.driver_login) !== login
        || existing.device_id !== normalizedDevice
        || existingDate !== requestedDate
        || String(existing.plan_id ?? "") !== String(planId ?? "")
        || Number(existing.plan_revision) !== planRevision
      ) {
        throw repositoryError(
          "A manifest ID cannot be reused for another driver, device, or plan revision.",
          409,
          "MANIFEST_IDEMPOTENCY_CONFLICT"
        );
      }
      manifestResult = await query(
        `UPDATE driver_offline_manifests
            SET driver_profile = $2::jsonb,
                day_state = $3::jsonb,
                samsara_workflow_enabled = $4,
                complete = complete OR $5,
                job_count = GREATEST(job_count, $6),
                last_accessed_at = now(),
                updated_at = now()
          WHERE manifest_id = $1::uuid
          RETURNING *`,
        [
          id,
          JSON.stringify(safeProfile),
          JSON.stringify(safeDayState),
          samsaraWorkflowEnabled === true,
          complete === true,
          materialized.length
        ]
      );
    }

    for (const item of materialized) {
      const inserted = await query(
        `INSERT INTO driver_offline_manifest_jobs (
           manifest_id, sequence_index, original_job_id, assigned_driver_login,
           job_fingerprint, predecessor_fingerprint, required_photo_count, job_snapshot
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          id,
          item.sequenceIndex,
          item.snapshot.jobId,
          login,
          item.fingerprint,
          item.predecessorFingerprint,
          item.snapshot.requiredPhotos,
          JSON.stringify(item.snapshot)
        ]
      );
      if (inserted.rowCount) continue;
      const existing = await query(
        `SELECT sequence_index, original_job_id, job_fingerprint, predecessor_fingerprint
           FROM driver_offline_manifest_jobs
          WHERE manifest_id = $1::uuid
            AND (sequence_index = $2 OR original_job_id = $3)
          ORDER BY id
          LIMIT 1`,
        [id, item.sequenceIndex, item.snapshot.jobId]
      );
      const row = existing.rows[0];
      if (
        !row
        || Number(row.sequence_index) !== item.sequenceIndex
        || row.original_job_id !== item.snapshot.jobId
        || row.job_fingerprint !== item.fingerprint
        || row.predecessor_fingerprint !== item.predecessorFingerprint
      ) {
        throw repositoryError(
          "The immutable job snapshot conflicts with an existing manifest.",
          409,
          "MANIFEST_JOB_CONFLICT"
        );
      }
    }

    const storedJobs = await query(
      `SELECT *
         FROM driver_offline_manifest_jobs
        WHERE manifest_id = $1::uuid
        ORDER BY sequence_index`,
      [id]
    );
    if (complete && storedJobs.rowCount !== materialized.length) {
      throw repositoryError(
        "A complete manifest cannot contain a partial or different job set.",
        409,
        "MANIFEST_JOB_SET_CONFLICT"
      );
    }
    const grant = await issueGrantInsideTransaction({
      manifestId: id,
      driverLogin: login,
      deviceId: normalizedDevice,
      planDate: requestedDate,
      expiresAt: expiresAt.toISOString()
    });
    return {
      ...mapManifest(manifestResult.rows[0], storedJobs.rows.map(mapManifestJob)),
      offlineSyncGrant: grant.token
    };
  });
}

export async function persistDriverOfflineBootstrap(options) {
  return persistDriverOfflineManifest({ ...options, complete: false });
}

export async function persistDriverOfflineDayPlan(options) {
  return persistDriverOfflineManifest({ ...options, complete: true });
}

export function driverOfflineRouteBootstrap(manifest, currentJobId = "") {
  if (!manifest?.manifestId) throw repositoryError("Offline manifest is required.");
  const jobs = Array.isArray(manifest.jobs) ? manifest.jobs : [];
  const current = currentJobId
    ? jobs.find((job) => String(job.jobId) === String(currentJobId))
    : jobs[0] || null;
  return {
    schemaVersion: Number(manifest.schemaVersion || DRIVER_OFFLINE_SCHEMA_VERSION),
    fingerprintVersion: Number(manifest.fingerprintVersion || DRIVER_OFFLINE_FINGERPRINT_VERSION),
    manifestId: manifest.manifestId,
    generatedAt: manifest.generatedAt,
    expiresAt: manifest.expiresAt,
    planId: manifest.planId ?? null,
    planDate: manifest.planDate,
    planRevision: Number(manifest.planRevision || 0),
    currentJobFingerprint: current?.fingerprint || "",
    currentJobContentFingerprint: current?.contentFingerprint
      || (current ? fingerprintDriverOfflineJobContent(current) : ""),
    predecessorFingerprint: current?.predecessorFingerprint || "",
    offlineSyncGrant: manifest.offlineSyncGrant || ""
  };
}

export async function supersedeDriverOfflineManifests({ driverLogin, planDate }) {
  const login = normalizeDriverLogin(driverLogin);
  const date = normalizePlanDate(planDate);
  const result = await query(
    `UPDATE driver_offline_manifests
        SET superseded_at = COALESCE(superseded_at, now()),
            updated_at = now()
      WHERE lower(driver_login) = $1
        AND plan_date = $2::date
        AND superseded_at IS NULL`,
    [login, date]
  );
  return result.rowCount;
}

export async function getDriverOfflineManifest(manifestId, {
  driverLogin = "",
  deviceId = "",
  touch = true
} = {}) {
  const id = uuidValue(manifestId, "Manifest ID");
  const params = [id];
  const clauses = ["manifest_id = $1::uuid"];
  if (driverLogin) {
    params.push(normalizeDriverLogin(driverLogin));
    clauses.push(`lower(driver_login) = $${params.length}`);
  }
  if (deviceId) {
    params.push(normalizeDriverDeviceId(deviceId));
    clauses.push(`device_id = $${params.length}`);
  }
  const result = await query(
    `SELECT *
       FROM driver_offline_manifests
      WHERE ${clauses.join(" AND ")}
      LIMIT 1`,
    params
  );
  if (!result.rowCount) return null;
  const jobs = await query(
    `SELECT *
       FROM driver_offline_manifest_jobs
      WHERE manifest_id = $1::uuid
      ORDER BY sequence_index`,
    [id]
  );
  if (touch) {
    await query(
      `UPDATE driver_offline_manifests
          SET last_accessed_at = now()
        WHERE manifest_id = $1::uuid`,
      [id]
    );
  }
  return mapManifest(result.rows[0], jobs.rows.map(mapManifestJob));
}

export async function getLatestDriverOfflineManifest(driverLogin, deviceId, planDate = "") {
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDevice = normalizeDriverDeviceId(deviceId);
  const date = planDate ? normalizePlanDate(planDate) : "";
  const result = await query(
    `SELECT manifest_id
      FROM driver_offline_manifests
      WHERE lower(driver_login) = $1
        AND device_id = $2
        AND ($3 = '' OR plan_date = NULLIF($3, '')::date)
        AND superseded_at IS NULL
      ORDER BY complete DESC, generated_at DESC, created_at DESC
      LIMIT 1`,
    [login, normalizedDevice, date]
  );
  return result.rowCount
    ? getDriverOfflineManifest(result.rows[0].manifest_id, { driverLogin: login, deviceId: normalizedDevice })
    : null;
}

export async function issueDriverOfflineSyncGrant(manifestId, {
  driverLogin,
  deviceId
}) {
  const id = uuidValue(manifestId, "Manifest ID");
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDevice = normalizeDriverDeviceId(deviceId);
  return withTransaction(async () => {
    const result = await query(
      `SELECT *
         FROM driver_offline_manifests
        WHERE manifest_id = $1::uuid
          AND lower(driver_login) = $2
          AND device_id = $3
        FOR UPDATE`,
      [id, login, normalizedDevice]
    );
    if (!result.rowCount) throw repositoryError("Offline manifest was not found.", 404, "MANIFEST_NOT_FOUND");
    return issueGrantInsideTransaction({
      manifestId: id,
      driverLogin: login,
      deviceId: normalizedDevice,
      planDate: result.rows[0].plan_date,
      expiresAt: result.rows[0].expires_at
    });
  });
}

function mapGrant(row) {
  if (!row) return null;
  return {
    grantId: row.grant_id,
    manifestId: row.manifest_id,
    driverLogin: row.driver_login,
    deviceId: row.device_id,
    planDate: row.plan_date instanceof Date ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at
  };
}

export async function authenticateDriverOfflineGrant(token, {
  manifestId,
  deviceId,
  touch = true
}) {
  if (!token) return null;
  const id = uuidValue(manifestId, "Manifest ID");
  const normalizedDevice = normalizeDriverDeviceId(deviceId);
  const result = await query(
    `SELECT g.*
       FROM driver_offline_sync_grants g
       JOIN driver_offline_manifests m ON m.manifest_id = g.manifest_id
      WHERE g.token_hash = $1
        AND g.manifest_id = $2::uuid
        AND g.device_id = $3
        AND g.revoked_at IS NULL
        AND g.expires_at > now()
        AND m.expires_at > now()
        AND m.superseded_at IS NULL
      LIMIT 1`,
    [hashToken(token), id, normalizedDevice]
  );
  if (!result.rowCount) return null;
  if (!touch) return mapGrant(result.rows[0]);
  const touched = await query(
    `UPDATE driver_offline_sync_grants
        SET last_used_at = now()
      WHERE grant_id = $1::uuid
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING *`,
    [result.rows[0].grant_id]
  );
  return mapGrant(touched.rows[0]);
}

export async function authorizeDriverOfflineSync({
  manifestId,
  deviceId,
  offlineGrant = "",
  liveDriverLogin = ""
}) {
  const manifest = await getDriverOfflineManifest(manifestId, { deviceId, touch: false });
  if (!manifest) return null;
  if (liveDriverLogin) {
    const login = normalizeDriverLogin(liveDriverLogin);
    if (normalizeDriverLogin(manifest.driver.login) !== login) {
      throw repositoryError("This offline manifest belongs to another driver.", 403, "DRIVER_OFFLINE_CROSS_DRIVER");
    }
    return { driverLogin: login, manifest, mode: "live_session" };
  }
  const grant = await authenticateDriverOfflineGrant(offlineGrant, { manifestId, deviceId });
  return grant ? { driverLogin: grant.driverLogin, manifest, grant, mode: "offline_grant" } : null;
}

export async function revokeDriverOfflineGrants({
  manifestId = "",
  driverLogin = "",
  deviceId = ""
} = {}) {
  const params = [];
  const clauses = ["revoked_at IS NULL"];
  if (manifestId) {
    params.push(uuidValue(manifestId, "Manifest ID"));
    clauses.push(`manifest_id = $${params.length}::uuid`);
  }
  if (driverLogin) {
    params.push(normalizeDriverLogin(driverLogin));
    clauses.push(`lower(driver_login) = $${params.length}`);
  }
  if (deviceId) {
    params.push(normalizeDriverDeviceId(deviceId));
    clauses.push(`device_id = $${params.length}`);
  }
  if (params.length === 0) throw repositoryError("Grant revocation requires a manifest, driver, or device.");
  const result = await query(
    `UPDATE driver_offline_sync_grants
        SET revoked_at = now()
      WHERE ${clauses.join(" AND ")}
      RETURNING grant_id`,
    params
  );
  return result.rowCount;
}

export function sanitizeDriverOfflinePhotoDescriptor(photo = {}, fallbackOrdinal = 0) {
  const mimeType = requiredText(photo.mimeType || photo.type, "Photo MIME type", { maxLength: 80 }).toLowerCase();
  if (!["image/jpeg", "image/jpg"].includes(mimeType)) {
    throw repositoryError("Offline evidence must be a JPEG image.", 400, "OFFLINE_PHOTO_TYPE_INVALID");
  }
  const byteSize = integerValue(photo.byteSize ?? photo.size, "Photo byte size", {
    min: 1,
    max: MAX_PHOTO_BYTES
  });
  const descriptor = {
    photoId: uuidValue(photo.photoId, "Photo ID"),
    ordinal: integerValue(photo.ordinal ?? fallbackOrdinal, "Photo ordinal", { min: 0, max: 999 }),
    recordType: requiredText(photo.recordType || "driver-stop-photo", "Photo record type", { maxLength: 80 }),
    mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType,
    byteSize,
    sha256: sha256Value(photo.sha256, "Photo SHA-256")
  };
  return { ...descriptor, descriptorHash: hashCanonical(descriptor) };
}

function sanitizeOfflineLocationDetails(details = {}) {
  return compactObject({
    verificationId: details.verificationId ? uuidValue(details.verificationId, "Location verification ID") : undefined,
    overrideReason: optionalText(details.overrideReason, { maxLength: 1000 }),
    warningCode: optionalText(details.warningCode, { maxLength: 120 }),
    checkedAt: details.checkedAt ? isoTimestamp(details.checkedAt, "Location check time") : undefined
  });
}

export function sanitizeDriverOfflineEventDetails(eventType, details = {}) {
  const source = details && typeof details === "object" && !Array.isArray(details) ? details : {};
  if (["job_started", "job_completed"].includes(eventType)) {
    return compactObject({
      locationVerificationId: source.locationVerificationId
        ? uuidValue(source.locationVerificationId, "Location verification ID")
        : undefined,
      locationOverrideReason: optionalText(source.locationOverrideReason, { maxLength: 1000 }),
      driverRemark: eventType === "job_completed"
        ? optionalText(source.driverRemark ?? source.remark, { maxLength: 1000 })
        : undefined,
      mbt: eventType === "job_completed" && source.mbt !== undefined
        ? normalizeMbtDriverEventDetails(source.mbt)
        : undefined
    });
  }
  if (["rest_started", "rest_ended"].includes(eventType)) {
    return compactObject({
      restId: optionalText(source.restId, { maxLength: 180 }),
      previousJobId: optionalText(source.previousJobId, { maxLength: 1000 }),
      nextJobId: optionalText(source.nextJobId, { maxLength: 1000 })
    });
  }
  if (eventType === "truck_switched_physical") {
    return compactObject({
      fromTruckId: optionalText(source.fromTruckId, { maxLength: 180 }),
      fromTruckPlate: optionalText(source.fromTruckPlate, { maxLength: 80 }),
      toTruckId: optionalText(source.toTruckId, { maxLength: 180 }),
      toTruckPlate: optionalText(source.toTruckPlate, { maxLength: 80 }),
      switchYard: optionalText(source.switchYard, { maxLength: 300 }),
      parkingSpot: optionalText(source.parkingSpot, { maxLength: 180 }),
      nextLoadId: optionalText(source.nextLoadId, { maxLength: 180 })
    });
  }
  if (eventType === "dvir_captured") {
    const dvirType = requiredText(source.dvirType || source.type, "DVIR type", { maxLength: 20 }).toLowerCase();
    if (!["pre", "post"].includes(dvirType)) throw repositoryError("DVIR type must be pre or post.");
    return compactObject({
      dvirType,
      truckId: optionalText(source.truckId, { maxLength: 180 }),
      truckPlate: optionalText(source.truckPlate, { maxLength: 80 })
    });
  }
  return {};
}

function normalizeOfflineEvent(event = {}, {
  manifestId,
  deviceId
}) {
  const eventType = requiredText(event.eventType, "Event type", { maxLength: 80 });
  if (!EVENT_TYPES.has(eventType)) {
    throw repositoryError("Unsupported offline event type.", 400, "OFFLINE_EVENT_TYPE_INVALID");
  }
  const locationStatus = requiredText(
    event.locationStatus || "not_checked_offline",
    "Location status",
    { maxLength: 80 }
  );
  if (!LOCATION_STATUSES.has(locationStatus)) {
    throw repositoryError("Unsupported offline location status.", 400, "OFFLINE_LOCATION_STATUS_INVALID");
  }
  const photos = (Array.isArray(event.photos) ? event.photos : [])
    .map((photo, index) => sanitizeDriverOfflinePhotoDescriptor(photo, index))
    .sort((left, right) => left.ordinal - right.ordinal);
  if (new Set(photos.map((photo) => photo.photoId)).size !== photos.length) {
    throw repositoryError("An event contains a duplicate photo ID.", 409, "OFFLINE_PHOTO_ID_CONFLICT");
  }
  if (new Set(photos.map((photo) => photo.ordinal)).size !== photos.length) {
    throw repositoryError("An event contains a duplicate photo ordinal.", 409, "OFFLINE_PHOTO_ORDINAL_CONFLICT");
  }
  const occurrence = occurrenceTimestamp(event.occurredAt);
  const normalized = {
    eventId: uuidValue(event.eventId, "Event ID"),
    deviceId,
    manifestId,
    clientSequence: integerValue(event.clientSequence, "Client sequence", { min: 1 }),
    eventType,
    jobId: optionalText(event.jobId, { maxLength: 1000 }),
    jobFingerprint: event.jobFingerprint
      ? sha256Value(event.jobFingerprint, "Job fingerprint")
      : "",
    predecessorFingerprint: optionalText(event.predecessorFingerprint, { maxLength: 80 }),
    ...occurrence,
    locationStatus,
    locationDetails: sanitizeOfflineLocationDetails(event.locationDetails || {}),
    details: sanitizeDriverOfflineEventDetails(eventType, event.details || event.payload || {}),
    photos: photos.map(({ descriptorHash, ...descriptor }) => descriptor)
  };
  const jobRequired = ["job_started", "job_completed", "truck_switched_physical"].includes(eventType);
  if (jobRequired && (!normalized.jobId || !normalized.jobFingerprint || !normalized.predecessorFingerprint)) {
    throw repositoryError(
      "This event requires its manifest job ID, fingerprint, and predecessor fingerprint.",
      400,
      "OFFLINE_EVENT_JOB_REQUIRED"
    );
  }
  const immutablePayload = {
    eventId: normalized.eventId,
    deviceId: normalized.deviceId,
    manifestId: normalized.manifestId,
    clientSequence: normalized.clientSequence,
    eventType: normalized.eventType,
    jobId: normalized.jobId,
    jobFingerprint: normalized.jobFingerprint,
    predecessorFingerprint: normalized.predecessorFingerprint,
    occurredAt: normalized.occurredAtRaw,
    locationStatus: normalized.locationStatus,
    locationDetails: normalized.locationDetails,
    details: normalized.details,
    photos: normalized.photos
  };
  return {
    ...normalized,
    photoDescriptors: photos,
    immutablePayload,
    payloadHash: hashCanonical(immutablePayload)
  };
}

function mapOfflinePhoto(row) {
  if (!row) return null;
  return {
    photoId: row.photo_id,
    ordinal: Number(row.ordinal),
    recordType: row.record_type,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    status: row.status,
    objectReference: row.object_reference || "",
    durableReceipt: row.status === "durably_received",
    uploadedAt: row.uploaded_at,
    durableReceivedAt: row.durable_received_at,
    verificationAttemptCount: Number(row.verification_attempt_count || 0),
    lastVerificationAttemptAt: row.last_verification_attempt_at || null,
    lastVerificationErrorCode: row.last_verification_error_code || "",
    lastVerificationError: row.last_verification_error || ""
  };
}

function mapOfflineEvent(row, photos = []) {
  if (!row) return null;
  const missingPhotoIds = photos
    .filter((photo) => photo.status !== "durably_received")
    .map((photo) => photo.photoId);
  return {
    eventId: row.event_id,
    manifestId: row.manifest_id,
    deviceId: row.device_id,
    driverLogin: row.driver_login,
    planDate: row.plan_date instanceof Date ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date),
    clientSequence: Number(row.client_sequence),
    eventType: row.event_type,
    jobId: row.original_job_id || "",
    effectiveJobId: row.effective_job_id || "",
    jobFingerprint: row.job_fingerprint || "",
    predecessorFingerprint: row.predecessor_fingerprint || "",
    occurredAt: row.device_occurred_at,
    occurredAtRaw: row.device_occurred_at_raw || "",
    occurrenceTimeValid: row.occurrence_time_valid !== false,
    receivedAt: row.server_received_at,
    appliedAt: row.server_applied_at,
    locationStatus: row.location_status,
    locationDetails: row.location_details || {},
    details: row.event_details || {},
    status: row.status,
    reviewRequired: row.status === "review_required",
    blocked: row.status === "blocked",
    reviewReason: row.review_reason || "",
    caseVersion: Number(row.case_version || 1),
    result: row.application_result || {},
    missingPhotoIds,
    photos
  };
}

async function photosForEventRecords(eventRecordIds) {
  if (!eventRecordIds.length) return new Map();
  const result = await query(
    `SELECT *
       FROM driver_offline_event_photos
      WHERE event_record_id = ANY($1::bigint[])
      ORDER BY event_record_id, ordinal`,
    [eventRecordIds]
  );
  const byEvent = new Map();
  for (const row of result.rows) {
    if (!byEvent.has(String(row.event_record_id))) byEvent.set(String(row.event_record_id), []);
    byEvent.get(String(row.event_record_id)).push(mapOfflinePhoto(row));
  }
  return byEvent;
}

async function manifestRowForRegistration(manifestId, driverLogin, deviceId) {
  const result = await query(
    `SELECT *
       FROM driver_offline_manifests
      WHERE manifest_id = $1::uuid
        AND lower(driver_login) = $2
        AND device_id = $3
      LIMIT 1`,
    [manifestId, driverLogin, deviceId]
  );
  if (!result.rowCount) {
    throw repositoryError("Offline manifest was not found for this driver and device.", 404, "MANIFEST_NOT_FOUND");
  }
  return result.rows[0];
}

async function manifestJobForEvent(manifestId, event) {
  if (!event.jobId) return null;
  const result = await query(
    `SELECT *
       FROM driver_offline_manifest_jobs
      WHERE manifest_id = $1::uuid
        AND original_job_id = $2
      LIMIT 1`,
    [manifestId, event.jobId]
  );
  const row = result.rows[0];
  if (!row) {
    throw repositoryError("The event job is not part of its manifest.", 409, "OFFLINE_EVENT_JOB_NOT_FOUND");
  }
  if (
    (event.jobFingerprint && event.jobFingerprint !== row.job_fingerprint)
    || (event.predecessorFingerprint && event.predecessorFingerprint !== row.predecessor_fingerprint)
  ) {
    throw repositoryError(
      "The event job identity does not match its immutable manifest snapshot.",
      409,
      "OFFLINE_EVENT_JOB_FINGERPRINT_CONFLICT"
    );
  }
  return row;
}

async function insertOrValidateOfflinePhoto(eventRecordId, photo) {
  const inserted = await query(
    `INSERT INTO driver_offline_event_photos (
       photo_id, event_record_id, ordinal, record_type, mime_type,
       byte_size, sha256, descriptor_hash
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      photo.photoId,
      eventRecordId,
      photo.ordinal,
      photo.recordType,
      photo.mimeType,
      photo.byteSize,
      photo.sha256,
      photo.descriptorHash
    ]
  );
  if (inserted.rowCount) return inserted.rows[0];
  const existing = await query(
    `SELECT *
       FROM driver_offline_event_photos
      WHERE photo_id = $1::uuid
         OR (event_record_id = $2 AND ordinal = $3)
      ORDER BY id
      LIMIT 2`,
    [photo.photoId, eventRecordId, photo.ordinal]
  );
  if (
    existing.rowCount !== 1
    || String(existing.rows[0].event_record_id) !== String(eventRecordId)
    || existing.rows[0].photo_id !== photo.photoId
    || existing.rows[0].descriptor_hash !== photo.descriptorHash
  ) {
    throw repositoryError(
      "A photo ID or ordinal was reused with different evidence.",
      409,
      "OFFLINE_PHOTO_IDEMPOTENCY_CONFLICT"
    );
  }
  return existing.rows[0];
}

export async function registerDriverOfflineEvents({
  driverLogin,
  deviceId,
  manifestId,
  events = []
}) {
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDevice = normalizeDriverDeviceId(deviceId);
  const id = uuidValue(manifestId, "Manifest ID");
  if (!Array.isArray(events)) throw repositoryError("Events must be an array.");
  if (events.length > 500) throw repositoryError("A sync batch may contain at most 500 events.", 413, "OFFLINE_BATCH_TOO_LARGE");
  const normalized = events.map((event) => normalizeOfflineEvent(event, {
    manifestId: id,
    deviceId: normalizedDevice
  }));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].clientSequence <= normalized[index - 1].clientSequence) {
      throw repositoryError(
        "Events must be submitted in strictly increasing client sequence.",
        400,
        "OFFLINE_EVENT_ORDER_INVALID"
      );
    }
  }

  return withTransaction(async () => {
    const manifest = await manifestRowForRegistration(id, login, normalizedDevice);
    const planDate = manifest.plan_date instanceof Date
      ? manifest.plan_date.toISOString().slice(0, 10)
      : String(manifest.plan_date);
    await lockDriverDay(login, planDate);
    const rows = [];
    for (const event of normalized) {
      const occurredAfterManifestExpiry = event.occurrenceTimeValid
        && new Date(event.occurredAt).getTime() > new Date(manifest.expires_at).getTime();
      const manifestJob = await manifestJobForEvent(id, event);
      const requiredPhotoDescriptors = event.eventType === "dvir_captured"
        ? 4
        : event.eventType === "job_completed"
          ? Number(manifestJob?.required_photo_count || 0)
          : 0;
      const reviewReasons = [];
      if (manifest.superseded_at) {
        reviewReasons.push(
          "Route superseded by an approved Dispatch or SCM change. The event was retained for Dispatch review and its operational effects are blocked."
        );
      }
      if (!event.occurrenceTimeValid) {
        reviewReasons.push("The device occurrence timestamp is invalid or implausibly far in the future and requires Dispatch review.");
      } else if (occurredAfterManifestExpiry) {
        reviewReasons.push("The event occurred after its offline route manifest expired and requires Dispatch review.");
      }
      if (event.photoDescriptors.length < requiredPhotoDescriptors) {
        const label = event.eventType === "dvir_captured" ? "DVIR capture" : "Job completion";
        reviewReasons.push(
          `${label} includes ${event.photoDescriptors.length} of ${requiredPhotoDescriptors} required photo descriptor${requiredPhotoDescriptors === 1 ? "" : "s"} from its manifest. The event was retained for Dispatch review and its operational effects are blocked.`
        );
      }
      const reviewReason = reviewReasons.join(" ");
      const existing = await query(
        `SELECT *
           FROM driver_offline_events
          WHERE event_id = $1::uuid
             OR (
               lower(driver_login) = $2
               AND device_id = $3
               AND client_sequence = $4
             )
          ORDER BY id
          LIMIT 2
          FOR UPDATE`,
        [event.eventId, login, normalizedDevice, event.clientSequence]
      );
      let eventRow;
      if (existing.rowCount) {
        if (
          existing.rowCount !== 1
          || existing.rows[0].event_id !== event.eventId
          || existing.rows[0].payload_hash !== event.payloadHash
          || Number(existing.rows[0].client_sequence) !== event.clientSequence
        ) {
          throw repositoryError(
            "An event ID or device sequence was reused with a different payload.",
            409,
            "OFFLINE_EVENT_IDEMPOTENCY_CONFLICT"
          );
        }
        eventRow = existing.rows[0];
      } else {
        if (event.eventType === "job_completed") {
          const conflictingCompletion = await query(
            `SELECT event_id, device_id, status
               FROM driver_offline_events
              WHERE lower(driver_login) = $1
                AND plan_date = $2::date
                AND device_id <> $3
                AND event_type = 'job_completed'
                AND original_job_id = $4
                AND job_fingerprint = $5
                AND predecessor_fingerprint = $6
                AND status NOT IN ('evidence_only', 'rejected')
              ORDER BY server_received_at, id
              LIMIT 1
              FOR UPDATE`,
            [
              login,
              planDate,
              normalizedDevice,
              event.jobId,
              event.jobFingerprint,
              event.predecessorFingerprint
            ]
          );
          if (conflictingCompletion.rowCount) {
            const conflict = conflictingCompletion.rows[0];
            throw Object.assign(
              repositoryError(
                "This stop was already saved on another Driver device. Synchronize that device or ask Dispatch to review it before retrying.",
                409,
                "DRIVER_OFFLINE_CROSS_DEVICE_COMPLETION_CONFLICT"
              ),
              {
                conflictingEventId: conflict.event_id,
                conflictingDeviceId: conflict.device_id,
                conflictingStatus: conflict.status
              }
            );
          }
        }
        const inserted = await query(
          `INSERT INTO driver_offline_events (
             event_id, manifest_id, manifest_job_id, driver_login, device_id, plan_date,
             client_sequence, event_type, original_job_id, job_fingerprint,
             predecessor_fingerprint, device_occurred_at, device_occurred_at_raw,
             occurrence_time_valid, location_status,
             location_details, event_details, immutable_payload, payload_hash, status
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6::date,
             $7, $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''),
             $12::timestamptz, $13, $14, $15, $16::jsonb, $17::jsonb, $18::jsonb, $19, $20
           )
           RETURNING *`,
          [
            event.eventId,
            id,
            manifestJob?.id || null,
            login,
            normalizedDevice,
            planDate,
            event.clientSequence,
            event.eventType,
            event.jobId,
            event.jobFingerprint,
            event.predecessorFingerprint,
            event.occurredAt,
            event.occurredAtRaw,
            event.occurrenceTimeValid,
            event.locationStatus,
            JSON.stringify(event.locationDetails),
            JSON.stringify(event.details),
            stableJson(event.immutablePayload),
            event.payloadHash,
            reviewReason
              ? "review_required"
              : event.photoDescriptors.length ? "waiting_photos" : "pending"
          ]
        );
        eventRow = inserted.rows[0];
        if (reviewReason) {
          const reviewed = await query(
            `UPDATE driver_offline_events
                SET review_reason = $2,
                    updated_at = now()
              WHERE id = $1
              RETURNING *`,
            [eventRow.id, reviewReason]
          );
          eventRow = reviewed.rows[0];
        }
      }
      for (const photo of event.photoDescriptors) {
        await insertOrValidateOfflinePhoto(eventRow.id, photo);
      }
      rows.push(eventRow);
    }
    const byEvent = await photosForEventRecords(rows.map((row) => row.id));
    return rows.map((row) => mapOfflineEvent(row, byEvent.get(String(row.id)) || []));
  });
}

export async function getDriverOfflinePhotoRegistration(photoId, {
  driverLogin,
  deviceId,
  manifestId
}) {
  const photo = uuidValue(photoId, "Photo ID");
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDevice = normalizeDriverDeviceId(deviceId);
  const id = uuidValue(manifestId, "Manifest ID");
  const result = await query(
    `SELECT p.*, e.event_id, e.original_job_id, e.event_type, e.event_details,
            e.manifest_id, e.driver_login, e.device_id
       FROM driver_offline_event_photos p
       JOIN driver_offline_events e ON e.id = p.event_record_id
      WHERE p.photo_id = $1::uuid
        AND e.manifest_id = $2::uuid
        AND lower(e.driver_login) = $3
        AND e.device_id = $4
      LIMIT 1`,
    [photo, id, login, normalizedDevice]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    ...mapOfflinePhoto(row),
    manifestId: row.manifest_id,
    eventId: row.event_id,
    eventType: row.event_type,
    jobId: row.original_job_id || "",
    dvirType: row.event_details?.dvirType || "",
    driverLogin: row.driver_login,
    deviceId: row.device_id
  };
}

export async function authorizeOfflinePhotoUpload({
  manifestId,
  deviceId,
  driverLogin,
  eventId,
  photoId,
  recordType,
  mimeType,
  byteSize,
  sha256
}) {
  const registration = await getDriverOfflinePhotoRegistration(photoId, {
    manifestId,
    deviceId,
    driverLogin
  });
  if (!registration) {
    throw repositoryError(
      "The photo must be registered by offline sync before an upload token is issued.",
      404,
      "OFFLINE_PHOTO_NOT_REGISTERED"
    );
  }
  const expected = {
    eventId: uuidValue(eventId, "Event ID"),
    recordType: requiredText(recordType, "Photo record type", { maxLength: 80 }),
    mimeType: requiredText(mimeType, "Photo MIME type", { maxLength: 80 }).toLowerCase().replace("image/jpg", "image/jpeg"),
    byteSize: integerValue(byteSize, "Photo byte size", { min: 1, max: MAX_PHOTO_BYTES }),
    sha256: sha256Value(sha256, "Photo SHA-256")
  };
  if (
    registration.eventId !== expected.eventId
    || registration.recordType !== expected.recordType
    || registration.mimeType !== expected.mimeType
    || registration.byteSize !== expected.byteSize
    || registration.sha256 !== expected.sha256
  ) {
    throw repositoryError(
      "Photo upload metadata does not match its registered descriptor.",
      409,
      "OFFLINE_PHOTO_UPLOAD_CONFLICT"
    );
  }
  if (registration.status === "rejected") {
    throw repositoryError("This photo registration was rejected.", 409, "OFFLINE_PHOTO_REJECTED");
  }
  return registration;
}

function normalizePhotoReceipt(receipt = {}) {
  const objectReference = requiredText(
    receipt.objectReference || receipt.reference || receipt.ref,
    "Photo object reference",
    { maxLength: 2048 }
  );
  if (!objectReference.startsWith("r2://") || objectReference.includes("..") || objectReference.includes("\\")) {
    throw repositoryError("Photo object reference is invalid.", 400, "OFFLINE_PHOTO_REFERENCE_INVALID");
  }
  const photoId = uuidValue(receipt.photoId, "Photo ID");
  if (!objectReference.toLowerCase().includes(photoId)) {
    throw repositoryError(
      "Photo object reference is outside its deterministic upload scope.",
      409,
      "OFFLINE_PHOTO_SCOPE_INVALID"
    );
  }
  return {
    photoId,
    objectReference,
    byteSize: integerValue(receipt.byteSize, "Photo byte size", { min: 1, max: MAX_PHOTO_BYTES }),
    sha256: sha256Value(receipt.sha256, "Photo SHA-256")
  };
}

function offlinePhotoReferenceMatchesRegistration(reference, registration) {
  const parts = String(reference || "").replace(/^r2:\/\//, "").split("/");
  return parts.length >= 7
    && parts[0] === "driver"
    && parts[1] === registration.record_type
    && /^\d{4}$/.test(parts[2])
    && /^(0[1-9]|1[0-2])$/.test(parts[3])
    && /^(0[1-9]|[12]\d|3[01])$/.test(parts[4])
    && parts[5].toLowerCase() === String(registration.photo_id).toLowerCase();
}

export async function recordDriverOfflinePhotoReceipts({
  driverLogin,
  deviceId,
  manifestId,
  photoReceipts = []
}) {
  const login = normalizeDriverLogin(driverLogin);
  const normalizedDevice = normalizeDriverDeviceId(deviceId);
  const id = uuidValue(manifestId, "Manifest ID");
  if (!Array.isArray(photoReceipts)) throw repositoryError("Photo receipts must be an array.");
  const receipts = photoReceipts.map(normalizePhotoReceipt);
  if (new Set(receipts.map((receipt) => receipt.photoId)).size !== receipts.length) {
    throw repositoryError("A sync batch contains a duplicate photo receipt.");
  }
  return withTransaction(async () => {
    const manifest = await manifestRowForRegistration(id, login, normalizedDevice);
    const planDate = manifest.plan_date instanceof Date
      ? manifest.plan_date.toISOString().slice(0, 10)
      : String(manifest.plan_date);
    await lockDriverDay(login, planDate);
    const output = [];
    for (const receipt of receipts) {
      const result = await query(
        `SELECT p.*
           FROM driver_offline_event_photos p
           JOIN driver_offline_events e ON e.id = p.event_record_id
          WHERE p.photo_id = $1::uuid
            AND e.manifest_id = $2::uuid
            AND lower(e.driver_login) = $3
            AND e.device_id = $4
          FOR UPDATE`,
        [receipt.photoId, id, login, normalizedDevice]
      );
      const row = result.rows[0];
      if (!row) throw repositoryError("Registered offline photo was not found.", 404, "OFFLINE_PHOTO_NOT_FOUND");
      if (Number(row.byte_size) !== receipt.byteSize || row.sha256 !== receipt.sha256) {
        throw repositoryError(
          "Uploaded photo metadata does not match its registered descriptor.",
          409,
          "OFFLINE_PHOTO_RECEIPT_CONFLICT"
        );
      }
      if (!offlinePhotoReferenceMatchesRegistration(receipt.objectReference, row)) {
        throw repositoryError(
          "Uploaded photo reference is outside its registered driver/event scope.",
          409,
          "OFFLINE_PHOTO_SCOPE_INVALID"
        );
      }
      if (
        row.object_reference
        && row.object_reference !== receipt.objectReference
        && row.status === "durably_received"
      ) {
        throw repositoryError(
          "A durably verified photo receipt cannot be changed.",
          409,
          "OFFLINE_PHOTO_RECEIPT_CONFLICT"
        );
      }
      const updated = await query(
        `UPDATE driver_offline_event_photos
            SET object_reference = CASE
                  WHEN status = 'durably_received' THEN object_reference
                  ELSE $2
                END,
                status = CASE
                  WHEN status = 'durably_received' THEN status
                  ELSE 'uploaded_unverified'
                END,
                uploaded_at = COALESCE(uploaded_at, now()),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [row.id, receipt.objectReference]
      );
      output.push(mapOfflinePhoto(updated.rows[0]));
    }
    return output;
  });
}

export async function markDriverOfflinePhotoDurable(photoId, {
  objectReference,
  verifiedByteSize,
  verifiedSha256,
  receipt = {}
}) {
  const photo = uuidValue(photoId, "Photo ID");
  const reference = requiredText(objectReference, "Photo object reference", { maxLength: 2048 });
  const bytes = integerValue(verifiedByteSize, "Verified photo byte size", { min: 1, max: MAX_PHOTO_BYTES });
  const checksum = sha256Value(verifiedSha256, "Verified photo SHA-256");
  return withTransaction(async () => {
    const result = await query(
      `SELECT *
         FROM driver_offline_event_photos
        WHERE photo_id = $1::uuid
        FOR UPDATE`,
      [photo]
    );
    const row = result.rows[0];
    if (!row) throw repositoryError("Registered offline photo was not found.", 404, "OFFLINE_PHOTO_NOT_FOUND");
    if (
      row.object_reference !== reference
      || Number(row.byte_size) !== bytes
      || row.sha256 !== checksum
    ) {
      throw repositoryError(
        "Durable photo verification does not match the registered evidence.",
        409,
        "OFFLINE_PHOTO_DURABILITY_CONFLICT"
      );
    }
    const updated = await query(
      `UPDATE driver_offline_event_photos
          SET status = 'durably_received',
              durable_received_at = COALESCE(durable_received_at, now()),
              durable_receipt = CASE
                WHEN status = 'durably_received' THEN durable_receipt
                ELSE $2::jsonb
              END,
              verification_attempt_count = verification_attempt_count
                + CASE WHEN status = 'durably_received' THEN 0 ELSE 1 END,
              last_verification_attempt_at = CASE
                WHEN status = 'durably_received' THEN last_verification_attempt_at
                ELSE now()
              END,
              last_verification_error_code = '',
              last_verification_error = '',
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [row.id, JSON.stringify(receipt || {})]
    );
    await query(
      `UPDATE driver_offline_events e
          SET status = CASE
                WHEN e.status = 'waiting_photos'
                 AND NOT EXISTS (
                   SELECT 1
                     FROM driver_offline_event_photos p
                    WHERE p.event_record_id = e.id
                      AND p.status <> 'durably_received'
                 )
                  THEN 'pending'
                ELSE e.status
              END,
              updated_at = now()
        WHERE e.id = $1`,
      [row.event_record_id]
    );
    return mapOfflinePhoto(updated.rows[0]);
  });
}

export async function recordDriverOfflinePhotoVerificationFailure(photoId, {
  errorCode = "OFFLINE_PHOTO_VERIFICATION_FAILED",
  errorMessage = "Photo durability verification failed."
} = {}) {
  const photo = uuidValue(photoId, "Photo ID");
  const code = optionalText(errorCode, { maxLength: 160 }) || "OFFLINE_PHOTO_VERIFICATION_FAILED";
  const message = optionalText(errorMessage, { maxLength: 2000 }) || "Photo durability verification failed.";
  return withTransaction(async () => {
    const result = await query(
      `SELECT *
         FROM driver_offline_event_photos
        WHERE photo_id = $1::uuid
        FOR UPDATE`,
      [photo]
    );
    const row = result.rows[0];
    if (!row) throw repositoryError("Registered offline photo was not found.", 404, "OFFLINE_PHOTO_NOT_FOUND");
    if (row.status === "durably_received") return mapOfflinePhoto(row);
    const updated = await query(
      `UPDATE driver_offline_event_photos
          SET verification_attempt_count = verification_attempt_count + 1,
              last_verification_attempt_at = now(),
              last_verification_error_code = $2,
              last_verification_error = $3,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [row.id, code, message]
    );
    return mapOfflinePhoto(updated.rows[0]);
  });
}

export async function findOpenDriverOfflineJobCompletion({
  driverLogin,
  deviceId,
  planDate,
  jobId,
  jobFingerprint,
  jobPredecessorFingerprint
}) {
  const login = normalizeDriverLogin(driverLogin);
  const currentDeviceId = normalizeDriverDeviceId(deviceId);
  const date = normalizePlanDate(planDate);
  const authoritativeJobId = requiredText(jobId, "Driver job ID", { maxLength: 1000 });
  const authoritativeFingerprint = sha256Value(jobFingerprint, "Driver job fingerprint");
  const authoritativePredecessorFingerprint = requiredText(
    jobPredecessorFingerprint,
    "Driver job predecessor fingerprint",
    { maxLength: 160 }
  );
  const openStatuses = [
    "registered",
    "waiting_photos",
    "pending",
    "applying",
    "review_required",
    "blocked",
    "resolution_pending"
  ];
  const result = await query(
    `SELECT event_id, device_id, original_job_id, job_fingerprint,
            predecessor_fingerprint, status,
            server_received_at, review_reason
       FROM driver_offline_events
      WHERE lower(driver_login) = $1
        AND plan_date = $2::date
        AND device_id <> $3
        AND event_type = 'job_completed'
        AND original_job_id = $4
        AND job_fingerprint = $5
        AND predecessor_fingerprint = $6
        AND status = ANY($7::text[])
      ORDER BY server_received_at, id
      LIMIT 1`,
    [
      login,
      date,
      currentDeviceId,
      authoritativeJobId,
      authoritativeFingerprint,
      authoritativePredecessorFingerprint,
      openStatuses
    ]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    eventId: row.event_id,
    eventType: "job_completed",
    deviceId: row.device_id,
    jobId: row.original_job_id,
    jobFingerprint: row.job_fingerprint,
    predecessorFingerprint: row.predecessor_fingerprint,
    status: row.status,
    reviewRequired: ["review_required", "blocked", "resolution_pending"].includes(row.status),
    reviewReason: row.review_reason || "",
    receivedAt: row.server_received_at
  };
}

export async function getDriverOfflineSyncQueue(driverLogin, planDate, {
  afterClientSequence = 0,
  limit = 500,
  deviceId = ""
} = {}) {
  const login = normalizeDriverLogin(driverLogin);
  const date = normalizePlanDate(planDate);
  const after = integerValue(afterClientSequence, "After sequence", { min: 0 });
  const safeLimit = integerValue(limit, "Queue limit", { min: 1, max: 1000 });
  const normalizedDeviceId = deviceId ? normalizeDriverDeviceId(deviceId) : "";
  const result = await query(
    `SELECT *
       FROM driver_offline_events
      WHERE lower(driver_login) = $1
        AND plan_date = $2::date
        AND client_sequence > $3
        AND ($4 = '' OR device_id = $4)
      ORDER BY client_sequence, id
      LIMIT $5`,
    [login, date, after, normalizedDeviceId, safeLimit]
  );
  const photos = await photosForEventRecords(result.rows.map((row) => row.id));
  return result.rows.map((row) => mapOfflineEvent(row, photos.get(String(row.id)) || []));
}

async function updateOfflineEventStatus(eventId, {
  allowedStatuses = [],
  status,
  effectiveJobId = "",
  reviewReason = "",
  result = {},
  applied = false
}) {
  const id = uuidValue(eventId, "Event ID");
  if (!allowedStatuses.length) throw repositoryError("Allowed event statuses are required.");
  return withTransaction(async () => {
    const identity = await query(
      `SELECT driver_login, plan_date
         FROM driver_offline_events
        WHERE event_id = $1::uuid
        LIMIT 1`,
      [id]
    );
    if (!identity.rowCount) throw repositoryError("Offline event was not found.", 404, "OFFLINE_EVENT_NOT_FOUND");
    await lockDriverDay(identity.rows[0].driver_login, identity.rows[0].plan_date);
    const updated = await query(
      `UPDATE driver_offline_events
          SET status = $2,
              effective_job_id = COALESCE(NULLIF($3, ''), effective_job_id),
              review_reason = $4,
              application_result = $5::jsonb,
              server_applied_at = CASE WHEN $6 THEN COALESCE(server_applied_at, now()) ELSE server_applied_at END,
              case_version = CASE
                WHEN status IS DISTINCT FROM $2 OR review_reason IS DISTINCT FROM $4
                  THEN case_version + 1
                ELSE case_version
              END,
              updated_at = now()
        WHERE event_id = $1::uuid
          AND status = ANY($7::text[])
        RETURNING *`,
      [
        id,
        status,
        optionalText(effectiveJobId, { maxLength: 1000 }),
        optionalText(reviewReason, { maxLength: 2000 }),
        JSON.stringify(result || {}),
        applied === true,
        allowedStatuses
      ]
    );
    if (!updated.rowCount) {
      const existing = await query("SELECT * FROM driver_offline_events WHERE event_id = $1::uuid", [id]);
      if (existing.rows[0].status === status) return mapOfflineEvent(existing.rows[0]);
      throw repositoryError("Offline event is no longer in an applicable state.", 409, "OFFLINE_EVENT_STATE_CONFLICT");
    }
    return mapOfflineEvent(updated.rows[0]);
  });
}

export function markDriverOfflineEventApplying(eventId) {
  return updateOfflineEventStatus(eventId, {
    allowedStatuses: ["pending"],
    status: "applying"
  });
}

export function markDriverOfflineEventApplied(eventId, {
  effectiveJobId = "",
  result = {}
} = {}) {
  return updateOfflineEventStatus(eventId, {
    allowedStatuses: ["pending", "applying", "resolution_pending"],
    status: "applied",
    effectiveJobId,
    result,
    applied: true
  });
}

export function markDriverOfflineEventReviewRequired(eventId, {
  reason,
  result = {}
} = {}) {
  return updateOfflineEventStatus(eventId, {
    allowedStatuses: ["pending", "applying", "blocked"],
    status: "review_required",
    reviewReason: requiredText(reason, "Review reason", { maxLength: 2000 }),
    result
  });
}

export function markDriverOfflineEventBlocked(eventId, {
  reason = "Blocked behind an earlier event requiring review."
} = {}) {
  return updateOfflineEventStatus(eventId, {
    allowedStatuses: ["pending"],
    status: "blocked",
    reviewReason: reason
  });
}

export function markDriverOfflineEventEvidenceOnly(eventId, {
  reason = "The saved event was retained as evidence after a Dispatcher correction.",
  result = {}
} = {}) {
  return updateOfflineEventStatus(eventId, {
    allowedStatuses: [
      "registered",
      "waiting_photos",
      "pending",
      "applying",
      "review_required",
      "blocked",
      "resolution_pending"
    ],
    status: "evidence_only",
    reviewReason: optionalText(reason, { maxLength: 2000 }),
    result,
    applied: true
  });
}

export function releaseDriverOfflineEventForReplay(eventId) {
  return updateOfflineEventStatus(eventId, {
    allowedStatuses: ["blocked"],
    status: "pending"
  });
}

export async function getDriverOfflineEvent(eventId) {
  const id = uuidValue(eventId, "Event ID");
  const result = await query(
    "SELECT * FROM driver_offline_events WHERE event_id = $1::uuid LIMIT 1",
    [id]
  );
  if (!result.rowCount) return null;
  const photos = await photosForEventRecords([result.rows[0].id]);
  return mapOfflineEvent(result.rows[0], photos.get(String(result.rows[0].id)) || []);
}

export async function getDriverOfflineSyncSummary(manifestId) {
  const id = uuidValue(manifestId, "Manifest ID");
  const result = await query(
    `SELECT
       COUNT(*) FILTER (
         WHERE status NOT IN ('applied', 'evidence_only', 'rejected')
       )::integer AS pending_count,
       COUNT(*) FILTER (
         WHERE status = 'review_required'
       )::integer AS review_count,
       MAX(server_applied_at) AS last_applied_at
       FROM driver_offline_events
      WHERE manifest_id = $1::uuid`,
    [id]
  );
  return {
    pendingCount: Number(result.rows[0]?.pending_count || 0),
    reviewRequired: Number(result.rows[0]?.review_count || 0) > 0,
    reviewCount: Number(result.rows[0]?.review_count || 0),
    lastAppliedAt: result.rows[0]?.last_applied_at || null
  };
}

export async function registerDriverOfflineSync({
  driverLogin,
  deviceId,
  manifestId,
  events = [],
  photoReceipts = []
}) {
  const registeredEvents = await registerDriverOfflineEvents({
    driverLogin,
    deviceId,
    manifestId,
    events
  });
  const photos = await recordDriverOfflinePhotoReceipts({
    driverLogin,
    deviceId,
    manifestId,
    photoReceipts
  });
  const refreshedEvents = [];
  for (const event of registeredEvents) {
    refreshedEvents.push(await getDriverOfflineEvent(event.eventId));
  }
  const summary = await getDriverOfflineSyncSummary(manifestId);
  return {
    manifestId: uuidValue(manifestId, "Manifest ID"),
    receivedAt: new Date().toISOString(),
    events: refreshedEvents,
    photos,
    ...summary
  };
}

export function findDriverOfflineRebaseCandidates(manifestEvent, currentJobs = [], driverLogin = "") {
  const event = manifestEvent || {};
  const login = normalizeDriverLogin(driverLogin || event.driverLogin);
  return materializeDriverOfflineJobs(currentJobs, login)
    .filter((job) =>
      job.fingerprint === event.jobFingerprint
      && job.predecessorFingerprint === event.predecessorFingerprint
      && normalizeDriverLogin(job.snapshot.driverLogin) === login
    )
    .map((job) => ({
      jobId: job.snapshot.jobId,
      label: [
        job.snapshot.stopType,
        job.snapshot.loadName || job.snapshot.loadId,
        job.snapshot.location || job.snapshot.address
      ].filter(Boolean).join(" · "),
      fingerprint: job.fingerprint,
      predecessorFingerprint: job.predecessorFingerprint,
      compatible: true,
      job: job.snapshot
    }));
}

export async function getDriverOfflineReviewCounts() {
  const openStatuses = [
    "registered",
    "waiting_photos",
    "pending",
    "applying",
    "review_required",
    "blocked",
    "resolution_pending"
  ];
  const [result, photoResult] = await Promise.all([
    query(
      `SELECT status, COUNT(*)::integer AS count
         FROM driver_offline_events
        WHERE status = ANY($1::text[])
        GROUP BY status`,
      [openStatuses]
    ),
    query(
      `SELECT COUNT(p.id)::integer AS photo_count,
              COUNT(p.id) FILTER (WHERE p.status = 'durably_received')::integer AS durable_photo_count,
              COUNT(p.id) FILTER (
                WHERE p.status <> 'durably_received' AND COALESCE(p.object_reference, '') <> ''
              )::integer AS uploaded_photo_count,
              COUNT(p.id) FILTER (
                WHERE p.status <> 'durably_received' AND COALESCE(p.object_reference, '') = ''
              )::integer AS missing_upload_photo_count,
              COUNT(p.id) FILTER (
                WHERE COALESCE(p.last_verification_error, '') <> ''
              )::integer AS verification_error_count
         FROM driver_offline_events e
         JOIN driver_offline_event_photos p ON p.event_record_id = e.id
        WHERE e.status = ANY($1::text[])`,
      [openStatuses]
    )
  ]);
  const byStatus = Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count || 0)]));
  const serverSyncCount = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  const actionRequiredCount = Number(byStatus.review_required || 0);
  const photoRow = photoResult.rows[0] || {};
  return {
    count: serverSyncCount,
    serverSyncCount,
    actionRequiredCount,
    syncInProgressCount: Math.max(0, serverSyncCount - actionRequiredCount),
    byStatus,
    photoCounts: {
      total: Number(photoRow.photo_count || 0),
      durable: Number(photoRow.durable_photo_count || 0),
      uploaded: Number(photoRow.uploaded_photo_count || 0),
      missingUploads: Number(photoRow.missing_upload_photo_count || 0),
      verificationErrors: Number(photoRow.verification_error_count || 0)
    }
  };
}

export async function countDriverOfflineReviews() {
  return (await getDriverOfflineReviewCounts()).serverSyncCount;
}

function mapReviewListRow(row) {
  const status = String(row.status || "");
  const stateAgeMs = Math.max(0, Number(row.state_age_ms || 0));
  return {
    eventId: row.event_id,
    caseVersion: Number(row.case_version || 1),
    status,
    driverLogin: row.driver_login,
    deviceId: row.device_id || "",
    planDate: row.plan_date instanceof Date ? row.plan_date.toISOString().slice(0, 10) : String(row.plan_date),
    eventType: row.event_type,
    originalJobId: row.original_job_id || "",
    effectiveJobId: row.effective_job_id || "",
    reason: row.review_reason || "",
    occurredAt: row.device_occurred_at,
    receivedAt: row.server_received_at,
    appliedAt: row.server_applied_at,
    stateUpdatedAt: row.updated_at,
    stateAgeMs,
    canResolveEvidenceOnly: status === "review_required"
      || (EVIDENCE_ONLY_RESOLVABLE_STATUSES.has(status) && stateAgeMs >= EVIDENCE_ONLY_STALE_MS),
    photoCount: Number(row.photo_count || 0),
    durablePhotoCount: Number(row.durable_photo_count || 0),
    uploadedPhotoCount: Number(row.uploaded_photo_count || 0),
    missingUploadPhotoCount: Number(row.missing_upload_photo_count || 0),
    photoVerificationErrorCount: Number(row.photo_verification_error_count || 0),
    lastPhotoVerificationAttemptAt: row.last_photo_verification_attempt_at || null
  };
}

export async function listDriverOfflineReviews({
  status = "open",
  limit = 100,
  offset = 0,
  driverLogin = "",
  planDate = ""
} = {}) {
  const safeLimit = integerValue(limit, "Review limit", { min: 1, max: 250 });
  const safeOffset = integerValue(offset, "Review offset", { min: 0, max: 1000000 });
  const params = [];
  const clauses = [];
  if (status === "open") {
    clauses.push(`e.status IN (
      'registered',
      'waiting_photos',
      'pending',
      'applying',
      'review_required',
      'blocked',
      'resolution_pending'
    )`);
  }
  else if (status === "resolved") {
    clauses.push("e.status IN ('applied', 'evidence_only')");
    clauses.push("EXISTS (SELECT 1 FROM driver_offline_resolutions r WHERE r.event_record_id = e.id)");
  }
  else if (status !== "all") throw repositoryError("Review status filter is invalid.");
  if (driverLogin) {
    params.push(normalizeDriverLogin(driverLogin));
    clauses.push(`lower(e.driver_login) = $${params.length}`);
  }
  if (planDate) {
    params.push(normalizePlanDate(planDate));
    clauses.push(`e.plan_date = $${params.length}::date`);
  }
  params.push(safeLimit, safeOffset);
  const result = await query(
    `SELECT e.*,
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - e.updated_at)) * 1000))::bigint AS state_age_ms,
            COUNT(p.id)::integer AS photo_count,
            COUNT(p.id) FILTER (WHERE p.status = 'durably_received')::integer AS durable_photo_count,
            COUNT(p.id) FILTER (
              WHERE p.status <> 'durably_received' AND COALESCE(p.object_reference, '') <> ''
            )::integer AS uploaded_photo_count,
            COUNT(p.id) FILTER (
              WHERE p.status <> 'durably_received' AND COALESCE(p.object_reference, '') = ''
            )::integer AS missing_upload_photo_count,
            COUNT(p.id) FILTER (
              WHERE COALESCE(p.last_verification_error, '') <> ''
            )::integer AS photo_verification_error_count,
            MAX(p.last_verification_attempt_at) AS last_photo_verification_attempt_at
       FROM driver_offline_events e
       LEFT JOIN driver_offline_event_photos p ON p.event_record_id = e.id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      GROUP BY e.id
      ORDER BY
        CASE WHEN e.status = 'review_required' THEN 0 ELSE 1 END,
        e.server_received_at,
        e.id
      LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params
  );
  return {
    cases: result.rows.map(mapReviewListRow),
    nextOffset: result.rowCount === safeLimit ? safeOffset + safeLimit : null
  };
}

function mapResolution(row) {
  if (!row) return null;
  return {
    resolutionId: row.resolution_id,
    idempotencyId: row.idempotency_id,
    caseVersion: Number(row.case_version),
    action: row.action,
    targetJobId: row.target_job_id || "",
    auditNote: row.audit_note,
    resolvedBy: row.resolved_by,
    resolvedAt: row.created_at,
    result: row.result || {}
  };
}

export async function getDriverOfflineReview(eventId) {
  const id = uuidValue(eventId, "Event ID");
  const result = await query(
    `SELECT e.*, j.job_snapshot, j.sequence_index,
            j.job_fingerprint AS snapshot_fingerprint,
            j.predecessor_fingerprint AS snapshot_predecessor_fingerprint,
            m.plan_id, m.plan_revision
       FROM driver_offline_events e
       JOIN driver_offline_manifests m ON m.manifest_id = e.manifest_id
       LEFT JOIN driver_offline_manifest_jobs j ON j.id = e.manifest_job_id
      WHERE e.event_id = $1::uuid
      LIMIT 1`,
    [id]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const photos = await photosForEventRecords([row.id]);
  const resolutionResult = await query(
    `SELECT *
       FROM driver_offline_resolutions
      WHERE event_record_id = $1
      LIMIT 1`,
    [row.id]
  );
  const resolution = mapResolution(resolutionResult.rows[0]);
  const event = mapOfflineEvent(row, photos.get(String(row.id)) || []);
  const photoSummary = {
    photo_count: event.photos.length,
    durable_photo_count: event.photos.filter((photo) => photo.durableReceipt).length,
    uploaded_photo_count: event.photos.filter((photo) => !photo.durableReceipt && photo.objectReference).length,
    missing_upload_photo_count: event.photos.filter((photo) => !photo.durableReceipt && !photo.objectReference).length,
    photo_verification_error_count: event.photos.filter((photo) => photo.lastVerificationError).length,
    last_photo_verification_attempt_at: event.photos
      .map((photo) => photo.lastVerificationAttemptAt)
      .filter(Boolean)
      .sort((left, right) => new Date(right) - new Date(left))[0] || null,
    state_age_ms: Math.max(0, Date.now() - new Date(row.updated_at).getTime())
  };
  const timeline = [
    {
      type: "occurred",
      status: "recorded_on_device",
      at: row.device_occurred_at,
      actor: row.driver_login,
      note: "",
      details: { eventType: row.event_type, locationStatus: row.location_status }
    },
    {
      type: "received",
      status: "durably_received",
      at: row.server_received_at,
      actor: "server",
      note: "",
      details: {}
    }
  ];
  if (row.review_reason) {
    timeline.push({
      type: "review",
      status: "review_required",
      at: row.updated_at,
      actor: "server",
      note: row.review_reason,
      details: { caseVersion: Number(row.case_version) }
    });
  }
  if (resolution) {
    timeline.push({
      type: "resolution",
      status: row.status,
      at: resolution.resolvedAt,
      actor: resolution.resolvedBy,
      note: resolution.auditNote,
      details: { action: resolution.action, targetJobId: resolution.targetJobId }
    });
  }
  if (row.server_applied_at) {
    timeline.push({
      type: "application",
      status: row.status,
      at: row.server_applied_at,
      actor: "server",
      note: "",
      details: row.application_result || {}
    });
  }
  timeline.sort((left, right) => new Date(left.at || 0) - new Date(right.at || 0));
  return {
    case: {
      ...mapReviewListRow({ ...row, ...photoSummary }),
      manifestId: row.manifest_id,
      deviceId: row.device_id,
      clientSequence: Number(row.client_sequence),
      locationStatus: row.location_status,
      locationDetails: row.location_details || {},
      payload: row.immutable_payload || {},
      originalJob: row.job_snapshot
        ? {
            jobId: row.original_job_id,
            fingerprint: row.snapshot_fingerprint,
            predecessorFingerprint: row.snapshot_predecessor_fingerprint,
            sequenceIndex: Number(row.sequence_index),
            snapshot: row.job_snapshot
          }
        : null,
      currentJob: null,
      candidates: [],
      photos: event.photos,
      timeline,
      resolution,
      version: Number(row.case_version || 1),
      planId: row.plan_id,
      planRevision: Number(row.plan_revision || 0)
    }
  };
}

function validateResolutionInput({
  eventId,
  action,
  targetJobId = "",
  auditNote,
  caseVersion,
  idempotencyId,
  resolvedBy,
  confirmed = false
}) {
  const normalizedAction = requiredText(action, "Resolution action", { maxLength: 40 });
  if (!["apply_original", "reattach", "evidence_only"].includes(normalizedAction)) {
    throw repositoryError("Resolution action is invalid.");
  }
  const target = optionalText(targetJobId, { maxLength: 1000 });
  if (normalizedAction === "reattach" && !target) {
    throw repositoryError("Reattach requires a validated target job.");
  }
  return {
    eventId: uuidValue(eventId, "Event ID"),
    action: normalizedAction,
    targetJobId: target,
    auditNote: requiredText(auditNote, "Audit note", { maxLength: 4000 }),
    caseVersion: integerValue(caseVersion, "Case version", { min: 1 }),
    idempotencyId: uuidValue(idempotencyId, "Resolution idempotency ID"),
    resolvedBy: requiredText(resolvedBy, "Resolving operator", { maxLength: 240 }),
    confirmed: confirmed === true
  };
}

function mapDriverOfflineRetryAttempt(row) {
  if (!row) return null;
  return {
    retryId: row.retry_id,
    eventRecordId: String(row.event_record_id),
    caseVersion: Number(row.case_version),
    requestedBy: row.requested_by,
    status: row.status,
    result: row.result || {},
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

export async function beginDriverOfflineRetry({
  eventId,
  caseVersion,
  retryId,
  requestedBy
}) {
  const eventUuid = uuidValue(eventId, "Event ID");
  const version = integerValue(caseVersion, "Case version", { min: 1 });
  const retryUuid = uuidValue(retryId, "Retry idempotency ID");
  const actor = requiredText(requestedBy, "Retrying operator", { maxLength: 240 });
  return withTransaction(async () => {
    const identity = await query(
      `SELECT driver_login, plan_date
         FROM driver_offline_events
        WHERE event_id = $1::uuid
        LIMIT 1`,
      [eventUuid]
    );
    if (!identity.rowCount) {
      throw repositoryError("Offline sync record was not found.", 404, "OFFLINE_EVENT_NOT_FOUND");
    }
    await lockDriverDay(identity.rows[0].driver_login, identity.rows[0].plan_date);
    const eventResult = await query(
      `SELECT *
         FROM driver_offline_events
        WHERE event_id = $1::uuid
        FOR UPDATE`,
      [eventUuid]
    );
    const eventRow = eventResult.rows[0];
    const existingResult = await query(
      `SELECT *
         FROM driver_offline_retry_attempts
        WHERE retry_id = $1::uuid
        LIMIT 1
        FOR UPDATE`,
      [retryUuid]
    );
    if (existingResult.rowCount) {
      const existing = existingResult.rows[0];
      if (
        String(existing.event_record_id) !== String(eventRow.id)
        || Number(existing.case_version) !== version
        || existing.requested_by !== actor
      ) {
        throw repositoryError(
          "This retry idempotency ID was already used for a different request.",
          409,
          "OFFLINE_RETRY_IDEMPOTENCY_CONFLICT"
        );
      }
      if (["completed", "failed"].includes(existing.status)) {
        return {
          replay: true,
          retry: mapDriverOfflineRetryAttempt(existing),
          result: existing.result || {}
        };
      }
      const attemptAgeMs = Math.max(0, Date.now() - new Date(existing.updated_at).getTime());
      if (attemptAgeMs < EVIDENCE_ONLY_STALE_MS) {
        throw repositoryError(
          "This offline retry is already running. Wait for it to finish and refresh.",
          409,
          "OFFLINE_RETRY_IN_PROGRESS"
        );
      }
      if (!RETRYABLE_OFFLINE_STATUSES.has(String(eventRow.status || ""))) {
        throw repositoryError(
          "This sync record is no longer in a retryable state.",
          409,
          "OFFLINE_RETRY_STATE_CONFLICT"
        );
      }
      if (Number(eventRow.case_version) !== version) {
        throw repositoryError(
          "Offline sync record changed. Refresh before resuming this retry.",
          409,
          "OFFLINE_RETRY_VERSION_CONFLICT"
        );
      }
      const resumed = await query(
        `UPDATE driver_offline_retry_attempts
            SET updated_at = now(),
                error_code = '',
                error_message = ''
          WHERE id = $1
          RETURNING *`,
        [existing.id]
      );
      const photos = await photosForEventRecords([eventRow.id]);
      return {
        replay: false,
        resumed: true,
        retry: mapDriverOfflineRetryAttempt(resumed.rows[0]),
        event: mapOfflineEvent(eventRow, photos.get(String(eventRow.id)) || [])
      };
    }
    if (!RETRYABLE_OFFLINE_STATUSES.has(String(eventRow.status || ""))) {
      throw repositoryError(
        "Only registered, waiting-for-photos, pending, or blocked sync records can be retried.",
        409,
        "OFFLINE_RETRY_STATE_CONFLICT"
      );
    }
    if (Number(eventRow.case_version) !== version) {
      throw repositoryError(
        "Offline sync record changed. Refresh before retrying it.",
        409,
        "OFFLINE_RETRY_VERSION_CONFLICT"
      );
    }
    const active = await query(
      `SELECT retry_id
         FROM driver_offline_retry_attempts
        WHERE event_record_id = $1
          AND status = 'executing'
          AND updated_at >= now() - interval '5 minutes'
        LIMIT 1`,
      [eventRow.id]
    );
    if (active.rowCount) {
      throw repositoryError(
        "Another retry for this offline sync record is already running.",
        409,
        "OFFLINE_RETRY_IN_PROGRESS"
      );
    }
    const inserted = await query(
      `INSERT INTO driver_offline_retry_attempts (
         retry_id, event_record_id, case_version, requested_by
       ) VALUES ($1::uuid, $2, $3, $4)
       RETURNING *`,
      [retryUuid, eventRow.id, version, actor]
    );
    const photos = await photosForEventRecords([eventRow.id]);
    return {
      replay: false,
      resumed: false,
      retry: mapDriverOfflineRetryAttempt(inserted.rows[0]),
      event: mapOfflineEvent(eventRow, photos.get(String(eventRow.id)) || [])
    };
  });
}

export async function completeDriverOfflineRetry(retryId, result = {}) {
  const retryUuid = uuidValue(retryId, "Retry idempotency ID");
  const updated = await query(
    `UPDATE driver_offline_retry_attempts
        SET status = 'completed',
            result = $2::jsonb,
            error_code = '',
            error_message = '',
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE retry_id = $1::uuid
        AND status = 'executing'
      RETURNING *`,
    [retryUuid, JSON.stringify(result || {})]
  );
  if (updated.rowCount) return mapDriverOfflineRetryAttempt(updated.rows[0]);
  const existing = await query(
    `SELECT * FROM driver_offline_retry_attempts WHERE retry_id = $1::uuid LIMIT 1`,
    [retryUuid]
  );
  if (!existing.rowCount) throw repositoryError("Offline retry attempt was not found.", 404, "OFFLINE_RETRY_NOT_FOUND");
  return mapDriverOfflineRetryAttempt(existing.rows[0]);
}

export async function failDriverOfflineRetry(retryId, error) {
  const retryUuid = uuidValue(retryId, "Retry idempotency ID");
  const code = String(error?.code || "OFFLINE_RETRY_FAILED").slice(0, 160);
  const message = String(error?.message || error || "Offline retry failed.").slice(0, 2000);
  const updated = await query(
    `UPDATE driver_offline_retry_attempts
        SET status = 'failed',
            result = $2::jsonb,
            error_code = $3,
            error_message = $4,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE retry_id = $1::uuid
        AND status = 'executing'
      RETURNING *`,
    [retryUuid, JSON.stringify({ error: message, code }), code, message]
  );
  return mapDriverOfflineRetryAttempt(updated.rows[0]);
}

export async function resolveDriverOfflineReview(input, {
  applyResolution = null,
  replayBlocked = null
} = {}) {
  const resolutionInput = validateResolutionInput(input);
  return withTransaction(async () => {
    const identityResult = await query(
      `SELECT driver_login, plan_date
         FROM driver_offline_events
        WHERE event_id = $1::uuid
        LIMIT 1`,
      [resolutionInput.eventId]
    );
    if (!identityResult.rowCount) {
      throw repositoryError("Offline review case was not found.", 404, "OFFLINE_REVIEW_NOT_FOUND");
    }
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    await lockDriverDay(identityResult.rows[0].driver_login, identityResult.rows[0].plan_date);
    const eventResult = await query(
      `SELECT *,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - updated_at)) * 1000))::bigint AS state_age_ms
         FROM driver_offline_events
        WHERE event_id = $1::uuid
        FOR UPDATE`,
      [resolutionInput.eventId]
    );
    const eventRow = eventResult.rows[0];
    if (!eventRow) throw repositoryError("Offline review case was not found.", 404, "OFFLINE_REVIEW_NOT_FOUND");

    const existing = await query(
      `SELECT *
         FROM driver_offline_resolutions
        WHERE event_record_id = $1
           OR idempotency_id = $2::uuid
        ORDER BY id
        LIMIT 2`,
      [eventRow.id, resolutionInput.idempotencyId]
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (
        existing.rowCount === 1
        && String(row.event_record_id) === String(eventRow.id)
        && row.idempotency_id === resolutionInput.idempotencyId
        && row.case_version === resolutionInput.caseVersion
        && row.action === resolutionInput.action
        && (row.target_job_id || "") === resolutionInput.targetJobId
        && row.audit_note === resolutionInput.auditNote
        && row.resolved_by === resolutionInput.resolvedBy
      ) {
        return {
          eventId: resolutionInput.eventId,
          status: eventRow.status,
          sourceStatus: row.result?.sourceStatus || "",
          sourceStateAgeMs: Number(row.result?.sourceStateAgeMs || 0),
          driverLogin: eventRow.driver_login,
          planDate: eventRow.plan_date instanceof Date
            ? eventRow.plan_date.toISOString().slice(0, 10)
            : String(eventRow.plan_date),
          deviceId: eventRow.device_id,
          resolution: mapResolution(row),
          replayed: row.result?.replayed || []
        };
      }
      throw repositoryError(
        "This case or idempotency ID already has a different resolution.",
        409,
        "OFFLINE_RESOLUTION_IDEMPOTENCY_CONFLICT"
      );
    }
    const sourceStatus = String(eventRow.status || "");
    const sourceStateAgeMs = Math.max(0, Number(eventRow.state_age_ms || 0));
    const evidenceOnly = resolutionInput.action === "evidence_only";
    const statusAllowed = evidenceOnly
      ? EVIDENCE_ONLY_RESOLVABLE_STATUSES.has(sourceStatus)
      : sourceStatus === "review_required";
    if (!statusAllowed) {
      throw repositoryError(
        evidenceOnly
          ? "This sync record cannot be closed as evidence only in its current state."
          : "Operational resolution is available only for a review-required record.",
        409,
        "OFFLINE_REVIEW_STATE_CONFLICT"
      );
    }
    if (evidenceOnly && sourceStatus !== "review_required" && sourceStateAgeMs < EVIDENCE_ONLY_STALE_MS) {
      const remainingMs = Math.max(1, EVIDENCE_ONLY_STALE_MS - sourceStateAgeMs);
      throw Object.assign(
        repositoryError(
          `This sync record is still active. Wait ${Math.ceil(remainingMs / 1000)} more second${remainingMs > 1000 ? "s" : ""}, refresh, and then close it as evidence only if the Driver device cannot finish synchronizing.`,
          409,
          "OFFLINE_EVIDENCE_ONLY_STATE_ACTIVE"
        ),
        { sourceStatus, sourceStateAgeMs, retryAfterMs: remainingMs }
      );
    }
    if (evidenceOnly && sourceStatus !== "review_required" && !resolutionInput.confirmed) {
      throw repositoryError(
        "Confirm that the Driver device cannot finish synchronizing before closing this active sync record as evidence only.",
        400,
        "OFFLINE_EVIDENCE_ONLY_CONFIRMATION_REQUIRED"
      );
    }
    if (Number(eventRow.case_version) !== resolutionInput.caseVersion) {
      throw repositoryError(
        "Offline review case changed. Refresh before resolving it.",
        409,
        "OFFLINE_REVIEW_VERSION_CONFLICT"
      );
    }
    if (!evidenceOnly) {
      const earlierBarrier = await query(
        `SELECT event_id, status, client_sequence
           FROM driver_offline_events
          WHERE lower(driver_login) = lower($1)
            AND plan_date = $2::date
            AND device_id = $3
            AND ROW(client_sequence, id) < ROW($4::bigint, $5::bigint)
            AND status IN (
              'registered',
              'waiting_photos',
              'pending',
              'applying',
              'review_required',
              'blocked',
              'resolution_pending'
            )
          ORDER BY client_sequence, id
          LIMIT 1`,
        [
          eventRow.driver_login,
          eventRow.plan_date,
          eventRow.device_id,
          eventRow.client_sequence,
          eventRow.id
        ]
      );
      if (earlierBarrier.rowCount) {
        throw repositoryError(
          `Resolve or synchronize the earlier ${earlierBarrier.rows[0].status} record before applying this event.`,
          409,
          "OFFLINE_RESOLUTION_EARLIER_EVENT_PENDING"
        );
      }
    }

    const eventPhotos = await photosForEventRecords([eventRow.id]);
    const event = mapOfflineEvent(eventRow, eventPhotos.get(String(eventRow.id)) || []);
    const effectiveJobId = resolutionInput.action === "apply_original"
      ? event.jobId
      : resolutionInput.action === "reattach"
        ? resolutionInput.targetJobId
        : "";
    let applicationResult = evidenceOnly
      ? {
          ...(event.result || {}),
          disposition: "evidence_only",
          sourceStatus,
          sourceStateAgeMs
        }
      : {};
    if (resolutionInput.action !== "evidence_only") {
      if (typeof applyResolution !== "function") {
        throw repositoryError(
          "An operational resolution handler is required for this action.",
          500,
          "OFFLINE_RESOLUTION_HANDLER_REQUIRED"
        );
      }
      applicationResult = await applyResolution({
        event,
        action: resolutionInput.action,
        effectiveJobId,
        resolvedBy: resolutionInput.resolvedBy,
        auditNote: resolutionInput.auditNote
      }) || {};
    }

    const nextStatus = resolutionInput.action === "evidence_only" ? "evidence_only" : "applied";
    const updated = await query(
      `UPDATE driver_offline_events
          SET status = $2,
              effective_job_id = COALESCE(NULLIF($3, ''), effective_job_id),
              application_result = $4::jsonb,
              server_applied_at = CASE
                WHEN $2 = 'applied' THEN COALESCE(server_applied_at, now())
                ELSE server_applied_at
              END,
              case_version = case_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [eventRow.id, nextStatus, effectiveJobId, JSON.stringify(applicationResult)]
    );

    const blockedResult = await query(
      `SELECT *
         FROM driver_offline_events
        WHERE lower(driver_login) = lower($1)
          AND plan_date = $2::date
          AND device_id = $3
          AND ROW(client_sequence, id) > ROW($4::bigint, $5::bigint)
          AND status = 'blocked'
        ORDER BY client_sequence, id
        FOR UPDATE`,
      [eventRow.driver_login, eventRow.plan_date, eventRow.device_id, eventRow.client_sequence, eventRow.id]
    );
    const blockedPhotos = await photosForEventRecords(blockedResult.rows.map((row) => row.id));
    const blockedEvents = blockedResult.rows.map((row) =>
      mapOfflineEvent(row, blockedPhotos.get(String(row.id)) || [])
    );
    const replayed = typeof replayBlocked === "function"
      ? await replayBlocked({
          driverLogin: eventRow.driver_login,
          planDate: event.planDate,
          deviceId: eventRow.device_id,
          afterClientSequence: Number(eventRow.client_sequence),
          afterEventRecordId: String(eventRow.id),
          blockedEvents
        }) || []
      : [];
    if (!Array.isArray(replayed)) {
      throw repositoryError("Blocked-event replay must return an array.", 500, "OFFLINE_REPLAY_RESULT_INVALID");
    }
    const blockedById = new Map(blockedResult.rows.map((row) => [row.event_id, row]));
    let stoppedAtReview = false;
    for (const replay of replayed) {
      const replayEventId = uuidValue(replay?.eventId, "Replayed event ID");
      const blockedRow = blockedById.get(replayEventId);
      if (!blockedRow) {
        throw repositoryError(
          "Blocked-event replay returned an event outside this sequence.",
          500,
          "OFFLINE_REPLAY_RESULT_INVALID"
        );
      }
      const replayStatus = requiredText(replay.status, "Replayed event status", { maxLength: 40 });
      if (!["applied", "review_required", "blocked"].includes(replayStatus)) {
        throw repositoryError("Blocked-event replay status is invalid.", 500, "OFFLINE_REPLAY_RESULT_INVALID");
      }
      const currentResult = await query(
        `SELECT *
           FROM driver_offline_events
          WHERE id = $1
          FOR UPDATE`,
        [blockedRow.id]
      );
      const currentRow = currentResult.rows[0];
      if (stoppedAtReview && replayStatus !== "blocked") {
        throw repositoryError(
          "Events after a replay conflict must remain blocked.",
          500,
          "OFFLINE_REPLAY_ORDER_INVALID"
        );
      }
      if (currentRow.status === replayStatus) {
        if (replayStatus === "review_required") stoppedAtReview = true;
        continue;
      }
      if (currentRow.status !== "blocked") {
        throw repositoryError(
          "Blocked-event replay returned a status that does not match the stored event.",
          500,
          "OFFLINE_REPLAY_RESULT_INVALID"
        );
      }
      if (replayStatus === "blocked") continue;
      const replayReason = replayStatus === "review_required"
        ? requiredText(replay.reason || replay.reviewReason, "Replay review reason", { maxLength: 2000 })
        : "";
      await query(
        `UPDATE driver_offline_events
            SET status = $2,
                effective_job_id = COALESCE(NULLIF($3, ''), effective_job_id),
                review_reason = $4,
                application_result = $5::jsonb,
                server_applied_at = CASE
                  WHEN $2 = 'applied' THEN COALESCE(server_applied_at, now())
                  ELSE server_applied_at
                END,
                case_version = CASE WHEN $2 = 'review_required' THEN case_version + 1 ELSE case_version END,
                updated_at = now()
          WHERE id = $1`,
        [
          blockedRow.id,
          replayStatus,
          optionalText(replay.effectiveJobId, { maxLength: 1000 }),
          replayReason,
          JSON.stringify(replay.result || {})
        ]
      );
      if (replayStatus === "review_required") stoppedAtReview = true;
    }
    const storedResult = { sourceStatus, sourceStateAgeMs, applicationResult, replayed };
    const inserted = await query(
      `INSERT INTO driver_offline_resolutions (
         resolution_id, event_record_id, idempotency_id, case_version,
         action, target_job_id, audit_note, resolved_by, result
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4, $5, NULLIF($6, ''), $7, $8, $9::jsonb
       )
       RETURNING *`,
      [
        crypto.randomUUID(),
        eventRow.id,
        resolutionInput.idempotencyId,
        resolutionInput.caseVersion,
        resolutionInput.action,
        resolutionInput.targetJobId,
        resolutionInput.auditNote,
        resolutionInput.resolvedBy,
        JSON.stringify(storedResult)
      ]
    );
    return {
      eventId: resolutionInput.eventId,
      status: updated.rows[0].status,
      sourceStatus,
      sourceStateAgeMs,
      driverLogin: eventRow.driver_login,
      planDate: event.planDate,
      deviceId: eventRow.device_id,
      resolution: mapResolution(inserted.rows[0]),
      replayed
    };
  });
}

export async function createDriverLocationVerification({
  verificationId = crypto.randomUUID(),
  driverLogin,
  deviceId = "",
  jobId,
  status,
  source = "samsara",
  details = {},
  ttlSeconds = 300
}) {
  const normalizedStatus = requiredText(status, "Location verification status", { maxLength: 40 });
  if (!["verified", "warning", "unavailable", "override_allowed"].includes(normalizedStatus)) {
    throw repositoryError("Location verification status is invalid.");
  }
  const normalizedSource = requiredText(source, "Location verification source", { maxLength: 40 });
  if (!["samsara", "server_override"].includes(normalizedSource)) {
    throw repositoryError("Location verification source is invalid.");
  }
  const seconds = integerValue(ttlSeconds, "Location verification lifetime", { min: 30, max: 900 });
  const result = await query(
    `INSERT INTO driver_location_verifications (
       verification_id, driver_login, device_id, job_id, status, source, details, expires_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, now() + ($8 || ' seconds')::interval
     )
     RETURNING *`,
    [
      uuidValue(verificationId, "Location verification ID"),
      normalizeDriverLogin(driverLogin),
      deviceId ? normalizeDriverDeviceId(deviceId) : "",
      requiredText(jobId, "Job ID", { maxLength: 1000 }),
      normalizedStatus,
      normalizedSource,
      JSON.stringify(details || {}),
      seconds
    ]
  );
  const row = result.rows[0];
  return {
    verificationId: row.verification_id,
    driverLogin: row.driver_login,
    deviceId: row.device_id,
    jobId: row.job_id,
    status: row.status,
    source: row.source,
    details: row.details || {},
    checkedAt: row.checked_at,
    expiresAt: row.expires_at
  };
}

export async function consumeDriverLocationVerification(verificationId, {
  driverLogin,
  jobId,
  eventId = "",
  deviceId = "",
  occurredAt = new Date()
}) {
  const id = uuidValue(verificationId, "Location verification ID");
  const login = normalizeDriverLogin(driverLogin);
  const normalizedJobId = requiredText(jobId, "Job ID", { maxLength: 1000 });
  const normalizedEventId = eventId ? uuidValue(eventId, "Event ID") : null;
  const normalizedDeviceId = deviceId ? normalizeDriverDeviceId(deviceId) : "";
  const normalizedOccurredAt = isoTimestamp(occurredAt, "Location evidence occurrence time");
  return withTransaction(async () => {
    const result = await query(
      `UPDATE driver_location_verifications
          SET consumed_at = COALESCE(consumed_at, now()),
              consumed_by_event_id = COALESCE(consumed_by_event_id, $6::uuid)
        WHERE verification_id = $1::uuid
          AND lower(driver_login) = $2
          AND job_id = $3
          AND ($4 = '' OR device_id = '' OR device_id = $4)
          AND $5::timestamptz >= checked_at - interval '5 minutes'
          AND $5::timestamptz <= expires_at + interval '5 minutes'
          AND (
            consumed_at IS NULL
            OR consumed_by_event_id IS NOT DISTINCT FROM $6::uuid
          )
        RETURNING *`,
      [id, login, normalizedJobId, normalizedDeviceId, normalizedOccurredAt, normalizedEventId]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      verificationId: row.verification_id,
      driverLogin: row.driver_login,
      jobId: row.job_id,
      status: row.status,
      source: row.source,
      details: row.details || {},
      checkedAt: row.checked_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      eventId: row.consumed_by_event_id
    };
  });
}
