// Preserve only edited forms so saving one line does not discard another line.
/** @typedef {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} FormField */
/** @typedef {Map<string, Map<string, {value:string, checked?:boolean}>>} FormDrafts */
/** @param {HTMLFormElement} form */
export function specialFormKey(form) {
  const kind = form.getAttributeNames().find(name => /^data-special-.*-form$/.test(name));
  return kind ? `${kind}:${form.dataset.lineId || ''}` : null;
}

/** @param {FormField} input */
function fieldKey(input) {
  const group = input.closest('[data-special-material], [data-special-po-line], [data-special-composer-line], [data-special-ancillary]');
  const section = group?.getAttributeNames().find(name => name.startsWith('data-special-'));
  const name = input.name || input.getAttributeNames().find(name => name.startsWith('data-special-'));
  return name ? `${section || ''}:${section ? group?.getAttribute(section) : ''}:${name}` : null;
}

/** @param {FormDrafts} drafts @param {HTMLFormElement|null} form */
export function rememberSpecialForm(drafts, form) {
  const key = form && specialFormKey(form);
  if (!key) return;
  const fields = new Map();
  for (const input of formFields(form)) {
    const name = fieldKey(input);
    if (name) fields.set(name, { value: input.value, checked: 'checked' in input ? input.checked : undefined });
  }
  drafts.set(key, fields);
}

/** @param {HTMLElement} root @param {FormDrafts} drafts */
export function restoreSpecialForms(root, drafts) {
  for (const form of root.querySelectorAll('form')) {
    const key = specialFormKey(form);
    const fields = key && drafts.get(key);
    if (!fields) continue;
    for (const input of formFields(form)) {
      const name = fieldKey(input);
      const saved = name && fields.get(name);
      if (!saved) continue;
      input.value = saved.value;
      if ('checked' in input && ['checkbox', 'radio'].includes(input.type)) input.checked = saved.checked === true;
    }
  }
}

/** @param {HTMLFormElement} form @returns {NodeListOf<FormField>} */
function formFields(form) {
  return form.querySelectorAll('input:not([type=file]), select, textarea');
}

/** @param {HTMLElement} root */
export function preserveSpecialScroll(root) {
  const panels = ['.stock-request-detail', '.stock-request-list'].map(selector => ({
    selector, top: root.querySelector(selector)?.scrollTop || 0,
    left: root.querySelector(selector)?.scrollLeft || 0
  }));
  const top = window.scrollY, left = window.scrollX;
  return () => {
    for (const panel of panels) root.querySelector(panel.selector)?.scrollTo({ top: panel.top, left: panel.left, behavior: 'instant' });
    window.scrollTo({ top, left, behavior: 'instant' });
  };
}
