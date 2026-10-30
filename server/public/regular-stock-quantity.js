(() => {
  const fields = ['pallets', 'layers', 'sections', 'pieces'];
  const clean = value => Number(value.toPrecision(15));
  const present = value => value != null && String(value).trim() !== '';

  function conversions(item) {
    return [
      ['pallets', 'PLT', item?.toPlt], ['layers', 'LYR', item?.toLyr],
      ['sections', 'SEC', item?.toSec], ['pieces', 'PCS', item?.toPcs]
    ].filter(([, , rate]) => Number.isFinite(Number(rate)) && Number(rate) > 0)
      .map(([field, label, rate]) => ({field, label, rate: Number(rate)}));
  }

  function toSales(item, quantities) {
    let total = 0, entered = false;
    for (const {field, rate} of conversions(item)) {
      if (!present(quantities[field])) continue;
      const quantity = Number(quantities[field]);
      if (!Number.isFinite(quantity) || quantity < 0 || (field === 'layers' && !Number.isInteger(quantity))) return null;
      entered = true;
      total += quantity * rate;
    }
    return entered && Number.isFinite(total) ? clean(total) : null;
  }

  // Prefer whole pallets/layers when layers exist. Other items use their
  // available pack units, largest first, rounding to the smallest unit.
  function fromSales(item, value) {
    const quantity = Number(value), available = conversions(item);
    if (!present(value) || !Number.isFinite(quantity) || quantity < 0 || !available.length) return null;
    const units = (available.some(unit => unit.field === 'layers')
      ? available.filter(unit => ['pallets', 'layers'].includes(unit.field)) : available)
      .sort((a, b) => b.rate - a.rate);
    const empty = () => Object.fromEntries(fields.map(field => [field, 0]));
    function closest(amount, index) {
      const {field, rate} = units[index];
      const tolerance = Number.EPSILON * Math.max(1, amount, rate) * 8;
      const count = Math.floor((amount + tolerance) / rate);
      const remainder = Math.max(0, clean(amount - count * rate));
      const lower = index + 1 < units.length ? closest(remainder, index + 1) : empty();
      lower[field] = count;
      const upper = {...empty(), [field]: count + 1};
      const lowTotal = toSales(item, lower), highTotal = toSales(item, upper);
      // Ties go up. Comparing the next full pack also handles non-integral
      // pallet/layer ratios without leaving a whole pallet in the layer field.
      return Math.abs(highTotal - amount) <= Math.abs(lowTotal - amount) + tolerance ? upper : lower;
    }
    const result = closest(quantity, 0);
    if (quantity > 0 && toSales(item, result) === 0) result[units.at(-1).field] = 1;
    return result;
  }

  window.RegularStockQuantity = {fields, conversions, toSales, fromSales};
})();
