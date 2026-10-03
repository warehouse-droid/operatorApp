/* global HTMLElement */
import { canAddSpecialItems } from './special-stock-request-actions.js';
import { normalizeSpecialRate, specialQuantity, specialPalletQuantity, specialLineSubtotal, specialDiscountLineSubtotal } from './special-stock-pricing.js';
import { savedSpecialDeliveryFee } from './special-stock-delivery-fee.js';

/** @typedef {{lineId:number,productName:string,quantity:number,rate:number,nameChanged:boolean,quantityChanged:boolean,rateChanged:boolean}} CaseLineEdit */
/** @typedef {{expectedRevision:number,lines:Array<{lineId:number,productName:string,quantity:number|string,rate:number|string}>,decisions:Array<{lineId:number,declined:boolean}>,pallet:{quantity:number|string,rate:number|string|null},deliveryFeeRate?:number|string|null}} CaseEditDraft */

/** @param {Record<string,any>|null} detail */
export function canEditSpecialCaseLines(detail) {
  return canAddSpecialItems(detail) && detail?.status !== 'cancelled';
}

/** @param {Record<string,any>} detail */
function currentPallet(detail) {
  const saved = detail.salesOrderLines?.find(/** @param {Record<string,any>} line */ line => line.ancillary && line.itemId === 1784);
  return { quantity: detail.palletTotal ?? saved?.quantity ?? 0, rate: detail.palletRate ?? saved?.rate ?? null };
}

/** @param {Record<string,any>} detail @returns {CaseEditDraft} */
export function specialCaseEditDraft(detail) {
  return { expectedRevision: detail.revision,
    lines: detail.lines.map(/** @param {Record<string,any>} line */ line => ({ lineId: line.id, productName: line.productName,
      quantity: line.packageQuantity ?? line.quantity, rate: line.originalRate ?? '' })),
    decisions: detail.lines.map(/** @param {Record<string,any>} line */ line => ({ lineId: line.id, declined: line.salesDecision === 'declined' })),
    pallet: currentPallet(detail),
    ...(detail.fulfillmentMethod === 'mbt_delivery' ? { deliveryFeeRate: savedSpecialDeliveryFee(detail) } : {}) };
}

/** Only restore a saved decision against the same SCM response.
 * @param {Record<string,any>} line @returns {string} */
export function revokeSpecialLineDecision(line) {
  const previous = line.declineRestore;
  return previous && Number(previous.responseRevision) === Number(line.responseRevision)
    && ['accepted', 'pending', 'request_update'].includes(previous.decision) ? previous.decision : 'pending';
}

/** @param {Record<string,any>} detail @param {string} derivedStage @returns {string} */
export function specialCaseStageAfterEdits(detail, derivedStage) {
  if (['closed', 'completed', 'pending_update'].includes(derivedStage)
    || detail.salesOrderId || detail.purchaseOrderId || detail.salesOrderSkipped || detail.purchaseOrderSkipped) return derivedStage;
  const state = detail.lineEditState;
  return state && Number(state.revision) === Number(detail.revision)
    && ['new_enquiry', 'await_customer_confirmation', 'wait_for_production', 'pending_update'].includes(state.stage) ? state.stage : derivedStage;
}

/** @param {string} message */
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'SPECIAL_CASE_EDIT_INVALID' });

