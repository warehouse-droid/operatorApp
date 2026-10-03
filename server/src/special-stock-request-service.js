import { specialSalesReps } from './special-stock-sales-reps.js';
import { specialOrderDiscountTotal } from './special-stock-discount-total.js';
import { config as applicationConfig } from "./config.js";
import {
  resolveSpecialOrderUnitsFromNetSuite,
  synchronizeSpecialSalesDescriptionsInNetSuite,
  createPurchaseOrderInNetSuite,
  findSpecialLinkedPurchaseOrderInNetSuite,
  finalizeSpecialLinkedPurchaseOrderInNetSuite,
  createSalesOrderInNetSuite,
  createSpecialDiscountSalesOrderInNetSuite,
  assertSpecialDiscountRestReady,
  verifySpecialDiscountSalesOrderInNetSuite,
  fetchPurchaseOrderReferenceFromNetSuite,
  fetchSalesOrderReferenceFromNetSuite,
  findSpecialStockOrdersWithNativeLinkFromNetSuite,
  resolveNetSuiteYardLocations,
  transformEstimateToSalesOrderInNetSuite
} from "./netsuite.js";
import {
  buildSpecialPurchaseOrderPayload,
  buildSpecialSalesOrderPayload,
  selectSpecialMarkerRecord
} from "./special-stock-request-netsuite.js";
import {
  markSpecialOrderSubmitted,
  prepareSpecialPurchaseOrder,
  recordSpecialSalesDescriptionsSynced,
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
import { assertSpecialStockRemoteOrderAllowed } from './special-stock-request-policy.js';
import { assertSpecialDeliveryDate } from '../public/special-stock-pricing.js';

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
    customerId: detail.netsuiteCustomerId || detail.customerId,
    salesRepId: detail.netsuiteSalesRepId,
    operationalYardLocationId: detail.operationalYardLocationId,
    fulfillmentMethod: detail.fulfillmentMethod,
    deliveryAddress: detail.deliveryAddress,
    deliveryContactName: detail.deliveryContactName,
    deliveryContactPhone: detail.deliveryContactPhone,
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
  findLinkedOrder = null,
  salesOrderId = null,
  sleep
}) {
  const marker = orderKind === "sales_order"
    ? specialSalesOrderMarker(caseId)
    : specialPurchaseOrderMarker(caseId);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await findMarkerOrders({ caseId, orderKind, entityId, salesOrderId });
    const match = selectMarker(rows, { marker, entityId, locationId });
    if (match) return match;
    const linked = findLinkedOrder ? await findLinkedOrder() : null;
    if (linked) return selectMarker([linked], { marker, entityId, locationId });
    if (attempt + 1 < attempts) await sleep(Math.min(2_000, 250 * (attempt + 1)));
  }
  return null;
}

