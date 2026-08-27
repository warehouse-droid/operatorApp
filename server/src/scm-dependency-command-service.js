function commandError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code, details });
}

function purchaseOrderSnapshotRefs(order = {}) {
  return [...new Set([
    order.id,
    order.originalPoRef,
    order.dispatchRef,
    order.sourcePoRef
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

export function mergeDependencyPurchaseOrderSnapshots(currentOrders = [], refreshedOrders = [], purchaseRefs = []) {
  const wanted = new Set((Array.isArray(purchaseRefs) ? purchaseRefs : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
  if (!wanted.size) {return currentOrders;}
  const next = [...(currentOrders || [])];
  for (const fresh of refreshedOrders || []) {
    const freshRefs = purchaseOrderSnapshotRefs(fresh);
    if (String(fresh?.type || "").toUpperCase() !== "PO"
      || !freshRefs.some((ref) => wanted.has(ref))) {continue;}
    const existingIndex = next.findIndex((order) =>
      String(order?.type || "").toUpperCase() === "PO"
      && purchaseOrderSnapshotRefs(order).some((ref) => freshRefs.includes(ref))
    );
    if (existingIndex >= 0) {next[existingIndex] = fresh;}
    else {next.push(fresh);}
  }
  return next;
}

function assertCommand(command = {}) {
  if (!command.requestId) {throw commandError(400, "DEPENDENCY_REQUEST_ID_REQUIRED", "A dependency request ID is required.");}
  if (!/^[0-9a-f]{64}$/u.test(String(command.payloadHash || ""))) {
    throw commandError(400, "DEPENDENCY_PAYLOAD_HASH_INVALID", "A SHA-256 dependency payload hash is required.");
  }
  if (!command.action) {throw commandError(400, "DEPENDENCY_ACTION_REQUIRED", "A dependency action is required.");}
}

function idempotentResult(receipt, payloadHash) {
  if (!receipt) {return null;}
  if (receipt.payloadHash && receipt.payloadHash !== payloadHash) {
    throw commandError(409, "DEPENDENCY_REQUEST_ID_REUSED", "This request ID was already used for different dependency data.");
  }
  if (receipt.status === "succeeded") {return { ...(receipt.result || {}), idempotent: true };}
  if (receipt.status === "executing") {
    throw commandError(409, "DEPENDENCY_REQUEST_IN_PROGRESS", "This dependency request is already being applied.");
  }
  return null;
}

function blockerError(blockers = []) {
  const first = blockers[0] || {};
  return commandError(
    409,
    first.code || "DEPENDENCY_MUTATION_BLOCKED",
    first.message || "This dependency change is blocked.",
    { blockers }
  );
}

function requiredPort(ports, name) {
  if (typeof ports?.[name] !== "function") {
    throw new TypeError(`SCM dependency command port ${name} is required.`);
  }
  return ports[name];
}

function stableValue(value) {
  if (Array.isArray(value)) {return value.map(stableValue);}
  if (!value || typeof value !== "object") {return value;}
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

export function scmDependencyPayloadHash(command = {}) {
  const payload = {
    action: command.action || "",
    targetRef: command.targetRef || "",
    targetSignature: command.targetSignature || "",
    planId: command.planId || null,
    planDate: command.planDate || "",
    expectedPlanRevision: command.expectedPlanRevision ?? null,
    expectedPlanDigest: command.expectedPlanDigest || "",
    payload: command.payload || {}
  };
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

async function mutateRelationship(command, actor, preview) {
  const payload = command.payload || {};
  switch (command.action) {
    case "link_to": {
      const dependency = await createOrderDependency({
        dispatchTargetRef: command.targetRef,
        transferOrderRef: payload.transferOrderRef,
        planDate: command.planDate || "",
        targetSignature: command.targetSignature || preview.targetSignature || "",
        mode: payload.mode || command.mode,
        allocations: payload.allocations || [],
        operatorId: actor.id || null
      });
      return {
        dependency,
        dependencyId: Number(dependency.id),
        effectiveAction: dependency.effectiveAction || preview.effectiveAction || "link_to",
        targetRef: dependency.dispatchTargetRef || command.targetRef,
        relatedOrderRefs: [dependency.salesOrderRef, dependency.transferOrderRef].filter(Boolean)
      };
    }
    case "unlink_to": {
      const dependencyId = Number(payload.dependencyId || command.dependencyId);
      const cancelled = await cancelOrderDependency(
        dependencyId,
        actor.id || null,
        command.planDate || ""
      );
      return {
        cancelled,
        dependencyId,
        effectiveAction: "unlink_to",
        targetRef: preview.target.ref,
        relatedOrderRefs: preview.affectedOrderRefs
      };
    }
    case "change_mode": {
      const dependencyId = Number(payload.dependencyId || command.dependencyId);
      const dependency = await updateOrderDependencyMode(
        dependencyId,
        payload.mode,
        actor.id || null,
        command.planDate || ""
      );
      return {
        dependency,
        dependencyId,
        effectiveAction: "change_mode",
        targetRef: dependency.dispatchTargetRef || preview.target.ref,
        relatedOrderRefs: [dependency.salesOrderRef, dependency.transferOrderRef].filter(Boolean)
      };
    }
    case "link_po": {
      const shared = {
        dispatchTargetRef: command.targetRef,
        salesOrderRef: command.targetRef,
        poRef: payload.poRef,
        planDate: command.planDate || "",
        targetSignature: command.targetSignature || preview.targetSignature || "",
        createdBy: actor.sessionId || actor.id || ""
      };
      const allocations = Array.isArray(payload.lines)
        ? await createSalesOrderPoAllocations({ ...shared, lines: payload.lines })
        : [await createSalesOrderPoAllocation({
            ...shared,
            targetLineKey: payload.targetLineKey,
            salesLineId: payload.salesLineId,
            poLineId: payload.poLineId,
            quantities: payload.quantities || payload
          })];
      return {
        allocations,
        allocationIds: allocations.map((allocation) => Number(allocation.id)),
        effectiveAction: "link_po",
        targetRef: command.targetRef,
        relatedOrderRefs: [command.targetRef, payload.poRef].filter(Boolean)
      };
    }
    case "unlink_po": {
      const allocationId = Number(payload.allocationId || command.allocationId);
      const cancelled = await cancelSalesOrderPoAllocation(allocationId, {
        cancelledBy: actor.sessionId || actor.id || ""
      });
      if (!cancelled) {throw commandError(404, "PO_ALLOCATION_NOT_FOUND", "The PO relationship was not found or was already removed.");}
      return {
        cancelled,
        allocationId,
        effectiveAction: "unlink_po",
        targetRef: cancelled.dispatchTargetRef || cancelled.salesOrderRef || preview.target.ref,
        relatedOrderRefs: [cancelled.salesOrderRef, cancelled.poOrderRef].filter(Boolean)
      };
    }
    default:
      throw commandError(400, "DEPENDENCY_ACTION_UNSUPPORTED", `Unsupported dependency action ${command.action}.`);
  }
}

async function refreshAffectedPlan(command, actor, preview, relationship) {
  const currentPlan = preview.affectedPlan;
  const purchaseRefs = [...new Set([
    ...(relationship.allocations || []).map((allocation) => allocation.poOrderRef),
    relationship.cancelled?.poOrderRef,
    relationship.poOrderRef
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const refreshedPurchaseOrders = [];
  for (const purchaseRef of purchaseRefs) {
    const candidates = await listDispatchOrders({
      type: "PO",
      search: purchaseRef,
      includeScmLinkedSearchRefs: true
    });
    const wanted = purchaseRef.toLowerCase();
    const exact = candidates.find((order) => purchaseOrderSnapshotRefs(order).includes(wanted));
    if (exact) {refreshedPurchaseOrders.push(exact);}
  }
  let orders = mergeDependencyPurchaseOrderSnapshots(
    currentPlan.orders || [],
    refreshedPurchaseOrders,
    purchaseRefs
  );
  orders = await enrichDispatchOrdersWithDependencies(orders);
  orders = await enrichDispatchOrdersWithPoTargetAllocations(orders, {
    projectUnallocatedPoRefs: relationship.relatedOrderRefs || [],
    releasedTargetRefs: [relationship.targetRef || command.targetRef].filter(Boolean)
  });
  const reconciled = reconcileDependencyManagedPickups({
    plan: { ...currentPlan, orders },
    enrichedOrders: orders,
    affectedTargetRefs: [...new Set([
      relationship.targetRef || command.targetRef,
      ...(relationship.relatedOrderRefs || [])
    ].filter(Boolean))]
  });
  const saved = await saveDispatchPlanSnapshot(currentPlan.id, {
    orders: reconciled.orders,
    trucks: reconciled.trucks,
    summary: currentPlan.summary || {},
    baseRevision: command.expectedPlanRevision ?? currentPlan.revision,
    planDate: currentPlan.planDate,
    sessionId: actor.sessionId || "scm-dependency-management"
  });
  await syncOrderDependenciesFromDispatchPlan(saved);
  await syncScmScheduleFromDispatchPlan(saved, {
    updatedBy: actor.sessionId || actor.id || "scm-dependency-management"
  });
  return saved;
}

async function createPending(command) {
  return createScmDependencyChangeRequest({
    requestId: command.requestId,
    payloadHash: command.payloadHash,
    action: command.action,
    payload: command.payload || {},
    targetRef: command.targetRef,
    targetSignature: command.targetSignature || "",
    planId: command.planId || null,
    planDate: command.planDate || null,
    expectedPlanRevision: command.expectedPlanRevision ?? null,
    expectedPlanDigest: command.expectedPlanDigest || "",
    requestedBy: command.actor?.id || "",
    requestedSurface: command.actor?.surface || "scm",
    devices: command.devices || []
  });
}

async function markPendingAppliedIfPresent(requestId, result) {
  const pending = await getScmDependencyChangeRequest(requestId);
  if (!pending) {return null;}
  return markScmDependencyChangeRequestApplied(requestId, result);
}

const defaultPorts = {
  getReceipt: getScmDependencyActionReceipt,
  withTransaction,
  preview: previewScmDependencyMutation,
  createPendingRequest: createPending,
  reserveReceipt: reserveScmDependencyActionReceipt,
  mutateRelationship,
  refreshPlan: refreshAffectedPlan,
  validatePlan: validateDispatchPlanDependencies,
  materializeOperator: (plan, command, relationship) => applyConfirmedDispatchPlanToDelivery(plan, {
    forceOrderRefs: [...new Set([
      relationship.targetRef || command.targetRef,
      ...(relationship.relatedOrderRefs || [])
    ].filter(Boolean))]
  }),
  supersedeDriverArtifacts: supersedeDriverRouteArtifacts,
  completeReceipt: completeScmDependencyActionReceipt,
  markPendingApplied: markPendingAppliedIfPresent
};

export async function executeScmDependencyCommand(command = {}, actor = {}, portOverrides = {}) {
  const ports = { ...defaultPorts, ...portOverrides };
  assertCommand(command);
  const getReceipt = requiredPort(ports, "getReceipt");
  const existing = await getReceipt(command.requestId);
  const priorResult = idempotentResult(existing, command.payloadHash);
  if (priorResult) {return priorResult;}

  return requiredPort(ports, "withTransaction")(async () => {
    const preview = await requiredPort(ports, "preview")(command, actor, { lock: true });
    const blockers = Array.isArray(preview?.blockers) ? preview.blockers : [];
    if (preview?.allowed === false) {
      if (preview?.routeReadiness?.pendingRequestRequired) {
        const pending = await requiredPort(ports, "createPendingRequest")({
          ...command,
          targetRef: command.targetRef || preview?.target?.ref || "",
          targetSignature: command.targetSignature || preview?.targetSignature || "",
          planId: command.planId || preview?.affectedPlan?.id || null,
          planDate: command.planDate || preview?.affectedPlan?.planDate || "",
          expectedPlanRevision: command.expectedPlanRevision ?? preview?.affectedPlan?.revision ?? null,
          expectedPlanDigest: command.expectedPlanDigest || preview?.affectedPlan?.digest || "",
          actor,
          devices: preview.affectedDriverDevices || []
        });
        return {
          status: pending?.status || "waiting_driver",
          requestId: command.requestId,
          blockers,
          routeReadiness: preview.routeReadiness,
          pending: true
        };
      }
      throw blockerError(blockers);
    }

    const reservation = await requiredPort(ports, "reserveReceipt")({
      requestId: command.requestId,
      payloadHash: command.payloadHash,
      action: command.action,
      actorId: actor.id || "",
      surface: actor.surface || "scm"
    });
    if (!reservation?.created) {
      const replay = idempotentResult(reservation?.receipt, command.payloadHash);
      if (replay) {return replay;}
      throw commandError(409, "DEPENDENCY_REQUEST_IN_PROGRESS", "This dependency request is already being applied.");
    }

    const relationship = await requiredPort(ports, "mutateRelationship")(command, actor, preview);
    let plan = preview?.affectedPlan || null;
    if (plan) {
      plan = await requiredPort(ports, "refreshPlan")(command, actor, preview, relationship);
      const conflicts = await requiredPort(ports, "validatePlan")(plan, command, relationship);
      if (Array.isArray(conflicts) && conflicts.length) {
        throw blockerError([{
          code: "DISPATCH_ORDER_DEPENDENCY_CONFLICT",
          message: String(conflicts[0]),
          details: { conflicts }
        }]);
      }
      if (plan.status === "confirmed") {
        // Manifest supersession is linked by foreign key to the durable change
        // request. Offline flows already have that row from Driver readiness;
        // immediate online-only flows must create the same audit envelope before
        // fencing any previously issued route artifacts.
        await requiredPort(ports, "createPendingRequest")({
          ...command,
          targetRef: command.targetRef || preview?.target?.ref || "",
          targetSignature: command.targetSignature || preview?.targetSignature || "",
          planId: plan.id,
          planDate: plan.planDate || command.planDate || "",
          actor,
          devices: preview.affectedDriverDevices || []
        });
        await requiredPort(ports, "materializeOperator")(plan, command, relationship);
        await requiredPort(ports, "supersedeDriverArtifacts")({
          planId: plan.id,
          planDate: plan.planDate || command.planDate || "",
          requestId: command.requestId
        });
      }
    }

    const result = {
      status: "applied",
      requestId: command.requestId,
      ...relationship,
      ...(plan ? { plan, planId: plan.id, planRevision: Number(plan.revision || 0) } : {})
    };
    await requiredPort(ports, "completeReceipt")(command.requestId, result);
    if (typeof ports.markPendingApplied === "function") {
      await ports.markPendingApplied(command.requestId, result);
    }
    return result;
  });
}
import crypto from "node:crypto";

import { withTransaction } from "./db.js";
import { applyConfirmedDispatchPlanToDelivery } from "./delivery-repository.js";
import {
  createSalesOrderPoAllocation,
  createSalesOrderPoAllocations,
  cancelSalesOrderPoAllocation,
  enrichDispatchOrdersWithPoTargetAllocations,
  listDispatchOrders,
  syncScmScheduleFromDispatchPlan
} from "./dispatch-repository.js";
import { saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import {
  cancelOrderDependency,
  createOrderDependency,
  enrichDispatchOrdersWithDependencies,
  syncOrderDependenciesFromDispatchPlan,
  updateOrderDependencyMode,
  validateDispatchPlanDependencies
} from "./order-dependency-repository.js";
import {
  completeScmDependencyActionReceipt,
  createScmDependencyChangeRequest,
  getScmDependencyActionReceipt,
  getScmDependencyChangeRequest,
  markScmDependencyChangeRequestApplied,
  reserveScmDependencyActionReceipt,
  supersedeDriverRouteArtifacts
} from "./scm-dependency-management-repository.js";
import { reconcileDependencyManagedPickups } from "./scm-dependency-plan-reconciler.js";
import { previewScmDependencyMutation } from "./scm-dependency-preview-service.js";
