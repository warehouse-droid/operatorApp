import { specialLineSubtotal } from './special-stock-pricing.js';
import { specialDeliveryFeeDisplay } from './special-stock-delivery-fee.js';
export { savedSpecialDeliveryFee } from './special-stock-delivery-fee.js';

/** Display the quoted PALLET charge separately from material stock decisions.
 * @param {{palletTotal?:number|null,palletRate?:number|null,salesOrderLines?:Array<{itemId?:number,ancillary?:boolean,quantity?:number,rate?:number|null}>}} detail
 */
export function specialRequestPalletLine(detail) {
  const saved = detail.salesOrderLines?.find(line => line.ancillary && line.itemId === 1784);
  const quantity = detail.palletTotal ?? saved?.quantity ?? 0;
  if (!(quantity > 0)) return specialDeliveryFeeDisplay(detail);
  const rate = detail.palletRate ?? saved?.rate ?? null;
  const format = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const money = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<article class="stock-request-line" data-special-pallet-line>
    <header><div><strong>PALLET</strong></div></header>
    <div class="stock-request-line-fields">
      <label><span>Quantity</span><output class="special-fixed-value" data-special-pallet-quantity>${Number(quantity)} EACH</output></label>
      <label><span>Sales rate ($ / EACH)</span><output class="special-fixed-value" data-special-pallet-rate>${rate == null ? '—' : '$' + format.format(rate)}</output></label>
      <label><span>Subtotal</span><output class="special-fixed-value" data-special-pallet-subtotal>${rate == null ? '—' : '$' + money.format(specialLineSubtotal(quantity, rate))}</output></label>
    </div>
  </article>` + specialDeliveryFeeDisplay(detail);
}
