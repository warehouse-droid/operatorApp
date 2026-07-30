import assert from "node:assert/strict";
import {
  fetchScmReconciliationLinkedTransactionsInBatches
} from "./scm-reconciliation-service.js";

function netSuiteTimeout(message = "NetSuite request timed out after 120 seconds.") {
  const error = new Error(message);
  error.code = "NETSUITE_REQUEST_TIMEOUT";
  return error;
}

// A broad reconciliation must stay sequential and bounded rather than placing
// every source order into one expensive linked-transaction SuiteQL request.
{
  const orderIds = Array.from({ length: 41 }, (_, index) => index + 1);
  const calls = [];
  const progress = [];
  const result = await fetchScmReconciliationLinkedTransactionsInBatches(orderIds, {
    batchSize: 15,
    async fetchBatch(batchIds) {
      calls.push([...batchIds]);
      return batchIds.map((sourceOrderId) => ({ sourceOrderId }));
    },
    async onBatch(event) {
      progress.push(event);
    }
  });

  assert.deepEqual(calls.map((batch) => batch.length), [15, 15, 11]);
  assert.deepEqual(calls.flat(), orderIds);
  assert.equal(result.requestCount, 3);
  assert.deepEqual(result.processedOrderIds, orderIds);
  assert.deepEqual(result.rows.map((row) => row.sourceOrderId), orderIds);
  assert.deepEqual(
    progress.map((event) => event.processedOrderIds.length),
    [15, 30, 41]
  );
  assert.deepEqual(
    progress.map((event) => event.totalSourceOrders),
    [41, 41, 41]
  );
}

// A transient timeout is retried once, with attempt/request progress exposed to
// the worker so it can persist an accurate checkpoint and API request count.
{
  const attempts = [];
  const retries = [];
  const delays = [];
  const batches = [];
  let fetchCalls = 0;
  const result = await fetchScmReconciliationLinkedTransactionsInBatches([51, 52], {
    batchSize: 15,
    maxTimeoutAttempts: 2,
    retryDelayMs: 25,
    async fetchBatch(batchIds) {
      fetchCalls += 1;
      if (fetchCalls === 1) throw netSuiteTimeout();
      return [{ sourceOrderId: batchIds[0], linkedTransactionId: 9001 }];
    },
    async delay(milliseconds) {
      delays.push(milliseconds);
    },
    async onAttempt(event) {
      attempts.push(event);
    },
    async onRetry(event) {
      retries.push(event);
    },
    async onBatch(event) {
      batches.push(event);
    }
  });

  assert.equal(fetchCalls, 2);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(delays, [25]);
  assert.deepEqual(attempts.map((event) => event.attempt), [1, 2]);
  assert.deepEqual(attempts.map((event) => event.requestCount), [1, 2]);
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0].orderIds, [51, 52]);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].maxAttempts, 2);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].attempts, 2);
  assert.deepEqual(batches[0].processedOrderIds, [51, 52]);
  assert.equal(batches[0].totalSourceOrders, 2);
  assert.match(batches[0].batchStartedAt, /^\d{4}-\d{2}-\d{2}T/);
}

