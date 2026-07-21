import { config } from "./config.js";
import {
  createPurchaseOrderInNetSuite,
  fetchPurchaseOrderDetailsFromNetSuite,
  fetchPurchaseOrderReferenceFromNetSuite,
  resolveNetSuiteYardLocations
} from "./netsuite.js";
import { upsertPurchaseOrderLines, upsertPurchaseOrders } from "./order-sync-repository.js";
import { buildSmartScmPurchaseOrderRestPayload } from "./smart-scm-purchase-netsuite.js";
import {
  completeSmartScmPurchaseExecution,
  failSmartScmPurchaseExecution,
  markSmartScmPurchaseAttention,
  prepareSmartScmPurchaseExecution
} from "./smart-scm-vendor-repository.js";

export async function executeSmartScmPurchaseProposal(proposalId, operatorId = null) {
  const prepared = await prepareSmartScmPurchaseExecution(proposalId, operatorId);
  let purchaseOrderId = null;
  let purchaseOrderRef = null;
  try {
    if (prepared.mode === "live") {
      if (!config.smartScm.liveExecutionEnabled) {
        throw new Error("Smart SCM live execution is blocked by SMART_SCM_LIVE_EXECUTION_ENABLED=false.");
      }
      const destinationSpecs = [...new Map(prepared.lines.map((line) => [Number(line.destinationLocationId), {
        locationId: Number(line.destinationLocationId),
        code: line.destinationName
      }])).values()];
      const destinations = await resolveNetSuiteYardLocations(destinationSpecs);
      const destination = destinations.find((row) => Number(row.localLocationId) === Number(prepared.destinationLocationId)) || destinations[0];
      const payload = buildSmartScmPurchaseOrderRestPayload({ proposal: prepared, locations: destinations });
      const created = await createPurchaseOrderInNetSuite(payload);
      purchaseOrderId = Number(created.id);
      if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
        throw new Error("NetSuite created the PO without returning a usable record ID; reconcile the MBBS-SCM-PO memo before retrying.");
      }
      const order = await fetchPurchaseOrderReferenceFromNetSuite(purchaseOrderId);
      purchaseOrderRef = order?.tranid || `PO-${purchaseOrderId}`;
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
      await completeSmartScmPurchaseExecution(prepared.id, {
        purchaseOrderId,
        purchaseOrderRef,
        mock: false
      }, operatorId);
    } else {
      purchaseOrderRef = `MOCK-PO-${prepared.id}`;
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
      purchaseOrderRef
    };
  } catch (error) {
    if (purchaseOrderId || purchaseOrderRef?.startsWith("MOCK-PO-")) {
      await markSmartScmPurchaseAttention(prepared.id, { purchaseOrderId, purchaseOrderRef, error }, operatorId);
    } else {
      await failSmartScmPurchaseExecution(prepared.id, error, operatorId);
    }
    throw error;
  }
}
