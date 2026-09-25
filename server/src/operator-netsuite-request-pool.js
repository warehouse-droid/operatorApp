// @ts-check
import { AsyncLocalStorage } from "node:async_hooks";
import { operatorPostingTelemetry as telemetry } from "./operator-netsuite-posting-telemetry.js";

const requestContext = new AsyncLocalStorage();
export function isOperatorNetSuiteRequest() {return requestContext.getStore() === true;}

/** @template T @param {() => T} work @returns {T} */
export function withOperatorNetSuitePriority(work) { return requestContext.run(true, work); }
/** @template T @param {() => T} work @returns {T} */
export function withBackgroundNetSuitePriority(work) { return requestContext.run(false, work); }

/** @param {number} [limit] */
export function createOperatorNetSuiteRequestPool(limit = 3) {
  if (!Number.isSafeInteger(limit) || limit < 1) {throw new RangeError("A positive request limit is required.");}
  let active = 0;
  /** @type {(() => void)[]} */ const waiting = [];
  /** @returns {Promise<void>} */
  function acquire() {
    if (active < limit) {active++; return Promise.resolve();}
    return new Promise(resolve => { waiting.push(resolve); });
  }
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  function run(work) {
    return telemetry.queued("operator", acquire(), async () => {
      try {return await requestContext.run(true, work);}
      finally {
        const next = waiting.shift();
        if (next) {next();} else {active--;}
      }
    });
  }
  return { run };
}

export const operatorNetSuiteRequestPool = createOperatorNetSuiteRequestPool(3);
