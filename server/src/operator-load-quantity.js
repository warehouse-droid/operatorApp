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
 * @param {unknown} unit */
export function operatorPackUnitCapacity(required, consumed, conversion, unit) {
  if (![required, consumed, conversion].every(Number.isFinite) || conversion <= 0
      || operatorRoundedSalesQuantity(required, unit) <= operatorRoundedSalesQuantity(consumed, unit)) return 0;
  return operatorLoadedUnitCount(required, consumed,
    Math.ceil(Math.max(0, required - consumed) / conversion), conversion, unit);
}
