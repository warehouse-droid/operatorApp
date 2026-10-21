// @ts-check
const EPSILON = 0.000001;
/** @param {string} message */
export function splitQuantityError(message) {
  return Object.assign(new Error(message), { code: 'DISPATCH_SPLIT_QUANTITY_MISMATCH', status: 409 });
}
/** @param {any} value */
const text = value => String(value ?? '').trim();
/** @param {any} line */
export function splitLineIdentity(line) {
  const lineId = text(line.lineId ?? line.line_id), rowId = text(line.lineRowId ?? line.id);
  return lineId ? `line:${lineId}` : rowId ? `row:${rowId}` : '';
}
/** @param {any} line */
const unit = line => text(line.unit || 'QTY').toUpperCase();
/** @param {number} value */
const display = value => value.toLocaleString('en-US', { maximumFractionDigits: 6 });
/** @param {any} value @param {string} label */
function quantity(value, label) {
  const number = value === null || value === '' ? NaN : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    throw splitQuantityError(`${label}: quantities must be finite, nonnegative numbers.`);
  }
  return number;
}
/** @param {any} source @param {any} child @param {string} label */
function assertPacking(source, child, label) {
  let converted = 0, hasPacking = false;
  for (const [field, rate] of [['pallets', 'toPlt'], ['layers', 'toLyr'], ['sections', 'toSec'], ['pieces', 'toPcs']]) {
    const count = quantity(child[field] ?? 0, label);
    const conversion = Number(source[rate] || 0);
    if (conversion > 0 && count > 0) {
      hasPacking = true;
      converted += count * conversion;
    }
  }
  if (hasPacking && (!Number.isFinite(converted) || Math.abs(converted - Number(child.quantity)) > EPSILON)) {
    throw splitQuantityError(`${label}: sales quantity must match the source packing-unit conversions.`);
  }
}
/** Validate each stable transaction line independently; matching SKUs are not interchangeable.
 * @param {{id: string, items: any[]}} source @param {any[]} children */
export function assertSplitLineQuantities(source, children) {
  const label = `Cannot split ${source.id}`;
  if (!Array.isArray(source.items) || !source.items.length || !Array.isArray(children) || children.length < 2) {
    throw splitQuantityError(`${label}: refresh the source and provide at least two nonempty splits.`);
  }
  const lines = new Map(), totals = new Map(), refs = new Set();
  for (const line of source.items) {
    const identity = splitLineIdentity(line);
    if (!identity || lines.has(identity)) throw splitQuantityError(`${label}: source line identities are missing or duplicated. Refresh Orders.`);
    quantity(line.quantity, label);
    lines.set(identity, line);
    totals.set(identity, 0);
  }
  for (const child of children) {
    const ref = text(child.id), seen = new Set();
    if (!ref || refs.has(ref) || !Array.isArray(child.items) || !child.items.length) {
      throw splitQuantityError(`${label}: each split needs a unique reference and nonempty item lines.`);
    }
    refs.add(ref);
    let childTotal = 0;
    for (const item of child.items) {
      const identity = splitLineIdentity(item), original = lines.get(identity);
      if (!original || seen.has(identity)
          || text(item.itemId ?? item.item_id) !== text(original.itemId ?? original.item_id)
          || unit(item) !== unit(original)) {
        throw splitQuantityError(`${label}: ${ref} contains a missing, duplicate, or mismatched source item/unit.`);
      }
      seen.add(identity);
      const value = quantity(item.quantity, label);
      assertPacking(original, item, label);
      totals.set(identity, totals.get(identity) + value);
      childTotal += value;
    }
    if (!(childTotal > 0) || !Number.isFinite(childTotal)) {
      throw splitQuantityError(`${label}: each split must contain a positive quantity.`);
    }
  }
  for (const [identity, original] of lines) {
    const expected = Number(original.quantity), allocated = totals.get(identity);
    if (!Number.isFinite(allocated) || Math.abs(allocated - expected) > EPSILON) {
      const difference = allocated - expected;
      throw splitQuantityError(`${label}: ${original.sku || original.itemName || identity} totals ${display(allocated)} ${unit(original)}; expected ${display(expected)} ${unit(original)} (${display(Math.abs(difference))} ${unit(original)} ${difference < 0 ? 'short' : 'over'}).`);
    }
  }
}
