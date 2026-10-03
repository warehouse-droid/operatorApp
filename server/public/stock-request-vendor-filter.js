/** JSON preserves vendor names containing commas. @param {unknown} value */
export function parseVendorNames(value) {
  if (value == null || value === '') return [];
  /** @type {unknown} */
  let values = value;
  try { if (typeof value === 'string') values = JSON.parse(value); } catch { values = null; }
  if (!Array.isArray(values) || values.length > 100 || values.some(name => typeof name !== 'string' || !name.trim() || name.length > 500)) {
    throw Object.assign(new Error('Select valid vendors.'), {status:400,code:'SPECIAL_VENDORS_INVALID'});
  }
  return [...new Set(values.map(name => name.trim()))];
}
/** @param {unknown} value */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char] ?? char));
/** @param {string[]} vendors @param {string[]} selected */
export function vendorFilterHtml(vendors, selected) {
  const names = new Set(parseVendorNames(selected));
  const options = [...new Set([...vendors,...names])].sort((a,b)=>a.localeCompare(b));
  return `<details class="stock-request-yard-filter special-vendor-filter"><summary>Vendors${names.size ? ` (${names.size})` : ': All'}</summary><div>${options.map(name=>`<label><input type="checkbox" data-special-vendor value="${escapeHtml(name)}" ${names.has(name)?'checked':''}> ${escapeHtml(name)}</label>`).join('')}<button type="button" data-special-clear-vendors>Clear selection</button></div></details>`;
}
