import { config as applicationConfig } from "./config.js";
import {
  createPurchaseOrderInNetSuite,
  createSalesOrderInNetSuite,
  fetchPurchaseOrderReferenceFromNetSuite,
  fetchSalesOrderReferenceFromNetSuite,
  findSpecialStockOrdersByMarkerFromNetSuite,
  resolveNetSuiteYardLocations,
  transformEstimateToSalesOrderInNetSuite
} from "./netsuite.js";
import {
  buildSpecialPurchaseOrderPayload,
  buildSpecialSalesOrderPayload,
  selectSpecialMarkerRecord
} from "./special-stock-request-netsuite.js";
import {
  claimSpecialOrderOperation,
  failSpecialOrderOperation,
  getSpecialStockCase,
  linkSpecialPurchaseOrder,
  linkSpecialSalesOrder,
  setSpecialSalesOrderStatus
} from "./special-stock-request-repository.js";
import {
  specialPurchaseOrderMarker,
  specialSalesOrderMarker
} from "./special-stock-request-domain.js";
import { recordScmNetSuitePoCreation } from "./scm-netsuite-po-history-repository.js";

function serviceError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status, specialStockAttention: true });
}

function recordId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function salesOrderApproved(reference = {}) {
  const status = `${reference.status || ""} ${reference.status_text || reference.statusText || ""}`.trim();
  return !/pending approval|closed|cancel/i.test(status) && Boolean(status);
}

function salesOrderActive(reference = {}) {
  const status = `${reference.status || ""} ${reference.status_text || reference.statusText || ""}`.trim();
  return !/closed|cancel/i.test(status);
}

function locationCode(detail) {
  return String(detail.storeName || detail.operationalYardLocationId || "").trim();
}

function salesDraft(detail) {
  return {
    customerId: detail.customerId,
    operationalYardLocationId: detail.operationalYardLocationId,
    fulfillmentMethod: detail.fulfillmentMethod,
    deliveryAddress: detail.deliveryAddress,
    deliveryDate: detail.deliveryDate,
    windowStart: detail.windowStart,
    windowEnd: detail.windowEnd,
    deliveryInstructions: detail.deliveryInstructions,
    materialLines: (detail.salesOrderLines || []).filter((line) => !line.ancillary),
    ancillaryLines: (detail.salesOrderLines || []).filter((line) => line.ancillary)
  };
}

async function recoverMarker({
  findMarkerOrders,
  selectMarker,
  caseId,
  orderKind,
  entityId,
  locationId,
  attempts = 1,
  sleep
}) {
  const marker = orderKind === "sales_order"
    ? specialSalesOrderMarker(caseId)
    : specialPurchaseOrderMarker(caseId);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await findMarkerOrders({ caseId, orderKind, entityId });
    const match = selectMarker(rows, { marker, entityId, locationId });
    if (match) return match;
    if (attempt + 1 < attempts) await sleep(Math.min(2_000, 250 * (attempt + 1)));
  }
  return null;
}

