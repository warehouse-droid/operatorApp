import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocationAwareIFAdapter } from '../../../src/item-fulfillment-parts-service.js';
import { verifyOperatorNetSuitePostingRecord } from '../../../src/operator-netsuite-posting-adapter.js';
import { createSalesOrderAutoFulfillmentProcessor } from '../../../src/sales-order-auto-fulfillment-service.js';

const step = { externalId: 'MBBS-SOIF-12059800-2026-4918-a014-000000996102', sourceOrderKind: 'SO', sourceNetSuiteId: 996102, transactionType: 'IF',
  payload: { externalId: 'MBBS-SOIF-12059800-2026-4918-a014-000000996102', item: { items: [
    { orderLine: 1, quantity: 2, location: 1, itemReceive: true },
    { orderLine: 3, quantity: 51.26, location: 14, itemReceive: true }
  ] } } };
function rejection() { return Object.assign(new Error('All fulfilled items must have the same location.'), {
  status: 400, netsuiteResponseReceived: true,
  netsuiteErrorDetails: [{ 'o:errorCode': 'USER_ERROR', detail: 'All fulfilled items must have the same location.' }]
}); }
function setup({ combine = false, failPart = null, uncertain = false } = {}) {
  let plan = null;
  let nextId = 100;
  let failed = false;
  const calls = [], records = new Map();
  const repository = {
    get: async () => structuredClone(plan),
    create: async (_step, parts) => {
      plan ||= { parts: parts.map((p, i) => ({ ...p, id: i + 1, status: 'pending' })) };
      return structuredClone(plan);
    },
    claim: async part => {
      const row = plan.parts.find(p => p.id === part.id);
      if (!['pending', 'failed'].includes(row.status)) return { ...structuredClone(row), fresh: false };
      row.status = 'posting'; row.attemptToken = `attempt-${nextId}`;
      return { ...structuredClone(row), fresh: true };
    },
    complete: async (part, record) => {
      Object.assign(plan.parts.find(p => p.id === part.id), { status: 'posted', transactionId: Number(record.id),
        transactionRef: record.tranId, response: structuredClone(record) });
    },
    fail: async (part, error, ambiguous) => { Object.assign(plan.parts.find(p => p.id === part.id), {
      status: ambiguous ? 'uncertain' : 'failed', lastError: error.message }); }
  };
  const adapter = {
    findByExternalId: async s => [...records.values()].find(r => r.externalId === s.externalId) || null,
    fetchById: async (_s, id) => records.get(id) || null,
    verify: verifyOperatorNetSuitePostingRecord,
    transform: async s => {
      calls.push(s.externalId);
      if (s.externalId === step.externalId && !combine) throw rejection();
      if (s.externalId.endsWith(`-L${failPart}`) && !failed) {
        failed = true;
        throw Object.assign(new Error(uncertain ? 'timeout' : 'Insufficient stock'), uncertain
          ? { ambiguous: true } : { status: 400, netsuiteResponseReceived: true });
      }
      const id = ++nextId;
      records.set(id, { id, externalId: s.externalId, tranId: `IF${id}`, createdFromId: s.sourceNetSuiteId,
        transactionType: 'IF', item: { items: s.payload.item.items.filter(i => i.itemReceive !== false) } });
      return { id };
    }
  };
  return { wrapped: createLocationAwareIFAdapter({ adapter, repository }), adapter, repository, records, calls,
    plan: () => structuredClone(plan) };
}
test('P1 accepted mixed locations create exactly one IF', async () => {
  const env = setup({ combine: true });
  const result = await env.wrapped.transform(step);
  const record = await env.wrapped.fetchById(step, result.id);
  assert.equal(env.wrapped.verify(step, record).id, result.id);
  assert.deepEqual(env.calls, [step.externalId]); assert.equal(env.plan(), null);
});
test('P2 explicit location rejection creates and verifies two durable parts', async () => {
  const env = setup();
  const result = await env.wrapped.transform(step);
  const record = await env.wrapped.fetchById(step, result.id);
  assert.equal(env.wrapped.verify(step, record).id, result.id);
  assert.equal(record.fulfillmentParts.length, 2);
  assert.deepEqual(record.fulfillmentParts.map(p => p.inventoryLocationIds), [[1], [14]]);
  assert.deepEqual(env.calls, [step.externalId, `${step.externalId}-L1`, `${step.externalId}-L14`]);
});
test('P3 a definitive second-part failure retries only that part', async () => {
  const env = setup({ failPart: 14 });
  await assert.rejects(env.wrapped.transform(step), /stock/);
  assert.deepEqual(env.plan().parts.map(p => p.status), ['posted', 'failed']);
  const restarted = createLocationAwareIFAdapter({ adapter: env.adapter, repository: env.repository });
  const result = await restarted.transform(step);
  assert.equal((await restarted.fetchById(step, result.id)).fulfillmentParts.length, 2);
  assert.deepEqual(env.calls, [step.externalId, `${step.externalId}-L1`, `${step.externalId}-L14`, `${step.externalId}-L14`]);
});
test('P4 an uncertain part is never transformed again without recovery', async () => {
  const env = setup({ failPart: 14, uncertain: true });
  await assert.rejects(env.wrapped.transform(step), /timeout/);
  const calls = [...env.calls];
  await assert.rejects(env.wrapped.transform(step), /verif|uncertain|recover/i);
  assert.deepEqual(env.calls, calls);
});
test('P5 unrelated rejection and timeout never create a split plan', async () => {
  for (const error of [Object.assign(new Error('Forbidden location'), { status: 403, netsuiteResponseReceived: true }),
    Object.assign(new Error('timeout'), { ambiguous: true })]) {
    const env = setup(); env.adapter.transform = async () => { throw error; };
    await assert.rejects(env.wrapped.transform(step), error);
    assert.equal(env.plan(), null);
  }
});
test('P6 an original IF discovered after rejection prevents splitting', async () => {
  const env = setup();
  env.records.set(77, { id: 77, externalId: step.externalId, tranId: 'IF77', createdFromId: step.sourceNetSuiteId,
    transactionType: 'IF', item: step.payload.item });
  const result = await env.wrapped.transform(step);
  assert.equal(result.id, 77); assert.equal(env.plan(), null);
  assert.equal(env.calls.length, 1);
});

