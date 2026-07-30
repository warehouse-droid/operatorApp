import { config } from "./config.js";
import {
  createPurchaseOrderInNetSuite,
  fetchPurchaseOrderDetailsFromNetSuite,
  fetchPurchaseOrderReferenceFromNetSuite,
  findPurchaseOrdersBySmartScmMarkerFromNetSuite,
  resolveNetSuiteYardLocations
} from "./netsuite.js";
import { upsertPurchaseOrderLines, upsertPurchaseOrders } from "./order-sync-repository.js";
import { buildSmartScmPurchaseOrderRestPayload } from "./smart-scm-purchase-netsuite.js";
import {
  completeSmartScmPurchaseExecution,
  failSmartScmPurchaseExecution,
  getSmartScmNetSuitePoReviewLoad,
  markSmartScmPurchaseAttention,
  prepareSmartScmPurchaseExecution
} from "./smart-scm-vendor-repository.js";

function validRecordId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function selectSmartScmMarkerPurchaseOrder(rows = [], { proposalId, vendorId = null } = {}) {
  const matches = Array.isArray(rows) ? rows : [];
  if (matches.length > 1) {
    const error = Object.assign(new Error("More than one NetSuite purchase order uses Smart SCM review marker " + proposalId + ". Reconcile the duplicates before retrying."), { smartScmAttention: true });
    error.markerMatches = matches.map((row) => ({ id: validRecordId(row.id), tranid: row.tranid || null }));
    throw error;
  }
  if (matches.length === 0) return null;
  const match = matches[0];
  const id = validRecordId(match.id);
  if (id === null) throw Object.assign(new Error("NetSuite returned an invalid PO ID for Smart SCM review marker " + proposalId + "."), { smartScmAttention: true });
  const expectedVendor = validRecordId(vendorId);
  const actualVendor = validRecordId(match.vendor_id ?? match.vendorId);
  if (expectedVendor && actualVendor && actualVendor !== expectedVendor) {
    throw Object.assign(new Error("Smart SCM review marker " + proposalId + " exists under a different NetSuite vendor."), { smartScmAttention: true });
  }
  return { ...match, id };
}

async function recoverPurchaseOrderByMarker({ proposalId, vendorId = null, attempts = 1, delayMs = 650 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const rows = await findPurchaseOrdersBySmartScmMarkerFromNetSuite({ proposalId });
    const match = selectSmartScmMarkerPurchaseOrder(rows, { proposalId, vendorId });
    if (match) return match;
    if (attempt < attempts) await wait(delayMs * attempt);
  }
  return null;
}

async function hydrateSmartScmPurchaseOrder(prepared, purchaseOrderId, fallbackReference = null) {
  const order = await fetchPurchaseOrderReferenceFromNetSuite(purchaseOrderId);
  const purchaseOrderRef = order?.tranid || fallbackReference || "PO-" + purchaseOrderId;
  if (order) {
    const canonicalOrder = {
      ...order,
      destination_location_id: prepared.destinationLocationId,
      destination_location: prepared.destinationName,
      order_location_id: prepared.destinationLocationId,
      order_location: prepared.destinationName,
      memo: order.memo || prepared.memo,
      netsuite_active: true
    };
    const lines = await fetchPurchaseOrderDetailsFromNetSuite(purchaseOrderId);
    await upsertPurchaseOrders([canonicalOrder]);
    await upsertPurchaseOrderLines(purchaseOrderId, lines);
  }
  return purchaseOrderRef;
}

