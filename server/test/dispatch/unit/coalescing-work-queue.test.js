import assert from "node:assert/strict";
import test from "node:test";
import {
  createCoalescingWorkQueue,
  createSerialExecutor,
  drainBoundedBatches,
  createSingleFlight
} from "../../../src/coalescing-work-queue.js";

test("coalescing queue permits one active job and merges an update burst into one trailing job", async () => {
  let releaseFirst;
  const calls = [];
  const queue = createCoalescingWorkQueue({
    merge(current, incoming) {
      return {
        force: current.force || incoming.force,
        delivery: current.delivery || incoming.delivery,
        receiving: current.receiving || incoming.receiving
      };
    },
    async worker(value) {
      calls.push(value);
      if (calls.length === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      return value;
    }
  });

  const first = queue.enqueue({ force: false, delivery: true, receiving: false });
  const second = queue.enqueue({ force: false, delivery: false, receiving: true });
  const third = queue.enqueue({ force: true, delivery: true, receiving: false });

  assert.equal(calls.length, 1);
  assert.deepEqual(queue.status(), { running: true, pending: true, pendingWaiters: 2 });
  releaseFirst();

  const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
  assert.deepEqual(firstResult, { force: false, delivery: true, receiving: false });
  assert.deepEqual(calls, [
    { force: false, delivery: true, receiving: false },
    { force: true, delivery: true, receiving: true }
  ]);
  assert.deepEqual(secondResult, calls[1]);
  assert.deepEqual(thirdResult, calls[1]);
  assert.deepEqual(queue.status(), { running: false, pending: false, pendingWaiters: 0 });
});

test("coalescing queue rejects a failed batch and continues with queued work", async () => {
  let releaseFailure;
  const calls = [];
  const queue = createCoalescingWorkQueue({
    merge: (current, incoming) => current + incoming,
    async worker(value) {
      calls.push(value);
      if (calls.length === 1) {
        await new Promise((resolve) => { releaseFailure = resolve; });
        throw new Error("first batch failed");
      }
      return value;
    }
  });

  const failed = queue.enqueue(1);
  const recovered = queue.enqueue(2);
  const coalesced = queue.enqueue(3);
  releaseFailure();

  await assert.rejects(failed, /first batch failed/u);
  assert.equal(await recovered, 5);
  assert.equal(await coalesced, 5);
  assert.deepEqual(calls, [1, 5]);
});

test("single-flight shares identical active reads and clears the key after completion", async () => {
  let release;
  let calls = 0;
  const singleFlight = createSingleFlight({
    key: ({ type, search }) => `${type}:${search.toLowerCase()}`,
    async worker(value) {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return value;
    }
  });

  const first = singleFlight.run({ type: "PO", search: "ABC" });
  const duplicate = singleFlight.run({ type: "PO", search: "abc" });
  assert.equal(first, duplicate);
  assert.deepEqual(singleFlight.status(), { active: 1 });
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, duplicate]);
  assert.deepEqual(singleFlight.status(), { active: 0 });
});

test("single-flight permits a retry after a failed read", async () => {
  let calls = 0;
  const singleFlight = createSingleFlight({
    key: (value) => value,
    async worker() {
      calls += 1;
      if (calls === 1) {throw new Error("temporary failure");}
      return "recovered";
    }
  });

  await assert.rejects(singleFlight.run("same-key"), /temporary failure/u);
  assert.equal(await singleFlight.run("same-key"), "recovered");
  assert.equal(calls, 2);
});

test("serial executor never overlaps unrelated heavyweight jobs and survives a failure", async () => {
  let releaseFirst;
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const executor = createSerialExecutor();
  const run = (name, { wait = false, fail = false } = {}) => executor.run(async () => {
    calls.push(name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (wait) {await new Promise((resolve) => { releaseFirst = resolve; });}
      if (fail) {throw new Error(`${name} failed`);}
      return name;
    } finally {
      active -= 1;
    }
  });

  const first = run("dispatch", { wait: true });
  const failed = run("po", { fail: true });
  const final = run("dispatch-retry");
  await Promise.resolve();
  assert.deepEqual(executor.status(), { active: 1, queued: 2 });
  releaseFirst();

  assert.equal(await first, "dispatch");
  await assert.rejects(failed, /po failed/u);
  assert.equal(await final, "dispatch-retry");
  assert.equal(maximumActive, 1);
  assert.deepEqual(calls, ["dispatch", "po", "dispatch-retry"]);
  assert.deepEqual(executor.status(), { active: 0, queued: 0 });
});

test("bounded batch drain yields between full chunks and reports whether work remains", async () => {
  const counts = [1_000, 1_000, 2];
  let yields = 0;
  const result = await drainBoundedBatches({
    batchSize: 1_000,
    maxBatches: 10,
    worker: async ({ batchSize }) => ({
      deleted: counts.shift(),
      checkpointIds: Array.from({ length: Math.min(counts.length + 1, 2) }, (_, index) => `${batchSize}:${index}`)
    }),
    yieldBetween: async () => { yields += 1; }
  });

  assert.equal(result.deleted, 2_002);
  assert.equal(result.batches, 3);
  assert.equal(result.exhausted, false);
  assert.equal(yields, 2);

  const capped = await drainBoundedBatches({
    batchSize: 500,
    maxBatches: 2,
    worker: async () => ({ deleted: 500, checkpointIds: [] }),
    yieldBetween: async () => {}
  });
  assert.deepEqual(capped, { deleted: 1_000, checkpointIds: [], batches: 2, exhausted: true });
});
