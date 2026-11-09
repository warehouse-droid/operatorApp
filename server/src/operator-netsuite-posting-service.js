import { fulfillmentTransactions } from "./item-fulfillment-parts-domain.js";
// @ts-check
import { pickupExistingFulfillmentTransactions } from './operator-pickup-existing-if-domain.js';
import { operatorPostingTelemetry as telemetry } from "./operator-netsuite-posting-telemetry.js";
import { operatorStepHasKits } from './operator-netsuite-posting-kits.js';
import { POSTING_AUTO_RETRY_DELAYS_MINUTES, isPostingTimeoutOrConnectionFailure } from './posting-auto-retry-policy.js';
import { sourceCompletionForStep } from './netsuite-attention-reconciliation.js';

/** An Admin re-post waits this long after anything was last sent to NetSuite, so
 * a slow earlier request has finished (RESTlets stop after 5 minutes). */
export const ADMIN_REPOST_QUIET_SECONDS = 10 * 60;

/** @param {string} message */
function refusedRepost(message) {
  return Object.assign(new Error(message), { code: "OPERATOR_NETSUITE_POSTING_RESULT_UNVERIFIED", ambiguous: true });
}

/**
 * The synchronous Admin re-post conditions: a current authorization, the quiet
 * period, and a baseline to compare the source order against.
 * @param {any} repost evidence from startAttempt @param {boolean} ready the boundary supports a re-post
 * @returns {number} the baseline transaction ID
 */
export function assertAdminRepostReady(repost, ready) {
  if (repost?.authorized !== true || !ready) {
    throw refusedRepost("The previous NetSuite attempt is not yet verified. Recovery must finish before another posting.");
  }
  const since = repost.secondsSinceRemoteAttempt;
  if (since !== null && !(Number(since) >= ADMIN_REPOST_QUIET_SECONDS)) {
    const minutes = Math.max(1, Math.ceil((ADMIN_REPOST_QUIET_SECONDS - Math.max(0, Number(since) || 0)) / 60));
    throw refusedRepost(`NetSuite has no record of the earlier attempt yet. Resume verification again in ${minutes} minute${minutes === 1 ? "" : "s"} to post the saved evidence.`);
  }
  const baseline = Number(repost.baselineTransactionId);
  if (!Number.isSafeInteger(baseline) || baseline <= 0) {
    throw refusedRepost("There is no earlier posting to compare this order against, so it cannot be posted again automatically.");
  }
  return baseline;
}

/** @param {unknown} error */
function failureDetails(error) {
  if (!error || typeof error !== "object") {return /** @type {Record<string, any>} */ ({});}
  return /** @type {Record<string, any>} */ (error);
}

/** @param {unknown} error */
function uncertainPostingError(error) {
  const details = failureDetails(error);
  return Object.assign(new Error(details.message || "NetSuite posting needs verification before this order can be released."),
    details, { ambiguous: true });
}

