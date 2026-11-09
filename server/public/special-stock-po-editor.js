import {specialLineSubtotal} from './special-stock-purchase-pricing.js';

/** @typedef {Record<string,any>} Line
 * @typedef {{id:number,name:string,aliases?:string[]}} Unit
 * @typedef {{units:Unit[],noUnits:boolean,defaultUnitId:number|null}} Catalog
 * @typedef {{id:number,purchaseOrderLines?:Line[]}} Detail */
/** @param {unknown} value */
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char] || char));
/** @param {unknown} error */
const errorText = error => error instanceof Error ? error.message : String(error);
/** @param {ParentNode} root @param {string} selector @returns {HTMLElement} */
function node(root,selector) {
  const found = root.querySelector(selector);
  if (!found) throw Error('The PO editor field is missing. Reload this request.');
  return /** @type {HTMLElement} */ (found);
}
/** @param {ParentNode} root @param {string} selector */
const field = (root,selector) => /** @type {HTMLInputElement} */ (node(root,selector));
/** @param {ParentNode} root */
const unitSelect = root => /** @type {HTMLSelectElement} */ (node(root,'[data-po-uom]'));
/** @param {Element} child @returns {HTMLElement} */
const extraParent = child => /** @type {HTMLElement} */ (child.closest('[data-special-po-extra]'));
/** @param {HTMLElement} root @returns {HTMLElement[]} */
const extraRows = root => [.../** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-special-po-extra]'))];
const packFields = [['palletQty','PLT'],['sectionQty','SEC'],['layerQty','LYR'],['pieceQty','PCS']];
/** @type {Map<string,Catalog>} */
const knownCatalogs = new Map();

/** @param {Catalog} data */
function uomOptions(data) {
  return data.noUnits ? '<option value="">No unit (NetSuite)</option>'
    : '<option value="">Select UOM</option>'+data.units.map(unit => `<option value="${escape(unit.name)}" data-unit-id="${escape(unit.id)}">${escape(unit.name)}</option>`).join('');
}

/** @param {Line} line */
export function specialPurchasePackFields(line) {
  return `<div class="stock-request-line-fields">${packFields.map(([name,label]) => `<label><span>${label}</span><input name="${name}" type="number" min="0" max="1000000000" step="any" value="${escape(line[name])}" /></label>`).join('')}</div>`;
}

/** @param {Line} line */
export function specialPurchaseUomField(line) {
  const data = knownCatalogs.get(String(line.itemId || 2055));
  const options = data ? uomOptions(data).replace(`value="${escape(line.uom)}"`, `value="${escape(line.uom)}" selected`)
    : `<option value="${escape(line.uom)}" selected>Loading NetSuite units…</option>`;
  return `<label><span>UOM *</span><select name="uom" data-po-uom ${data?.noUnits ? '' : 'required'} data-wanted-uom="${escape(line.uom)}">${options}</select><input name="unitId" type="hidden" value="" /><small data-po-uom-message></small></label>`;
}

/** @param {Line} line @param {{removable?:boolean}} [options] */
function extraRow(line, {removable = true} = {}) {
  return `<article class="stock-request-line" data-special-po-extra="${escape(line.key)}" data-special-ancillary="po-${escape(line.key)}">
    <header><strong>PO-only item</strong>${removable ? '<button type="button" data-po-remove>Remove item</button>' : ''}</header>
    <label><span>Search NetSuite item</span><span class="stock-request-item-search special-po-item-search"><input type="search" data-po-item-search value="${escape(line.itemName)}" placeholder="Item name or fee" autocomplete="off" required /><div class="stock-request-suggestions" data-po-item-results></div></span><input name="itemId" type="hidden" value="${escape(line.itemId)}" /></label>
    <div class="stock-request-line-fields"><label class="stock-request-wide"><span>Order description *</span><input name="description" required maxlength="4000" value="${escape(line.description)}" /></label>
    <label><span>Quantity *</span><input name="quantity" type="number" min="0.000001" max="1000000000" step="any" required value="${escape(line.quantity ?? 1)}" /></label>
    ${specialPurchaseUomField(line)}<label><span>Unit cost ($) *</span><input name="unitPurchaseCost" type="number" min="0" max="1000000000" step="any" required value="${escape(line.unitPurchaseCost)}" /></label></div>
    ${specialPurchasePackFields(line)}<p data-po-extra-total></p></article>`;
}

/** Forms that hold PO-only item rows: the PO review before creation, and Add item after it. */
const EDITOR_FORMS = '[data-special-po-form], [data-special-po-add-form]';

/** PO item editor owns its extra rows; the parent owns request materials.
 * @param {HTMLElement} root @param {{api:(url:string)=>Promise<any>,getDetail:()=>Detail|null,changed:()=>void}} options */
export function createSpecialPurchaseEditor(root,{api,getDetail,changed}) {
  /** Unsaved rows, keyed by request (PO review) or `add:<request>` (Add item after PO creation).
   * @type {Map<string,Line[]>} */
  const drafts = new Map();
  /** @type {Map<string,Promise<Catalog>>} */
  const catalogs = new Map();
  /** @type {Map<string,Line[]>} */
  const searches = new Map();
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @param {HTMLElement} row */
  const values = row => Object.fromEntries([.../** @type {NodeListOf<HTMLInputElement|HTMLSelectElement>} */ (row.querySelectorAll('[name]'))].map(input => [input.name,input.value]));
  /** @param {HTMLElement} [scope] */
  const extraLines = (scope = root) => extraRows(scope).map(values);

  function capture() {
    if (!getDetail()) return;
    for (const host of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-po-extras]'))) {
      drafts.set(host.dataset.poDraftKey || '',extraRows(host).map(row => ({...values(row),
        key:row.dataset.specialPoExtra,itemName:field(row,'[data-po-item-search]').value})));
    }
  }
  /** @param {Detail} detail @param {{mode?:'po'|'add'}} [options] */
  function extrasHtml(detail, {mode = 'po'} = {}) {
    const key = mode === 'add' ? `add:${detail.id}` : String(detail.id);
    if (!drafts.has(key)) {
      drafts.set(key,mode === 'add' ? [{key:crypto.randomUUID(),quantity:1}]
        : (detail.purchaseOrderLines || []).filter(line => line.ancillary && Number(line.itemId) !== 1784)
          .map(line => ({...line,key:crypto.randomUUID()})));
    }
    const rows = (drafts.get(key) || []).map(line => extraRow(line,{removable:mode !== 'add'})).join('');
    return mode === 'add' ? `<div data-po-extras data-po-draft-key="${escape(key)}">${rows}</div>`
      : `<div data-po-extras data-po-draft-key="${escape(key)}">${rows}</div><button type="button" data-po-add>Add Item</button><p>Add vendor fees or other items to this PO.</p>`;
  }
  /** @param {string|number} rawItemId @returns {Promise<Catalog>} */
  async function catalog(rawItemId) {
    const itemId = String(rawItemId);
    if (!catalogs.has(itemId)) {
      const promise = api(`/api/scm/special-stock-requests/items/${encodeURIComponent(itemId)}/units`)
        .catch(error => {catalogs.delete(itemId);throw error;});
      catalogs.set(itemId,promise);
    }
    return /** @type {Promise<Catalog>} */ (catalogs.get(itemId));
  }
  /** @param {HTMLSelectElement} select */
  function chosenUnit(select) {
    field(/** @type {HTMLElement} */ (select.closest('label')),'[name=unitId]').value = select.selectedOptions[0]?.dataset.unitId || '';
  }
  /** @param {HTMLSelectElement} select @param {string|number|null} itemId */
  async function loadUnits(select, itemId, useDefault = false) {
    if (!itemId) {
      select.innerHTML = '<option value="">Select an item first</option>';
      select.setCustomValidity('Select a NetSuite item first.');
      return;
    }
    const wanted = select.value || select.dataset.wantedUom || '';
    select.dataset.itemId = String(itemId);
    select.setCustomValidity('Wait for the NetSuite units list.');
    const message = node(/** @type {HTMLElement} */ (select.closest('label')),'[data-po-uom-message]');
    try {
      const data = await catalog(itemId);
      if (!select.isConnected || select.dataset.itemId !== String(itemId)) return;
      if (!Array.isArray(data.units) || (!data.noUnits && !data.units.length)) throw Error('NetSuite units are unavailable.');
      knownCatalogs.set(String(itemId),data);
      select.required = !data.noUnits;
      select.innerHTML = uomOptions(data);
      const existing = data.units.find(unit => (unit.aliases || [unit.name]).some(alias => String(alias).toUpperCase() === wanted.toUpperCase()));
      const selected = existing || (useDefault ? data.units.find(unit => unit.id === data.defaultUnitId) : null);
      select.value = selected?.name || '';
      select.dataset.wantedUom = select.value;
      select.setCustomValidity('');chosenUnit(select);message.textContent = '';
      if (wanted && !selected && !data.noUnits) message.textContent = 'The previous UOM is unavailable. Select a NetSuite unit.';
      capture();
    } catch (error) {
      if (!select.isConnected) return;
      select.setCustomValidity('Reload the NetSuite units before creating the PO.');
      message.innerHTML = `${escape(errorText(error))} <button type="button" data-po-reload-units>Reload units</button>`;
    }
  }
  function refresh() {
    for (const select of /** @type {NodeListOf<HTMLSelectElement>} */ (root.querySelectorAll('[data-po-uom]'))) {
      const row = select.closest('[data-special-po-extra]');
      const itemId = row ? field(row,'[name=itemId]').value : 2055;
      if (row) field(row,'[data-po-item-search]').setCustomValidity(itemId ? '' : 'Select a NetSuite item from the search results.');
      void loadUnits(select,itemId);
    }
  }
  /** @param {HTMLElement} [scope] */
  function totals(scope = root) {
    let cents = 0;
    for (const row of extraRows(scope)) {
      const line = values(row);
      const total = specialLineSubtotal(line.quantity,line.unitPurchaseCost);
      cents += Math.round(total*100);
      node(row,'[data-po-extra-total]').textContent = `Line total: $${total.toFixed(2)}`;
    }
    if (!Number.isSafeInteger(cents)) throw Error('The added item total is too large.');
    return cents/100;
  }
  /** @param {HTMLInputElement} input */
  async function search(input) {
    const row = extraParent(input), term = input.value;
    const results = node(row,'[data-po-item-results]');
    field(row,'[name=itemId]').value = '';
    input.setCustomValidity('Select a NetSuite item from the search results.');
    void loadUnits(unitSelect(row),null);
    results.textContent = '';capture();changed();
    clearTimeout(timer);
    if (term.trim().length < 2) return;
    timer = setTimeout(async () => {
      try {
        const data = /** @type {{items?:Line[]}} */ (await api(`/api/scm/special-stock-requests/items?search=${encodeURIComponent(term)}`));
        if (!input.isConnected || input.value !== term) return;
        const items = (data.items || []).filter(item => ![1784,4981,10716].includes(Number(item.itemId)));
        searches.set(row.dataset.specialPoExtra || '',items);
        results.innerHTML = items.map(item => `<button type="button" data-po-choose-item="${escape(item.itemId)}">${escape(item.itemName)}</button>`).join('') || '<small>No matching items.</small>';
      } catch (error) {if (input.isConnected) results.textContent = errorText(error);}
    },250);
  }
  /** @param {HTMLElement} button */
  async function choose(button) {
    const row = extraParent(button);
    const item = (searches.get(row.dataset.specialPoExtra || '') || []).find(candidate => String(candidate.itemId) === button.dataset.poChooseItem);
    if (!item) return;
    field(row,'[name=itemId]').value = item.itemId;
    const input = field(row,'[data-po-item-search]');input.value = item.itemName;input.setCustomValidity('');
    field(row,'[name=description]').value = item.description || item.displayName || item.itemName;
    node(row,'[data-po-item-results]').textContent = '';
    const select = unitSelect(row);select.value = '';select.dataset.wantedUom = '';
    await loadUnits(select,item.itemId,true);capture();changed();
  }
  root.addEventListener('click',event => {
    const target = /** @type {HTMLElement} */ (event.target);
    const form = target.closest(EDITOR_FORMS);
    if (!form || target.closest('fieldset')?.disabled) return;
    if (target.closest('[data-po-add]')) {
      const host = node(form,'[data-po-extras]');
      if (host.children.length >= 100) return;
      host.insertAdjacentHTML('beforeend',extraRow({key:crypto.randomUUID(),quantity:1}));
      const row = /** @type {HTMLElement} */ (host.lastElementChild);field(row,'[data-po-item-search]').focus();
      void loadUnits(unitSelect(row),null);capture();changed();
    } else if (target.closest('[data-po-remove]')) {
      extraParent(target).remove();capture();changed();
    } else if (target.closest('[data-po-choose-item]')) {
      void choose(/** @type {HTMLElement} */ (target.closest('[data-po-choose-item]')));
    } else if (target.closest('[data-po-reload-units]')) {
      const select = unitSelect(/** @type {HTMLElement} */ (target.closest('label')));
      catalogs.delete(select.dataset.itemId || '');void loadUnits(select,select.dataset.itemId || null);
    }
  });
  root.addEventListener('input',event => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.matches('[data-po-item-search]')) void search(/** @type {HTMLInputElement} */ (target));
    if (target.closest('[data-special-po-extra]')) capture();
  });
  root.addEventListener('change',event => {
    const target = /** @type {HTMLSelectElement} */ (event.target);
    if (target.matches('[data-po-uom]')) {chosenUnit(target);target.dataset.wantedUom=target.value;capture();changed();}
  });
  /** @param {string} key */
  const discard = key => {drafts.delete(key);};
  return {extrasHtml,extraLines,refresh,totals,capture,discard,reset:()=>{drafts.clear();searches.clear();}};
}