export function createSpecialStockRequestService(dependencies = {}) {
  const deps = {
    markSubmitted: markSpecialOrderSubmitted,
    preparePurchaseOrder: prepareSpecialPurchaseOrder,
    synchronizeSalesDescriptions: synchronizeSpecialSalesDescriptionsInNetSuite,
    recordDescriptionSync: recordSpecialSalesDescriptionsSynced,
    resolveOrderUnits: resolveSpecialOrderUnitsFromNetSuite,
    getCase: getSpecialStockCase,
    claimOperation: claimSpecialOrderOperation,
    linkSalesOrder: linkSpecialSalesOrder,
    linkPurchaseOrder: linkSpecialPurchaseOrder,
    failOperation: failSpecialOrderOperation,
    setSalesOrderStatus: setSpecialSalesOrderStatus,
    resolveLocations: resolveNetSuiteYardLocations,
    findMarkerOrders: findSpecialStockOrdersWithNativeLinkFromNetSuite,
    selectMarker: selectSpecialMarkerRecord,
    selectSalesRep: specialSalesReps.select,
    createSalesOrder: createSalesOrderInNetSuite,
    createDiscountSalesOrder: createSpecialDiscountSalesOrderInNetSuite,
    assertDiscountReady: assertSpecialDiscountRestReady,
    verifyDiscountSalesOrder: verifySpecialDiscountSalesOrderInNetSuite,
    transformEstimate: transformEstimateToSalesOrderInNetSuite,
    createPurchaseOrder: createPurchaseOrderInNetSuite,
    findLinkedPurchaseOrder: findSpecialLinkedPurchaseOrderInNetSuite,
    finalizeLinkedPurchaseOrder: finalizeSpecialLinkedPurchaseOrderInNetSuite,
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
      const before = await deps.getCase(caseId, { audience: "scm", authorizedStoreLocationIds: context.authorizedStoreLocationIds });
      assertSpecialStockRemoteOrderAllowed(before);
      if (!before.salesOrderSubmissionStartedAt && before.fulfillmentMethod === 'mbt_delivery') assertSpecialDeliveryDate(before.deliveryDate);
      const source = input.source === "estimate_transform" ? "estimate_transform" : "standalone";
      if (source === "estimate_transform" && !recordId(before.estimateId)) {
        throw serviceError("This case has no linked NetSuite estimate to transform.", "SPECIAL_ESTIMATE_REQUIRED", 400);
      }
      const selectedRep = before.salesOrderSubmissionStartedAt ? null
        : await deps.selectSalesRep(input.salesRepId ?? before.netsuiteSalesRepId);
      claimed = await deps.claimOperation(caseId, {
        expectedRevision: input.expectedRevision,
        orderKind: "sales_order",
        netsuiteSalesRep: selectedRep,
        operationId
      }, context);
      const location = await resolvedLocation(claimed);
      const recoveryInput = {
        findMarkerOrders: deps.findMarkerOrders,
        selectMarker: deps.selectMarker,
        caseId: claimed.id,
        orderKind: "sales_order",
        entityId: claimed.netsuiteCustomerId || claimed.customerId,
        locationId: location.netsuiteLocationId,
        sleep: deps.sleep
      };
      let match = await recoverMarker({ ...recoveryInput, attempts: 1 });
      let remoteId = recordId(match?.id);
      if (!remoteId) {
        if (claimed.salesOrderSubmissionStartedAt) throw serviceError('The SO submission already started. Its marker is not yet visible; recover again after NetSuite sync.', 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN');
        const payload = buildSpecialSalesOrderPayload({
          caseId: claimed.id,
          discountMode: claimed.salesDiscountMode || 'line',
          draft: {
            ...salesDraft(claimed),
            materialLines: await deps.resolveOrderUnits(salesDraft(claimed).materialLines),
            ancillaryLines: await deps.resolveOrderUnits(salesDraft(claimed).ancillaryLines)
          },
          netsuiteLocationId: location.netsuiteLocationId,
          subsidiaryId: location.subsidiaryId || deps.config.subsidiaryId,
          deliveryMethodId: deps.config.deliveryMethodId,
          pickupMethodId: deps.config.pickupMethodId
        });
        const discounted=Boolean(payload.discountItem) || payload.item.items.some(line=>Number(line.item.id)===10716);
        if(discounted)await deps.assertDiscountReady();
        claimed = await deps.markSubmitted(caseId, { expectedRevision: claimed.revision, operationId, orderKind: 'sales_order' }, context);
        let remoteError = null;
        try {
          const created = discounted ? await deps.createDiscountSalesOrder(payload,{estimateId:source==='estimate_transform'?claimed.estimateId:null}) : source === "estimate_transform"
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
      if((claimed.salesOrderLines||[]).some(line=>line.nativeDiscountPercent>0 || ['palletQty','layerQty','sectionQty','pieceQty'].some(field=>line[field]!=null))){
        const draft=salesDraft(claimed);
        const expected=buildSpecialSalesOrderPayload({caseId:claimed.id,discountMode:claimed.salesDiscountMode || 'line',draft:{...draft,materialLines:await deps.resolveOrderUnits(draft.materialLines),ancillaryLines:await deps.resolveOrderUnits(draft.ancillaryLines)},
          netsuiteLocationId:location.netsuiteLocationId,subsidiaryId:location.subsidiaryId||deps.config.subsidiaryId,deliveryMethodId:deps.config.deliveryMethodId,pickupMethodId:deps.config.pickupMethodId});
        await deps.verifyDiscountSalesOrder(remoteId,expected);
      }
      return await deps.linkSalesOrder(caseId, {
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
          errorMessage: error.message,
          errorCode: error.code
        }, context).catch(() => null);
      }
      throw error;
    }
  }

  async function createPurchaseOrder(caseId, input = {}, context = {}) {
    const operationId = String(input.operationId || "");
    /** @type {any} */
    let claimed = null;
    try {
      const before = await deps.getCase(caseId, { audience: 'scm' });
      assertSpecialStockRemoteOrderAllowed(before);
      const prepared = Array.isArray(input.lines) && !before.purchaseOrderSubmissionStartedAt
        ? await deps.preparePurchaseOrder(caseId, input, context) : before;
      if (!prepared.purchaseOrderSubmissionStartedAt && prepared.vendorDiscountReview?.mode !== 'per_line') {
        throw serviceError('SCM must confirm a vendor discount percentage for every material, including 0, before PO creation.', 'SPECIAL_VENDOR_DISCOUNT_REQUIRED', 400);
      }
      claimed = await deps.claimOperation(caseId, {
        expectedRevision: prepared !== before ? prepared.revision : input.expectedRevision,
        orderKind: "purchase_order",
        operationId
      }, context);
      const changes = (claimed.salesOrderId ? claimed.purchaseOrderLines || [] : []).flatMap(line => {
        const sales = (claimed.salesOrderLines || []).find(candidate => candidate.caseLineId === line.caseLineId && !candidate.ancillary);
        if (!sales || (sales.description === line.description && Number(sales.quantity) === Number(line.quantity) && sales.uom === line.uom)) return [];
        if (!sales.remoteLineId) throw serviceError('Wait for the exact SO lines to synchronize before applying the SCM review.', 'SPECIAL_SO_LINES_NOT_READY');
        return [{ ...sales, previousDescription: sales.description, previousQuantity: sales.quantity, previousUom: sales.uom,
          description: line.description, quantity: line.quantity, uom: line.uom }];
      });
      if (changes.length) {
        const previous = await deps.resolveOrderUnits(changes.map(line => ({ ...line, uom: line.previousUom })));
        const resolved = (await deps.resolveOrderUnits(changes)).map((line, index) => ({ ...line, previousUnitId: previous[index].unitId }));
        const materials = claimed.salesOrderLines.filter(line => !line.ancillary);
        const discountTotal = claimed.salesDiscountMode === 'total' ? {
          before: specialOrderDiscountTotal(materials),
          after: specialOrderDiscountTotal(materials.map(line => ({ ...line, ...(resolved.find(change => change.caseLineId === line.caseLineId) || {}) })))
        } : undefined;
        await deps.synchronizeSalesDescriptions({ salesOrderId: claimed.salesOrderId, vendorId: claimed.vendorId, changes: resolved, discountTotal });
        claimed = await deps.recordDescriptionSync(caseId, { expectedRevision: claimed.revision, operationId, changes: resolved }, context);
      }
      const location = await resolvedLocation(claimed);
      /** @type {{salesOrderId:number|null,salesOrderLines:any[],purchaseOrderLines:any[],payload:Record<string,any>}|undefined} */
      let remoteInput;
      const prepareRemoteInput = async () => {
        if (!remoteInput) {
          const salesOrderRef = String(claimed.salesOrderRef || '').trim()
            || (claimed.salesOrderId ? String((await deps.fetchSalesOrderReference(claimed.salesOrderId))?.tranid || '').trim() : '');
          if (claimed.salesOrderId && !salesOrderRef) throw serviceError(
            'The Sales Order number could not be hydrated from NetSuite.', 'SPECIAL_REMOTE_HYDRATION_FAILED', 502);
          remoteInput = { salesOrderId: claimed.salesOrderId, salesOrderLines: claimed.salesOrderLines,
            purchaseOrderLines: claimed.purchaseOrderLines,
            payload: buildSpecialPurchaseOrderPayload({ caseId: claimed.id, vendorId: claimed.vendorId, salesOrderRef,
              netsuiteLocationId: location.netsuiteLocationId, subsidiaryId: location.subsidiaryId || deps.config.subsidiaryId,
              lines: await deps.resolveOrderUnits(claimed.purchaseOrderLines || []), vendorDiscountReview: claimed.vendorDiscountReview }) };
        }
        return remoteInput;
      };
      const recoveryInput = {
        findMarkerOrders: deps.findMarkerOrders,
        selectMarker: deps.selectMarker,
        caseId: claimed.id,
        orderKind: "purchase_order",
        salesOrderId: claimed.salesOrderId,
        findLinkedOrder: async () => deps.findLinkedPurchaseOrder(await prepareRemoteInput()),
        entityId: claimed.vendorId,
        locationId: location.netsuiteLocationId,
        sleep: deps.sleep
      };
      let match = await recoverMarker({ ...recoveryInput, attempts: 1 });
      let remoteId = recordId(match?.id);
      let nativeLink = match?.nativeLink === true;
      if (!remoteId) {
        if (claimed.purchaseOrderSubmissionStartedAt) throw serviceError('The PO submission already started. Its marker is not yet visible; recover again after NetSuite sync.', 'SPECIAL_REMOTE_OUTCOME_UNCERTAIN');
        const purchaseInput = await prepareRemoteInput();
        claimed = await deps.markSubmitted(caseId, { expectedRevision: claimed.revision, operationId, orderKind: 'purchase_order' }, context);
        let remoteError = null;
        try {
          const created = await deps.createPurchaseOrder(purchaseInput.payload);
          remoteId = recordId(created?.id);
          nativeLink = created?.nativeLink === true;
        } catch (error) {
          remoteError = error;
        }
        if (!remoteId) {
          match = await recoverMarker({ ...recoveryInput, attempts: 4 });
          remoteId = recordId(match?.id);
          nativeLink = match?.nativeLink === true;
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
      if (nativeLink) await deps.finalizeLinkedPurchaseOrder({ ...await prepareRemoteInput(), purchaseOrderId: remoteId });
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
      return await deps.linkPurchaseOrder(caseId, {
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
    const detail = await deps.getCase(caseId, { audience: "scm", authorizedStoreLocationIds: context.authorizedStoreLocationIds });
    assertSpecialStockRemoteOrderAllowed(detail);
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

let defaultService = createSpecialStockRequestService();
export function configureSpecialStockReviewBoundary(dependencies) {
  if (process.env.NODE_ENV !== 'test' || process.env.MBT_TEST_ISOLATED !== '1' || process.env.NETSUITE_DIRECT_ACCESS_ENABLED !== 'false') {
    throw new Error('The simulated boundary is restricted to the isolated test environment.');
  }
  defaultService = createSpecialStockRequestService(dependencies);
}

export const createSpecialSalesOrder = (...args) => defaultService.createSalesOrder(...args);
export const createSpecialPurchaseOrder = (...args) => defaultService.createPurchaseOrder(...args);
export const refreshSpecialSalesOrder = (...args) => defaultService.refreshSalesOrder(...args);