/** @param {unknown} error */
export function isAmbiguousOperatorNetSuiteFailure(error) {
  const value = failureDetails(error);
  const status = Number(value.status);
  const code = String(value.code).toUpperCase();
  if (value.ambiguous === true || code === "OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH") {return true;}
  if (value.postingNotAttempted === true) {return false;}
  if (["NETSUITE_REQUEST_TIMEOUT", "ABORT_ERR", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) {return true;}
  if (status === 408 || status === 429 || status >= 500) {return true;}
  if (status >= 400 && status < 500 && value.netsuiteResponseReceived === true) {return false;}
  return true;
}

/** @param {Record<string, any>} command */
function completionResult(command) {
  return {
    ok: true,
    commandId: command.id,
    transactions: [...(command.steps || []).flatMap(fulfillmentTransactions), ...pickupExistingFulfillmentTransactions(command)]
  };
}

/** @param {Record<string, any>} command @param {Record<string, any>} updatedStep */
function replaceStep(command, updatedStep) {
  command.steps = (command.steps || []).map((/** @type {Record<string, any>} */ step) => (
    Number(step.id) === Number(updatedStep.id) ? updatedStep : step
  ));
}

/** @param {Record<string, any>} record */
function safeRemoteEvidence(record) {
  return {
    id: Number(record.id),
    tranId: String(record.tranId ?? record.tranid ?? record.id),
    externalId: String(record.externalId ?? record.externalid ?? ""),
    ...(record.fulfillmentParts ? { fulfillmentParts: record.fulfillmentParts } : {})
  };
}

/**
 * @param {object} dependencies
 * @param {{get: Function, claim: Function, renew: Function, startAttempt: Function, success: Function, failure: Function, attention: Function, fail: Function, complete: Function, markAttemptRemote?: Function, scheduleAutoRetry?: Function}} dependencies.repository
 * @param {{findByExternalId: Function, verify: Function, transform: Function, fetchById: Function, hasSplitPlan?: Function, linkedTransactionsAfter?: Function}} dependencies.adapter
 * @param {(command: Record<string, any>) => Promise<unknown>} dependencies.finalize
 * @param {string} dependencies.workerId
 * @param {(command: Record<string, any>) => Promise<unknown>} [dependencies.lockFinalization]
 *   Takes the local order lock(s) at the start of the completion transaction,
 *   before the command row is locked (the same order admission uses).
 */
export function createOperatorNetSuitePostingProcessor({ repository, adapter, finalize, workerId, lockFinalization }) {
  const leaseSeconds = 180;

  /** @param {Record<string, any>} command @param {() => Promise<unknown>} work */
  async function withLeaseHeartbeat(command, work) {
    await repository.renew({
      commandId: command.id,
      leaseToken: command.leaseToken,
      leaseSeconds
    });
    /** @type {Promise<unknown>} */
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal
        .then(() => repository.renew({
          commandId: command.id,
          leaseToken: command.leaseToken,
          leaseSeconds
        }))
        .then(() => undefined)
        .catch(() => undefined);
    }, 30000);
    try {
      return await work();
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }

  /** @param {Record<string, any>} step @param {Record<string, any>} record */
  function verifyObservedRecord(step, record) {
    try { return adapter.verify(step, record); }
    catch (error) {
      // An observed record proves neither the requested quantities nor completion.
      // Retain its reference only when it belongs to this command and source.
      if (error && typeof error === 'object'
          && String(record.externalId ?? record.externalid ?? '') === String(step.externalId)
          && Number(record.createdFromId ?? record.createdfrom ?? record.createdFrom?.id) === Number(step.sourceNetSuiteId)
          && Number.isSafeInteger(Number(record.id)) && Number(record.id) > 0) {
        Object.assign(error, { observedTransaction: safeRemoteEvidence(record) });
      }
      throw error;
    }
  }

  /**
   * Outcome for a direct step whose earlier attempt has no verified result, after the
   * external-ID read proved NetSuite holds no transaction for it.
   *  1. Reconciliation: if an IF/IR was posted against the source order since the request and
   *     NetSuite shows this step's lines fully fulfilled, that transaction completes the step.
   *     If something was posted but quantity remains, a person decides (throws).
   *  2. Admin re-post: with nothing posted since, only a fresh Admin "Resume verification"
   *     (one attempt), after a quiet period, may send the saved payload again.
   * Otherwise it throws and nothing is sent.
   * @param {Record<string, any>} step @param {Record<string, any>} attempt
   * @returns {Promise<{ record?: Record<string, any>, verified?: Record<string, any>, reconciliation?: Record<string, any>,
   *   repostEvidence?: Record<string, any> }>}
   */
  async function unverifiedStepOutcome(step, attempt) {
    const repost = attempt.adminRepost;
    const baseline = Number(repost?.baselineTransactionId);
    /** @type {any[]|null} */ let later = null;
    if (typeof adapter.linkedTransactionsAfter === "function" && Number.isSafeInteger(baseline) && baseline > 0) {
      later = await uncheckedAsUnverified(step, "list the transactions posted against", () => telemetry.context({ stage: "repost_check" },
        () => telemetry.time({ operation: "posting.repost_check" }, () => /** @type {Function} */ (adapter.linkedTransactionsAfter)(step, baseline))));
      if (!Array.isArray(later)) {throw refusedRepost("NetSuite did not list the transactions for this order. Nothing was posted again.");}
      if (later.length) {return reconcileFromSource(step, later, baseline);}
    }
    assertAdminRepostReady(repost, later !== null && typeof repository.markAttemptRemote === "function");
    return { repostEvidence: { adminRepost: { authorizedAt: repost.authorizedAt, secondsSinceRemoteAttempt: repost.secondsSinceRemoteAttempt,
      baselineTransactionId: baseline, laterLinkedTransactions: 0, externalIdAbsent: true } } };
  }

  /**
   * A reconciliation read that fails proves nothing: the step stays "not yet verified" (so
   * automatic verification continues) and nothing is sent.
   * @param {Record<string, any>} step @param {string} action @param {() => Promise<any>} read
   */
  async function uncheckedAsUnverified(step, action, read) {
    try { return await read(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw refusedRepost(`NetSuite could not ${action} ${step.sourceOrderRef || "this order"} (${message}). Nothing was posted again.`);
    }
  }

  /**
   * @param {Record<string, any>} step @param {any[]} later IF/IR posted against the order since the request
   * @param {number} baseline
   */
  async function reconcileFromSource(step, later, baseline) {
    const order = step.sourceOrderRef || "This order";
    const refs = later.map((/** @type {any} */ item) => item.tranId || item.id).join(", ");
    if (typeof adapter.sourceFulfillment !== "function" || step.sourceOrderKind !== "SO" || step.transactionType !== "IF") {
      throw refusedRepost(`${order} already has ${refs} posted after this request. Check it in NetSuite; nothing was posted again.`);
    }
    const live = await uncheckedAsUnverified(step, "read the fulfillment of", () => telemetry.context({ stage: "reconciliation" },
      () => telemetry.time({ operation: "posting.reconciliation" }, () => /** @type {Function} */ (adapter.sourceFulfillment)(step))));
    const completion = sourceCompletionForStep(step, live);
    if (!completion.complete) {
      throw refusedRepost(`${order} already has ${refs} posted after this request, but NetSuite does not show this posting's quantity as fulfilled. Check it in NetSuite; nothing was posted again.`);
    }
    const latest = later[later.length - 1];
    const id = Number(latest.id);
    if (!Number.isSafeInteger(id) || id <= 0) {throw refusedRepost(`${order}: NetSuite returned an unreadable transaction ID. Nothing was posted again.`);}
    const tranId = String(latest.tranId || id);
    return { record: { id, tranId, externalId: "" }, verified: { id, transactionRef: tranId },
      reconciliation: { reconciledFromSource: true, baselineTransactionId: baseline, transactions: later,
        reason: completion.reason, status: completion.status, lines: completion.lines } };
  }

  async function verifiedExternalRecord(/** @type {Record<string, any>} */ step, stage = "duplicate_check", direct = false) {
    const record = await telemetry.context({ stage }, () => telemetry.time({ operation: `posting.${stage}` }, () => adapter.findByExternalId(step, direct)));
    if (!record) {return null;}
    const verified = verifyObservedRecord(step, record);
    return { record, verified };
  }

  // The branches mirror one remote transform/recovery state machine; splitting
  // them would obscure the no-second-transform invariant. Its one exception is an
  // Admin re-post, allowed only by adminRepostEvidence after NetSuite proves absence.
  // eslint-disable-next-line complexity
  async function postStep(/** @type {Record<string, any>} */ command, /** @type {Record<string, any>} */ step) {
    const attempt = await repository.startAttempt({
      commandId: command.id,
      stepId: step.id,
      leaseToken: command.leaseToken
    });
    let record;
    let verified;
    let recovered = false;
    const direct = command.inputSnapshot?.postingStrategy === "stored_order_line_v1";
    const backgroundRetry = Boolean(command.inputSnapshot?.transferEvidence) && step.status === 'failed';
    const mayTransform = !direct || attempt.fresh === true || backgroundRetry || await adapter.hasSplitPlan?.(step) === true;
    let recoveryAttempted = direct && !mayTransform;
    let remoteMayExist = direct && !mayTransform;
    /** @type {Record<string, any>|undefined} */ let reconciliation;
    /** @type {Record<string, any>} */ let outcome = { repostEvidence: {} };
    try {
      const existing = direct && mayTransform && !backgroundRetry && !operatorStepHasKits(step) ? null
        : await verifiedExternalRecord(step, direct ? "recovery" : "duplicate_check", direct);
      if (existing) {
        ({ record, verified } = existing);
        recovered = true;
      } else {
        // The external-ID read above found nothing. An unverified step is either completed
        // by reconciliation or, only by Admin re-post, sent again with its saved payload.
        if (!mayTransform) {outcome = await unverifiedStepOutcome(step, attempt);}
        if (outcome.record) {
          ({ record, verified, reconciliation } = outcome);
          recovered = true;
        }
      }
      if (!recovered) {
        if (!mayTransform) {recoveryAttempted = false;}
        await repository.markAttemptRemote?.({ commandId: command.id, leaseToken: command.leaseToken,
          stepId: step.id, attemptNumber: attempt.attemptNumber, details: outcome.repostEvidence });
        const transformed = await telemetry.context({ stage: "transform" }, () => telemetry.time({ operation: "posting.transform" }, () => adapter.transform(step)));
        remoteMayExist = true;
        const transactionId = Number(transformed?.id);
        if (Number.isSafeInteger(transactionId) && transactionId > 0) {
          record = transformed.record ?? await telemetry.context({ stage: "verification" }, () => telemetry.time({ operation: "posting.verification" }, () => adapter.fetchById(step, transactionId)));
          if (!record) {
            throw Object.assign(new Error("NetSuite transform succeeded but the created record could not be read."), {
              code: "OPERATOR_NETSUITE_POSTING_RESULT_UNVERIFIED",
              ambiguous: true
            });
          }
          verified = verifyObservedRecord(step, record);
        } else {
          recoveryAttempted = true;
          const afterTransform = await verifiedExternalRecord(step, "recovery", direct);
          if (!afterTransform) {
            throw Object.assign(new Error("NetSuite transform returned no verifiable transaction identity."), {
              code: "OPERATOR_NETSUITE_POSTING_RESULT_UNVERIFIED",
              ambiguous: true
            });
          }
          ({ record, verified } = afterTransform);
          recovered = true;
        }
      }
    } catch (error) {
      const observedTransaction = failureDetails(error).observedTransaction;
      const ambiguous = remoteMayExist || isAmbiguousOperatorNetSuiteFailure(error);
      if (ambiguous && !recoveryAttempted) {
        try {
          const recovery = await verifiedExternalRecord(step, "recovery", direct);
          if (recovery) {
            ({ record, verified } = recovery);
            recovered = true;
          }
        } catch (recoveryError) {
          error = recoveryError;
        }
      }
      if (!record || !verified) {
        if (ambiguous) {error = uncertainPostingError(error);}
        const updated = await repository.failure({
          commandId: command.id,
          stepId: step.id,
          leaseToken: command.leaseToken,
          attemptNumber: attempt.attemptNumber,
          error,
          uncertain: ambiguous,
          observedTransaction: failureDetails(error).observedTransaction || observedTransaction
        });
        replaceStep(command, updated);
        throw error;
      }
    }
    const updated = await repository.success({
      commandId: command.id,
      stepId: step.id,
      leaseToken: command.leaseToken,
      attemptNumber: attempt.attemptNumber,
      transactionId: verified.id,
      transactionRef: verified.transactionRef,
      response: { ...safeRemoteEvidence(record),
        ...(verified.quantityAdjustments?.length ? { quantityAdjustments: verified.quantityAdjustments } : {}),
        ...(verified.additionalPurchaseCharges?.length ? { additionalPurchaseCharges: verified.additionalPurchaseCharges } : {}),
        ...(reconciliation ? { reconciliation } : {}) },
      recovered
    });
    replaceStep(command, updated);
  }

  /**
   * Timeouts and lost connections get an automatic Resume verification. A
   * command already on automatic retry keeps verifying while NetSuite cannot
   * yet confirm the earlier attempt; it never posts a second time.
   * @param {Record<string, any>} command @param {unknown} error @param {unknown} priorAutoRetries
   */
  async function scheduleAutoRetry(command, error, priorAutoRetries) {
    const continuing = Number(priorAutoRetries) > 0
      && failureDetails(error).code === "OPERATOR_NETSUITE_POSTING_RESULT_UNVERIFIED";
    if (!repository.scheduleAutoRetry || command?.status !== "attention"
      || !(continuing || isPostingTimeoutOrConnectionFailure(error))) {return command;}
    try {
      const scheduled = await repository.scheduleAutoRetry({ commandId: command.id, delaysMinutes: POSTING_AUTO_RETRY_DELAYS_MINUTES });
      return scheduled ? { ...command, nextAutoRetryAt: scheduled.nextAutoRetryAt } : command;
    } catch {
      return command; // An unscheduled command stays in Admin attention, as before.
    }
  }

  /** @param {Record<string, any>} command @param {unknown} error */
  function requiresAttention(command, error) {
    return command.inputSnapshot?.localOperation?.kind === "delivery_consolidation_load"
      || command.steps.some((/** @type {Record<string, any>} */ step) => ["posted", "uncertain"].includes(step.status))
      || isAmbiguousOperatorNetSuiteFailure(error);
  }

  async function process(/** @type {string} */ commandId) {
    let command = await repository.claim({
      commandId,
      workerId,
      leaseSeconds
    });
    if (!command) {return repository.get(commandId);}
    const runStep = (/** @type {Record<string, any>} */ step) =>
      telemetry.context({ commandId: command.id, functionKey: command.functionKey,
          actorOperatorId: command.actorOperatorId, orderId: step.sourceNetSuiteId, orderRef: step.sourceOrderRef,
          transactionType: step.transactionType, sourceOrderKind: step.sourceOrderKind,
          sourceNetSuiteId: step.sourceNetSuiteId, stepIndex: step.stepIndex, stage: "posting" },
        () => telemetry.time({ operation: "posting.step" }, () => withLeaseHeartbeat(command, () => postStep(command, step))));
    try {
      const pending = (command.steps || []).filter((/** @type {Record<string, any>} */ step) => step.status !== "posted");
      if (command.inputSnapshot?.postingStrategy === "stored_order_line_v1") {
        let next = 0;
        /** @type {{error: unknown} | undefined} */ let failure;
        await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (!failure && next < pending.length) {
            const step = pending[next++];
            try {await runStep(step);} catch (error) {failure ??= { error };}
          }
        }));
        if (failure) {throw failure.error;}
      } else {
        for (const step of pending) {await runStep(step);}
      }
    } catch (error) {
        const priorAutoRetries = command.autoRetryCount;
        command = requiresAttention(command, error)
          ? await repository.attention({
              commandId: command.id,
              leaseToken: command.leaseToken,
              error
            })
          : await repository.fail({
              commandId: command.id,
              leaseToken: command.leaseToken,
              error
            });
        return scheduleAutoRetry(command, error, priorAutoRetries);
    }
    try {
      await repository.renew({
        commandId: command.id,
        leaseToken: command.leaseToken,
        leaseSeconds
      });
      return await repository.complete({
        commandId: command.id,
        leaseToken: command.leaseToken,
        result: completionResult(command),
        ...(lockFinalization ? { lockLocalOrder: () => lockFinalization(command) } : {}),
        finalize: () => telemetry.context({ commandId: command.id, transactionType: command.transactionType,
          actorOperatorId: command.actorOperatorId, orderId: command.steps?.[0]?.sourceNetSuiteId, orderRef: command.steps?.[0]?.sourceOrderRef,
          functionKey: command.functionKey, stage: "finalization" }, () => telemetry.time({ operation: "posting.finalization" }, () => finalize(command)))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attention = await repository.attention({
        commandId: command.id,
        leaseToken: command.leaseToken,
        error: Object.assign(new Error(`NetSuite posted, but local finalization needs attention: ${message}`), {
          cause: error
        })
      });
      return scheduleAutoRetry(attention, error, command.autoRetryCount);
    }
  }

  return { process };
}
