import crypto from "node:crypto";

import {
  acknowledgeScmDependencyChangeRequest,
  getScmDependencyChangeRequest,
  listRouteBearingDevicePresence
} from "./scm-dependency-management-repository.js";
import { SCM_DEPENDENCY_HEARTBEAT_FRESHNESS_MS } from "./scm-dependency-management-policy.js";

export const DRIVER_ROUTE_READINESS_TTL_MS = 2 * 60 * 1000;

function text(value) {
  return String(value ?? "").trim();
}

function serviceError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code, details });
}

function timestamp(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function sameLogin(left, right) {
  return text(left).toLowerCase() === text(right).toLowerCase();
}

export function assertDriverRouteDeviceReady(presence = {}, expected = {}, now = new Date()) {
  if (
    !sameLogin(presence.driverLogin, expected.driverLogin)
    || text(presence.deviceId) !== text(expected.deviceId)
    || text(presence.manifestId) !== text(expected.manifestId)
  ) {
    throw serviceError(
      409,
      "DRIVER_ROUTE_MANIFEST_MISMATCH",
      "This Driver device no longer has the route manifest named by the pending change. Refresh the route before acknowledging it."
    );
  }

  const nowMs = timestamp(now) ?? Date.now();
  const heartbeatMs = timestamp(presence.heartbeatAt);
  const fresh = heartbeatMs !== null
    && heartbeatMs <= nowMs
    && nowMs - heartbeatMs <= SCM_DEPENDENCY_HEARTBEAT_FRESHNESS_MS;
  if (!presence.visible || !presence.online || !fresh) {
    throw serviceError(
      409,
      "DRIVER_ROUTE_DEVICE_NOT_VISIBLE",
      "Keep the Driver PWA open and visible while confirming this route update."
    );
  }

  const pendingEventCount = Number(presence.pendingEventCount || 0);
  const pendingPhotoCount = Number(presence.pendingPhotoCount || 0);
  if (presence.syncState !== "clean" || pendingEventCount > 0 || pendingPhotoCount > 0) {
    throw serviceError(
      409,
      "DRIVER_ROUTE_SYNC_NOT_CLEAN",
      "Finish synchronizing all Driver events and photos before confirming this route update.",
      { syncState: presence.syncState || "unknown", pendingEventCount, pendingPhotoCount }
    );
  }

  if (text(presence.activeJobId)) {
    throw serviceError(
      409,
      "DRIVER_ROUTE_ACTIVITY_ACTIVE",
      "Finish the active Driver stop or rest before confirming this route update.",
      { activeJobId: text(presence.activeJobId) }
    );
  }
  return true;
}

const defaultPorts = {
  getRequest: getScmDependencyChangeRequest,
  listPresence: listRouteBearingDevicePresence,
  acknowledge: acknowledgeScmDependencyChangeRequest,
  randomBytes: crypto.randomBytes
};

export async function acknowledgeDriverRouteChange({
  requestId,
  driverLogin,
  deviceId,
  now = new Date()
} = {}, portOverrides = {}) {
  const ports = { ...defaultPorts, ...portOverrides };
  const request = await ports.getRequest(text(requestId));
  if (!request) {
    throw serviceError(404, "DEPENDENCY_CHANGE_REQUEST_NOT_FOUND", "The pending route change was not found.");
  }
  if (!["waiting_driver", "driver_ready"].includes(request.status)) {
    throw serviceError(409, "DEPENDENCY_CHANGE_REQUEST_NOT_PENDING", "This route change is no longer waiting for Driver readiness.");
  }
  const expiresAt = timestamp(request.expiresAt);
  const nowMs = timestamp(now) ?? Date.now();
  if (expiresAt === null || expiresAt <= nowMs) {
    throw serviceError(409, "DEPENDENCY_CHANGE_REQUEST_EXPIRED", "This route-change request expired. SCM must preview it again.");
  }

  const expectedDevice = (request.devices || []).find((entry) => (
    sameLogin(entry.driverLogin, driverLogin)
    && text(entry.deviceId) === text(deviceId)
  ));
  if (!expectedDevice) {
    throw serviceError(403, "DRIVER_ROUTE_DEVICE_MISMATCH", "This pending route change is not assigned to this Driver device.");
  }

  const devices = await ports.listPresence({
    planId: request.planId,
    planDate: request.planDate,
    driverLogins: [driverLogin]
  });
  const presence = devices.find((entry) => (
    sameLogin(entry.driverLogin, driverLogin)
    && text(entry.deviceId) === text(deviceId)
    && text(entry.manifestId) === text(expectedDevice.manifestId)
  ));
  assertDriverRouteDeviceReady(presence || {}, expectedDevice, now);

  const readinessToken = ports.randomBytes(32).toString("base64url");
  const readyExpiresAt = new Date(nowMs + DRIVER_ROUTE_READINESS_TTL_MS).toISOString();
  const acknowledged = await ports.acknowledge({
    requestId: request.requestId,
    driverLogin,
    deviceId,
    manifestId: expectedDevice.manifestId,
    readinessTokenHash: crypto.createHash("sha256").update(readinessToken).digest("hex"),
    readyExpiresAt
  });
  return {
    request: acknowledged,
    readyExpiresAt,
    routeChanged: false,
    message: "Driver readiness recorded. SCM must re-preview and explicitly apply the change."
  };
}
