import { createOperatorNetSuitePostingProcessor } from '../../src/operator-netsuite-posting-service.js';
import { createOperatorNetSuitePostingAdapter } from '../../src/operator-netsuite-posting-netsuite-adapter.js';
import { normalizeOperatorKitSource, mapOperatorKitSelections } from '../../src/operator-netsuite-posting-kits.js';
import { sobFixture, kitDraft } from './operator-kit-fixture.mjs';

export function kitRemote(step, id = 8001) {
  return { id, tranId: `IF${id}`, transactionType: 'IF', externalId: step.externalId, createdFromId: step.sourceNetSuiteId,
    item: { items: step.payload.item.items.filter(line => line.itemReceive).map(line => ({ ...line,
      item: { id: String(line.orderLine === 2 ? 10126 : 2141) } })) } };
}

export function kitServiceHarness({ find, transform, readSource, remote, attemptCount = 0 } = {}) {
  const fixture = sobFixture();
  const source = normalizeOperatorKitSource(fixture.evidence);
  const draft = kitDraft(source, mapOperatorKitSelections(source, fixture.selected));
  const command = { ...draft, id: draft.requestId, status: 'queued', steps: [{ ...draft.steps[0], id: 1, status: 'pending', attemptCount }] };
  const calls = [];
  const repository = {
    get: async () => command,
    claim: async () => { if (command.status !== 'queued') { return null; } command.status = 'posting'; return command; },
    renew: async () => command,
    startAttempt: async () => { const step = command.steps[0]; step.attemptCount++; return { fresh: step.attemptCount === 1, attemptNumber: step.attemptCount }; },
    success: async value => Object.assign(command.steps[0], { status: 'posted', netSuiteTransactionId: value.transactionId, netSuiteTransactionRef: value.transactionRef }),
    failure: async value => { command.steps[0].status = value.uncertain ? 'uncertain' : 'failed'; command.error = value.error; return command.steps[0]; },
    fail: async () => { command.status = 'failed'; return command; },
    attention: async () => { command.status = 'attention'; return command; },
    complete: async ({ finalize }) => { await finalize(); command.status = 'completed'; return command; }
  };
  const adapter = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async () => { calls.push('find'); return find ? find(command.steps[0], calls) : null; },
    fetchKitSource: async () => { calls.push('source'); return readSource ? readSource(source) : source; },
    transformSalesOrderToItemFulfillment: async (_id, payload) => { calls.push('post'); return transform ? transform(payload) : { id: 8001 }; },
    fetchItemFulfillment: async () => { calls.push('fetch'); return remote ? remote(command.steps[0]) : kitRemote(command.steps[0]); }
  });
  const processor = createOperatorNetSuitePostingProcessor({ repository, adapter,
    finalize: async () => { calls.push('finalize'); return { loaded: true }; }, workerId: 'kit-worker' });
  return { command, calls, processor, adapter, source };
}
