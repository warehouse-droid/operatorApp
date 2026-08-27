// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperatorNetSuitePostingProcessor,
  isAmbiguousOperatorNetSuiteFailure
} from "../../../src/operator-netsuite-posting-service.js";
import { verifyOperatorNetSuitePostingRecord } from "../../../src/operator-netsuite-posting-adapter.js";

function step(index = 1, sourceId = 901) {
  return {
    id: index,
    stepIndex: index,
    sourceOrderKind: "SO",
    sourceNetSuiteId: sourceId,
    sourceOrderRef: `SOA${sourceId}`,
    transactionType: "IF",
    externalId: `MBBS-OP-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${index}`,
    status: "pending",
    payload: {
      externalId: `MBBS-OP-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${index}`,
      item: {
        items: [
          { orderLine: 1, quantity: 2, itemReceive: true, location: 15 },
          { orderLine: 2, itemReceive: false, location: 15 }
        ]
      }
    }
  };
}

function remoteRecord(targetStep, id = 8001) {
  return {
    id,
    tranId: `IF${id}`,
    transactionType: targetStep.transactionType,
    externalId: targetStep.externalId,
    createdFromId: targetStep.sourceNetSuiteId,
    item: {
      items: [{ orderLine: 1, quantity: 2, itemReceive: true, location: 15 }]
    }
  };
}

function fakeRepository(steps = [step()]) {
  const state = {
    command: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "queued",
      leaseToken: null,
      inputSnapshot: {
        localOperation: { kind: "delivery_prep_load", orderId: "901", orderType: "sales_order" }
      },
      steps: structuredClone(steps),
      result: {}
    },
    attempts: [],
    renewals: [],
    failures: [],
    finalized: 0
  };
  const repository = {
    async get(commandId) {
      assert.equal(commandId, state.command.id);
      return structuredClone(state.command);
    },
    async claim() {
      if (state.command.status !== "queued") {return null;}
      state.command.status = "posting";
      state.command.leaseToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // secret-scan: allow -- deterministic lease fixture.
      return structuredClone(state.command);
    },
    async startAttempt({ stepId }) {
      const target = state.command.steps.find((item) => item.id === stepId);
      target.status = "posting";
      const attemptNumber = (target.attemptCount || 0) + 1;
      target.attemptCount = attemptNumber;
      state.attempts.push({ stepId, attemptNumber });
      return { attemptNumber, step: structuredClone(target) };
    },
    async renew(input) {
      state.renewals.push(input);
      return structuredClone(state.command);
    },
    async success({ stepId, transactionId, transactionRef, recovered }) {
      const target = state.command.steps.find((item) => item.id === stepId);
      target.status = "posted";
      target.netSuiteTransactionId = transactionId;
      target.netSuiteTransactionRef = transactionRef;
      target.recovered = recovered;
      return structuredClone(target);
    },
    async failure(input) {
      const target = state.command.steps.find((item) => item.id === input.stepId);
      target.status = input.uncertain ? "uncertain" : "failed";
      state.failures.push(input);
      return structuredClone(target);
    },
    async attention({ error }) {
      state.command.status = "attention";
      state.command.leaseToken = null;
      state.command.lastError = error?.message || String(error || "");
      return structuredClone(state.command);
    },
    async fail() {
      state.command.status = "failed";
      state.command.leaseToken = null;
      return structuredClone(state.command);
    },
    async complete({ result, finalize }) {
      const localFinalization = await finalize();
      state.command.status = "completed";
      state.command.leaseToken = null;
      state.command.result = { ...result, localFinalization };
      return structuredClone(state.command);
    }
  };
  return { state, repository };
}

function processorHarness({ steps, find, transform, fetchById, finalize } = {}) {
  const { state, repository } = fakeRepository(steps);
  const calls = { find: 0, transform: 0, fetch: 0, finalize: 0 };
  const processor = createOperatorNetSuitePostingProcessor({
    repository,
    adapter: {
      findByExternalId: async (targetStep) => {
        calls.find += 1;
        return find ? find(targetStep, calls.find) : null;
      },
      transform: async (targetStep) => {
        calls.transform += 1;
        return transform ? transform(targetStep, calls.transform) : { id: 8000 + targetStep.id };
      },
      fetchById: async (targetStep, id) => {
        calls.fetch += 1;
        return fetchById ? fetchById(targetStep, id) : remoteRecord(targetStep, id);
      },
      verify: verifyOperatorNetSuitePostingRecord
    },
    finalize: async (command) => {
      calls.finalize += 1;
      state.finalized += 1;
      return finalize ? finalize(command) : { loaded: true };
    },
    workerId: "unit-worker"
  });
  return { state, calls, processor };
}

test("P5/P6 a verified external-ID hit is recovered without transform and finalizes once", async () => {
  const harness = processorHarness({ find: (targetStep) => remoteRecord(targetStep) });
  const completed = await harness.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(completed.status, "completed");
  assert.equal(harness.calls.find, 1);
  assert.equal(harness.calls.transform, 0);
  assert.equal(harness.calls.finalize, 1);
  assert.equal(harness.state.renewals.length, 2, "Lease renews before the remote step and local finalization.");
  assert.equal(completed.steps[0].recovered, true);
  assert.deepEqual(completed.result.localFinalization, { loaded: true });
});

