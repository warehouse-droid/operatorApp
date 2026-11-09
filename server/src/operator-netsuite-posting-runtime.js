// @ts-check

import {
  claimOperatorNetSuitePostingCommand,
  completeOperatorNetSuitePostingCommand,
  failOperatorNetSuitePostingCommand,
  getOperatorNetSuitePostingCommand,
  listOperatorNetSuitePostingAttentionCommands,
  listRunnableOperatorNetSuitePostingCommandIds,
  markOperatorNetSuitePostingAttemptRemote,
  markOperatorNetSuitePostingCommandAttention,
  operatorNetSuitePostingBaselineTransactionId,
  recordOperatorNetSuitePostingStepFailure,
  recordOperatorNetSuitePostingStepSuccess,
  renewOperatorNetSuitePostingLease,
  resumeDueOperatorNetSuitePostingAutoRetries,
  resumeOperatorNetSuitePostingCommand,
  scheduleOperatorNetSuitePostingAutoRetry,
  startOperatorNetSuitePostingAttempt
} from "./operator-netsuite-posting-repository.js";
import { withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { POSTING_AUTO_RETRY_LIMIT } from "./posting-auto-retry-policy.js";
import { operatorNetSuitePostingAdapter } from "./operator-netsuite-posting-netsuite-adapter.js";
import { finalizeOperatorNetSuitePosting, lockOperatorNetSuitePostingFinalization } from "./operator-netsuite-posting-finalizer.js";
import { createOperatorNetSuitePostingProcessor } from "./operator-netsuite-posting-service.js";
import { createOperatorAttentionReconciler, throttled } from "./netsuite-attention-reconciliation.js";

/**
 * @param {object} dependencies
 * @param {(commandId: string) => Promise<unknown>} dependencies.process
 * @param {() => Promise<string[]>} dependencies.listRunnable
 * @param {(error: Error, commandId: string) => void} dependencies.logError
 * @param {() => Promise<unknown>} [dependencies.resumeDueAutoRetries]
 * @param {() => Promise<unknown>} [dependencies.reconcileAttention] throttled; runs in the background
 */
export function createOperatorNetSuitePostingRuntime({ process: processCommand, listRunnable, logError, resumeDueAutoRetries,
  reconcileAttention }) {
  const inFlight = new Map();

  function enqueue(/** @type {unknown} */ value) {
    const commandId = String(value || "").trim();
    if (!commandId) {return Promise.resolve(null);}
    if (inFlight.has(commandId)) {return inFlight.get(commandId);}
    const work = Promise.resolve()
      .then(() => processCommand(commandId))
      .catch((error) => {
        logError(error, commandId);
        return null;
      })
      .finally(() => {
        if (inFlight.get(commandId) === work) {inFlight.delete(commandId);}
      });
    inFlight.set(commandId, work);
    return work;
  }

  async function tick() {
    if (resumeDueAutoRetries) {
      try {await resumeDueAutoRetries();} catch (error) {logError(/** @type {Error} */ (error), "automatic-retry");}
    }
    if (reconcileAttention) {
      // Never delays posting; a re-queued command is picked up by a later tick.
      void Promise.resolve().then(reconcileAttention)
        .catch((error) => logError(/** @type {Error} */ (error), "attention-reconciliation"));
    }
    const commandIds = await listRunnable();
    await Promise.all(commandIds.map((commandId) => enqueue(commandId)));
    return { discovered: commandIds.length };
  }

  return { enqueue, tick };
}

const repository = {
  get: getOperatorNetSuitePostingCommand,
  claim: claimOperatorNetSuitePostingCommand,
  renew: renewOperatorNetSuitePostingLease,
  startAttempt: startOperatorNetSuitePostingAttempt,
  markAttemptRemote: markOperatorNetSuitePostingAttemptRemote,
  success: recordOperatorNetSuitePostingStepSuccess,
  failure: recordOperatorNetSuitePostingStepFailure,
  attention: markOperatorNetSuitePostingCommandAttention,
  fail: failOperatorNetSuitePostingCommand,
  complete: completeOperatorNetSuitePostingCommand,
  scheduleAutoRetry: scheduleOperatorNetSuitePostingAutoRetry
};

/** Requeue due automatic retries and audit each one in the same transaction. */
async function resumeDueAutoRetriesWithAudit() {
  return withTransaction(async () => {
    const resumed = await resumeDueOperatorNetSuitePostingAutoRetries({ limit: 10 });
    for (const retry of resumed) {
      await writeAudit({
        actorType: "system",
        source: "admin",
        action: "operator_netsuite_posting.command.auto_resumed",
        details: { commandId: retry.commandId, autoRetry: retry.autoRetryCount, limit: POSTING_AUTO_RETRY_LIMIT,
          reason: "timeout_or_lost_connection", previousError: retry.previousError }
      });
    }
    return resumed;
  });
}

/**
 * NetSuite shows this attention posting complete: re-queue it for verification (no re-post
 * authorization). The processor re-checks under its lease, then completes and finalizes it.
 * @param {string} commandId @param {Record<string, any>} evidence
 */
export async function requeueReconciledAttention(commandId, evidence) {
  return withTransaction(async () => {
    const resumed = await resumeOperatorNetSuitePostingCommand(commandId);
    await writeAudit({ actorType: "system", source: "admin", action: "operator_netsuite_posting.command.reconcile_resumed",
      details: { commandId, ...evidence } });
    return resumed;
  });
}

const attentionReconciler = createOperatorAttentionReconciler({
  listAttention: () => listOperatorNetSuitePostingAttentionCommands({ limit: 50 }),
  baselineFor: operatorNetSuitePostingBaselineTransactionId,
  findByExternalId: (step, direct) => operatorNetSuitePostingAdapter.findByExternalId(step, direct),
  linkedTransactionsAfter: (step, baseline) => operatorNetSuitePostingAdapter.linkedTransactionsAfter(step, baseline),
  sourceFulfillment: (step) => operatorNetSuitePostingAdapter.sourceFulfillment(step),
  requeue: requeueReconciledAttention
});

const processor = createOperatorNetSuitePostingProcessor({
  repository,
  adapter: operatorNetSuitePostingAdapter,
  finalize: finalizeOperatorNetSuitePosting,
  lockFinalization: lockOperatorNetSuitePostingFinalization,
  workerId: `operator-netsuite-${process.pid}`
});

export const operatorNetSuitePostingRuntime = createOperatorNetSuitePostingRuntime({
  process: processor.process,
  listRunnable: () => listRunnableOperatorNetSuitePostingCommandIds({ limit: 25 }),
  resumeDueAutoRetries: resumeDueAutoRetriesWithAudit,
  reconcileAttention: throttled(() => attentionReconciler.run({
    log: (error, commandId) => console.error(`Operator NetSuite attention reconciliation for ${commandId} failed:`,
      error instanceof Error ? error.message : String(error))
  })),
  logError: (error, commandId) => {
    console.error(`Operator NetSuite posting command ${commandId} worker failed:`, error.message);
  }
});

let runtimeStarted = false;

export function startOperatorNetSuitePostingRuntime() {
  if (runtimeStarted) {return;}
  runtimeStarted = true;
  void operatorNetSuitePostingRuntime.tick();
  setInterval(() => void operatorNetSuitePostingRuntime.tick(), 10000);
}
