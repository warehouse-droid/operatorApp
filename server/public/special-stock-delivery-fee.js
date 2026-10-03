import { normalizeSpecialRate, specialLineSubtotal } from './special-stock-pricing.js';

/** @param {{fulfillmentMethod?:unknown,deliveryFeeRate?:unknown}} input */
export function normalizeSpecialDeliveryFee(input) {
  if (String(input.fulfillmentMethod || '').trim().toLowerCase() !== 'mbt_delivery' || input.deliveryFeeRate == null) return null;
  try { return normalizeSpecialRate(input.deliveryFeeRate); }
  catch { throw Object.assign(new Error('Enter a delivery fee rate of zero or more, with at most six decimal places.'),
    { status: 400, code: 'SPECIAL_DELIVERY_FEE_INVALID' }); }
}

/** @param {number} rate */
export function specialDeliveryFeeLine(rate) {
  return { itemId: 1987, description: 'Delivery Charge', quantity: 1, uom: null, rate };
}

/** @param {Record<string,any>} detail */
export function savedSpecialDeliveryFee(detail) {
  if (detail.deliveryFeeRate != null || detail.fulfillmentMethod !== 'mbt_delivery') return normalizeSpecialDeliveryFee(detail);
  const lines = (/** @type {Array<Record<string,any>>} */ (detail.salesOrderLines || [])).filter(line => line.ancillary && Number(line.itemId) === 1987);
  const cents = lines.reduce((sum, line) => sum + Math.round(specialLineSubtotal(line.quantity, line.rate) * 100), 0);
  return normalizeSpecialDeliveryFee({ ...detail, deliveryFeeRate: lines.length ? cents / 100 : null });
}

/** @param {Record<string,any>} detail */
export function specialDeliveryFeeDisplay(detail) {
  const rate = savedSpecialDeliveryFee(detail);
  if (rate == null) return '';
  const amount = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(rate);
  return `<article class="stock-request-line" data-special-delivery-fee-line>
    <header><strong>Delivery fee</strong></header><div class="stock-request-line-fields">
      <label><span>Sales rate</span><output class="special-fixed-value">${amount}</output></label>
      <label><span>Subtotal (before tax)</span><output class="special-fixed-value">${amount}</output></label>
    </div><small>Customer charge only.</small></article>`;
}
