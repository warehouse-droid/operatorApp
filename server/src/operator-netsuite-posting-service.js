// @ts-check
import { operatorPostingTelemetry as telemetry } from "./operator-netsuite-posting-telemetry.js";

/** @param {unknown} error */
function failureDetails(error) {
  if (!error || typeof error !== "object") {return /** @type {Record<string, any>} */ ({});}
  return /** @type {Record<string, any>} */ (error);
}

/** @param {unknown} error */
export function isAmbiguousOperatorNetSuiteFailure(error) {
  const value = failureDetails(error);
  const status = Number(value.status);
  const code = String(value.code).toUpperCase();
  if (value.ambiguous === true || code === "OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH") {return true;}
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
    transactions: (command.steps || []).map((/** @type {Record<string, any>} */ step) => ({
      stepIndex: step.stepIndex,
      transactionType: step.transactionType,
      sourceOrderKind: step.sourceOrderKind,
      sourceNetSuiteId: step.sourceNetSuiteId,
      sourceOrderRef: step.sourceOrderRef,
      externalId: step.externalId,
      transactionId: step.netSuiteTransactionId,
      transactionRef: step.netSuiteTransactionRef
    }))
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
    externalId: String(record.externalId ?? record.externalid ?? "")
  };
}

/**
 * @param {object} dependencies
 * @param {{get: Function, claim: Function, renew: Function, startAttempt: Function, success: Function, failure: Function, attention: Function, fail: Function, complete: Function}} dependencies.repository
 * @param {{findByExternalId: Function, verify: Function, transform: Function, fetchById: Function}} dependencies.adapter
 * @param {(command: Record<string, any>) => Promise<unknown>} dependencies.finalize
 * @param {string} dependencies.workerId
 */
export function createOperatorNetSuitePostingProcessor({ repository, adapter, finalize, workerId }) {
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

  async function verifiedExternalRecord(/** @type {Record<string, any>} */ step, stage = "duplicate_check") {
    const record = await telemetry.context({ stage }, () => telemetry.time({ operation: `posting.${stage}` }, () => adapter.findByExternalId(step)));
    if (!record) {return null;}
    const verified = adapter.verify(step, record);
    return { record, verified };
  }

  // The branches mirror one remote transform/recovery state machine; splitting
  // them would obscure the no-second-transform invariant.
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
    try {
      const existing = await verifiedExternalRecord(step);
      if (existing) {
        ({ record, verified } = existing);
        recovered = true;
      } else {
        const transformed = await telemetry.context({ stage: "transform" }, () => telemetry.time({ operation: "posting.transform" }, () => adapter.transform(step)));
        const transactionId = Number(transformed?.id);
        if (Number.isSafeInteger(transactionId) && transactionId > 0) {
          record = await telemetry.context({ stage: "verification" }, () => telemetry.time({ operation: "posting.verification" }, () => adapter.fetchById(step, transactionId)));
          if (!record) {
            throw Object.assign(new Error("NetSuite transform succeeded but the created record could not be read."), {
              code: "OPERATOR_NETSUITE_POSTING_RESULT_UNVERIFIED",
              ambiguous: true
            });
          }
          verified = adapter.verify(step, record);
        } else {
          const afterTransform = await verifiedExternalRecord(step, "recovery");
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
      const ambiguous = isAmbiguousOperatorNetSuiteFailure(error);
      if (ambiguous) {
        try {
          const recovery = await verifiedExternalRecord(step, "recovery");
          if (recovery) {
            ({ record, verified } = recovery);
            recovered = true;
          }
        } catch (recoveryError) {
          error = recoveryError;
        }
      }
      if (!record || !verified) {
        const updated = await repository.failure({
          commandId: command.id,
          stepId: step.id,
          leaseToken: command.leaseToken,
          attemptNumber: attempt.attemptNumber,
          error,
          uncertain: isAmbiguousOperatorNetSuiteFailure(error)
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
      response: safeRemoteEvidence(record),
      recovered
    });
    replaceStep(command, updated);
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
    for (const step of command.steps || []) {
      if (step.status === "posted") {continue;}
      try {
        await telemetry.context({ commandId: command.id, functionKey: command.functionKey,
          transactionType: step.transactionType, sourceOrderKind: step.sourceOrderKind,
          sourceNetSuiteId: step.sourceNetSuiteId, stepIndex: step.stepIndex, stage: "posting" },
        () => telemetry.time({ operation: "posting.step" }, () => withLeaseHeartbeat(command, () => postStep(command, step))));
      } catch (error) {
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
        return command;
      }
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
        finalize: () => telemetry.context({ commandId: command.id, transactionType: command.transactionType,
          functionKey: command.functionKey, stage: "finalization" }, () => telemetry.time({ operation: "posting.finalization" }, () => finalize(command)))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return repository.attention({
        commandId: command.id,
        leaseToken: command.leaseToken,
        error: Object.assign(new Error(`NetSuite posted, but local finalization needs attention: ${message}`), {
          cause: error
        })
      });
    }
  }

  return { process };
}
