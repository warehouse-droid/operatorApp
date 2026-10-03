import { normalizeSpecialDiscount, specialDiscountLineAmount } from '../public/special-stock-pricing.js';

/** @param {number[]} amounts */
export function sumSpecialAmounts(amounts) {
  const cents = amounts.reduce((sum, amount) => sum + BigInt(Math.round(amount * 100)), 0n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Object.assign(Error('The order total is too large.'), { status: 400, code: 'SPECIAL_SUBTOTAL_INVALID' });
  }
  return Number(cents) / 100;
}

/** @param {{quantity:number,rate:number,nativeDiscountPercent?:number,discountPercent?:number}[]} lines */
export function specialOrderDiscountTotal(lines) {
  return sumSpecialAmounts(lines.map(line => specialDiscountLineAmount(line.quantity, line.rate,
    normalizeSpecialDiscount(line.nativeDiscountPercent ?? line.discountPercent))));
}
