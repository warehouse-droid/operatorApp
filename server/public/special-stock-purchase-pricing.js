import { normalizeSpecialRate, normalizeSpecialDiscount, specialDiscountLineAmount, specialLineSubtotal, specialQuantity, specialPalletQuantity } from './special-stock-pricing.js';
export { specialLineSubtotal };

/** @param {string} message @param {string} [code] */
const invalid = (message, code = 'SPECIAL_VENDOR_DISCOUNT_INVALID') => Object.assign(Error(message), {status:400,code});
/** @param {number} amount */
const cents = amount => BigInt(Math.round(amount * 100));

/** @param {{quantity?:unknown,unitPurchaseCost?:unknown}} input */
export function specialPurchasePalletLine(input) {
  const quantity = specialPalletQuantity(input.quantity);
  if (quantity === 0) return null;
  const unitPurchaseCost = normalizeSpecialRate(input.unitPurchaseCost);
  specialLineSubtotal(quantity, unitPurchaseCost);
  return {itemId:1784,ancillary:true,description:'PALLET',quantity,uom:'EACH',unitPurchaseCost};
}

/** @param {{caseLineId:number,quantity:number,unitPurchaseCost:number,vendorDiscountPercent?:unknown}[]} lines */
export function specialVendorLineDiscountReview(lines) {
  if (!Array.isArray(lines) || !lines.length) throw invalid('Review every vendor discount percentage.');
  const reviewed = lines.map(line => {
    const quantity = specialQuantity(line.quantity), cost = normalizeSpecialRate(line.unitPurchaseCost);
    let percent;
    try {
      if (line.vendorDiscountPercent == null || String(line.vendorDiscountPercent).trim() === '') throw invalid('Missing percentage.');
      percent = normalizeSpecialDiscount(line.vendorDiscountPercent);
    } catch { throw invalid('Enter a vendor discount percentage from 0 to 100 for every material, with at most four decimal places. Enter 0 for no discount.'); }
    const gross = cents(specialLineSubtotal(quantity,cost)), discount = cents(-specialDiscountLineAmount(quantity,cost,percent));
    return {...line,quantity,unitPurchaseCost:cost,grossUnitCost:cost,vendorDiscountPercent:percent,
      grossTotal:Number(gross)/100,discountAmount:Number(discount)/100,netTotal:Number(gross-discount)/100};
  });
  const gross = reviewed.reduce((sum,line)=>sum+cents(line.grossTotal),0n);
  const discount = reviewed.reduce((sum,line)=>sum+cents(line.discountAmount),0n);
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('The gross purchase total is too large.');
  return {mode:'per_line',amount:Number(discount)/100,grossTotal:Number(gross)/100,netTotal:Number(gross-discount)/100,lines:reviewed};
}

/** Combine current quantities/costs with only the vendor percentages confirmed for these exact materials.
 * @param {{caseLineId:number,quantity:number,unitPurchaseCost:number}[]} lines
 * @param {{lines?:{caseLineId:number,vendorDiscountPercent?:unknown}[]}} review */
export function refreshSpecialVendorDiscountReview(lines, review) {
  const saved = review.lines;
  if (!Array.isArray(saved) || saved.length !== lines.length || new Set(saved.map(line=>Number(line.caseLineId))).size !== lines.length) {
    throw invalid('The saved vendor discounts must match every reviewed material.');
  }
  return specialVendorLineDiscountReview(lines.map(line=>({...line,
    vendorDiscountPercent:saved.find(s=>Number(s.caseLineId)===Number(line.caseLineId))?.vendorDiscountPercent})));
}

// Retained for previously submitted reviews whose material prices already include the discount.
/** @param {{caseLineId:number,quantity:number,unitPurchaseCost:number}[]} lines @param {unknown} amount */
export function specialVendorDiscountReview(lines, amount) {
  const value = Number(amount);
  if (!['string','number'].includes(typeof amount) || String(amount).trim() === '' || !Number.isFinite(value)
    || value < 0 || value !== Number(value.toFixed(2)) || !Number.isSafeInteger(Math.round(value*100))) {
    throw invalid('Confirm the total vendor discount amount, or enter 0 for no discount.');
  }
  const gross = lines.map(line => cents(specialLineSubtotal(specialQuantity(line.quantity), normalizeSpecialRate(line.unitPurchaseCost))));
  const total = gross.reduce((sum,n)=>sum+n,0n), discount = cents(value);
  if (!lines.length || total > BigInt(Number.MAX_SAFE_INTEGER) || discount > total) throw invalid('The vendor discount must not exceed the gross purchase total.');
  const shares = gross.map(n => total ? discount*n/total : 0n);
  const residual = Number(discount-shares.reduce((sum,n)=>sum+n,0n));
  const ranked = gross.map((n,i)=>({i,remainder:total ? discount*n%total : 0n})).sort((a,b)=>a.remainder===b.remainder ? a.i-b.i : a.remainder>b.remainder ? -1 : 1);
  for (const {i} of ranked.slice(0,residual)) shares[i]++;
  const reviewed = lines.map((line,i) => {
    const net = gross[i]-shares[i], quantityMicros = BigInt(Number(line.quantity).toFixed(6).replace('.',''));
    const rate = discount === 0n ? Number(line.unitPurchaseCost) : Number((net*10000000000n+quantityMicros/2n)/quantityMicros)/1e6;
    if (cents(specialLineSubtotal(line.quantity,rate)) !== net) throw invalid('This vendor discount cannot be represented at the PO unit-cost precision. Review the quantities or discount amount.', 'SPECIAL_VENDOR_DISCOUNT_ROUNDING');
    return {...line,grossUnitCost:Number(line.unitPurchaseCost),unitPurchaseCost:rate,discountAmount:Number(shares[i])/100};
  });
  return {amount:value,grossTotal:Number(total)/100,netTotal:Number(total-discount)/100,lines:reviewed};
}
