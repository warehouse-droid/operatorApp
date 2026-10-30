// @ts-check

import { isNetSuiteOrderClosed } from "./netsuite-closed-order-policy.js";
import { fetchSalesOrderFulfillmentStateFromNetSuite } from "./netsuite.js";
import { operatorNetSuitePostingAdapter } from "./operator-netsuite-posting-netsuite-adapter.js";
import { outboundOrderYards } from './outbound-location-domain.js';
import { fetchOperatorKitSource } from './operator-netsuite-posting-kit-source.js';
import { readDeliveryFulfillmentSource } from './sales-order-auto-fulfillment-kits.js';

/** @typedef {Record<string, any>} LooseRecord */

/** @param {LooseRecord} candidate @param {LooseRecord} [payload] */
function postingStep(candidate, payload = candidate?.payload) {
  return {
    externalId: candidate.externalId,
    sourceNetSuiteId: candidate.sourceSalesOrderId,
    sourceOrderKind: "SO",
    transactionType: "IF",
    dispatchAutoFulfillment: true,
    lineSnapshot: candidate.liveSnapshot?.kitPostingLines || candidate.lineSnapshot,
    payload
  };
}

/** @param {LooseRecord} candidate @param {{readSource?:Function,readKitSource?:Function}} [dependencies] */
export async function fetchLiveSalesOrderAutoFulfillmentState(candidate, {
  readSource = fetchSalesOrderFulfillmentStateFromNetSuite, readKitSource = fetchOperatorKitSource
} = {}) {
  const live = await readDeliveryFulfillmentSource(candidate, {readSource,readKitSource});
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

/** @param {LooseRecord} [adapter] */
export function createSalesOrderAutoFulfillmentNetSuiteAdapter(adapter = operatorNetSuitePostingAdapter) {
  return {
  /** @param {LooseRecord} candidate */
  hasSplitPlan(candidate) {
    return adapter.hasSplitPlan?.(postingStep(candidate));
  },
  /** @param {LooseRecord} candidate */
  findByExternalId(candidate) {
    return adapter.findByExternalId(postingStep(candidate));
  },
  /** @param {LooseRecord} candidate @param {LooseRecord} payload */
  transform(candidate, payload) {
    return adapter.transform(postingStep(candidate, payload));
  },
  /** @param {LooseRecord} candidate @param {number} id */
  fetchById(candidate, id) {
    return adapter.fetchById(postingStep(candidate), id);
  },
  /** @param {LooseRecord} candidate @param {LooseRecord} record @param {LooseRecord} payload */
  verify(candidate, record, payload) {
    return adapter.verify(postingStep(candidate, payload), record);
  }
};
}

export const salesOrderAutoFulfillmentNetSuiteAdapter = createSalesOrderAutoFulfillmentNetSuiteAdapter();
