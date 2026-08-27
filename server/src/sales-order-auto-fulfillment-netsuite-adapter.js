// @ts-check

import { isNetSuiteOrderClosed } from "./netsuite-closed-order-policy.js";
import { fetchSalesOrderFulfillmentStateFromNetSuite } from "./netsuite.js";
import { operatorNetSuitePostingAdapter } from "./operator-netsuite-posting-netsuite-adapter.js";

/** @typedef {Record<string, any>} LooseRecord */

/** @param {LooseRecord} candidate @param {LooseRecord} [payload] */
function postingStep(candidate, payload = candidate?.payload) {
  return {
    externalId: candidate.externalId,
    sourceNetSuiteId: candidate.sourceSalesOrderId,
    sourceOrderKind: "SO",
    transactionType: "IF",
    payload
  };
}

/** @param {LooseRecord} candidate */
export async function fetchLiveSalesOrderAutoFulfillmentState(candidate) {
  const live = await fetchSalesOrderFulfillmentStateFromNetSuite(candidate.sourceSalesOrderId);
  if (!live) {
    return { closed: true, missing: true, lines: [] };
  }
  return {
    ...live,
    closed: isNetSuiteOrderClosed(live)
  };
}

export const salesOrderAutoFulfillmentNetSuiteAdapter = {
  /** @param {LooseRecord} candidate */
  findByExternalId(candidate) {
    return operatorNetSuitePostingAdapter.findByExternalId(postingStep(candidate));
  },
  /** @param {LooseRecord} candidate @param {LooseRecord} payload */
  transform(candidate, payload) {
    return operatorNetSuitePostingAdapter.transform(postingStep(candidate, payload));
  },
  /** @param {LooseRecord} candidate @param {number} id */
  fetchById(candidate, id) {
    return operatorNetSuitePostingAdapter.fetchById(postingStep(candidate), id);
  },
  /** @param {LooseRecord} candidate @param {LooseRecord} record @param {LooseRecord} payload */
  verify(candidate, record, payload) {
    return operatorNetSuitePostingAdapter.verify(postingStep(candidate, payload), record);
  }
};
