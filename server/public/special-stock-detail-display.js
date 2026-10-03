const minimumOffset = -2;
const maximumOffset = 8;
/** @param {unknown} value */
const normalizeOffset = value => Number.isInteger(Number(value))
  ? Math.max(minimumOffset, Math.min(maximumOffset, Number(value))) : 0;

/** Add the same pixel offset to every original detail font size, including inherited sizes.
 * Preferences are scoped to the authenticated user in this browser, across Sales and SCM.
 * @param {HTMLElement} mount
 * @param {() => string|number|null|undefined} accountId
 */
export function installSpecialDetailDisplay(mount, accountId) {
  let owner = '';
  let offset = 0;
  let frame = 0;
  /** @type {Map<HTMLElement, {value:string,priority:string}>} */
  const originals = new Map();
  const cacheKey = () => `mbbs.special-stock.detail-font-offset.${owner}`;
  const readOffset = () => {
    try { return normalizeOffset(window.localStorage.getItem(cacheKey())); }
    catch { return 0; }
  };

  function apply() {
    observer.disconnect();
    // Restore all ancestors before measuring any child so inheritance never adds the offset twice.
    for (const [element, style] of originals) {
      if (style.value) element.style.setProperty('font-size', style.value, style.priority);
      else element.style.removeProperty('font-size');
    }
    originals.clear();
    const nextOwner = String(accountId() || '');
    if (owner !== nextOwner) { owner = nextOwner; offset = owner ? readOffset() : 0; }
    const panel = mount.querySelector('.special-stock-page .stock-request-detail');
    const toolbar = mount.querySelector('.special-stock-page .stock-request-toolbar');
    if (panel instanceof window.HTMLElement && toolbar && owner) {
      let controls = toolbar.querySelector('[data-special-detail-display]');
      if (!controls) {
        controls = document.createElement('div');
        controls.className = 'special-detail-display';
        controls.setAttribute('data-special-detail-display', '');
        controls.setAttribute('role', 'group');
        controls.setAttribute('aria-label', 'Detail text size');
        controls.setAttribute('title', 'Saved for your user in this browser');
        controls.innerHTML = '<span>Detail text</span><button type="button" data-special-text-size="-1" aria-label="Decrease detail text size">−</button><output aria-live="polite"></output><button type="button" data-special-text-size="1" aria-label="Increase detail text size">+</button><button type="button" data-special-text-size="reset">Reset</button>';
        toolbar.append(controls);
      }
      const output = controls.querySelector('output');
      if (output) output.textContent = `${offset >= 0 ? '+' : ''}${offset} px`;
      for (const button of controls.querySelectorAll('button')) {
        button.disabled = button.dataset.specialTextSize === '-1' ? offset <= minimumOffset
          : button.dataset.specialTextSize === '1' ? offset >= maximumOffset : offset === 0;
      }
      if (offset) {
        // Read every baseline before writing any adjusted size, preserving each existing hierarchy.
        const sizes = [panel, ...panel.querySelectorAll('*')].filter(element => element instanceof window.HTMLElement)
          .map(element => ({ element, size: Number.parseFloat(window.getComputedStyle(element).fontSize) }));
        for (const {element, size} of sizes) {
          if (!Number.isFinite(size)) continue;
          originals.set(element, {value: element.style.getPropertyValue('font-size'), priority: element.style.getPropertyPriority('font-size')});
          element.style.setProperty('font-size', `${size + offset}px`);
        }
      }
    }
    observer.observe(mount, {childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden']});
  }

  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; apply(); });
  }
  const observer = new window.MutationObserver(schedule);
  mount.addEventListener('click', event => {
    const button = event.target instanceof window.Element ? event.target.closest('[data-special-text-size]') : null;
    if (!(button instanceof window.HTMLButtonElement) || !owner) return;
    offset = button.dataset.specialTextSize === 'reset' ? 0 : normalizeOffset(offset + Number(button.dataset.specialTextSize));
    try { window.localStorage.setItem(cacheKey(), String(offset)); } catch { /* Keep the setting for this page visit. */ }
    apply();
  });
  window.addEventListener('resize', schedule);
  window.addEventListener('storage', event => {
    if (owner && (event.key === cacheKey() || event.key === null)) { offset = readOffset(); schedule(); }
  });
  apply();
}
