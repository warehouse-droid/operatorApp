export const pickupMutants = {
  wrongSource: ['id(record.createdFrom ?? record.createdfrom) === Number(e.sourceNetSuiteId)', 'true'],
  wrongItem: ['id(item.item) === Number(local.item_id)', 'true'],
  wrongLocation: ['id(item.location) === location', 'true'],
  wrongUnit: ["String(item.units ?? '') === String(source.units ?? '')", 'true'],
  wrongQuantity: ['!equalQuantity(completed, context.source.quantity)', 'false'],
  unshipped: ["label(link.statusText).replace(/\\s*:\\s*/gu, ':') === 'ITEM FULFILLMENT:SHIPPED'", 'true'],
  missingReference: ['return [...transactions.values()].sort((a, b) => a.transactionId - b.transactionId);', 'return [];']
};
