// @ts-check
/** @param {Record<string,any>|null|undefined} request */
export function canAddRegularItems(request) {
  if (!request || request.requestType !== 'regular' || !['submitted', 'active'].includes(request.status)) return false;
  const regular = request.regular || {};
  if (['backorder', 'waitlist'].includes(regular.deliveryMethod) || regular.deliveryVersion === 1) return false;
  if (regular.salesOrderId || regular.salesOrderRef || regular.handoffStatus || regular.pickupTransfer || regular.resolution) return false;
  if (request.transfers?.length) return false;
  return Boolean(request.lines?.length && request.lines.every((/** @type {Record<string,any>} */ line) =>
    ['submitted', 'approved', 'changes_requested', 'rejected'].includes(line.status)
    && !line.transferId && !line.purchase?.demandId && !line.resolution && !line.yardStock));
}

/** Preserve item evidence and conversation history while restarting review.
 * @param {Record<string,any>} regular */
export function resetRegularItemReview(regular) {
  return {...regular, approvedAt: null, approvalExpiresAt: null, replyStatus: null,
    approval: {...regular.approval, automatic: false},
    ...(regular.stockingLines ? {stockingLines: Object.fromEntries(Object.entries(regular.stockingLines)
      .map(([id, state]) => [id, {...state, replyStatus: null}]))} : {})};
}

/** @param {Record<string,any>|null} request @param {boolean} busy */
export function regularAddItemsButton(request, busy) {
  if (!request || !canAddRegularItems(request) || request.lines.length >= 100) return '';
  return `<div class="stock-request-actions special-case-line-actions"><button class="special-add-item-button" type="button" data-sales-stock-action="add-items" ${busy ? 'disabled' : ''}>Add item</button></div>`;
}
