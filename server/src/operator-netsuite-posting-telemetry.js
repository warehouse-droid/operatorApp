// @ts-check
import { AsyncLocalStorage } from "node:async_hooks";

const fields = ["commandId", "transactionType", "functionKey", "sourceOrderKind", "sourceNetSuiteId", "stepIndex", "stage", "operation", "method", "attempt", "photoId", "queue"];

/** @param {Record<string, any>} value */
function safeFields(value) {
  const result = /** @type {Record<string, any>} */ ({});
  for (const key of fields) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) {result[key] = item;}
    else if (typeof item === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(item)) {result[key] = item;}
  }
  if (typeof value.path === "string") {result.path = new URL(value.path, "https://netsuite.invalid").pathname;}
  return result;
}

/** @param {any} value @param {any} error */
function outcomeFields(value, error) {
  const status = Number(error?.status ?? value?.response?.status ?? value?.status);
  return { outcome: error || status >= 400 ? "error" : "ok",
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
}
/** @param {any} error */
function errorFields(error) {
  if (!error) {return {};}
  const errorCode = String(error.code || "REQUEST_FAILED");
  return { errorCode: /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : "REQUEST_FAILED" };
}

/** @param {{now?: () => number, log?: (entry: Record<string, any>) => void}} [options] */
export function createOperatorPostingTelemetry({ now = () => performance.now(), log = (entry) => console.info(JSON.stringify(entry)) } = {}) {
  const storage = new AsyncLocalStorage();
  /** @template T @param {Record<string, any>} details @param {() => T} work @returns {T} */
  function context(details, work) {
    return storage.run({ ...storage.getStore(), ...safeFields(details) }, work);
  }
  /** @param {Record<string, any>} details @param {number} started @param {unknown} [value] @param {unknown} [error] */
  function emit(details, started, value, error) {
    const current = storage.getStore();
    if (!current?.commandId) {return;}
    try {
      log({ event: "operator_posting_timing", at: new Date().toISOString(), ...current, ...safeFields(details),
        durationMs: Math.max(0, Math.round((now() - started) * 100) / 100),
        ...outcomeFields(value, error), ...errorFields(error) });
    } catch { /* Diagnostics must never change the result of posting. */ }
  }
  /** @template T @param {Record<string, any>} details @param {() => Promise<T>} work @returns {Promise<T>} */
  async function time(details, work) {
    const started = now();
    let value;
    try {
      value = await work();
    } catch (error) {
      emit(details, started, undefined, error);
      throw error;
    }
    emit(details, started, value);
    return value;
  }
  /** @template T @param {string} name @param {Promise<unknown>} queue @param {() => Promise<T>} work @returns {Promise<T>} */
  function queued(name, queue, work) {
    const started = now();
    const run = () => { emit({ operation: "netsuite.queue", queue: name }, started); return work(); };
    return queue.then(run, run);
  }
  return { context, time, queued };
}

export const operatorPostingTelemetry = createOperatorPostingTelemetry();
