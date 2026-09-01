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

/**
 * @param {object} dependencies
 * @param {Function} dependencies.findTransactionByExternalId
 * @param {Function} dependencies.transformSalesOrderToItemFulfillment
 * @param {Function} dependencies.transformTransferOrderToItemFulfillment
 * @param {Function} dependencies.transformPurchaseOrderToItemReceipt
 * @param {Function} dependencies.transformTransferOrderToItemReceipt
 * @param {Function} dependencies.fetchItemFulfillment
 * @param {Function} dependencies.fetchItemReceipt
 */
export function createOperatorNetSuitePostingAdapter({
  findTransactionByExternalId,
  transformSalesOrderToItemFulfillment: salesOrderFulfillment,
  transformTransferOrderToItemFulfillment: transferOrderFulfillment,
  transformPurchaseOrderToItemReceipt: purchaseOrderReceipt,
  transformTransferOrderToItemReceipt: transferOrderReceipt,
  fetchItemFulfillment,
  fetchItemReceipt
}) {
  async function fetchById(/** @type {Record<string, any>} */ step, /** @type {number} */ id) {
    return step.transactionType === "IF"
      ? fetchItemFulfillment(id)
      : fetchItemReceipt(id);
  }

  return {
    async findByExternalId(/** @type {Record<string, any>} */ step) {
      const found = await findTransactionByExternalId(
        step.externalId,
        step.transactionType,
        step.sourceNetSuiteId
      );
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
        transactionType: step.transactionType
      };
    },
    async transform(/** @type {Record<string, any>} */ step) {
      if (step.transactionType === "IF" && step.sourceOrderKind === "SO") {
        return salesOrderFulfillment(step.sourceNetSuiteId, step.payload);
      }
      if (step.transactionType === "IF" && step.sourceOrderKind === "TO") {
        return transferOrderFulfillment(step.sourceNetSuiteId, step.payload);
      }
      if (step.transactionType === "IR" && step.sourceOrderKind === "PO") {
        return purchaseOrderReceipt(step.sourceNetSuiteId, step.payload);
      }
      if (step.transactionType === "IR" && step.sourceOrderKind === "TO") {
        return transferOrderReceipt(step.sourceNetSuiteId, step.payload);
      }
      throw unsupported(`A ${step.sourceOrderKind || "missing"} source cannot create ${step.transactionType || "this transaction"}.`);
    },
    fetchById,
    verify: verifyOperatorNetSuitePostingRecord
  };
}

export const operatorNetSuitePostingAdapter = createOperatorNetSuitePostingAdapter({
  findTransactionByExternalId: findOperatorNetSuitePostingTransactionByExternalId,
  transformSalesOrderToItemFulfillment,
  transformTransferOrderToItemFulfillment,
  transformPurchaseOrderToItemReceipt,
  transformTransferOrderToItemReceipt,
  fetchItemFulfillment: fetchItemFulfillmentFromNetSuite,
  fetchItemReceipt: fetchItemReceiptFromNetSuite
});
