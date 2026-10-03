/* global HTMLElement */
import {torontoDate} from './special-stock-workflow.js';
import {defaultSpecialExpiry} from './special-stock-expiry.js';
import {savedSpecialDeliveryFee} from './special-stock-delivery-fee.js';

/** @param {Record<string, any>|null|undefined} detail */
export function canAddSpecialItems(detail) {
  return Boolean(detail && detail.closeStatus === 'active' && !detail.operationallyComplete
    && !detail.salesOrderId && !detail.purchaseOrderId && !detail.salesOrderSkipped && !detail.purchaseOrderSkipped
    && !detail.salesOrderSubmissionStartedAt && !detail.purchaseOrderSubmissionStartedAt && !detail.attention
    && !detail.quantityReviewPending
    && !['pending','applying','attention'].includes(detail.fulfillmentChange?.status)
    && ![detail.salesOrderOperationStatus,detail.purchaseOrderOperationStatus].some(status => ['creating','attention'].includes(status)));
}

const copiedHeaderFields = ['customerName','customerPhone','vendorName','remarks','salesInternalRemark','fulfillmentMethod',
  'deliveryAddress','deliveryContactName','deliveryContactPhone','deliveryDate','windowStart','windowEnd','deliveryInstructions'];
const copiedLineFields = ['brand','productName','color','size','detailSpec','quantity','uom','discountPercent',
  'palletQty','layerQty','sectionQty','pieceQty','requiredDate','customerNote','estimateLineReference'];

/** @param {Record<string, any>&{lines:Array<Record<string,any>>}} detail @param {{today?:string, expiresOn?:string}} options */
export function copySpecialRequestDraft(detail, {today = torontoDate(), expiresOn = defaultSpecialExpiry(today)} = {}) {
  return {
    ...Object.fromEntries(copiedHeaderFields.map(field => [field,detail[field] ?? ''])),
    storeLocationId: String(detail.storeLocationId), inquiryDate: today, expiresOn,
    customerId: String(detail.customerId ?? ''), vendorId: String(detail.vendorId ?? ''),
    salesRepId: String(detail.netsuiteSalesRepId ?? ''), estimateId: String(detail.estimateId ?? ''),
    palletTotal: detail.palletTotal ?? 0, palletRate: detail.palletRate ?? '',
    deliveryFeeRate: savedSpecialDeliveryFee(detail) ?? '',
    selectedCustomerName: detail.customerName || '', selectedCustomerPhone: detail.customerPhone || '',
    selectedVendorName: detail.vendorName || '',
    lines: detail.lines.map(line => ({
      ...Object.fromEntries(copiedLineFields.map(field => [field,line[field] ?? ''])),
      key: crypto.randomUUID(), rate: line.originalRate ?? line.rate ?? ''
    }))
  };
}

/** @returns {Promise<boolean>} */
export function confirmSpecialAddItems() {
  const focus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'regular-stock-dialog special-add-items-warning';
  dialog.setAttribute('aria-labelledby','specialAddItemsTitle');
  dialog.setAttribute('aria-describedby','specialAddItemsMessage');
  dialog.innerHTML = `<div class="special-add-items-warning-icon" aria-hidden="true">!</div>
    <h2 id="specialAddItemsTitle">Add items to this request?</h2>
    <p id="specialAddItemsMessage">Adding new items will make this request become a new request again. Existing items’ names, prices and stock information will be saved. This action can only be done before creating a Sales Order.</p>
    <div class="regular-dialog-actions"><button type="button" data-special-add-cancel>Cancel</button><button type="button" class="special-add-item-button" data-special-add-continue>Continue</button></div>`;
  document.body.append(dialog);
  return new Promise(resolve => {
    /** @param {boolean} confirmed */
    const finish = confirmed => {
      dialog.close(); dialog.remove();
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
      resolve(confirmed);
    };
    /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-special-add-cancel]')).addEventListener('click',() => finish(false));
    /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-special-add-continue]')).addEventListener('click',() => finish(true));
    dialog.addEventListener('cancel',event => { event.preventDefault(); finish(false); });
    dialog.showModal();
    /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-special-add-cancel]')).focus();
  });
}
