// @ts-check
// Reconciliation clears Admin attention when NetSuite shows the work is already done, for
// example a fulfillment entered by hand after an app posting got stuck. It never posts:
//  * An Operator posting is re-queued for verification only when every unposted step either
//    exists in NetSuite under its external ID, or (SO:IF) is fully fulfilled by a transaction
//    posted against the order after the request. The processor re-checks under its lease and
//    then completes the posting and its local finalization with the operator's saved evidence.
//  * A Delivery SO fulfillment candidate is marked reconciled (or closed) when NetSuite shows the
//    order fulfilled (or closed), or its delivered lines already fulfilled.
import { compareSalesOrderFulfillmentSnapshot } from "./sales-order-auto-fulfillment-domain.js";

/** Minutes between reconciliation sweeps, and before the same posting is re-queued again. */
export const ATTENTION_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
export const ATTENTION_REQUEUE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** @param {unknown} status */
function statusCode(status) {
  return String(status || "").trim().toUpperCase().split(":").at(-1) || "";
}

/** @param {Record<string, any>} step */
export function postingOrderLines(step) {
  return [...new Set((step?.payload?.item?.items || [])
    .filter((/** @type {any} */ item) => item?.itemReceive === true && Number(item.quantity) > 0)
    .map((/** @type {any} */ item) => Number(item.orderLine))
    .filter((/** @type {number} */ line) => Number.isSafeInteger(line) && line > 0))];
}

/**
 * Is an SO:IF posting step fully covered by NetSuite's current fulfillment of its order?
 * A fully billed/pending-billing order covers every line; a closed or cancelled order, or a
 * closed line, never does (a person decides those).
 * @param {Record<string, any>} step
 * @param {any} liveOrder fetchSalesOrderFulfillmentStateFromNetSuite(id, { includeAllSourceLines: true })
 */
export function sourceCompletionForStep(step, liveOrder) {
  if (step?.sourceOrderKind !== "SO" || step?.transactionType !== "IF") {
    return { complete: false, reason: "unsupported_source", lines: [] };
  }
  if (!liveOrder || typeof liveOrder !== "object") {return { complete: false, reason: "source_unreadable", lines: [] };}
  const status = statusCode(liveOrder.status);
  if (liveOrder.fulfillmentComplete === true) {
    const fulfilled = ["F", "G"].includes(status);
    return { complete: fulfilled, reason: fulfilled ? "order_fulfilled" : "order_closed", status, lines: [] };
  }
  const wanted = postingOrderLines(step);
  if (!wanted.length) {return { complete: false, reason: "no_posting_lines", status, lines: [] };}
  const lines = wanted.map((orderLine) => {
    const live = (Array.isArray(liveOrder.lines) ? liveOrder.lines : []).find((/** @type {any} */ line) => Number(line.orderLine) === orderLine);
    return { orderLine, quantity: live ? Number(live.quantity) : null, fulfilledQuantity: live ? Number(live.fulfilledQuantity) : null,
      remainingQuantity: live ? Number(live.remainingQuantity) : null, lineClosed: live?.lineClosed === true };
  });
  const complete = lines.every((line) => line.remainingQuantity === 0 && !line.lineClosed && Number(line.fulfilledQuantity) > 0);
  return { complete, reason: complete ? "posting_lines_fulfilled" : "quantity_remaining", status, lines };
}

/**
 * Reconcile-only outcome for a Delivery SO candidate in attention: "reconciled", "closed" or null.
 * @param {Record<string, any>} candidate @param {any} liveOrder fetchLiveSalesOrderAutoFulfillmentState
 */