// A repeatedly slow batch is bisected. Completed halves report progress, while
// a source that still times out alone is surfaced as resumable with its ID.
{
  const calls = [];
  const attempts = [];
  const retries = [];
  const splits = [];
  const completedBatches = [];
  let caught = null;

  try {
    await fetchScmReconciliationLinkedTransactionsInBatches([61, 62], {
      batchSize: 2,
      maxTimeoutAttempts: 2,
      retryDelayMs: 0,
      async fetchBatch(batchIds) {
        calls.push([...batchIds]);
        if (batchIds.includes(62)) throw netSuiteTimeout("slow source 62");
        return [{ sourceOrderId: 61 }];
      },
      async delay() {},
      async onAttempt(event) {
        attempts.push(event);
      },
      async onRetry(event) {
        retries.push(event);
      },
      async onSplit(event) {
        splits.push(event);
      },
      async onBatch(event) {
        completedBatches.push(event);
      }
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught);
  assert.equal(caught.code, "SCM_RECONCILIATION_LINKED_TIMEOUT");
  assert.equal(caught.resumable, true);
  assert.equal(caught.sourceOrderId, 62);
  assert.match(caught.message, /slow source 62/);
  assert.deepEqual(calls, [[61, 62], [61, 62], [61], [62], [62]]);
  assert.equal(attempts.length, 5);
  assert.deepEqual(attempts.map((event) => event.requestCount), [1, 2, 3, 4, 5]);
  assert.equal(retries.length, 2);
  assert.equal(splits.length, 1);
  assert.deepEqual(splits[0].orderIds, [61, 62]);
  assert.deepEqual(splits[0].left, [61]);
  assert.deepEqual(splits[0].right, [62]);
  assert.equal(completedBatches.length, 1);
  assert.deepEqual(completedBatches[0].processedOrderIds, [61]);
}

// Authentication, validation, and other non-timeout failures must not be
// retried because doing so would spend API capacity without changing outcome.
{
  const expected = new Error("NetSuite authentication failed.");
  expected.code = "NETSUITE_AUTH_FAILED";
  let fetchCalls = 0;
  let retryCalls = 0;
  let splitCalls = 0;

  await assert.rejects(
    fetchScmReconciliationLinkedTransactionsInBatches([71, 72], {
      maxTimeoutAttempts: 5,
      async fetchBatch() {
        fetchCalls += 1;
        throw expected;
      },
      async onRetry() {
        retryCalls += 1;
      },
      async onSplit() {
        splitCalls += 1;
      }
    }),
    (error) => error === expected
  );
  assert.equal(fetchCalls, 1);
  assert.equal(retryCalls, 0);
  assert.equal(splitCalls, 0);
}

// Empty input is a no-op and does not require a fetcher.
{
  let fetchCalls = 0;
  const result = await fetchScmReconciliationLinkedTransactionsInBatches([], {
    async fetchBatch() {
      fetchCalls += 1;
      return [];
    }
  });
  assert.deepEqual(result, {
    rows: [],
    processedOrderIds: [],
    requestCount: 0
  });
  assert.equal(fetchCalls, 0);
}

// NetSuite IDs are normalized to unique positive safe integers before any
// request, preventing duplicate evidence and invalid query parameters.
{
  const calls = [];
  const result = await fetchScmReconciliationLinkedTransactionsInBatches(
    [81, "81", 0, -1, null, undefined, "", "invalid", 82, 82.5, " 83 ", Infinity],
    {
      batchSize: 15,
      async fetchBatch(batchIds) {
        calls.push([...batchIds]);
        return [];
      }
    }
  );
  assert.deepEqual(calls, [[81, 82, 83]]);
  assert.deepEqual(result.processedOrderIds, [81, 82, 83]);
  assert.equal(result.requestCount, 1);
}

// beforeAttempt is awaited for every physical request, including retries and
// split batches, so cancellation/yield checks can stop work at safe boundaries.
{
  const beforeAttempts = [];
  let call = 0;
  const result = await fetchScmReconciliationLinkedTransactionsInBatches([91], {
    maxTimeoutAttempts: 2,
    retryDelayMs: 0,
    async fetchBatch() {
      call += 1;
      if (call === 1) throw netSuiteTimeout();
      return [];
    },
    async delay() {},
    async beforeAttempt(event) {
      beforeAttempts.push(event);
    }
  });

  assert.equal(result.requestCount, 2);
  assert.deepEqual(beforeAttempts.map((event) => event.attempt), [1, 2]);
  assert.ok(beforeAttempts.every((event) => event.maxAttempts === 2));
  assert.ok(beforeAttempts.every((event) => event.orderIds[0] === 91));
}

console.log("SCM reconciliation linked-transaction fetch harness passed.");
