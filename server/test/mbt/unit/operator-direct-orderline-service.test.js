import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { createOperatorNetSuitePostingProcessor } from "../../../src/operator-netsuite-posting-service.js";
import { verifyOperatorNetSuitePostingRecord } from "../../../src/operator-netsuite-posting-adapter.js";
import { createOperatorNetSuitePostingAdapter } from "../../../src/operator-netsuite-posting-netsuite-adapter.js";
import { findOperatorNetSuitePostingTransactionByExternalId } from "../../../src/netsuite.js";

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
      return { attemptNumber, fresh: attemptNumber === 1, step: structuredClone(target) };
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


function direct(harness) {
  harness.state.command.inputSnapshot.postingStrategy = "stored_order_line_v1";
  return harness;
}

for (const kind of ["IF", "IR"]) {
  test(`${kind}: a fresh direct command transforms once without an external-ID scan`, async () => {
    const selected = step(); selected.transactionType = kind;
    selected.sourceOrderKind = kind === "IR" ? "PO" : "SO";
    const h = direct(processorHarness({ steps: [selected], find: () => { throw new Error("History lookup on fresh posting"); } }));
    const result = await h.processor.process(h.state.command.id);
    assert.equal(result.status, "completed");
    assert.deepEqual(h.calls, { find: 0, transform: 1, fetch: 1, finalize: 1 });
  });

  test(`${kind}: a read from the known endpoint verifies when the type is absent`, async () => {
    const selected = step(); selected.transactionType = kind;
    const raw = remoteRecord(selected); delete raw.transactionType;
    const adapter = createOperatorNetSuitePostingAdapter({ fetchItemFulfillment: async () => raw, fetchItemReceipt: async () => raw });
    const record = await adapter.fetchById(selected, raw.id);
    assert.equal(adapter.verify(selected, record).id, raw.id);
    raw.transactionType = kind === "IF" ? "IR" : "IF";
    await assert.rejects(async () => adapter.verify(selected, await adapter.fetchById(selected, raw.id)), { code: "OPERATOR_NETSUITE_POSTING_REMOTE_MISMATCH" });
  });

  test(`${kind}: recovery uses exact REST external ID with no transaction history`, async () => {
    const selected = step(); selected.transactionType = kind;
    const paths = []; const raw = remoteRecord(selected);
    const found = await findOperatorNetSuitePostingTransactionByExternalId(selected.externalId, kind, selected.sourceNetSuiteId, {
      direct: true,
      queryAll: () => { throw new Error("History query forbidden"); },
      rest: async (path, options) => { paths.push([path, options.method]); return { data: raw }; }
    });
    assert.equal(found.id, raw.id);
    assert.equal(found.record, raw);
    assert.deepEqual(paths, [[`/record/v1/${kind === "IF" ? "itemFulfillment" : "itemReceipt"}/eid:${selected.externalId}?expandSubResources=true`, "GET"]]);
  });
}

test("an uncertain direct attempt with no recovery match cannot submit another transform", async () => {
  const h = direct(processorHarness());
  h.state.command.steps[0].status = "uncertain";
  h.state.command.steps[0].attemptCount = 1;
  const result = await h.processor.process(h.state.command.id);
  assert.equal(result.status, "attention");
  assert.equal(h.calls.transform, 0); assert.equal(h.calls.finalize, 0);
});

test("five independent direct steps run with a maximum of three concurrent operations", async () => {
  let active = 0, peak = 0;
  const h = direct(processorHarness({ steps: Array.from({length:5}, (_, i) => step(i+1, 901+i)),
    transform: async s => { active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,20)); active--; return {id:8000+s.id}; }
  }));
  const result = await h.processor.process(h.state.command.id);
  assert.equal(result.status, "completed"); assert.equal(peak,3);
  assert.equal(h.calls.transform,5); assert.equal(h.calls.finalize,1);
});

