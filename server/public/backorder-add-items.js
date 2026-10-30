// @ts-check
import {isBackorder} from './backorder-workflow.js';
import {canAddSpecialItems} from './special-stock-request-actions.js';

/** @param {Record<string,any>|null|undefined} request */
export function canAddBackorderItems(request) {
  return Boolean(request && isBackorder(request) && canAddSpecialItems(request)
    && ['submitted','active'].includes(request.status) && !['closed','completed'].includes(request.stage)
    && !request.salesOrderRef && !request.purchaseOrderRef && !request.alreadyOrderedSalesOrderRef
    && request.lines?.length > 0 && request.lines.length < 100);
}

/** @param {Record<string,any>|null|undefined} request @param {boolean} busy */
export function backorderAddItemsButton(request,busy) {
  if (!canAddBackorderItems(request)) return '';
  return `<div class="stock-request-actions special-case-line-actions"><button class="special-add-item-button" type="button" data-sales-stock-action="add-items" ${busy?'disabled':''}>Add item</button></div>`;
}
