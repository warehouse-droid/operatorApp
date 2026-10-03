/** Empty selection means all permitted yards; authorization remains server-owned.
 * @param {unknown} value
 */
export function parseYardIds(value) {
  if (value == null || value === '') return [];
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
  if (values.length > 64 || values.some(id =>
    !['string', 'number'].includes(typeof id) || !/^\d+$/.test(String(id).trim()) ||
    !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw Object.assign(new Error('Select valid yards.'), {status: 400, code: 'STOCK_REQUEST_YARDS_INVALID'});
  }
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char] ?? char));
}

/**
 * @param {Array<{locationId:number|string,yardCode?:string,name?:string}>} yards
 * @param {unknown} selected
 */
export function yardFilterHtml(yards, selected, {label = 'Yards', name = 'storeLocationIds', attribute = 'data-special-yard', disabled = false} = {}) {
  const ids = new Set(parseYardIds(selected));
  return `<details class="stock-request-yard-filter" data-yard-filter="${escapeHtml(name)}"><summary>${escapeHtml(label)}${ids.size ? ` (${ids.size})` : ': All'}</summary><div>${yards.map(yard => `<label><input type="checkbox" name="${escapeHtml(name)}" ${attribute} value="${Number(yard.locationId)}" ${ids.has(Number(yard.locationId)) ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${escapeHtml(yard.yardCode || yard.name || yard.locationId)}</label>`).join('')}<button type="button" data-yard-filter-clear="${escapeHtml(name)}" ${disabled ? 'disabled' : ''}>Clear selection</button></div></details>`;
}
