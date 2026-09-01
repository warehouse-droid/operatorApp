import crypto from "node:crypto";

import { closeDb, withTransaction } from "./db.js";
import { enqueueDispatchOrderCatalogRefresh } from "./dispatch-order-catalog-repository.js";
import {
  claimNetSuiteOrderWebhook,
  completeNetSuiteOrderWebhook,
  failNetSuiteOrderWebhook,
  renewNetSuiteOrderWebhookLease
} from "./netsuite-order-webhook-queue-repository.js";
import { createNetSuiteOrderWebhookWorker } from "./netsuite-order-webhook-worker-service.js";
import { enqueueScmPurchaseOrderCatalogRefresh } from "./scm-purchase-order-catalog-repository.js";
import { processScmNetSuitePoHistoryWebhook } from "./scm-netsuite-po-history-service.js";
import { processNetSuiteOrderWebhook } from "./server.js";

const workerId = `netsuite-order-webhook:${process.pid}:${crypto.randomUUID()}`;
const leaseMs = 120_000;
const pollMs = Math.min(Math.max(Number(process.env.NETSUITE_ORDER_WEBHOOK_WORKER_POLL_MS) || 1_000, 250), 10_000);
let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processWebhook(job) {
  return withTransaction(async () => {
    const order = await processNetSuiteOrderWebhook(job.payload, { emitEvents: false });
    const poHistory = await processScmNetSuitePoHistoryWebhook(job.payload);
    const result = {
      ok: order?.ok === true,
      orderId: String(order?.orderId || job.netsuiteOrderId || ""),
      recordType: job.recordType,
      eventType: job.eventType,
      appCreatedPoHistoryMatched: poHistory.matched === true,
      poHistoryEvent: String(poHistory.event?.name || "")
    };
    const orderType = job.recordType === "sales_order" ? "SO"
      : job.recordType === "purchase_order" ? "PO"
        : job.recordType === "transfer_order" ? "TO" : "";
    const orderRef = String(job.payload?.tranid || "").trim();
    await enqueueDispatchOrderCatalogRefresh({
      orderRef,
      orderType,
      source: "netsuite-webhook-worker"
    });
    if (job.recordType === "purchase_order") {
      await enqueueScmPurchaseOrderCatalogRefresh({
        orderRef,
        source: "netsuite-webhook-worker"
      });
    }
    await completeNetSuiteOrderWebhook({
      id: job.id,
      leaseToken: job.leaseToken,
      result
    });
    return result;
  });
}

const worker = createNetSuiteOrderWebhookWorker({
  claim: () => claimNetSuiteOrderWebhook({ workerId, leaseMs }),
  process: processWebhook,
  complete: completeNetSuiteOrderWebhook,
  fail: failNetSuiteOrderWebhook,
  renew: (input) => renewNetSuiteOrderWebhookLease({ ...input, leaseMs }),
  heartbeatMs: Math.floor(leaseMs / 3),
  completeInProcess: true,
  logger: console
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    stopping = true;
  });
}

async function main() {
  if (String(process.env.NETSUITE_ORDER_WEBHOOK_WORKER_CONCURRENCY || "1") !== "1") {
    console.warn("NETSUITE_ORDER_WEBHOOK_WORKER_CONCURRENCY is forced to 1.");
  }
  console.log(`NetSuite order webhook serial worker ${workerId} started.`);
  while (!stopping) {
    const result = await worker.tick();
    if (!result.processed) await sleep(pollMs);
  }
  await closeDb();
  console.log("NetSuite order webhook serial worker stopped.");
}

await main();
