// @ts-check

import {
  fetchItemFulfillmentFromNetSuite,
  fetchItemReceiptFromNetSuite,
  fetchPurchaseOrderHistorySnapshotFromNetSuite,
  fetchSalesOrderFulfillmentStateFromNetSuite,
  findLinkedPostingTransactionsAfter,
  findOperatorNetSuitePostingTransactionByExternalId,
  postIfirViaNetSuiteRestlet,
  transformPurchaseOrderToItemReceipt,
  transformSalesOrderToItemFulfillment,
  transformTransferOrderToItemFulfillment,
  transformTransferOrderToItemReceipt
} from "./netsuite.js";
import { purchaseReceiptNeedsChargeSource, verifyPurchaseReceiptWithCharges } from './operator-netsuite-receipt-charges.js';
import { operatorNetSuiteRequestPool } from "./operator-netsuite-request-pool.js";
import { createLocationAwareIFAdapter } from './item-fulfillment-parts-service.js';
import { itemFulfillmentPartsRepository } from './item-fulfillment-parts-repository.js';
import { fetchOperatorKitSource } from './operator-netsuite-posting-kit-source.js';
import { assertOperatorKitStepCurrent, operatorKitError, operatorStepHasKits } from './operator-netsuite-posting-kits.js';
import { assertDirectPoReceiptStepCurrent } from './direct-po-auto-receipt-domain.js';
import {assertAllocatedPoReceiptCurrent} from './direct-po-allocation-receipt.js';
import { assertDispatchFulfillmentStepCurrent } from './netsuite-fulfillable-items.js';
import { assertTransferPostingStepReady } from './transfer-order-posting-repository.js';
import { assertTransferPostingSourceCurrent } from './transfer-order-posting-domain.js';
import { fetchLiveSourceFromNetSuite } from './operator-netsuite-posting-targets.js';
import { prepareSalesOrderFulfillmentPayload, prepareDeferredSalesOrderNativePayload, readSalesOrderFulfillmentSource } from './operator-netsuite-posting-fulfillment-lines.js';

/** @param {Record<string,any>} step */
async function recheckTransferPosting(step) {
  if(!await assertTransferPostingStepReady(step)){return;}
  assertTransferPostingSourceCurrent(step,await fetchLiveSourceFromNetSuite({sourceOrderKind:'TO',sourceNetSuiteId:step.sourceNetSuiteId}));
}

/** @param {Record<string, any>} record @param {string | undefined} fallback */
function transactionTypeFromRecord(record, fallback) {
  return record?.transactionType ?? record?.transaction_type ?? record?.type ?? fallback;
}

/** @param {string} message */
function unsupported(message) {
  return Object.assign(new Error(message), {
    status: 409,
    code: "OPERATOR_NETSUITE_POSTING_TRANSFORM_UNSUPPORTED"
  });
}

/**
 * @param {Record<string, any>} found
 * @param {Record<string, any>} step
 * @param {Function} fetchById
 */
async function readableFoundRecord(found, step, fetchById) {
  if (found.record && typeof found.record === "object") {return found.record;}
  return fetchById(step, Number(found.id));
}

/** @param {any} step @param {Function} readSource */
async function recheckKitSource(step, readSource) {
  if (!operatorStepHasKits(step)) { return null; }
  try {
    const source = await readSource(step.sourceNetSuiteId);
    assertOperatorKitStepCurrent(step, source);
    return { id: step.sourceNetSuiteId, lines: source.availableLines };
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'OPERATOR_NETSUITE_POSTING_KIT_INVALID') { throw error; }
    throw operatorKitError('The current NetSuite kit source could not be rechecked.');
  }
}

/**
 * @param {object} dependencies
 * @param {Function} dependencies.findTransactionByExternalId
 * @param {Function} dependencies.transformSalesOrderToItemFulfillment
 * @param {Function} dependencies.transformTransferOrderToItemFulfillment
 * @param {Function} dependencies.transformPurchaseOrderToItemReceipt
 * @param {Function} dependencies.transformTransferOrderToItemReceipt
 * @param {Function} dependencies.fetchItemFulfillment
 * @param {Function} dependencies.fetchItemReceipt
 * @param {Function} [dependencies.fetchKitSource]
 * @param {Function} [dependencies.fetchDirectReceiptSource]
 * @param {Function} [dependencies.fetchPurchaseReceiptSource]
 * @param {Function} [dependencies.fetchDispatchFulfillmentSource]
 * @param {Function} [dependencies.fetchSalesOrderFulfillmentSource]
 * @param {Function} [dependencies.checkTransferPosting]
 * @param {Function|null} [dependencies.postIfirRestlet]
 * @param {Function} [dependencies.findLinkedTransactionsAfter]
 */
