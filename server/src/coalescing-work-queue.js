export function createCoalescingWorkQueue({ merge, worker } = {}) {
  if (typeof merge !== "function") throw new TypeError("A coalescing merge function is required.");
  if (typeof worker !== "function") throw new TypeError("A coalescing queue worker is required.");

  let running = false;
  let pending = null;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending) {
        const batch = pending;
        pending = null;
        try {
          const result = await worker(batch.value);
          for (const waiter of batch.waiters) waiter.resolve(result);
        } catch (error) {
          for (const waiter of batch.waiters) waiter.reject(error);
        }
      }
    } finally {
      running = false;
    }
  }

  function enqueue(value) {
    return new Promise((resolve, reject) => {
      if (pending) {
        pending.value = merge(pending.value, value);
        pending.waiters.push({ resolve, reject });
      } else {
        pending = { value, waiters: [{ resolve, reject }] };
      }
      void drain();
    });
  }

  function status() {
    return {
      running,
      pending: Boolean(pending),
      pendingWaiters: pending?.waiters.length || 0
    };
  }

  return { enqueue, status };
}

export function createSingleFlight({ key, worker } = {}) {
  if (typeof key !== "function") throw new TypeError("A single-flight key function is required.");
  if (typeof worker !== "function") throw new TypeError("A single-flight worker is required.");

  const active = new Map();

  function run(value) {
    const flightKey = key(value);
    const existing = active.get(flightKey);
    if (existing) return existing;

    let request;
    request = Promise.resolve()
      .then(() => worker(value))
      .finally(() => {
        if (active.get(flightKey) === request) active.delete(flightKey);
      });
    active.set(flightKey, request);
    return request;
  }

  function status() {
    return { active: active.size };
  }

  return { run, status };
}

export function createSerialExecutor() {
  const pending = [];
  let active = 0;
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) {
        const task = pending.shift();
        active += 1;
        try {
          task.resolve(await task.worker());
        } catch (error) {
          task.reject(error);
        } finally {
          active -= 1;
        }
      }
    } finally {
      draining = false;
    }
  }

  function run(worker) {
    if (typeof worker !== "function") throw new TypeError("A serial executor worker is required.");
    return new Promise((resolve, reject) => {
      pending.push({ worker, resolve, reject });
      void drain();
    });
  }

  function status() {
    return { active, queued: pending.length };
  }

  return { run, status };
}

export async function drainBoundedBatches({
  worker,
  batchSize = 1_000,
  maxBatches = 10,
  yieldBetween = () => new Promise((resolve) => setImmediate(resolve))
} = {}) {
  if (typeof worker !== "function") throw new TypeError("A bounded batch worker is required.");
  if (typeof yieldBetween !== "function") throw new TypeError("A bounded batch yield function is required.");
  const safeBatchSize = Math.max(1, Math.floor(Number(batchSize) || 1_000));
  const safeMaxBatches = Math.max(1, Math.floor(Number(maxBatches) || 10));
  const summary = { deleted: 0, checkpointIds: [], batches: 0, exhausted: false };

  for (let index = 0; index < safeMaxBatches; index += 1) {
    const result = await worker({ batchSize: safeBatchSize, batchNumber: index + 1 }) || {};
    const deleted = Math.max(0, Number(result.deleted) || 0);
    summary.deleted += deleted;
    summary.checkpointIds.push(...(Array.isArray(result.checkpointIds) ? result.checkpointIds : []));
    summary.batches += 1;
    if (deleted < safeBatchSize) return summary;
    if (index + 1 < safeMaxBatches) await yieldBetween();
  }
  summary.exhausted = true;
  return summary;
}
