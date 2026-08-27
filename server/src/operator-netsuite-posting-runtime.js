// @ts-check

import {
  claimOperatorNetSuitePostingCommand,
  completeOperatorNetSuitePostingCommand,
  failOperatorNetSuitePostingCommand,
  getOperatorNetSuitePostingCommand,
  listRunnableOperatorNetSuitePostingCommandIds,
  markOperatorNetSuitePostingCommandAttention,
  recordOperatorNetSuitePostingStepFailure,
  recordOperatorNetSuitePostingStepSuccess,
  renewOperatorNetSuitePostingLease,
  startOperatorNetSuitePostingAttempt
} from "./operator-netsuite-posting-repository.js";
import { operatorNetSuitePostingAdapter } from "./operator-netsuite-posting-netsuite-adapter.js";
import { finalizeOperatorNetSuitePosting } from "./operator-netsuite-posting-finalizer.js";
import { createOperatorNetSuitePostingProcessor } from "./operator-netsuite-posting-service.js";

/**
 * @param {object} dependencies
 * @param {(commandId: string) => Promise<unknown>} dependencies.process
 * @param {() => Promise<string[]>} dependencies.listRunnable
 * @param {(error: Error, commandId: string) => void} dependencies.logError
 */
export function createOperatorNetSuitePostingRuntime({ process: processCommand, listRunnable, logError }) {
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
  success: recordOperatorNetSuitePostingStepSuccess,
  failure: recordOperatorNetSuitePostingStepFailure,
  attention: markOperatorNetSuitePostingCommandAttention,
  fail: failOperatorNetSuitePostingCommand,
  complete: completeOperatorNetSuitePostingCommand
};

const processor = createOperatorNetSuitePostingProcessor({
  repository,
  adapter: operatorNetSuitePostingAdapter,
  finalize: finalizeOperatorNetSuitePosting,
  workerId: `operator-netsuite-${process.pid}`
});

export const operatorNetSuitePostingRuntime = createOperatorNetSuitePostingRuntime({
  process: processor.process,
  listRunnable: () => listRunnableOperatorNetSuitePostingCommandIds({ limit: 25 }),
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
