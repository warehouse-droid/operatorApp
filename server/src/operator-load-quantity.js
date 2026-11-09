// @ts-check

/** Match NetSuite's formula: round the entire converted SQFT line once.
 * @param {number} value @param {unknown} unit */
export function operatorRoundedSalesQuantity(value, unit) {
  return String(unit || '').trim().toUpperCase() === 'SQFT'
    ? Math.round(value * 100) / 100 : value;
}

/** Consume whole units by checking the forward cumulative line formula.
 * No posting tolerance is applied to physical counts.
 * @param {number} loaded @param {number} consumed @param {number} required
 * @param {number} conversion @param {unknown} unit */
export function operatorLoadedUnitCount(loaded, consumed, required, conversion, unit) {
  if (![loaded, consumed, required, conversion].every(Number.isFinite)
      || loaded <= 0 || required <= 0 || conversion <= 0) { return 0; }
  const available = Math.max(0, loaded - consumed);
  const lower = Math.min(required, Math.floor(available / conversion));
  const upper = Math.min(required, Math.ceil(available / conversion));
  const lowerSales = operatorRoundedSalesQuantity(consumed + lower * conversion, unit);
  const upperSales = operatorRoundedSalesQuantity(consumed + upper * conversion, unit);
  return upper > lower && upperSales > lowerSales
    && upperSales === operatorRoundedSalesQuantity(loaded, unit) ? upper : lower;
}

/** Whole packages that fit the shared balance, rounding the cumulative total once.
 * @param {number} required @param {number} consumed @param {number} conversion
 * @param {unknown} unit @param {number} [conversionGap] see operatorPackConversionGap */
export function operatorPackUnitCapacity(required, consumed, conversion, unit, conversionGap = 0) {
  if (![required, consumed, conversion].every(Number.isFinite) || conversion <= 0
      || operatorRoundedSalesQuantity(required, unit) <= operatorRoundedSalesQuantity(consumed, unit)) return 0;
  const count = operatorLoadedUnitCount(required, consumed,
    Math.ceil(Math.max(0, required - consumed) / conversion), conversion, unit);
  // One more package may finish a balance it overshoots by no more than the line's
  // conversion gap: the last layer of a broken pallet.
  const short = operatorRoundedSalesQuantity(consumed + count * conversion, unit)
    < operatorRoundedSalesQuantity(required, unit);
  return conversionGap > 0 && short && consumed + (count + 1) * conversion - required <= conversionGap + 0.000001
    ? count + 1 : count;
}

/** NetSuite rounds package conversions, so a pallet taken as loose layers can hold more
 * than its own conversion (95.6 SQFT/PLT, but 9 x 10.63 = 95.67 SQFT of layers). This is
 * the most the whole larger packages of a line can differ from the smaller packages they
 * hold. Only packages within 1% of a whole multiple count; unrelated conversions add 0.
 * @param {number} required @param {number[]} conversions */
export function operatorPackConversionGap(required, conversions) {
  const sizes = conversions.filter(value => Number.isFinite(value) && value > 0);
  if (!Number.isFinite(required) || required <= 0) return 0;
  const packageGap = (/** @type {number} */ larger) => Math.max(0, ...sizes.map(smaller => {
    const count = Math.round(larger / smaller), gap = Math.abs(larger - count * smaller);
    return count > 1 && gap <= larger * 0.01 ? gap : 0;
  }));
  return sizes.reduce((total, larger) => total + Math.floor(required / larger + 0.000001) * packageGap(larger), 0);
}