export function createOperatorNetSuitePostingAdapter({
  findTransactionByExternalId,
  transformSalesOrderToItemFulfillment: salesOrderFulfillment,
  transformTransferOrderToItemFulfillment: transferOrderFulfillment,
  transformPurchaseOrderToItemReceipt: purchaseOrderReceipt,
  transformTransferOrderToItemReceipt: transferOrderReceipt,
  fetchItemFulfillment,
  fetchItemReceipt,
  fetchKitSource = fetchOperatorKitSource,
  fetchDirectReceiptSource = fetchPurchaseOrderHistorySnapshotFromNetSuite,
  fetchPurchaseReceiptSource = fetchPurchaseOrderHistorySnapshotFromNetSuite,
  fetchDispatchFulfillmentSource = (/** @type {number} */ id) => fetchSalesOrderFulfillmentStateFromNetSuite(id, { includeAllSourceLines: true }),
  fetchSalesOrderFulfillmentSource = (/** @type {number} */ id) => fetchSalesOrderFulfillmentStateFromNetSuite(id, { includeAllSourceLines: true }),
  checkTransferPosting = async () => {},
  postIfirRestlet = null,
  findLinkedTransactionsAfter = findLinkedPostingTransactionsAfter
}) {
  const endpointTypes = new WeakMap();
  // Source proof comes from our authenticated read or the validated RESTlet envelope.
  const purchaseChargeSources = new WeakMap();
  /** @param {any} step @param {any} payload @param {Function} native */
  async function post(step, payload, native) {
    const result = await postIfirRestlet?.({ ...step, payload });
    if (result) {
      purchaseChargeSources.set(result.record, result.source);
      endpointTypes.set(result.record, step.transactionType);
      return result;
    }
    return native(step.sourceNetSuiteId, payload);
  }
  async function readChargeSource(/** @type {any} */ step, /** @type {any} */ record) {
    if (!purchaseReceiptNeedsChargeSource(step, record) || purchaseChargeSources.has(record)) { return; }
    try {
      purchaseChargeSources.set(record, await operatorNetSuiteRequestPool.run(() => fetchPurchaseReceiptSource(step.sourceNetSuiteId)));
    } catch {
      // Keep the readable IR so the posting service can show its identity while
      // holding finalization until its extra charge can be verified.
      purchaseChargeSources.set(record, null);
    }
  }
  async function fetchById(/** @type {Record<string, any>} */ step, /** @type {number} */ id) {
    const record = await operatorNetSuiteRequestPool.run(() => step.transactionType === "IF"
      ? fetchItemFulfillment(id)
      : fetchItemReceipt(id));
    if (record && typeof record === "object") {endpointTypes.set(record, step.transactionType);}
    await readChargeSource(step, record);
    return record;
  }

  return {
    /** IF/IR linked to the step's source order created after a baseline transaction ID. */
    async linkedTransactionsAfter(/** @type {Record<string, any>} */ step, /** @type {number} */ afterTransactionId) {
      return operatorNetSuiteRequestPool.run(() => findLinkedTransactionsAfter(
        step.sourceNetSuiteId, step.transactionType, afterTransactionId));
    },
    /** Live line fulfillment of an SO:IF step's order (reconciliation only; null for other sources). */
    async sourceFulfillment(/** @type {Record<string, any>} */ step) {
      if (step.sourceOrderKind !== "SO" || step.transactionType !== "IF") {return null;}
      return operatorNetSuiteRequestPool.run(() => fetchSalesOrderFulfillmentSource(step.sourceNetSuiteId));
    },
    async findByExternalId(/** @type {Record<string, any>} */ step, direct = false) {
      const found = await operatorNetSuiteRequestPool.run(() => findTransactionByExternalId(
        step.externalId,
        step.transactionType,
        step.sourceNetSuiteId,
        ...(direct ? [{ direct: true }] : [])
      ));
      if (!found) {return null;}
      const id = Number(found.id);
      const record = await readableFoundRecord(found, step, fetchById);
      if (!record) {
        throw Object.assign(new Error("The external-ID transaction exists but its record cannot be read."), {
          code: "OPERATOR_NETSUITE_POSTING_RESULT_UNVERIFIED",
          ambiguous: true
        });
      }
      await readChargeSource(step, record);
      const normalized = {
        ...record,
        id,
        tranId: record.tranId ?? record.tranid ?? found.tranid,
        externalId: record.externalId ?? record.externalid ?? found.externalid,
        createdFromId: record.createdFromId
          ?? record.createdfrom
          ?? record.createdFrom?.id
          ?? found.createdfrom,
        transactionType: transactionTypeFromRecord(record, step.transactionType)
      };
      purchaseChargeSources.set(normalized, purchaseChargeSources.get(record));
      return normalized;
    },
    async transform(/** @type {Record<string, any>} */ step) {
      if (step.transactionType === "IF" && step.sourceOrderKind === "SO") {
        return operatorNetSuiteRequestPool.run(async () => {
          let source = null;
          if (step.dispatchAutoFulfillment) {
            source = await readSalesOrderFulfillmentSource(step, fetchDispatchFulfillmentSource);
            assertDispatchFulfillmentStepCurrent(step, source);
          }
          source = await recheckKitSource(step, fetchKitSource) ?? source;
          if (!source && step.payload?.item?.items?.length) {
            source = await readSalesOrderFulfillmentSource(step, fetchSalesOrderFulfillmentSource);
          }
          const payload = step.payload?.item?.items?.length ? prepareSalesOrderFulfillmentPayload(step, source) : step.payload;
          return post(step, payload, (/** @type {number} */ id, /** @type {any} */ nativePayload) =>
            salesOrderFulfillment(id, prepareDeferredSalesOrderNativePayload(step, nativePayload, source)));
        });
      }
      if (step.transactionType === "IF" && step.sourceOrderKind === "TO") {
        await checkTransferPosting(step);
        return operatorNetSuiteRequestPool.run(() => post(step, step.payload, transferOrderFulfillment));
      }
      if (step.transactionType === "IR" && step.sourceOrderKind === "PO") {
        return operatorNetSuiteRequestPool.run(async () => {
          await assertAllocatedPoReceiptCurrent(step);
          if ((step.lineSnapshot || []).some((/** @type {Record<string,any>} */ line)=>line.directCompletionEventId || line.directReceiptJobId)) {
            assertDirectPoReceiptStepCurrent(step,await fetchDirectReceiptSource(step.sourceNetSuiteId));
          }
          return post(step, step.payload, purchaseOrderReceipt);
        });
      }
      if (step.transactionType === "IR" && step.sourceOrderKind === "TO") {
        await checkTransferPosting(step);
        return operatorNetSuiteRequestPool.run(() => post(step, step.payload, transferOrderReceipt));
      }
      throw unsupported(`A ${step.sourceOrderKind || "missing"} source cannot create ${step.transactionType || "this transaction"}.`);
    },
    fetchById,
    verify(/** @type {Record<string, any>} */ step, /** @type {Record<string, any>} */ record) {
      return verifyPurchaseReceiptWithCharges(step, { ...record,
        transactionType: transactionTypeFromRecord(record, endpointTypes.get(record)) }, purchaseChargeSources.get(record));
    }
  };
}

const nativePostingAdapter = createOperatorNetSuitePostingAdapter({
  findTransactionByExternalId: findOperatorNetSuitePostingTransactionByExternalId,
  transformSalesOrderToItemFulfillment,
  transformTransferOrderToItemFulfillment,
  transformPurchaseOrderToItemReceipt,
  transformTransferOrderToItemReceipt,
  fetchItemFulfillment: fetchItemFulfillmentFromNetSuite,
  fetchItemReceipt: fetchItemReceiptFromNetSuite,
  postIfirRestlet: postIfirViaNetSuiteRestlet,
  checkTransferPosting: recheckTransferPosting
});

export const operatorNetSuitePostingAdapter = createLocationAwareIFAdapter({
  adapter: nativePostingAdapter, repository: itemFulfillmentPartsRepository
});