/** @param {Record<string,any>} detail @param {CaseLineEdit[]} changes @param {Record<string,any>} pallet @param {number|null} deliveryFeeRate @param {number} taxBps */
function assertCaseEditTotal(detail, changes, pallet, deliveryFeeRate, taxBps) {
  let gross = 0n, net = 0n;
  for (const line of detail.lines) {
    const change = changes.find(value => value.lineId === line.id);
    const rate = change?.rate ?? line.originalRate;
    if (rate == null) continue;
    const quantity = change?.quantity ?? line.packageQuantity ?? line.quantity;
    gross += BigInt(Math.round(specialLineSubtotal(quantity, rate) * 100));
    net += BigInt(Math.round(specialDiscountLineSubtotal(quantity, rate, line.discountPercent) * 100));
  }
  if (pallet.quantity > 0 && pallet.rate != null) {
    const amount = BigInt(Math.round(specialLineSubtotal(pallet.quantity, pallet.rate) * 100)); gross += amount; net += amount;
  }
  for (const line of detail.salesOrderLines || []) {
    if (line.ancillary && Number(line.itemId) !== 1784 && !(deliveryFeeRate != null && Number(line.itemId) === 1987)) {
      const amount = BigInt(Math.round(specialLineSubtotal(line.quantity, line.rate) * 100)); gross += amount; net += amount;
    }
  }
  if (deliveryFeeRate != null) {
    const amount = BigInt(Math.round(specialLineSubtotal(1, deliveryFeeRate) * 100)); gross += amount; net += amount;
  }
  if (gross > BigInt(Number.MAX_SAFE_INTEGER) || net + (net * BigInt(taxBps) + 5000n) / 10000n > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('The combined quote total is too large.');
}

/** Build a whitelisted edit plan from the saved case, never from client review flags.
 * @param {Record<string,any>} detail @param {Record<string,any>} input
 * @param {{taxBps?:number}} [options]
 * @returns {{lines:CaseLineEdit[],pallet:{quantity:number,rate:number|null}|null,deliveryFeeRate?:number,decisions?:Array<{lineId:number,declined:boolean}>,restart:boolean}}
 */
export function planSpecialCaseEdits(detail, input, { taxBps = 0 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Enter the case line changes.');
  const supplied = input.lines === undefined ? [] : input.lines;
  if (!Array.isArray(supplied) || supplied.length > 100) throw invalid('Edit at most 100 existing case lines.');
  const saved = new Map(detail.lines.map(/** @param {Record<string,any>} line */ line => [Number(line.id), line]));
  const ids = new Set();
  /** @type {CaseLineEdit[]} */
  const lines = [];
  for (const value of supplied) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Enter a valid case line.');
    if (!['number', 'string'].includes(typeof value.lineId)) throw invalid('Enter a valid case line ID.');
    const lineId = Number(value.lineId), before = saved.get(lineId);
    if (!Number.isSafeInteger(lineId) || !before || ids.has(lineId)) throw invalid('Each edited line must belong to this request exactly once.');
    ids.add(lineId);
    if (typeof value.productName !== 'string') throw invalid('Enter a product name.');
    const productName = value.productName.trim().replace(/\r\n?/g, '\n');
    if (!productName || productName.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(productName)) {
      throw invalid('Product name must contain 1 to 500 valid characters.');
    }
    const quantity = specialQuantity(value.quantity);
    const nameChanged = productName !== before.productName, quantityChanged = quantity !== Number(before.packageQuantity ?? before.quantity);
    if (before.originalRate == null && (value.rate == null || value.rate === '') && !nameChanged && !quantityChanged) continue;
    const rate = normalizeSpecialRate(value.rate);
    specialLineSubtotal(quantity, rate, before.discountPercent ?? 0);
    const change = { lineId, productName, quantity, rate, nameChanged, quantityChanged,
      rateChanged: before.originalRate == null || rate !== Number(before.originalRate) };
    if (change.nameChanged || change.quantityChanged || change.rateChanged) lines.push(change);
  }
  /** @type {Array<{lineId:number,declined:boolean}>} */
  const decisions = [];
  if (input.decisions !== undefined) {
    if (!Array.isArray(input.decisions) || input.decisions.length > 100) throw invalid('Edit at most 100 line decisions.');
    const decisionIds = new Set();
    for (const value of input.decisions) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !['number', 'string'].includes(typeof value.lineId)
        || typeof value.declined !== 'boolean') throw invalid('Enter a valid line decision.');
      const lineId = Number(value.lineId), before = saved.get(lineId);
      if (!Number.isSafeInteger(lineId) || !before || decisionIds.has(lineId)) throw invalid('Each decision must belong to this request exactly once.');
      decisionIds.add(lineId);
      // A material change clears the old review, so retain an explicitly staged decline after that reset.
      const reviewReset = lines.some(change => change.lineId === lineId && (change.nameChanged || change.quantityChanged));
      if (value.declined === (before.salesDecision === 'declined') && !(value.declined && reviewReset)) continue;
      if (before.salesDecision === 'closed') throw invalid('A closed line cannot be declined or reopened.');
      decisions.push({ lineId, declined: value.declined });
    }
  }
  let pallet = null;
  if (input.pallet !== undefined) {
    if (!input.pallet || typeof input.pallet !== 'object' || Array.isArray(input.pallet)) throw invalid('Enter the PALLET quantity and rate.');
    const candidate = { quantity: input.pallet.quantity, rate: input.pallet.rate };
    const quantity = specialPalletQuantity(candidate.quantity);
    const rate = candidate.rate == null || candidate.rate === '' ? null : normalizeSpecialRate(candidate.rate);
    if (quantity > 0 && rate === null) throw Object.assign(invalid('Review the PALLET sales rate.'), { code: 'SPECIAL_PALLET_RATE_REQUIRED' });
    if (quantity > 0) specialLineSubtotal(quantity, rate);
    const before = currentPallet(detail);
    if (quantity !== Number(before.quantity) || rate !== before.rate) pallet = { quantity, rate };
  }
  const savedFee = savedSpecialDeliveryFee(detail);
  let deliveryFeeRate;
  if (Object.hasOwn(input, 'deliveryFeeRate')) {
    if (detail.fulfillmentMethod !== 'mbt_delivery') throw invalid('Delivery fee can only be edited on a delivery request.');
    // Legacy requests with no charge can retain a blank field while editing other lines.
    if (!(savedFee == null && (input.deliveryFeeRate == null || input.deliveryFeeRate === ''))) {
      const candidate = normalizeSpecialRate(input.deliveryFeeRate);
      if (candidate !== savedFee) deliveryFeeRate = candidate;
    }
  }
  if (lines.length || pallet || deliveryFeeRate !== undefined) assertCaseEditTotal(detail, lines, pallet || currentPallet(detail), deliveryFeeRate ?? savedFee, taxBps);
  return { lines, pallet, ...(decisions.length ? { decisions } : {}), ...(deliveryFeeRate !== undefined ? { deliveryFeeRate } : {}), restart: lines.some(change => change.nameChanged || change.quantityChanged) };
}

/** @returns {Promise<boolean>} */
export function confirmSpecialCaseRestart() {
  const focus = document.activeElement, dialog = document.createElement('dialog');
  dialog.className = 'regular-stock-dialog special-add-items-warning';
  dialog.setAttribute('aria-labelledby', 'specialCaseRestartTitle');
  dialog.innerHTML = `<div class="special-add-items-warning-icon" aria-hidden="true">!</div>
    <h2 id="specialCaseRestartTitle">Return to New enquiry?</h2>
    <p>Changing a material name or quantity returns this request to New enquiry. The changed items need a new SCM stock check and customer confirmation.</p>
    <div class="regular-dialog-actions"><button type="button" data-case-edit-cancel>Cancel</button><button type="button" class="primary" data-case-edit-confirm>Save and restart enquiry</button></div>`;
  document.body.append(dialog);
  return new Promise(resolve => {
    /** @param {boolean} confirmed */
    const finish = confirmed => {
      dialog.close(); dialog.remove();
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
      resolve(confirmed);
    };
    /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-case-edit-cancel]')).addEventListener('click', () => finish(false));
    /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-case-edit-confirm]')).addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.showModal();
    /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-case-edit-cancel]')).focus();
  });
}