export function createSpecialStockRequestService(dependencies = {}) {
  const deps = {
    getCase: getSpecialStockCase,
    claimOperation: claimSpecialOrderOperation,
    linkSalesOrder: linkSpecialSalesOrder,
    linkPurchaseOrder: linkSpecialPurchaseOrder,
    failOperation: failSpecialOrderOperation,
    setSalesOrderStatus: setSpecialSalesOrderStatus,
    resolveLocations: resolveNetSuiteYardLocations,
    findMarkerOrders: findSpecialStockOrdersByMarkerFromNetSuite,
    selectMarker: selectSpecialMarkerRecord,
    createSalesOrder: createSalesOrderInNetSuite,
    transformEstimate: transformEstimateToSalesOrderInNetSuite,
    createPurchaseOrder: createPurchaseOrderInNetSuite,
    fetchSalesOrderReference: fetchSalesOrderReferenceFromNetSuite,
    fetchPurchaseOrderReference: fetchPurchaseOrderReferenceFromNetSuite,
    recordPurchaseOrderCreation: recordScmNetSuitePoCreation,
    config: {
      subsidiaryId: applicationConfig.specialStock?.subsidiaryId,
      deliveryMethodId: applicationConfig.specialStock?.deliveryMethodId,
      pickupMethodId: applicationConfig.specialStock?.pickupMethodId
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...dependencies
  };

  async function resolvedLocation(detail) {
    const locations = await deps.resolveLocations([{
      locationId: detail.operationalYardLocationId,
      code: locationCode(detail)
    }]);
    const location = locations?.[0];
    if (!recordId(location?.netsuiteLocationId)) {
      throw serviceError("The operational yard could not be mapped to NetSuite.", "SPECIAL_REMOTE_LOCATION_MISSING", 503);
    }
    return location;
  }

  async function createSalesOrder(caseId, input = {}, context = {}) {
    const operationId = String(input.operationId || "");
    let claimed = null;
    try {
      const before = await deps.getCase(caseId, { audience: "scm" });
      const source = input.source === "estimate_transform" ? "estimate_transform" : "standalone";
      if (source === "estimate_transform" && !recordId(before.estimateId)) {
        throw serviceError("This case has no linked NetSuite estimate to transform.", "SPECIAL_ESTIMATE_REQUIRED", 400);
      }
      claimed = await deps.claimOperation(caseId, {
        expectedRevision: input.expectedRevision,
        orderKind: "sales_order",
        operationId
      }, context);
      const location = await resolvedLocation(claimed);
      const recoveryInput = {
        findMarkerOrders: deps.findMarkerOrders,
        selectMarker: deps.selectMarker,
        caseId: claimed.id,
        orderKind: "sales_order",
        entityId: claimed.customerId,
        locationId: location.netsuiteLocationId,
        sleep: deps.sleep
      };
      let match = await recoverMarker({ ...recoveryInput, attempts: 1 });
      let remoteId = recordId(match?.id);
      if (!remoteId) {
        const payload = buildSpecialSalesOrderPayload({
          caseId: claimed.id,
          draft: salesDraft(claimed),
          netsuiteLocationId: location.netsuiteLocationId,
          subsidiaryId: location.subsidiaryId || deps.config.subsidiaryId,
          deliveryMethodId: deps.config.deliveryMethodId,
          pickupMethodId: deps.config.pickupMethodId
        });
        let remoteError = null;
        try {
          const created = source === "estimate_transform"
            ? await deps.transformEstimate(claimed.estimateId, payload)
            : await deps.createSalesOrder(payload);
          remoteId = recordId(created?.id);
        } catch (error) {
          remoteError = error;
        }
        if (!remoteId) {
          match = await recoverMarker({ ...recoveryInput, attempts: 4 });
          remoteId = recordId(match?.id);
        }
        if (!remoteId) {
          const uncertain = serviceError(
            `${remoteError?.message || "NetSuite did not return a durable Sales Order ID."} The marker is not visible, so no automatic resubmission was attempted.`,
            "SPECIAL_REMOTE_OUTCOME_UNCERTAIN"
          );
          uncertain.cause = remoteError || undefined;
          throw uncertain;
        }
      }
      const reference = await deps.fetchSalesOrderReference(remoteId);
      if (!reference?.tranid) {
        throw serviceError("The Sales Order exists but could not be hydrated from NetSuite.", "SPECIAL_REMOTE_HYDRATION_FAILED", 502);
      }
      return deps.linkSalesOrder(caseId, {
        expectedRevision: claimed.revision,
        salesOrderId: remoteId,
        salesOrderRef: reference.tranid,
        source,
        salesOrderStatus: reference.status_text || reference.status || null,
        salesOrderApproved: salesOrderApproved(reference),
        operationId,
        verifiedRemote: true
      }, context);
    } catch (error) {
      if (claimed) {
        await deps.failOperation(caseId, {
          orderKind: "sales_order",
          operationId,
          errorMessage: error.message
        }, context).catch(() => null);
      }
      throw error;
    }
  }

  async function createPurchaseOrder(caseId, input = {}, context = {}) {
    const operationId = String(input.operationId || "");
    let claimed = null;
    try {
      claimed = await deps.claimOperation(caseId, {
        expectedRevision: input.expectedRevision,
        orderKind: "purchase_order",
        operationId
      }, context);
      const location = await resolvedLocation(claimed);
      const recoveryInput = {
        findMarkerOrders: deps.findMarkerOrders,
        selectMarker: deps.selectMarker,
        caseId: claimed.id,
        orderKind: "purchase_order",
        entityId: claimed.vendorId,
        locationId: location.netsuiteLocationId,
        sleep: deps.sleep
      };
      let match = await recoverMarker({ ...recoveryInput, attempts: 1 });
      let remoteId = recordId(match?.id);
      if (!remoteId) {
        const payload = buildSpecialPurchaseOrderPayload({
          caseId: claimed.id,
          vendorId: claimed.vendorId,
          netsuiteLocationId: location.netsuiteLocationId,
          subsidiaryId: location.subsidiaryId || deps.config.subsidiaryId,
          lines: claimed.purchaseOrderLines || []
        });
        let remoteError = null;
        try {
          const created = await deps.createPurchaseOrder(payload);
          remoteId = recordId(created?.id);
        } catch (error) {
          remoteError = error;
        }
        if (!remoteId) {
          match = await recoverMarker({ ...recoveryInput, attempts: 4 });
          remoteId = recordId(match?.id);
        }
        if (!remoteId) {
          const uncertain = serviceError(
            `${remoteError?.message || "NetSuite did not return a durable Purchase Order ID."} The marker is not visible, so no automatic resubmission was attempted.`,
            "SPECIAL_REMOTE_OUTCOME_UNCERTAIN"
          );
          uncertain.cause = remoteError || undefined;
          throw uncertain;
        }
      }
      const reference = await deps.fetchPurchaseOrderReference(remoteId);
      if (!reference?.tranid) {
        throw serviceError("The Purchase Order exists but could not be hydrated from NetSuite.", "SPECIAL_REMOTE_HYDRATION_FAILED", 502);
      }
      await deps.recordPurchaseOrderCreation({
        purchaseOrderId: remoteId,
        purchaseOrderRef: reference.tranid,
        creationSnapshot: {
          source: "special_stock_request",
          requestId: claimed.id,
          requestRef: claimed.requestRef,
          salesOrderId: claimed.salesOrderId,
          salesOrderRef: claimed.salesOrderRef,
          vendorId: claimed.vendorId,
          vendor: claimed.vendorName,
          operationalYardLocationId: claimed.operationalYardLocationId,
          lines: claimed.purchaseOrderLines || []
        }
      }, context.operatorId || null);
      return deps.linkPurchaseOrder(caseId, {
        expectedRevision: claimed.revision,
        purchaseOrderId: remoteId,
        purchaseOrderRef: reference.tranid,
        purchaseOrderStatus: reference.status_text || reference.status || null,
        operationId,
        verifiedRemote: true
      }, context);
    } catch (error) {
      if (claimed) {
        await deps.failOperation(caseId, {
          orderKind: "purchase_order",
          operationId,
          errorMessage: error.message
        }, context).catch(() => null);
      }
      throw error;
    }
  }

  async function refreshSalesOrder(caseId, context = {}) {
    const detail = await deps.getCase(caseId, { audience: "scm" });
    if (!recordId(detail.salesOrderId)) {
      throw serviceError("This case has no linked Sales Order.", "SPECIAL_SO_NOT_LINKED", 400);
    }
    const reference = await deps.fetchSalesOrderReference(detail.salesOrderId);
    if (!reference) throw serviceError("The linked Sales Order is missing from NetSuite.", "SPECIAL_SO_REMOTE_MISSING", 502);
    return deps.setSalesOrderStatus(caseId, {
      salesOrderStatus: reference.status_text || reference.status || null,
      approved: salesOrderApproved(reference),
      active: salesOrderActive(reference),
      salesOrderRef: reference.tranid || detail.salesOrderRef
    }, context);
  }

  return { createSalesOrder, createPurchaseOrder, refreshSalesOrder };
}

const defaultService = createSpecialStockRequestService();

export const createSpecialSalesOrder = defaultService.createSalesOrder;
export const createSpecialPurchaseOrder = defaultService.createPurchaseOrder;
export const refreshSpecialSalesOrder = defaultService.refreshSalesOrder;
