// @ts-check

import { config } from "./config.js";
import { salesOrderAutoFulfillmentNetSuiteAdapter, fetchLiveSalesOrderAutoFulfillmentState } from "./sales-order-auto-fulfillment-netsuite-adapter.js";
import {
  claimSalesOrderAutoFulfillmentCandidate,
  completeSalesOrderAutoFulfillmentCandidate,
  failSalesOrderAutoFulfillmentCandidate,
  getSalesOrderAutoFulfillmentCandidate,
  listRunnableSalesOrderAutoFulfillmentCandidateIds,
  markSalesOrderAutoFulfillmentAttention,
  markSalesOrderAutoFulfillmentClosed,
  markSalesOrderAutoFulfillmentReconciled,
  prepareSalesOrderAutoFulfillmentCandidate,
  renewSalesOrderAutoFulfillmentCandidateLease,
  startSalesOrderAutoFulfillmentAttempt
} from "./sales-order-auto-fulfillment-repository.js";
import { createSalesOrderAutoFulfillmentProcessor } from "./sales-order-auto-fulfillment-service.js";

const repository = {
  get: getSalesOrderAutoFulfillmentCandidate,
  prepare: prepareSalesOrderAutoFulfillmentCandidate,
  claim: claimSalesOrderAutoFulfillmentCandidate,
  renew: renewSalesOrderAutoFulfillmentCandidateLease,
  startAttempt: startSalesOrderAutoFulfillmentAttempt,
  complete: completeSalesOrderAutoFulfillmentCandidate,
  failure: failSalesOrderAutoFulfillmentCandidate,
  attention: markSalesOrderAutoFulfillmentAttention,
  closed: markSalesOrderAutoFulfillmentClosed,
  reconciled: markSalesOrderAutoFulfillmentReconciled
};

const processor = createSalesOrderAutoFulfillmentProcessor({
  repository,
  fetchLiveOrder: fetchLiveSalesOrderAutoFulfillmentState,
  adapter: salesOrderAutoFulfillmentNetSuiteAdapter,
  workerId: `dispatch-so-if-${process.pid}`
});

/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();

/** @param {unknown} candidateId */
export function enqueueSalesOrderAutoFulfillmentCandidate(candidateId) {
  const id = String(candidateId || "").trim();
  if (!id) {return Promise.resolve(null);}
  if (inFlight.has(id)) {return inFlight.get(id);}
  const work = processor.process(id)
    .catch((error) => {
      console.error(
        `Dispatch SO fulfillment candidate ${id} failed:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    })
    .finally(() => {
      if (inFlight.get(id) === work) {inFlight.delete(id);}
    });
  inFlight.set(id, work);
  return work;
}

export async function salesOrderAutoFulfillmentTick() {
  if (config.netsuite?.directAccessEnabled !== true) {return { disabled: true, discovered: 0 };}
  const ids = await listRunnableSalesOrderAutoFulfillmentCandidateIds({ limit: 25 });
  await Promise.all(ids.map((/** @type {unknown} */ id) => enqueueSalesOrderAutoFulfillmentCandidate(id)));
  return { disabled: false, discovered: ids.length };
}

let started = false;

export function startSalesOrderAutoFulfillmentRuntime() {
  if (started || config.netsuite?.directAccessEnabled !== true) {return;}
  started = true;
  void salesOrderAutoFulfillmentTick();
  setInterval(() => void salesOrderAutoFulfillmentTick(), 10000);
}
