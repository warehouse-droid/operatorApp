// @ts-check

import { query } from "./db.js";
import { recordCustomerPickupLoad, recordDeliveryLoad } from "./delivery-repository.js";
import { recordReceivingReceipt } from "./receiving-repository.js";
import {
  syncDirectDependencyOperatorProgress,
  syncOrderDependenciesForTransferOrder
} from "./order-dependency-repository.js";

/** @type {(type: string, payload: Record<string, any>) => unknown} */
let completionEventEmitter = (_type, _payload) => {};

/** @param {(type: string, payload: Record<string, any>) => unknown} emitEvent */
export function configureOperatorNetSuitePostingCompletionEvents(emitEvent) {
  if (typeof emitEvent !== "function") {throw new TypeError("An Operator posting completion event emitter is required.");}
  completionEventEmitter = emitEvent;
}

/** @param {Record<string, any>} command @param {Record<string, any>} operation @param {Record<string, any>} result */
export function publishOperatorNetSuitePostingCompletionEvents(command, operation, result) {
  const common = { orderId: operation.orderId, operatorId: command.actorOperatorId };
  if (operation.kind === "customer_pickup_load") {
    completionEventEmitter("delivery.order.loaded", { ...common, source: "customer-pickup", result });
    return;
  }
  if (operation.kind === "receiving_receipt") {
    completionEventEmitter("receiving.order.received", {
      ...common,
      orderType: operation.orderType || null,
      jobId: command.id,
      itemReceiptTranid: result.itemReceiptTranid || null
    });
    return;
  }
  completionEventEmitter("delivery.order.loaded", { ...common, resultId: result.id || null });
  if (Array.isArray(result.activatedCo) && result.activatedCo.length) {
    const coPayload = { orderId: operation.orderId, activatedCo: result.activatedCo, source: "delivery-load" };
    completionEventEmitter("receiving.order.updated", coPayload);
    completionEventEmitter("dispatch.co.updated", coPayload);
  }
}

/** @param {Record<string, any>} command */
function postingEvidence(command) {
  return {
    schemaVersion: "operator-netsuite-posting-evidence-v1",
    commandId: command.id,
    requestId: command.requestId,
    gateKey: command.gateKey,
    gateRevision: command.gateRevision,
    transactions: (command.steps || []).map((/** @type {Record<string, any>} */ step) => ({
      transactionType: step.transactionType,
      sourceOrderKind: step.sourceOrderKind,
      sourceNetSuiteId: step.sourceNetSuiteId,
      sourceOrderRef: step.sourceOrderRef,
      externalId: step.externalId,
      transactionId: step.netSuiteTransactionId,
      transactionRef: step.netSuiteTransactionRef
    })),
    lineReconciliation: command?.inputSnapshot?.lineReconciliation || null
  };
}

/** @param {Record<string, any>} command */
function authoritativeLineReconciliation(command) {
  const reconciliation = command?.inputSnapshot?.lineReconciliation;
  const lines = Array.isArray(reconciliation?.lines) ? reconciliation.lines : [];
  return lines.length > 0 && lines.every((/** @type {Record<string, any>} */ line) => line?.authoritative !== false
    && Number(line?.reconciledQuantity) >= 0);
}

/** @param {Record<string, any>} command */
// Linked evidence can span multiple lines and receipts; every guard is part of
// proving that one header identity is safe to retain locally.
// eslint-disable-next-line complexity
function uniqueReconciledReceipt(command) {
  const lines = command?.inputSnapshot?.lineReconciliation?.lines || [];
  const receipts = new Map();
  for (const line of lines) {
    for (const transaction of line?.linkedTransactions || []) {
      if (String(transaction?.type).toUpperCase() !== "IR") {continue;}
      const id = Number(transaction?.id);
      if (!Number.isSafeInteger(id) || id <= 0) {continue;}
      receipts.set(id, { id, ref: String(transaction?.ref || "") });
    }
  }
  return receipts.size === 1 ? [...receipts.values()][0] : null;
}

