// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import {
  POSTING_AUTO_RETRY_DELAYS_MINUTES,
  POSTING_AUTO_RETRY_LIMIT,
  isPostingTimeoutOrConnectionFailure,
  postingAutoRetryDelayMinutes
} from "../../../src/posting-auto-retry-policy.js";
import { createOperatorNetSuitePostingProcessor } from "../../../src/operator-netsuite-posting-service.js";
import { createOperatorNetSuitePostingRuntime } from "../../../src/operator-netsuite-posting-runtime.js";
import { verifyOperatorNetSuitePostingRecord } from "../../../src/operator-netsuite-posting-adapter.js";

/** @param {string} message @param {Record<string, unknown>} [fields] */
const failure = (message, fields = {}) => Object.assign(new Error(message), fields);

test("timeouts and lost connections are retried automatically", () => {
  for (const error of [
    failure("canceling statement due to lock timeout", { code: "55P03" }),
    failure("canceling statement due to lock timeout"),
    failure("canceling statement due to statement timeout", { code: "57014" }),
    failure("terminating connection due to administrator command", { code: "57P01" }),
    failure("Connection terminated unexpectedly"),
    failure("timeout exceeded when trying to connect"),
    failure("NetSuite request timed out after 120 seconds.", { code: "NETSUITE_REQUEST_TIMEOUT" }),
    new TypeError("fetch failed", { cause: failure("read ECONNRESET", { code: "ECONNRESET" }) }),
    failure("other side closed", { code: "UND_ERR_SOCKET" }),
    failure("NetSuite REST failed: 504 Gateway Timeout", { status: 504, netsuiteResponseReceived: true }),
    Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    // Local finalization wraps the database error it hit.
    failure("NetSuite posted, but local finalization needs attention: canceling statement due to lock timeout",
      { cause: failure("canceling statement due to lock timeout", { code: "55P03" }) })
  ]) {
    assert.equal(isPostingTimeoutOrConnectionFailure(error), true, error.message);
  }
});

test("rejections, validation, and other outages stay with a person", () => {
  for (const error of [
    failure("NetSuite REST failed: 400 You can not initialize itemreceipt: invalid reference 1101175.", { status: 400, netsuiteResponseReceived: true }),
    failure("The live transfer item or remaining quantity changed before posting.", { code: "TRANSFER_POSTING_EVIDENCE_INVALID", postingNotAttempted: true }),
    failure("NetSuite RESTlet returned HTTP 503.", { status: 503 }),
    failure("NetSuite REST failed: 429 Too Many Requests", { status: 429 }),
    failure("deadlock detected", { code: "40P01" }),
    failure("The previous NetSuite attempt is not yet verified. Recovery must finish before another posting.",
      { code: "OPERATOR_NETSUITE_POSTING_RESULT_UNVERIFIED", ambiguous: true }),
    failure("A selected Sales Order line is missing, closed, or already fulfilled."),
    null,
    "timeout"
  ]) {
    assert.equal(isPostingTimeoutOrConnectionFailure(error), false, String(error && /** @type {any} */ (error).message || error));
  }
});

test("five automatic retries wait 1, 5, 15, 30 and 60 minutes", () => {
  assert.deepEqual([...POSTING_AUTO_RETRY_DELAYS_MINUTES], [1, 5, 15, 30, 60]);
  assert.equal(POSTING_AUTO_RETRY_LIMIT, 5);
  assert.deepEqual([0, 1, 2, 3, 4].map(postingAutoRetryDelayMinutes), [1, 5, 15, 30, 60]);
  for (const used of [5, 6, -1, 1.5, Number.NaN]) {assert.equal(postingAutoRetryDelayMinutes(used), null);}
});

const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function step(status = "pending") {
  return { id: 1, stepIndex: 1, sourceOrderKind: "SO", sourceNetSuiteId: 901, sourceOrderRef: "SOA901",
    transactionType: "IF", externalId: `MBBS-OP-${commandId}-1`, status,
    payload: { externalId: `MBBS-OP-${commandId}-1`, item: { items: [{ orderLine: 1, quantity: 2, itemReceive: true, location: 15 }] } } };
}
function remote() {
  return { id: 8001, tranId: "IF8001", transactionType: "IF", externalId: `MBBS-OP-${commandId}-1`, createdFromId: 901,
    item: { items: [{ orderLine: 1, quantity: 2, itemReceive: true, location: 15 }] } };
}

