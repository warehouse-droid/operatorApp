// PO-only items: vendor fees (such as a split fee) or other items SCM orders on the PO.
// They are ancillary PO lines, never SO lines, and need no Sales decision.
// Shared by the SCM page and the server.

/** Status of an item SCM added after the PO existed. Items sent with the PO at creation have none. */
export const SPECIAL_ADDED_PO_ITEM_STATUSES = Object.freeze(['pending', 'synced', 'attention', 'local']);
const NOT_ON_NETSUITE_PO = new Set(['pending', 'attention', 'local']);

/** @param {Record<string,any>} line */
export function specialPurchaseItemOnNetSuitePo(line) {
  return !NOT_ON_NETSUITE_PO.has(line?.poSyncStatus);
}

/** Every PO-only item of the request, excluding the PALLET line (it has its own editor).
 * @param {Record<string,any>|null|undefined} detail @returns {Array<Record<string,any>>} */
export function specialPurchaseOnlyItems(detail) {
  return (detail?.purchaseOrderLines || []).filter(/** @param {Record<string,any>} line */ line => line.ancillary && Number(line.itemId) !== 1784);
}

/** Where a newly added item goes: the NetSuite PO this application created, or a record for SCM only.
 * @param {Record<string,any>} detail @returns {'netsuite'|'local'} */
export function specialAddedPurchaseItemMode(detail) {
  return detail.purchaseOrderId && !detail.purchaseOrderSkipped && detail.purchaseOrderCreatedByApp ? 'netsuite' : 'local';
}

/** Why SCM cannot add a PO item to the existing PO now, or '' when it can. The server re-checks.
 * @param {Record<string,any>|null|undefined} detail */
export function specialAddedPurchaseItemBlocker(detail) {
  if (!detail || detail.workflowKind === 'backorder') return 'Only Special requests support SCM-added PO items.';
  if (!detail.purchaseOrderId && !detail.purchaseOrderSkipped) return 'Before the PO is created, add PO-only items in the Purchase Order review.';
  if (detail.closeStatus !== 'active' || detail.operationallyComplete || ['closed', 'completed'].includes(detail.stage)) return 'This request is closed or completed.';
  if (detail.informationRequest?.status === 'pending') return 'Sales must submit the requested information first.';
  if (['applying', 'attention'].includes(detail.quantityReview?.status) || ['applying', 'attention'].includes(detail.fulfillmentChange?.status)
    || [detail.salesOrderOperationStatus, detail.purchaseOrderOperationStatus].some(status => ['creating', 'attention'].includes(status))) {
    return 'Resolve the current NetSuite operation first.';
  }
  if (specialPurchaseOnlyItems(detail).some(line => ['pending', 'attention'].includes(line.poSyncStatus))) {
    return 'Finish the NetSuite PO update of the previously added item first.';
  }
  return '';
}