export async function executeSmartScmPurchaseProposal(proposalId, operatorId = null) {
  let prepared = null;
  let purchaseOrderId = null;
  let purchaseOrderRef = null;
  let recovered = false;
  try {
    const review = await getSmartScmNetSuitePoReviewLoad(proposalId);
    if (review.status === "executing") {
      const lastUpdate = new Date(review.updatedAt || 0).getTime();
      const freshExecution = Number.isFinite(lastUpdate) && lastUpdate > 0
        && Date.now() - lastUpdate < 5 * 60 * 1000;
      if (freshExecution) {
        throw Object.assign(
          new Error("This PO insertion is already running. Wait for it to finish before retrying."),
          { status: 409, smartScmStateRecorded: true }
        );
      }
    }
    let markerMatch = null;
    const retryWithoutPersistedMode = review.persistedExecutionMode === null
      && ["failed", "executing"].includes(review.status);
    if (review.executionMode === "live" || retryWithoutPersistedMode) {
      markerMatch = await recoverPurchaseOrderByMarker({ proposalId: review.id });
    }
    if (review.status === "executing") {
      if (markerMatch === null) {
        const interrupted = Object.assign(new Error("The previous PO insertion was interrupted and no NetSuite marker was found. The review was reset to Failed; retry once to create the PO safely."), {
          status: 409,
          smartScmStateRecorded: true
        });
        await failSmartScmPurchaseExecution(review.id, interrupted, operatorId);
        throw interrupted;
      }
      await failSmartScmPurchaseExecution(review.id, "Recovering a NetSuite PO found after an interrupted insertion.", operatorId);
    }
    prepared = await prepareSmartScmPurchaseExecution(proposalId, operatorId, {
      executionMode: markerMatch ? "live" : null
    });
    if (prepared.mode === "live" && config.smartScm.liveExecutionEnabled === false && markerMatch === null) {
      throw new Error("Smart SCM live execution is blocked by SMART_SCM_LIVE_EXECUTION_ENABLED=false.");
    }
    if (prepared.mode === "live" || markerMatch) {
      if (markerMatch) {
        markerMatch = selectSmartScmMarkerPurchaseOrder([markerMatch], {
          proposalId: prepared.id,
          vendorId: prepared.vendorId
        });
        purchaseOrderId = markerMatch.id;
        purchaseOrderRef = markerMatch.tranid || null;
        recovered = true;
      } else {
        const destinationSpecs = [...new Map(prepared.lines.map((line) => [Number(line.destinationLocationId), {
          locationId: Number(line.destinationLocationId),
          code: line.destinationName
        }])).values()];
        const destinations = await resolveNetSuiteYardLocations(destinationSpecs);
        const payload = buildSmartScmPurchaseOrderRestPayload({
          proposal: prepared,
          locations: destinations,
          palletItem: prepared.palletItem
        });
        let createError = null;
        try {
          const created = await createPurchaseOrderInNetSuite(payload);
          purchaseOrderId = validRecordId(created.id);
        } catch (error) {
          createError = error;
        }
        if (purchaseOrderId === null) {
          const recoveredMatch = await recoverPurchaseOrderByMarker({
            proposalId: prepared.id,
            vendorId: prepared.vendorId,
            attempts: 4
          });
          if (recoveredMatch === null) {
            throw createError || new Error("NetSuite did not return a PO ID and no matching Smart SCM memo marker was found. Retry is safe after the review returns to Failed.");
          }
          purchaseOrderId = recoveredMatch.id;
          purchaseOrderRef = recoveredMatch.tranid || null;
          recovered = true;
        }
      }
      purchaseOrderRef = await hydrateSmartScmPurchaseOrder(prepared, purchaseOrderId, purchaseOrderRef);
      await completeSmartScmPurchaseExecution(prepared.id, {
        purchaseOrderId,
        purchaseOrderRef,
        mock: false
      }, operatorId);
    } else {
      purchaseOrderRef = "MOCK-PO-" + prepared.id;
      await completeSmartScmPurchaseExecution(prepared.id, {
        purchaseOrderId: null,
        purchaseOrderRef,
        mock: true
      }, operatorId);
    }
    return {
      proposalId: prepared.id,
      mode: prepared.mode,
      purchaseOrderId,
      purchaseOrderRef,
      recovered
    };
  } catch (error) {
    if (error.smartScmStateRecorded) throw error;
    if (purchaseOrderId || purchaseOrderRef?.startsWith("MOCK-PO-") || error.smartScmAttention) {
      await markSmartScmPurchaseAttention(prepared?.id || proposalId, { purchaseOrderId, purchaseOrderRef, error }, operatorId);
    } else if (prepared) {
      await failSmartScmPurchaseExecution(prepared.id, error, operatorId);
    }
    throw error;
  }
}
