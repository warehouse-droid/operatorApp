// @ts-check
import { setTimeout as sleep } from 'node:timers/promises';
import { netSuiteRequestQueueStore, netSuiteQueueError } from './netsuite-request-queue-store.js';
import { isOperatorNetSuiteRequest } from './operator-netsuite-request-pool.js';
import { operatorPostingTelemetry as telemetry } from './operator-netsuite-posting-telemetry.js';

/** @param {number} value */
function positiveTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3600000) {
    throw new RangeError('NetSuite timeouts must be positive integers of at most one hour.');
  }
}

/** @param {{store?: typeof netSuiteRequestQueueStore, pollMs?: number, waitTimeoutMs?: number}} [options] */
export function createNetSuiteRequestScheduler({ store = netSuiteRequestQueueStore, pollMs = 50, waitTimeoutMs = 300000 } = {}) {
  positiveTimeout(pollMs); positiveTimeout(waitTimeoutMs);

  /** @param {string} id @param {number} timeoutMs @param {AbortSignal} signal */
  async function acquire(id, timeoutMs, signal) {
    while (true) {
      signal.throwIfAborted();
      const started = performance.now();
      if (await store.claim(id, timeoutMs)) { return started; }
      await sleep(pollMs, undefined, { signal });
    }
  }

  /** @template T @param {(signal: AbortSignal) => Promise<T>} work
   * @param {{priority?: 'operator' | 'background', timeoutMs?: number, signal?: AbortSignal | undefined}} [options] */
  async function run(work, { priority = isOperatorNetSuiteRequest() ? 'operator' : 'background', timeoutMs = 120000, signal } = {}) {
    positiveTimeout(timeoutMs);
    if (!['operator', 'background'].includes(priority)) { throw new TypeError('Invalid NetSuite request priority.'); }
    signal?.throwIfAborted();
    const queueDeadline = AbortSignal.timeout(waitTimeoutMs);
    const waitingSignal = signal ? AbortSignal.any([queueDeadline, signal]) : queueDeadline;
    const id = await store.enqueue(priority);
    try {
      const started = await telemetry.time({ operation: 'netsuite.queue', queue: `shared_${priority}` },
        () => acquire(id, timeoutMs, waitingSignal));
      waitingSignal.throwIfAborted();
      // Account for time spent receiving the grant: a paused caller must never
      // start HTTP using a grant whose remote deadline could already have passed.
      const remaining = Math.floor(timeoutMs - (performance.now() - started));
      if (remaining <= 0) { throw netSuiteQueueError('NETSUITE_GRANT_EXPIRED', 'NetSuite request grant expired before sending.'); }
      const deadline = AbortSignal.timeout(remaining);
      const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
      return await work(requestSignal);
    } finally {
      // An already successful write must not look failed just because cleanup
      // lost its connection. Its reservation expires automatically instead.
      await store.release(id).catch(() => { console.warn('NetSuite request queue release failed; reservation will expire.'); });
    }
  }
  return { run };
}
export const netSuiteRequestScheduler = createNetSuiteRequestScheduler();
