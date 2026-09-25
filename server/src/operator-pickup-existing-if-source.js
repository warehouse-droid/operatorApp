// @ts-check
import { fetchTransactionStatusesFromNetSuite, fetchOperatorNetSuiteSourceItemLinesFromNetSuite,
  fetchPoToLinkedTransactionsFromNetSuite, fetchItemFulfillmentFromNetSuite } from './netsuite.js';
import { operatorNetSuiteRequestPool } from './operator-netsuite-request-pool.js';
import { pickupEvidenceError, resolvePickupExistingFulfillment } from './operator-pickup-existing-if-domain.js';

/** @param {any} value */
function sourceId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) { throw pickupEvidenceError('A positive source SO ID is required.'); }
  return id;
}

/** @param {any} dependencies */
export function createPickupExistingFulfillmentReader({ fetchStatuses, fetchSourceItems, fetchLinkedTransactions, fetchFulfillment }) {
  return async (/** @type {any} */ input) => {
    const id = sourceId(input.sourceNetSuiteId);
    const statuses = await fetchStatuses([id], 'SalesOrd');
    if (statuses.length !== 1 || Number(statuses[0].id) !== id || statuses[0].tranid !== input.sourceOrderRef) {
      throw pickupEvidenceError('The current source SO could not be read exactly.');
    }
    const status = (String(statuses[0].status_text || '').split(':').at(-1) || '').trim().toLowerCase();
    if (['closed', 'cancelled', 'canceled', 'rejected'].includes(status)) { throw pickupEvidenceError('The source SO is closed.'); }
    if (!['billed', 'pending billing'].includes(status)) {
      if (!/pending|partially/u.test(status)) { throw pickupEvidenceError('The source SO status is not verifiable.'); }
      return null;
    }
    const sourceItems = await fetchSourceItems('SO', id);
    const links = await fetchLinkedTransactions([id]);
    const selectedKeys = new Set(input.selectedItems.map((/** @type {any} */ row) => String(row.orderLine)));
    const relevant = links.filter((/** @type {any} */ row) => selectedKeys.has(String(row.sourceLineKey)));
    const ids = [...new Set(relevant.map((/** @type {any} */ row) => Number(row.transactionId)))];
    if (ids.some(value => !Number.isSafeInteger(value) || Number(value) <= 0)) { throw pickupEvidenceError('An IF ID is invalid.'); }
    const records = [];
    for (const transactionId of ids) { records.push(await fetchFulfillment(transactionId)); }
    return resolvePickupExistingFulfillment({ ...input, sourceItems, links: relevant, records });
  };
}

export const fetchPickupExistingFulfillment = createPickupExistingFulfillmentReader({
  fetchStatuses: (/** @type {any[]} */ ids, /** @type {string} */ type) => operatorNetSuiteRequestPool.run(() => fetchTransactionStatusesFromNetSuite(ids, type)),
  fetchSourceItems: (/** @type {string} */ kind, /** @type {number} */ id) => operatorNetSuiteRequestPool.run(() => fetchOperatorNetSuiteSourceItemLinesFromNetSuite(kind, id)),
  fetchLinkedTransactions: (/** @type {any[]} */ ids) => operatorNetSuiteRequestPool.run(() => fetchPoToLinkedTransactionsFromNetSuite(ids)),
  fetchFulfillment: (/** @type {number} */ id) => operatorNetSuiteRequestPool.run(() => fetchItemFulfillmentFromNetSuite(id))
});
