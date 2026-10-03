// @ts-check

import { isNetSuiteOrderClosed } from "./netsuite-closed-order-policy.js";
import { fetchSalesOrderFulfillmentStateFromNetSuite } from "./netsuite.js";
import { operatorNetSuitePostingAdapter } from "./operator-netsuite-posting-netsuite-adapter.js";
import { outboundOrderYards } from './outbound-location-domain.js';

/** @typedef {Record<string, any>} LooseRecord */

/** @param {LooseRecord} candidate @param {LooseRecord} [payload] */
function postingStep(candidate, payload = candidate?.payload) {
  return {
    externalId: candidate.externalId,
    sourceNetSuiteId: candidate.sourceSalesOrderId,
    sourceOrderKind: "SO",
    transactionType: "IF",
    dispatchAutoFulfillment: true,
    lineSnapshot: candidate.lineSnapshot,
    payload
  };
}

/** @param {LooseRecord} candidate */
export async function fetchLiveSalesOrderAutoFulfillmentState(candidate) {
  const live = await fetchSalesOrderFulfillmentStateFromNetSuite(candidate.sourceSalesOrderId);
  if (!live) {
    return { closed: true, missing: true, lines: [] };
  }
  if (live.fulfillmentComplete) {return {...live,closed:isNetSuiteOrderClosed(live)};}
  const selected = new Set((candidate.lineSnapshot || []).map((/** @type {LooseRecord} */ line) => Number(line.orderLine)));
  const yards = outboundOrderYards({ outbound_location_id: candidate.canonicalLocationId,
    lines: live.lines.filter((/** @type {LooseRecord} */ line) => selected.has(line.orderLine))
      .map((/** @type {LooseRecord} */ line) => ({ location_id: line.location })) });
  if (yards.length !== 1 || yards[0] !== Number(candidate.canonicalLocationId)) {
    throw Object.assign(new Error('The live fulfillment inventory locations no longer belong to the completed yard.'), { status: 409 });
  }
  return {
    ...live,
    closed: isNetSuiteOrderClosed(live)
  };
}

export const salesOrderAutoFulfillmentNetSuiteAdapter = {
  /** @param {LooseRecord} candidate */
  hasSplitPlan(candidate) {
    return operatorNetSuitePostingAdapter.hasSplitPlan(postingStep(candidate));
  },
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
