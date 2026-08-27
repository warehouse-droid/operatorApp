// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { createOperatorNetSuitePostingRuntime } from "../../../src/operator-netsuite-posting-runtime.js";

test("P5/P9 runtime deduplicates in-process work and discovers durable restart candidates", async () => {
  const processed = [];
  const resolvers = [];
  const runtime = createOperatorNetSuitePostingRuntime({
    process: async (id) => {
      processed.push(id);
      await new Promise((resolve) => resolvers.push(resolve));
    },
    listRunnable: async () => ["command-b", "command-c"],
    logError: () => {}
  });
  const first = runtime.enqueue("command-a");
  const duplicate = runtime.enqueue("command-a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, ["command-a"]);
  assert.equal(first, duplicate);
  resolvers.shift()();
  await first;

  const tick = runtime.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, ["command-a", "command-b", "command-c"]);
  resolvers.shift()();
  resolvers.shift()();
  await tick;

  const retry = runtime.enqueue("command-a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, ["command-a", "command-b", "command-c", "command-a"]);
  resolvers.shift()();
  await retry;
});

test("P9 a processor failure is logged and does not permanently poison the command key", async () => {
  let attempts = 0;
  const errors = [];
  const runtime = createOperatorNetSuitePostingRuntime({
    process: async () => {
      attempts += 1;
      if (attempts === 1) {throw new Error("synthetic worker crash");}
    },
    listRunnable: async () => [],
    logError: (error) => errors.push(error.message)
  });
  await runtime.enqueue("command-a");
  await runtime.enqueue("command-a");
  assert.equal(attempts, 2);
  assert.deepEqual(errors, ["synthetic worker crash"]);
});