/** @param {Record<string, any>} localResult */
function loadRecordIds(localResult) {
  return [...new Set([
    localResult?.id,
    ...(localResult?.sourceLoadRecords || []).map((/** @type {Record<string, any>} */ record) => record?.id)
  ].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

/** @param {Record<string, any>} localResult @param {Record<string, any>} command */
async function attachLoadEvidence(localResult, command) {
  const ids = loadRecordIds(localResult);
  if (!ids.length) {return;}
  await query(
    `UPDATE operator_load_records
        SET response = COALESCE(response, '{}'::jsonb)
          || jsonb_build_object('operatorNetSuitePosting', $2::jsonb)
      WHERE id = ANY($1::bigint[])`,
    [ids, JSON.stringify(postingEvidence(command))]
  );
}

/**
 * @param {object} dependencies
 * @param {Function} dependencies.recordCustomerPickupLoad
 * @param {Function} dependencies.recordDeliveryLoad
 * @param {Function} dependencies.recordReceivingReceipt
 * @param {Function} dependencies.syncDirectDependencyOperatorProgress
 * @param {Function} dependencies.syncOrderDependenciesForTransferOrder
 * @param {Function} dependencies.attachLoadEvidence
 * @param {Function} [dependencies.publishCompletionEvents]
 */
export function createOperatorNetSuitePostingFinalizer({
  recordCustomerPickupLoad: finalizeCustomerPickup,
  recordDeliveryLoad: finalizeDeliveryLoad,
  recordReceivingReceipt: finalizeReceivingReceipt,
  syncDirectDependencyOperatorProgress: syncDirectDependencies,
  syncOrderDependenciesForTransferOrder: syncTransferDependencies,
  attachLoadEvidence: persistLoadEvidence,
  publishCompletionEvents: publishEvents = () => {}
}) {
  /** @param {Record<string, any>} command @param {Record<string, any>} operation @param {string[]} photos */
  async function customerPickupFinalization(command, operation, photos) {
      const result = await finalizeCustomerPickup(operation.orderId, command.actorOperatorId, {
        photoDataUrls: photos,
        allowNetSuiteCompleted: true
      });
      await persistLoadEvidence(result, command);
      const completed = { ...result, operatorNetSuitePosting: postingEvidence(command) };
      await publishEvents(command, operation, completed);
      return completed;
  }

  /** @param {Record<string, any>} command @param {Record<string, any>} operation @param {string[]} photos */
  async function deliveryPrepFinalization(command, operation, photos) {
      const result = await finalizeDeliveryLoad(operation.orderId, command.actorOperatorId, {
        photoDataUrls: photos,
        requestId: command.requestId,
        allowNetSuiteCompleted: true
      });
      await persistLoadEvidence(result, command);
      const dependencyProgress = result.localOnly
        ? null
        : await syncDirectDependencies(operation.orderId);
      const completed = { ...result, dependencyProgress, operatorNetSuitePosting: postingEvidence(command) };
      await publishEvents(command, operation, completed);
      return completed;
  }

  /** @param {Record<string, any>} command @param {Record<string, any>} operation @param {string[]} photos */
  // This is the single local IR finalization boundary for both a verified new
  // receipt and an authoritative zero-step reconciliation.
  // eslint-disable-next-line complexity
  async function receivingFinalization(command, operation, photos) {
    const steps = command.steps || [];
    const reconciledWithoutPost = steps.length === 0 && authoritativeLineReconciliation(command);
    if ((!reconciledWithoutPost && steps.length !== 1)
        || (steps.length === 1 && steps[0].transactionType !== "IR")) {
      throw Object.assign(new Error("Receiving finalization requires one verified Item Receipt."), {
        status: 409,
        code: "OPERATOR_NETSUITE_POSTING_FINALIZER_UNSUPPORTED"
      });
    }
    const step = steps[0] || null;
    const existingReceipt = reconciledWithoutPost ? uniqueReconciledReceipt(command) : null;
    const payload = command?.inputSnapshot?.localPayload || step?.payload;
    if (!payload?.item?.items?.length) {
      throw Object.assign(new Error("Receiving finalization requires the stable local receipt payload."), {
        status: 409,
        code: "OPERATOR_NETSUITE_POSTING_FINALIZER_UNSUPPORTED"
      });
    }
    const result = await finalizeReceivingReceipt(operation.orderId, command.actorOperatorId, {
      photoDataUrls: photos,
      payload,
      response: { operatorNetSuitePosting: postingEvidence(command) },
      itemReceiptId: step?.netSuiteTransactionId ?? existingReceipt?.id ?? null,
      itemReceiptTranid: step?.netSuiteTransactionRef ?? existingReceipt?.ref ?? null,
      allowNetSuiteCompleted: true
    });
    if (operation.orderType === "transfer_order") {
      await syncTransferDependencies(operation.orderId);
    }
    const completed = { ...result, operatorNetSuitePosting: postingEvidence(command) };
    await publishEvents(command, operation, completed);
    return completed;
  }

  const handlers = {
    customer_pickup_load: customerPickupFinalization,
    delivery_prep_load: deliveryPrepFinalization,
    receiving_receipt: receivingFinalization
  };

  return async function finalizeOperatorNetSuitePosting(/** @type {Record<string, any>} */ command) {
    const operation = command?.inputSnapshot?.localOperation;
    const photos = Array.isArray(command?.photoRefs) ? command.photoRefs : [];
    const handler = handlers[/** @type {keyof typeof handlers} */ (operation?.kind)];
    if (!handler) {
      throw Object.assign(new Error("The durable Operator local finalization operation is unsupported."), {
        status: 409,
        code: "OPERATOR_NETSUITE_POSTING_FINALIZER_UNSUPPORTED"
      });
    }
    return handler(command, operation, photos);
  };
}

export const finalizeOperatorNetSuitePosting = createOperatorNetSuitePostingFinalizer({
  recordCustomerPickupLoad,
  recordDeliveryLoad,
  recordReceivingReceipt,
  syncDirectDependencyOperatorProgress,
  syncOrderDependenciesForTransferOrder,
  attachLoadEvidence,
  publishCompletionEvents: publishOperatorNetSuitePostingCompletionEvents
});
