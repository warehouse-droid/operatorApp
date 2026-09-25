// @ts-check

import {
  fetchItemFulfillmentFromNetSuite,
  fetchItemReceiptFromNetSuite,
  findOperatorNetSuitePostingTransactionByExternalId,
  transformPurchaseOrderToItemReceipt,
  transformSalesOrderToItemFulfillment,
  transformTransferOrderToItemFulfillment,
  transformTransferOrderToItemReceipt
} from "./netsuite.js";
import { verifyOperatorNetSuitePostingRecord } from "./operator-netsuite-posting-adapter.js";
import { operatorNetSuiteRequestPool } from "./operator-netsuite-request-pool.js";
import { createLocationAwareIFAdapter } from './item-fulfillment-parts-service.js';
import { itemFulfillmentPartsRepository } from './item-fulfillment-parts-repository.js';
import { fetchOperatorKitSource } from './operator-netsuite-posting-kit-source.js';
import { assertOperatorKitStepCurrent, operatorKitError, operatorStepHasKits } from './operator-netsuite-posting-kits.js';

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
  if (!operatorStepHasKits(step)) { return; }
  try { assertOperatorKitStepCurrent(step, await readSource(step.sourceNetSuiteId)); }
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
 */
export function createOperatorNetSuitePostingAdapter({
  findTransactionByExternalId,
  transformSalesOrderToItemFulfillment: salesOrderFulfillment,
  transformTransferOrderToItemFulfillment: transferOrderFulfillment,
  transformPurchaseOrderToItemReceipt: purchaseOrderReceipt,
  transformTransferOrderToItemReceipt: transferOrderReceipt,
  fetchItemFulfillment,
  fetchItemReceipt,
  fetchKitSource = fetchOperatorKitSource
}) {
  const endpointTypes = new WeakMap();
  async function fetchById(/** @type {Record<string, any>} */ step, /** @type {number} */ id) {
    const record = await operatorNetSuiteRequestPool.run(() => step.transactionType === "IF"
      ? fetchItemFulfillment(id)
      : fetchItemReceipt(id));
    if (record && typeof record === "object") {endpointTypes.set(record, step.transactionType);}
    return record;
  }

  return {
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
      return {
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
    },
    async transform(/** @type {Record<string, any>} */ step) {
      if (step.transactionType === "IF" && step.sourceOrderKind === "SO") {
        return operatorNetSuiteRequestPool.run(async () => {
          await recheckKitSource(step, fetchKitSource);
          return salesOrderFulfillment(step.sourceNetSuiteId, step.payload);
        });
      }
      if (step.transactionType === "IF" && step.sourceOrderKind === "TO") {
        return operatorNetSuiteRequestPool.run(() => transferOrderFulfillment(step.sourceNetSuiteId, step.payload));
      }
      if (step.transactionType === "IR" && step.sourceOrderKind === "PO") {
        return operatorNetSuiteRequestPool.run(() => purchaseOrderReceipt(step.sourceNetSuiteId, step.payload));
      }
      if (step.transactionType === "IR" && step.sourceOrderKind === "TO") {
        return operatorNetSuiteRequestPool.run(() => transferOrderReceipt(step.sourceNetSuiteId, step.payload));
      }
      throw unsupported(`A ${step.sourceOrderKind || "missing"} source cannot create ${step.transactionType || "this transaction"}.`);
    },
    fetchById,
    verify(/** @type {Record<string, any>} */ step, /** @type {Record<string, any>} */ record) {
      return verifyOperatorNetSuitePostingRecord(step, { ...record,
        transactionType: transactionTypeFromRecord(record, endpointTypes.get(record)) });
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
  fetchItemReceipt: fetchItemReceiptFromNetSuite
});

export const operatorNetSuitePostingAdapter = createLocationAwareIFAdapter({
  adapter: nativePostingAdapter, repository: itemFulfillmentPartsRepository
});
