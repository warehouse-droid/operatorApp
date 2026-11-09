// @ts-check

import { config } from "./config.js";
import { directPoAutoReceiptTick } from './direct-po-auto-receipt.js';
import { transferPostingTick } from './transfer-order-posting-service.js';
import { operatorNetSuitePostingRuntime } from './operator-netsuite-posting-runtime.js';
import { salesOrderAutoFulfillmentNetSuiteAdapter, fetchLiveSalesOrderAutoFulfillmentState } from "./sales-order-auto-fulfillment-netsuite-adapter.js";
import {
  claimSalesOrderAutoFulfillmentCandidate,
  completeSalesOrderAutoFulfillmentCandidate,
  failSalesOrderAutoFulfillmentCandidate,
  getSalesOrderAutoFulfillmentCandidate,
  listRunnableSalesOrderAutoFulfillmentCandidateIds,
  listSalesOrderAutoFulfillmentAttentionCandidates,
  markSalesOrderAutoFulfillmentAttention,
  markSalesOrderAutoFulfillmentClosed,
  markSalesOrderAutoFulfillmentReconciled,
  prepareSalesOrderAutoFulfillmentCandidate,
  reconcileSalesOrderAutoFulfillmentAttention,
  renewSalesOrderAutoFulfillmentCandidateLease,
  startSalesOrderAutoFulfillmentAttempt
} from "./sales-order-auto-fulfillment-repository.js";
import { createSalesOrderAutoFulfillmentProcessor } from "./sales-order-auto-fulfillment-service.js";
import { createDeliveryAttentionReconciler, throttled } from "./netsuite-attention-reconciliation.js";

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

// Attention items NetSuite already shows fulfilled (or closed) are cleared; nothing is posted.
const reconcileDeliveryAttention = throttled(() => createDeliveryAttentionReconciler({
  listAttention: () => listSalesOrderAutoFulfillmentAttentionCandidates({ limit: 50 }),
  fetchLiveOrder: fetchLiveSalesOrderAutoFulfillmentState,
  resolve: reconcileSalesOrderAutoFulfillmentAttention
}).run({ log: (error, candidateId) => console.error(`Dispatch SO fulfillment attention reconciliation for ${candidateId} failed:`,
  error instanceof Error ? error.message : String(error)) }));

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
  void reconcileDeliveryAttention().catch((error) => console.error("Dispatch SO fulfillment attention reconciliation failed:",
    error instanceof Error ? error.message : String(error)));
  await directPoAutoReceiptTick();
  await transferPostingTick({enqueue:(/** @type {string} */ id)=>operatorNetSuitePostingRuntime.enqueue(id)});
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