export function deliveryAttentionOutcome(candidate, liveOrder) {
  if (!liveOrder || typeof liveOrder !== "object" || liveOrder.missing === true) {return null;}
  if (liveOrder.closed === true) {return "closed";}
  if (liveOrder.fulfillmentComplete === true) {return "reconciled";}
  const snapshot = Array.isArray(candidate?.lineSnapshot) ? candidate.lineSnapshot : [];
  if (!snapshot.length) {return null;}
  try {
    return compareSalesOrderFulfillmentSnapshot({ snapshotLines: snapshot, liveOrder }).state === "reconciled" ? "reconciled" : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} dependencies
 * @param {() => Promise<Record<string, any>[]>} dependencies.listAttention hydrated attention commands
 * @param {(commandId: string) => Promise<number|null>} dependencies.baselineFor
 * @param {(step: Record<string, any>, direct: boolean) => Promise<any>} dependencies.findByExternalId
 * @param {(step: Record<string, any>, baseline: number) => Promise<any[]>} dependencies.linkedTransactionsAfter
 * @param {(step: Record<string, any>) => Promise<any>} dependencies.sourceFulfillment
 * @param {(commandId: string, evidence: Record<string, any>) => Promise<unknown>} dependencies.requeue
 * @param {() => number} [dependencies.now]
 */
export function createOperatorAttentionReconciler({ listAttention, baselineFor, findByExternalId, linkedTransactionsAfter,
  sourceFulfillment, requeue, now = Date.now }) {
  /** @type {Map<string, number>} */
  const requeuedAt = new Map();

  /** @param {Record<string, any>} command @param {Record<string, any>} step @param {number|null} baseline */
  async function stepEvidence(command, step, baseline) {
    const direct = command.inputSnapshot?.postingStrategy === "stored_order_line_v1";
    const found = await findByExternalId(step, direct);
    if (found) {return { stepId: step.id, via: "external_id", transactionId: Number(found.id) || null };}
    if (!baseline || step.sourceOrderKind !== "SO" || step.transactionType !== "IF") {return null;}
    const later = await linkedTransactionsAfter(step, baseline);
    if (!Array.isArray(later) || !later.length) {return null;}
    const completion = sourceCompletionForStep(step, await sourceFulfillment(step));
    return completion.complete ? { stepId: step.id, via: "source_fulfilled", transactions: later, reason: completion.reason } : null;
  }

  /** @param {Record<string, any>} command */
  async function reconcileCommand(command) {
    const unposted = (command.steps || []).filter((/** @type {any} */ step) => step.status !== "posted");
    if (!unposted.length || command.nextAutoRetryAt || now() - (requeuedAt.get(command.id) ?? -Infinity) < ATTENTION_REQUEUE_COOLDOWN_MS) {
      return null;
    }
    const baseline = await baselineFor(command.id);
    const steps = [];
    for (const step of unposted) {
      const evidence = await stepEvidence(command, step, baseline);
      if (!evidence) {return null;}
      steps.push(evidence);
    }
    requeuedAt.set(command.id, now());
    await requeue(command.id, { reason: "netsuite_reconciliation", baselineTransactionId: baseline, steps });
    return { commandId: command.id, steps };
  }

  return {
    /** @param {{ log?: (error: unknown, commandId: string) => void }} [options] */
    async run({ log = () => {} } = {}) {
      const results = [];
      for (const command of await listAttention()) {
        try {
          const result = await reconcileCommand(command);
          if (result) {results.push(result);}
        } catch (error) {
          log(error, command.id);
        }
      }
      return results;
    }
  };
}

/**
 * @param {object} dependencies
 * @param {() => Promise<Record<string, any>[]>} dependencies.listAttention candidates in attention
 * @param {(candidate: Record<string, any>) => Promise<any>} dependencies.fetchLiveOrder
 * @param {(input: { candidateId: string, outcome: string, liveOrder: any }) => Promise<unknown>} dependencies.resolve
 */
export function createDeliveryAttentionReconciler({ listAttention, fetchLiveOrder, resolve }) {
  return {
    /** @param {{ log?: (error: unknown, candidateId: string) => void }} [options] */
    async run({ log = () => {} } = {}) {
      const results = [];
      for (const candidate of await listAttention()) {
        try {
          const liveOrder = await fetchLiveOrder(candidate);
          const outcome = deliveryAttentionOutcome(candidate, liveOrder);
          if (!outcome) {continue;}
          await resolve({ candidateId: candidate.id, outcome, liveOrder });
          results.push({ candidateId: candidate.id, outcome });
        } catch (error) {
          log(error, candidate.id);
        }
      }
      return results;
    }
  };
}

/** Run work at most once per interval; overlapping calls share the running sweep. */
export function throttled(/** @type {() => Promise<unknown>} */ work, intervalMs = ATTENTION_RECONCILE_INTERVAL_MS, now = Date.now) {
  let last = -Infinity;
  /** @type {Promise<unknown>|null} */ let running = null;
  return () => {
    if (running) {return running;}
    if (now() - last < intervalMs) {return Promise.resolve(null);}
    last = now();
    running = work().finally(() => { running = null; });
    return running;
  };
}
