import { readFileSync } from 'node:fs';
import { createOperatorNetSuitePostingAdapter } from '../../src/operator-netsuite-posting-netsuite-adapter.js';

export function fixture() {
  const input = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
  input.step = input.command.steps[0];
  input.receipt.transactionType = 'IR';
  input.receipt.item.items.forEach(line => { line.orderDoc = { id: String(input.source.id) }; });
  return input;
}

export function adapterFixture(input = fixture(), { inline = true, sourceError = false } = {}) {
  const calls = { find: 0, fetch: 0, source: 0, transform: 0 };
  const unexpected = async () => { throw new Error('Unexpected transform'); };
  const adapter = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: async () => {
      calls.find++;
      return { id: input.receipt.id, tranid: input.receipt.tranId, externalid: input.receipt.externalId,
        createdfrom: input.source.id, ...(inline ? { record: structuredClone(input.receipt) } : {}) };
    },
    fetchItemReceipt: async () => { calls.fetch++; return structuredClone(input.receipt); },
    fetchItemFulfillment: async () => { calls.fetch++; return structuredClone(input.receipt); },
    fetchPurchaseReceiptSource: async () => {
      calls.source++;
      if (sourceError) { throw new Error('Temporary source read failure'); }
      return structuredClone(input.source);
    },
    transformPurchaseOrderToItemReceipt: async () => { calls.transform++; return { id: Number(input.receipt.id) }; },
    transformSalesOrderToItemFulfillment: unexpected,
    transformTransferOrderToItemFulfillment: unexpected,
    transformTransferOrderToItemReceipt: unexpected
  });
  return { input, adapter, calls };
}
