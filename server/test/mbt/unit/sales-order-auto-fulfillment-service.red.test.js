// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { createSalesOrderAutoFulfillmentProcessor } from "../../../src/sales-order-auto-fulfillment-service.js";

function readyCandidate(overrides = {}) {
  return {
    id: "ca6f8ff2-1844-4cf6-98fc-1f4295683cd2",
    sourceSalesOrderId: 800100,
    sourceSalesOrderRef: "SOA100",
    externalId: "MBBS-SOIF-ca6f8ff2-1844-4cf6-98fc-1f4295683cd2",
    status: "queued",
    lineSnapshot: [{ orderLine: 10, itemId: 100, deliveredQuantity: 8, location: 15 }],
    resolutionAction: "automatic",
    ...overrides
  };
}

function liveOrder(overrides = {}) {
  return {
    closed: false,
    lines: [{ orderLine: 10, itemId: 100, remainingQuantity: 8, fulfilledQuantity: 0, location: 15 }],
    ...overrides
  };
}

function memoryRepository(candidate = readyCandidate()) {
  let claimed = false;
  const calls = [];
  return {
    calls,
    prepare: async () => candidate,
    claim: async () => {
      if (claimed) {return null;}
      claimed = true;
      return { ...candidate, leaseToken: "test-lease-one", status: "posting" };
    },
    renew: async (input) => { calls.push(["renew", input]); return true; },
    startAttempt: async () => ({ attemptNumber: 1 }),
    complete: async (input) => { calls.push(["complete", input]); candidate.status = "completed"; return candidate; },
    attention: async (input) => { calls.push(["attention", input]); candidate.status = "attention"; return candidate; },
    closed: async (input) => { calls.push(["closed", input]); candidate.status = "closed"; return candidate; },
    reconciled: async (input) => { calls.push(["reconciled", input]); candidate.status = "reconciled"; return candidate; },
    failure: async (input) => {
      calls.push(["failure", input]);
      candidate.status = input.uncertain ? "uncertain" : "failed";
      claimed = false;
      return candidate;
    },
    get: async () => candidate
  };
}

test("L9 drift and closed sources stop before any NetSuite transform", async () => {
  for (const [source, expectedCall] of [
    [liveOrder({ closed: true, lines: [] }), "closed"],
    [liveOrder({ lines: [{ orderLine: 10, itemId: 999, remainingQuantity: 8, fulfilledQuantity: 0, location: 15 }] }), "attention"]
  ]) {
    const repository = memoryRepository();
    let transforms = 0;
    const processor = createSalesOrderAutoFulfillmentProcessor({
      repository,
      fetchLiveOrder: async () => source,
      adapter: {
        findByExternalId: async () => null,
        transform: async () => { transforms += 1; return { id: 1 }; },
        fetchById: async () => ({}),
        verify: () => ({ id: 1, transactionRef: "IF1" })
      },
      workerId: "test-worker"
    });
    await processor.process("candidate-one");
    assert.equal(transforms, 0);
    assert.equal(repository.calls[0][0], expectedCall);
  }
});

test("L10 concurrent workers perform one remote transform and one completion", async () => {
  const repository = memoryRepository();
  let transforms = 0;
  const adapter = {
    findByExternalId: async () => null,
    transform: async () => { transforms += 1; return { id: 9001 }; },
    fetchById: async () => ({ id: 9001, externalId: readyCandidate().externalId }),
    verify: () => ({ id: 9001, transactionRef: "IF9001" })
  };
  const processor = createSalesOrderAutoFulfillmentProcessor({
    repository,
    fetchLiveOrder: async () => liveOrder(),
    adapter,
    workerId: "test-worker"
  });
  await Promise.all([
    processor.process("candidate-one"),
    processor.process("candidate-one"),
    processor.process("candidate-one")
  ]);
  assert.equal(transforms, 1);
  assert.equal(repository.calls.filter(([name]) => name === "complete").length, 1);
  assert.ok(repository.calls.some(([name]) => name === "renew"), "the remote operation must retain its durable lease");
});

test("L10 an existing deterministic external ID is verified without another transform", async () => {
  const repository = memoryRepository();
  let transforms = 0;
  const processor = createSalesOrderAutoFulfillmentProcessor({
    repository,
    fetchLiveOrder: async () => liveOrder(),
    adapter: {
      findByExternalId: async () => ({ id: 9000, externalId: readyCandidate().externalId }),
      transform: async () => { transforms += 1; return { id: 9000 }; },
      fetchById: async () => ({ id: 9000, externalId: readyCandidate().externalId }),
      verify: () => ({ id: 9000, transactionRef: "IF9000" })
    },
    workerId: "test-worker"
  });

  await processor.process("candidate-one");

  assert.equal(transforms, 0);
  const completed = repository.calls.find(([name]) => name === "complete");
  assert.ok(completed);
  assert.equal(completed[1].recovered, true);
});