/** A minimal in-memory command store with the automatic-retry hook. */
function harness({ stepStatus = "pending", autoRetryCount = 0, direct = false, transform, find, finalize } = /** @type {any} */ ({})) {
  const state = {
    command: { id: commandId, status: "queued", leaseToken: null, autoRetryCount, steps: [step(stepStatus)], result: {},
      inputSnapshot: { localOperation: { kind: "delivery_prep_load" }, ...(direct ? { postingStrategy: "stored_order_line_v1" } : {}) } },
    scheduled: /** @type {any[]} */ ([]), transforms: 0
  };
  const repository = {
    get: async () => structuredClone(state.command),
    claim: async () => {
      if (state.command.status !== "queued") {return null;}
      state.command.status = "posting"; state.command.leaseToken = "lease";
      return structuredClone(state.command);
    },
    renew: async () => structuredClone(state.command),
    startAttempt: async () => {
      const fresh = state.command.steps[0].status === "pending";
      state.command.steps[0].status = "posting";
      return { attemptNumber: 1, fresh, step: structuredClone(state.command.steps[0]) };
    },
    success: async ({ transactionId, transactionRef }) => Object.assign(state.command.steps[0],
      { status: "posted", netSuiteTransactionId: transactionId, netSuiteTransactionRef: transactionRef }),
    failure: async ({ uncertain }) => Object.assign(state.command.steps[0], { status: uncertain ? "uncertain" : "failed" }),
    attention: async ({ error }) => Object.assign(state.command, { status: "attention", leaseToken: null, lastError: error.message }),
    fail: async ({ error }) => Object.assign(state.command, { status: "failed", leaseToken: null, lastError: error.message }),
    complete: async ({ finalize: run }) => { await run(); return Object.assign(state.command, { status: "completed", leaseToken: null }); },
    scheduleAutoRetry: async (/** @type {any} */ input) => {
      state.scheduled.push(input);
      return { commandId: input.commandId, autoRetryCount: state.command.autoRetryCount, nextAutoRetryAt: "2026-11-03T21:00:00.000Z" };
    }
  };
  const processor = createOperatorNetSuitePostingProcessor({
    repository,
    adapter: {
      findByExternalId: async () => (find ? find() : null),
      transform: async () => { state.transforms += 1; return transform ? transform() : { id: 8001, record: remote() }; },
      fetchById: async () => remote(),
      verify: verifyOperatorNetSuitePostingRecord
    },
    finalize: async () => (finalize ? finalize() : { loaded: true }),
    workerId: "auto-retry-unit"
  });
  return { state, processor };
}

test("a NetSuite timeout during posting schedules an automatic verification", async () => {
  const { state, processor } = harness({ transform: () => { throw failure("NetSuite request timed out after 120 seconds.", { code: "NETSUITE_REQUEST_TIMEOUT" }); } });
  const result = await processor.process(commandId);
  assert.equal(result.status, "attention");
  assert.equal(result.nextAutoRetryAt, "2026-11-03T21:00:00.000Z");
  assert.deepEqual(state.scheduled, [{ commandId, delaysMinutes: POSTING_AUTO_RETRY_DELAYS_MINUTES }]);
});

test("a lost connection during local finalization schedules a retry of the finalization", async () => {
  const { state, processor } = harness({ finalize: () => { throw failure("canceling statement due to lock timeout", { code: "55P03" }); } });
  const result = await processor.process(commandId);
  assert.equal(result.status, "attention");
  assert.match(result.lastError, /local finalization needs attention/);
  assert.equal(state.scheduled.length, 1);
});

test("a NetSuite rejection is never scheduled", async () => {
  const { state, processor } = harness({ transform: () => {
    throw failure("NetSuite REST failed: 400 invalid reference", { status: 400, netsuiteResponseReceived: true });
  } });
  const result = await processor.process(commandId);
  assert.equal(result.status, "failed");
  assert.equal(state.scheduled.length, 0);
});

test("an HTTP 503 still waits for a person", async () => {
  const { state, processor } = harness({ transform: () => { throw failure("NetSuite RESTlet returned HTTP 503.", { status: 503 }); } });
  const result = await processor.process(commandId);
  assert.equal(result.status, "attention");
  assert.equal(state.scheduled.length, 0);
});

test("an automatic verification that cannot see the record yet keeps verifying without posting again", async () => {
  const { state, processor } = harness({ stepStatus: "uncertain", autoRetryCount: 1, direct: true });
  const result = await processor.process(commandId);
  assert.equal(result.status, "attention");
  assert.equal(state.transforms, 0, "an uncertain posting must never be sent twice");
  assert.equal(state.scheduled.length, 1);
});

test("a person's resume that cannot verify the record is not put on automatic retry", async () => {
  const { state, processor } = harness({ stepStatus: "uncertain", autoRetryCount: 0, direct: true });
  const result = await processor.process(commandId);
  assert.equal(result.status, "attention");
  assert.equal(state.transforms, 0);
  assert.equal(state.scheduled.length, 0);
});

test("an automatic verification that finds the record completes the posting", async () => {
  const { state, processor } = harness({ stepStatus: "uncertain", autoRetryCount: 1, direct: true, find: () => remote() });
  const result = await processor.process(commandId);
  assert.equal(result.status, "completed");
  assert.equal(state.transforms, 0);
  assert.equal(state.scheduled.length, 0);
});

test("each runtime cycle resumes due automatic retries before taking runnable work", async () => {
  /** @type {string[]} */ const order = [];
  const runtime = createOperatorNetSuitePostingRuntime({
    resumeDueAutoRetries: async () => { order.push("resume"); },
    listRunnable: async () => { order.push("list"); return []; },
    process: async () => null,
    logError: () => assert.fail("no error expected")
  });
  await runtime.tick();
  assert.deepEqual(order, ["resume", "list"]);
});

test("a failed automatic resume is logged and the cycle still runs", async () => {
  /** @type {string[]} */ const logged = [];
  /** @type {string[]} */ const processed = [];
  const runtime = createOperatorNetSuitePostingRuntime({
    resumeDueAutoRetries: async () => { throw new Error("Connection terminated unexpectedly"); },
    listRunnable: async () => ["cmd-1"],
    process: async (id) => { processed.push(id); return null; },
    logError: (error, id) => { logged.push(`${id}: ${error.message}`); }
  });
  await runtime.tick();
  assert.deepEqual(logged, ["automatic-retry: Connection terminated unexpectedly"]);
  assert.deepEqual(processed, ["cmd-1"]);
});
