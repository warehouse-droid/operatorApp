// @ts-check

const PACK_COLUMNS = [
  ['pallets', 'pallet', 'custcol_plt'],
  ['layers', 'layer', 'custcol_lyr'],
  ['sections', 'section', 'custcol_sec'],
  ['pieces', 'piece', 'custcol_pcs']
];

/** These descriptive NetSuite columns are int64; never round physical counts.
 * Invalid optional metadata must not gate an accounting transaction.
 * @param {unknown} value @returns {number | undefined} */
function packCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {return undefined;}
  if (typeof value === 'string' && !value.trim()) {return undefined;}
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** @param {unknown} value @returns {Record<string, number> | undefined} */
function normalizedPacks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return undefined;}
  const raw = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(PACK_COLUMNS.flatMap(([name]) => {
    const count = packCount(raw[/** @type {string} */ (name)]);
    return count === undefined ? [] : [[name, count]];
  }));
}

/** @param {unknown} value */
export function operatorPostingPackEvidence(value) {
  const packs = normalizedPacks(value);
  return packs === undefined ? {} : { packQuantities: packs };
}

/** Use only this physical operation, not copied full-order pack columns.
 * @param {Record<string, any>} line @param {string} functionKey */
export function operatorPostingLinePackQuantities(line, functionKey) {
  return Object.fromEntries(PACK_COLUMNS.flatMap(([name, column]) => {
    const packed = packCount(line[`packed_${column}_qty`] ?? 0);
    const completed = packCount(line[`fulfilled_${column}_qty`] ?? 0);
    const quantity = functionKey === 'receiving'
      ? line[`received_${column}_qty`] ?? 0
      : packed === undefined || completed === undefined ? undefined : Math.max(packed - completed, 0);
    const count = packCount(quantity);
    return count === undefined ? [] : [[name, count]];
  }));
}

/** Missing legacy evidence cannot be treated as a known zero allocation.
 * @param {Record<string, any> | undefined} current @param {Record<string, any>} next */
export function mergeOperatorPostingPackEvidence(current, next) {
  if (!current) {return operatorPostingPackEvidence(next.packQuantities);}
  const left = normalizedPacks(current.packQuantities), right = normalizedPacks(next.packQuantities);
  if (!left || !right) {return {};}
  const packs = Object.fromEntries(PACK_COLUMNS.flatMap(([name]) => {
    const key = /** @type {string} */ (name);
    const sum = left[key] === undefined || right[key] === undefined ? undefined : packCount(left[key] + right[key]);
    return sum === undefined ? [] : [[name, sum]];
  }));
  return { packQuantities: packs };
}

/** @param {unknown} value */
export function operatorPostingPackFields(value) {
  const packs = normalizedPacks(value);
  return Object.fromEntries(PACK_COLUMNS.flatMap(([name, _column, field]) => {
    const count = packs?.[/** @type {string} */ (name)];
    return count === undefined ? [] : [[field, count]];
  }));
}