test('P7 concurrent split recovery posts each part once', async () => {
  const env = setup({ failPart: 14 });
  await assert.rejects(env.wrapped.transform(step), /stock/);
  const results = await Promise.allSettled([env.wrapped.transform(step), env.wrapped.transform(step), env.wrapped.transform(step)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(env.calls.filter(id => id.endsWith('-L1')).length, 1);
  assert.equal(env.calls.filter(id => id.endsWith('-L14')).length, 2);
  assert.deepEqual(env.plan().parts.map(part => part.status), ['posted', 'posted']);
});

test('P8 a timeout after a committed part recovers the exact IF without another POST', async () => {
  const env = setup(), transform = env.adapter.transform;
  env.adapter.transform = async target => {
    const result = await transform(target);
    if (target.externalId.endsWith('-L14')) { throw Object.assign(new Error('connection lost after commit'), { ambiguous: true }); }
    return result;
  };
  await env.wrapped.transform(step);
  assert.deepEqual(env.plan().parts.map(part => part.status), ['posted', 'posted']);
  assert.deepEqual(env.calls, [step.externalId, `${step.externalId}-L1`, `${step.externalId}-L14`]);
});

test('P9 recovered part with changed source or location cannot complete', async () => {
  for (const wrongSource of [true, false]) {
    const env = setup({ failPart: 14 });
    await assert.rejects(env.wrapped.transform(step), /stock/);
    const record = [...env.records.values()][0];
    if (wrongSource) { record.createdFromId = 999; } else { record.item.items[0].location = 14; }
    const calls = [...env.calls];
    await assert.rejects(env.wrapped.transform(step), /source|location/i);
    assert.deepEqual(env.calls, calls);
  }
});

test('P10 delivery recovery retains both original parts after the first location is fulfilled', async () => {
  const env = setup({ failPart: 14 });
  const candidate = { id: 'delivery-test', externalId: step.externalId, sourceSalesOrderId: 996102, status: 'queued',
    resolutionAction: 'automatic', lineSnapshot: [
      { orderLine: 1, itemId: 11, deliveredQuantity: 2, location: 1 },
      { orderLine: 3, itemId: 33, deliveredQuantity: 51.26, location: 14 }
    ] };
  let evidence;
  const asStep = c => ({ ...step, payload: c.payload });
  const repository = {
    prepare: async () => candidate, get: async () => candidate,
    claim: async ({ payload, liveOrder, selectedLines }) => Object.assign(candidate, { payload, liveSnapshot: { ...liveOrder, selectedLines }, leaseToken: 'one', status: 'posting' }),
    renew: async () => true, startAttempt: async () => ({ attemptNumber: 1 }),
    failure: async ({ uncertain }) => Object.assign(candidate, { status: uncertain ? 'uncertain' : 'failed' }),
    complete: async result => { evidence = result; return Object.assign(candidate, { status: 'completed' }); },
    attention: async () => Object.assign(candidate, { status: 'attention' }),
    closed: async () => Object.assign(candidate, { status: 'closed' }),
    reconciled: async () => Object.assign(candidate, { status: 'reconciled' })
  };
  const processor = createSalesOrderAutoFulfillmentProcessor({ repository, workerId: 'restarted-driver-worker',
    fetchLiveOrder: async () => ({ closed: false, lines: candidate.lineSnapshot.map(line => ({ ...line,
      remainingQuantity: line.orderLine === 1 && env.records.size ? 0 : line.deliveredQuantity,
      fulfilledQuantity: line.orderLine === 1 && env.records.size ? 2 : 0 })) }),
    adapter: {
      hasSplitPlan: c => env.wrapped.hasSplitPlan(asStep(c)),
      findByExternalId: c => env.wrapped.findByExternalId(asStep(c)),
      fetchById: (c, id) => env.wrapped.fetchById(asStep(c), id),
      transform: (c, payload) => env.wrapped.transform({ ...asStep(c), payload }),
      verify: (c, record, payload) => env.wrapped.verify({ ...asStep(c), payload }, record)
    } });
  assert.equal((await processor.process(candidate.id)).status, 'uncertain');
  candidate.resolutionAction = 'recover';
  assert.equal((await processor.process(candidate.id)).status, 'completed');
  assert.equal(evidence.response.fulfillmentParts.length, 2);
  assert.deepEqual(env.calls, [step.externalId, `${step.externalId}-L1`, `${step.externalId}-L14`, `${step.externalId}-L14`]);
});

test('P11 a missing transform identity recovers by the retained part external ID', async () => {
  const env = setup(), transform = env.adapter.transform;
  env.adapter.transform = async target => {
    const result = await transform(target);
    return target.externalId.endsWith('-L14') ? {} : result;
  };
  const result = await env.wrapped.transform(step);
  assert.equal((await env.wrapped.fetchById(step, result.id)).fulfillmentParts.length, 2);
  assert.deepEqual(env.calls, [step.externalId, `${step.externalId}-L1`, `${step.externalId}-L14`]);
});

test('P12 an unidentifiable part response freezes its attempt and cannot be posted again', async () => {
  const env = setup(), transform = env.adapter.transform;
  env.adapter.transform = async target => {
    if (target.externalId.endsWith('-L14')) { env.calls.push(target.externalId); return {}; }
    return transform(target);
  };
  await assert.rejects(env.wrapped.transform(step), /no verifiable IF part/);
  assert.deepEqual(env.plan().parts.map(part => part.status), ['posted', 'uncertain']);
  const calls = [...env.calls];
  await assert.rejects(env.wrapped.transform(step), /verification/);
  assert.deepEqual(env.calls, calls);
});