test("direct recovery distinguishes missing external ID from permissions and server failures", async () => {
  const selected=step();
  const lookup=error=>findOperatorNetSuitePostingTransactionByExternalId(selected.externalId,"IR",901,{
    direct:true,queryAll:()=>{throw new Error("history forbidden");},rest:async()=>{throw error;}
  });
  assert.equal(await lookup(Object.assign(new Error("missing"),{status:404,netsuiteErrorCodes:["NONEXISTENT_EXTERNAL_ID"]})),null);
  for(const status of [403,429,500]) {await assert.rejects(lookup(Object.assign(new Error("denied"),{status})), /denied/);}
});

test("property: every resumed direct attempt is recovery-only unless its exact remote record is found", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:8}),fc.boolean(),async(attemptCount,found)=>{
    const h=direct(processorHarness({find:s=>found?remoteRecord(s):null}));
    Object.assign(h.state.command.steps[0],{attemptCount,status:"uncertain"});
    const result=await h.processor.process(h.state.command.id);
    assert.equal(result.status,found?"completed":"attention");
    assert.equal(h.calls.transform,0); assert.equal(h.calls.finalize,found?1:0);
  }),{seed:160916,numRuns:24});
});

test("property: fresh direct commands never need duplicate lookup and preserve all exact quantities",async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:10000}),async(quantity)=>{
    const selected=step();selected.payload.item.items[0].quantity=quantity;
    const h=direct(processorHarness({steps:[selected],find:()=>{throw new Error("unexpected lookup");},fetchById:(s,id)=>{
      const record=remoteRecord(s,id);record.item.items[0].quantity=quantity;return record;
    }}));
    assert.equal((await h.processor.process(h.state.command.id)).status,"completed");
    assert.equal(h.calls.find,0);assert.equal(h.calls.transform,1);
  }),{seed:160917,numRuns:24});
});

test("a malformed rejected remote promise cannot finalize a partial direct batch", async () => {
  const h = direct(processorHarness({ transform: async () => { throw null; } }));
  const result = await h.processor.process(h.state.command.id);
  assert.equal(result.status, "attention");
  assert.equal(h.calls.finalize, 0);
});

test("runtime recovery selects the fast lookup only for the direct snapshot strategy", async () => {
  const calls = [];
  const adapter = createOperatorNetSuitePostingAdapter({ findTransactionByExternalId: async (...args) => { calls.push(args); return null; } });
  const selected = step();
  await adapter.findByExternalId(selected);
  await adapter.findByExternalId(selected, true);
  assert.deepEqual(calls, [
    [selected.externalId, selected.transactionType, selected.sourceNetSuiteId],
    [selected.externalId, selected.transactionType, selected.sourceNetSuiteId, {direct: true}]
  ]);
});

test("a verification permission error after a successful transform keeps the order on hold", async () => {
  const denied = () => {throw Object.assign(new Error("Read permission denied"), {status:403,netsuiteResponseReceived:true});};
  const h = direct(processorHarness({fetchById:denied,find:denied}));
  const result = await h.processor.process(h.state.command.id);
  assert.equal(result.status, "attention");
  assert.equal(h.calls.transform, 1);
  assert.equal(h.calls.finalize, 0);
  assert.equal(h.state.failures[0].uncertain, true);
});

test("property: recovery read failures cannot turn an uncertain posting into a safe rejection", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(400,403,404,429,500),fc.boolean(),async(status,resumed)=>{
    const denied=()=>{throw Object.assign(new Error("Cannot verify"),{status,netsuiteResponseReceived:true});};
    const h=direct(processorHarness({fetchById:denied,find:denied}));
    if(resumed) {Object.assign(h.state.command.steps[0],{attemptCount:1,status:"uncertain"});}
    const result=await h.processor.process(h.state.command.id);
    assert.equal(result.status,"attention");
    assert.equal(h.calls.transform,resumed?0:1);
    assert.equal(h.calls.finalize,0);
    assert.equal(h.state.failures[0].uncertain,true);
  }),{seed:160922,numRuns:20});
});