test("P6 a multi-parent command renews its exact lease before every remote step and finalization", async () => {
  const harness = processorHarness({ steps: [step(), step(2, 902)] });
  const completed = await harness.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(completed.status, "completed");
  assert.equal(harness.state.renewals.length, 3);
  assert.ok(harness.state.renewals.every((renewal) => renewal.commandId === harness.state.command.id));
  assert.ok(harness.state.renewals.every((renewal) => renewal.leaseToken === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
});

test("P6 an unavailable command is read without any remote or local mutation", async () => {
  const harness = processorHarness();
  harness.state.command.status = "completed";
  const existing = await harness.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(existing.status, "completed");
  assert.equal(harness.calls.find, 0);
  assert.equal(harness.calls.transform, 0);
  assert.equal(harness.calls.finalize, 0);
});

test("P6 a lost transform response recovers by external ID and never transforms twice", async () => {
  const timeout = Object.assign(new Error("response lost"), { code: "NETSUITE_REQUEST_TIMEOUT" });
  const harness = processorHarness({
    find: (targetStep, call) => call === 1 ? null : remoteRecord(targetStep, 8111),
    transform: async () => { throw timeout; }
  });
  const completed = await harness.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(completed.status, "completed");
  assert.equal(harness.calls.transform, 1);
  assert.equal(harness.calls.find, 2);
  assert.equal(completed.steps[0].netSuiteTransactionId, 8111);
});

test("P6 a transform without an ID recovers by external ID and an unreadable created record needs attention", async () => {
  const recovered = processorHarness({
    find: (targetStep, call) => call === 1 ? null : remoteRecord(targetStep, 8122),
    transform: async () => ({})
  });
  assert.equal((await recovered.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).status, "completed");
  assert.equal(recovered.calls.transform, 1);
  assert.equal(recovered.calls.find, 2);

  const unreadable = processorHarness({ fetchById: async () => null });
  const attention = await unreadable.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(attention.status, "attention");
  assert.equal(unreadable.calls.finalize, 0);
});

test("P7 definitive pre-write rejection fails and never performs local finalization", async () => {
  const rejection = Object.assign(new Error("invalid line"), { status: 400, netsuiteResponseReceived: true });
  const harness = processorHarness({ transform: async () => { throw rejection; } });
  const failed = await harness.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(failed.status, "failed");
  assert.equal(harness.calls.finalize, 0);
  assert.equal(harness.state.failures[0].uncertain, false);
});

test("P8 an unverifiable timeout or a partial group stops in attention", async () => {
  const timeout = Object.assign(new Error("response lost"), { code: "NETSUITE_REQUEST_TIMEOUT" });
  const ambiguous = processorHarness({ transform: async () => { throw timeout; } });
  const attention = await ambiguous.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(attention.status, "attention");
  assert.equal(ambiguous.calls.finalize, 0);
  assert.equal(ambiguous.state.failures[0].uncertain, true);

  const secondStep = step(2, 902);
  const partial = processorHarness({
    steps: [step(), secondStep],
    transform: async (targetStep) => {
      if (targetStep.id === 2) {
        throw Object.assign(new Error("second parent rejected"), { status: 422, netsuiteResponseReceived: true });
      }
      return { id: 8201 };
    }
  });
  const partialAttention = await partial.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(partialAttention.status, "attention");
  assert.equal(partial.calls.finalize, 0);
  assert.equal(partial.state.command.steps[0].status, "posted");
  assert.equal(partial.state.command.steps[1].status, "failed");
});

test("P8 local finalization failure preserves posted work for Admin attention", async () => {
  const harness = processorHarness({ finalize: async () => { throw new Error("local write unavailable"); } });
  const attention = await harness.processor.process("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(attention.status, "attention");
  assert.match(attention.lastError || "", /local finalization needs attention/u);
  assert.equal(harness.state.command.steps[0].status, "posted");
});

test("P6/P8 verification rejects a wrong source, external ID, transaction type, extra line, or quantity", () => {
  const targetStep = step();
  assert.deepEqual(verifyOperatorNetSuitePostingRecord(targetStep, remoteRecord(targetStep)), {
    id: 8001,
    transactionRef: "IF8001"
  });
  const invalid = [
    { ...remoteRecord(targetStep), createdFromId: 999 },
    { ...remoteRecord(targetStep), externalId: "different" },
    { ...remoteRecord(targetStep), transactionType: "IR" },
    { ...remoteRecord(targetStep), item: { items: [{ orderLine: 1, quantity: 3, itemReceive: true }] } },
    { ...remoteRecord(targetStep), item: { items: [{ orderLine: 1, quantity: 2, itemReceive: true }, { orderLine: 2, quantity: 1, itemReceive: true }] } }
  ];
  for (const record of invalid) {
    assert.throws(
      () => verifyOperatorNetSuitePostingRecord(targetStep, record),
      (error) => error?.code === "OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH"
    );
  }
  assert.equal(isAmbiguousOperatorNetSuiteFailure({ code: "NETSUITE_REQUEST_TIMEOUT" }), true);
  assert.equal(isAmbiguousOperatorNetSuiteFailure({ status: 503, netsuiteResponseReceived: true }), true);
  assert.equal(isAmbiguousOperatorNetSuiteFailure({ status: 400, netsuiteResponseReceived: true }), false);
  assert.equal(isAmbiguousOperatorNetSuiteFailure({ status: 408 }), true);
  assert.equal(isAmbiguousOperatorNetSuiteFailure({ status: 429 }), true);
  assert.equal(isAmbiguousOperatorNetSuiteFailure({ code: "OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH" }), true);
  assert.equal(isAmbiguousOperatorNetSuiteFailure(null), true);
});