test("L10 ambiguous transform is recovered by external ID without a second transform", async () => {
  const repository = memoryRepository();
  let transforms = 0;
  let finds = 0;
  const adapter = {
    findByExternalId: async () => {
      finds += 1;
      return finds === 1 ? null : { id: 9002, externalId: readyCandidate().externalId };
    },
    transform: async () => {
      transforms += 1;
      throw Object.assign(new Error("timeout after remote commit"), { code: "NETSUITE_REQUEST_TIMEOUT" });
    },
    fetchById: async () => ({ id: 9002, externalId: readyCandidate().externalId }),
    verify: () => ({ id: 9002, transactionRef: "IF9002" })
  };
  const processor = createSalesOrderAutoFulfillmentProcessor({
    repository,
    fetchLiveOrder: async () => liveOrder(),
    adapter,
    workerId: "test-worker"
  });
  await processor.process("candidate-one");
  assert.equal(transforms, 1);
  assert.equal(finds, 2);
  const completed = repository.calls.find(([name]) => name === "complete");
  assert.ok(completed);
  assert.equal(completed[1].recovered, true);
  assert.equal(repository.calls.some(([name]) => name === "failure"), false);
});

test("L9 an audited Admin snapshot decision may proceed after acknowledged live drift", async () => {
  const repository = memoryRepository(readyCandidate({
    resolutionAction: "snapshot",
    resolutionReason: "Dispatch evidence was reviewed against the live order"
  }));
  let transforms = 0;
  const processor = createSalesOrderAutoFulfillmentProcessor({
    repository,
    fetchLiveOrder: async () => liveOrder({
      lines: [
        {
          orderLine: 10,
          itemId: 100,
          remainingQuantity: 8,
          fulfilledQuantity: 0,
          location: 15
        },
        {
          orderLine: 11,
          itemId: 101,
          remainingQuantity: 2,
          fulfilledQuantity: 0,
          location: 15
        }
      ]
    }),
    adapter: {
      findByExternalId: async () => null,
      transform: async () => { transforms += 1; return { id: 9003 }; },
      fetchById: async () => ({
        id: 9003,
        externalId: readyCandidate().externalId,
        createdFromId: 800100,
        transactionType: "IF",
        item: { items: [{ orderLine: 10, quantity: 8, itemReceive: true, location: 15 }] }
      }),
      verify: () => ({ id: 9003, transactionRef: "IF9003" })
    },
    workerId: "test-worker"
  });

  await processor.process("candidate-one");

  assert.equal(transforms, 1);
  assert.equal(repository.calls.some(([name]) => name === "attention"), false);
  assert.equal(repository.calls.filter(([name]) => name === "complete").length, 1);
});

test("L10 an unresolved ambiguous post freezes without an automatic second transform", async () => {
  const repository = memoryRepository();
  let transforms = 0;
  const processor = createSalesOrderAutoFulfillmentProcessor({
    repository,
    fetchLiveOrder: async () => liveOrder(),
    adapter: {
      findByExternalId: async () => null,
      transform: async () => {
        transforms += 1;
        throw Object.assign(new Error("timeout after possible remote commit"), { code: "NETSUITE_REQUEST_TIMEOUT" });
      },
      fetchById: async () => null,
      verify: () => { throw new Error("No record to verify"); }
    },
    workerId: "test-worker"
  });

  const first = await processor.process("candidate-one");
  const second = await processor.process("candidate-one");

  assert.equal(first.status, "uncertain");
  assert.equal(second.status, "uncertain");
  assert.equal(transforms, 1);
});

test("L9/L10 Admin recovery verifies the original external ID even after live quantity reaches zero", async () => {
  const originalPayload = {
    externalId: readyCandidate().externalId,
    item: { items: [{ orderLine: 10, quantity: 8, itemReceive: true, location: 15 }] }
  };
  const repository = memoryRepository(readyCandidate({
    status: "queued",
    resolutionAction: "recover",
    resolutionReason: "Recover the timeout by deterministic external ID",
    payload: originalPayload,
    liveSnapshot: {
      selectedLines: [{ orderLine: 10, itemId: 100, quantity: 8, location: 15 }]
    }
  }));
  let transforms = 0;
  const processor = createSalesOrderAutoFulfillmentProcessor({
    repository,
    fetchLiveOrder: async () => liveOrder({
      lines: [{ orderLine: 10, itemId: 100, remainingQuantity: 0, fulfilledQuantity: 8, location: 15 }]
    }),
    adapter: {
      findByExternalId: async () => ({ id: 9004, externalId: readyCandidate().externalId }),
      transform: async () => { transforms += 1; return { id: 9005 }; },
      fetchById: async () => null,
      verify: (_candidate, _record, payload) => {
        assert.deepEqual(payload, originalPayload);
        return { id: 9004, transactionRef: "IF9004" };
      }
    },
    workerId: "test-worker"
  });

  const completed = await processor.process("candidate-one");

  assert.equal(completed.status, "completed");
  assert.equal(transforms, 0);
  assert.equal(repository.calls.some(([name]) => name === "reconciled"), false);
  assert.equal(repository.calls.filter(([name]) => name === "complete").length, 1);
});
