const HEARTBEAT_FRESHNESS_MS = 15_000;

function hasEntries(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

function blocker(code, message, details) {
  return { code, message, details };
}

function mutationError(status, code, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

export function evaluateDependencyMutationBlockers(input = {}) {
  const blockers = [];
  if (hasEntries(input.closedOrders)) {
    blockers.push(blocker(
      "ORDER_CLOSED",
      "A selected order is closed and cannot be changed.",
      { orders: input.closedOrders }
    ));
  }
  if (input.targetChanged) {
    blockers.push(blocker(
      "DISPATCH_TARGET_CHANGED",
      "The selected group, split, or order lines changed. Refresh before applying.",
      { targetSignature: input.targetSignature || "" }
    ));
  }
  if (input.planChanged) {
    blockers.push(blocker(
      "DISPATCH_PLAN_CHANGED",
      "The Dispatch plan changed. Refresh and preview the dependency again.",
      {
        expectedRevision: input.expectedPlanRevision ?? null,
        actualRevision: input.actualPlanRevision ?? null
      }
    ));
  }
  if (hasEntries(input.editLease)) {
    blockers.push(blocker(
      "DISPATCH_EDIT_LEASE_HELD",
      "Another planner currently holds the Dispatch edit lease.",
      { ...input.editLease }
    ));
  }
  if (hasEntries(input.operatorActivity)) {
    blockers.push(blocker(
      "OPERATOR_ACTIVITY_STARTED",
      "Operator work has started for an affected order.",
      { ...input.operatorActivity }
    ));
  }
  if (hasEntries(input.receivingActivity)) {
    blockers.push(blocker(
      "SCM_RECEIVING_ACTIVITY_STARTED",
      "SCM receiving work has started for an affected purchase order.",
      { ...input.receivingActivity }
    ));
  }
  if (hasEntries(input.dependencyExecution)) {
    blockers.push(blocker(
      "DEPENDENCY_EXECUTION_STARTED",
      "A transfer dependency has already started execution.",
      { ...input.dependencyExecution }
    ));
  }
  if (hasEntries(input.driverActivity)) {
    blockers.push(blocker(
      "DRIVER_ACTIVITY_STARTED",
      "Driver activity has started for an affected stop.",
      { ...input.driverActivity }
    ));
  }
  if (hasEntries(input.offlineEvidence)) {
    blockers.push(blocker(
      "DRIVER_OFFLINE_EVIDENCE_PENDING",
      "Driver offline events or photo uploads must synchronize before this route can change.",
      { ...input.offlineEvidence }
    ));
  }
  if (input.planTerminal) {
    blockers.push(blocker(
      "DISPATCH_PLAN_TERMINAL",
      "Completed or cancelled Dispatch plans cannot be changed.",
      { status: input.planTerminal }
    ));
  }
  if (hasEntries(input.sequenceConflicts)) {
    blockers.push(blocker(
      "DISPATCH_ORDER_DEPENDENCY_CONFLICT",
      "The proposed relationship violates the route dependency sequence.",
      { conflicts: input.sequenceConflicts }
    ));
  }
  return blockers;
}

export function normalizeDependencyMutationAction({
  action,
  targetRef,
  mode,
  existing = null
} = {}) {
  if (!action) {
    throw mutationError(400, "DEPENDENCY_ACTION_REQUIRED", "A dependency action is required.");
  }
  if (!existing || action !== "link_to") {
    return {
      action,
      effectiveAction: action,
      ...(existing?.id ? { dependencyId: existing.id } : {})
    };
  }

  const requestedTarget = String(targetRef || "").trim().toUpperCase();
  const existingTarget = String(existing.targetRef || "").trim().toUpperCase();
  if (existingTarget && requestedTarget !== existingTarget) {
    throw mutationError(
      409,
      "TO_ALREADY_LINKED_ELSEWHERE",
      `The transfer order is already linked to ${existing.targetRef}.`,
      { dependencyId: existing.id, existingTargetRef: existing.targetRef, requestedTargetRef: targetRef }
    );
  }
  if (existing.mode && mode && existing.mode !== mode) {
    throw mutationError(
      409,
      "DEPENDENCY_MODE_MISMATCH",
      "The existing dependency uses a different transfer mode.",
      { dependencyId: existing.id, existingMode: existing.mode, requestedMode: mode }
    );
  }
  return {
    action,
    effectiveAction: "extend_to",
    dependencyId: existing.id
  };
}

function dateMs(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function deviceDetails(device) {
  return {
    driverLogin: device.driverLogin || "",
    deviceId: device.deviceId || "",
    manifestId: device.manifestId || ""
  };
}

export function driverRouteReadiness({ planStatus = "draft", devices = [], now = new Date() } = {}) {
  if (planStatus !== "confirmed") {
    return { required: false, ready: true, blockers: [] };
  }
  const currentTime = dateMs(now) ?? Date.now();
  const blockers = [];

  for (const device of devices) {
    const heartbeatAt = dateMs(device.heartbeatAt);
    const heartbeatFresh = heartbeatAt !== null
      && heartbeatAt <= currentTime
      && currentTime - heartbeatAt <= HEARTBEAT_FRESHNESS_MS;
    if (!device.visible || !device.online || !heartbeatFresh) {
      blockers.push(blocker(
        "DRIVER_ROUTE_OFFLINE",
        "A route-bearing Driver PWA is offline, suspended, or not visible.",
        deviceDetails(device)
      ));
      continue;
    }

    const pendingEventCount = Number(device.pendingEventCount || 0);
    const pendingPhotoCount = Number(device.pendingPhotoCount || 0);
    if (device.syncState !== "clean" || pendingEventCount > 0 || pendingPhotoCount > 0) {
      blockers.push(blocker(
        "DRIVER_OFFLINE_EVIDENCE_PENDING",
        "The Driver PWA must finish synchronizing events and photos before its route changes.",
        { ...deviceDetails(device), pendingEventCount, pendingPhotoCount, syncState: device.syncState || "unknown" }
      ));
      continue;
    }

    if (device.activeJobId) {
      blockers.push(blocker(
        "DRIVER_ACTIVITY_STARTED",
        "The Driver PWA has an active stop and cannot accept a route replacement.",
        { ...deviceDetails(device), jobId: device.activeJobId }
      ));
      continue;
    }

    const readyAt = dateMs(device.readyAt);
    const readyExpiresAt = dateMs(device.readyExpiresAt);
    if (readyAt === null || readyAt > currentTime || readyExpiresAt === null || readyExpiresAt <= currentTime) {
      blockers.push(blocker(
        "DRIVER_ROUTE_UPDATE_REQUIRED",
        "The visible Driver PWA must acknowledge this pending route update.",
        deviceDetails(device)
      ));
    }
  }

  return {
    required: devices.length > 0,
    ready: blockers.length === 0,
    blockers,
    ...(blockers.some((entry) => ["DRIVER_ROUTE_OFFLINE", "DRIVER_ROUTE_UPDATE_REQUIRED"].includes(entry.code))
      ? { pendingRequestRequired: true }
      : {})
  };
}

export const SCM_DEPENDENCY_HEARTBEAT_FRESHNESS_MS = HEARTBEAT_FRESHNESS_MS;
