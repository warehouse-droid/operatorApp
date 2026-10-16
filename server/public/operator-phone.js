(function () {
  "use strict";
  const agent = /** @type {Navigator & {userAgentData?: {mobile?: boolean}}} */ (navigator);
  const phone = (/iPhone|iPod|Android.*Mobile/i.test(agent.userAgent) || agent.userAgentData?.mobile === true)
    && Math.min(screen.width, screen.height) <= 600;
  const tablet = !phone && agent.maxTouchPoints > 0;
  const narrow = window.matchMedia("(max-width: 600px)");
  const root = document.documentElement;
  const app = document.getElementById("app");
  const viewport = window.visualViewport;
  let keyboardFrame = 0;
  let keyboardOpen = false;
  let viewportWidth = window.innerWidth;
  let restingHeight = window.innerHeight;
  let enabled = false;
  function update() {
    // Real phones retain their layout in landscape. Tablet layouts stay intact.
    document.documentElement.dataset.operatorPhone = String(enabled && !tablet && (narrow.matches || (phone && window.innerWidth <= 950)));
    scheduleKeyboard();
  }
  function editable(element) {
    return element instanceof HTMLElement && app?.contains(element)
      && (element.isContentEditable || (element.matches("input,textarea")
        && !element.disabled && !element.readOnly
        && !element.matches('[type="button"],[type="submit"],[type="reset"],[type="checkbox"],[type="radio"],[type="range"],[type="file"],[type="color"]')));
  }
  function updateKeyboard() {
    keyboardFrame = 0;
    const input = editable(document.activeElement) ? document.activeElement : null;
    const layoutHeight = Math.max(window.innerHeight, root.clientHeight);
    if (viewportWidth !== window.innerWidth) {
      viewportWidth = window.innerWidth;
      restingHeight = layoutHeight;
    }
    const usableViewport = viewport && Math.abs(viewport.scale - 1) < 0.01;
    const height = usableViewport ? viewport.height : window.innerHeight;
    const top = usableViewport ? viewport.offsetTop : 0;
    const shrink = Math.max(restingHeight, layoutHeight) - height;
    keyboardOpen = root.dataset.operatorPhone === "true" && (!viewport || usableViewport)
      && Boolean(input || keyboardOpen) && shrink > 100;
    if (!keyboardOpen) {
      delete root.dataset.operatorKeyboard;
      root.style.removeProperty("--operator-keyboard-space");
      if (!input) restingHeight = layoutHeight;
      return;
    }
    root.dataset.operatorKeyboard = "true";
    // The page can stay full height while the visual viewport shrinks. Add
    // the covered area to its scroll range, including when Safari pans it.
    const bounds = app.getBoundingClientRect();
    const bottom = Math.min(bounds.bottom, top + height);
    const space = Math.max(0, bounds.bottom - bottom);
    root.style.setProperty("--operator-keyboard-space", `${Math.ceil(space)}px`);
    if (!input) return;
    const field = input.getBoundingClientRect();
    const visibleTop = Math.max(bounds.top, top) + 12;
    const visibleBottom = bottom - 24;
    if (field.bottom > visibleBottom) app.scrollTop += field.bottom - visibleBottom;
    else if (field.top < visibleTop) app.scrollTop -= visibleTop - field.top;
  }
  function scheduleKeyboard() {
    if (!keyboardFrame) keyboardFrame = window.requestAnimationFrame(updateKeyboard);
  }
  function reveal(selector) {
    if (document.documentElement.dataset.operatorPhone !== "true") return;
    window.requestAnimationFrame(() => {
      if (document.documentElement.dataset.operatorPhone !== "true") return;
      const target = document.querySelector(selector);
      const header = document.querySelector("#app > .topbar");
      if (target instanceof HTMLElement) {
        document.documentElement.style.setProperty("--operator-phone-header", `${header?.getBoundingClientRect().height || 0}px`);
        target.scrollIntoView({ block: "start" });
      }
    });
  }
  window.MBBSOperatorPhone = Object.freeze({
    enabled: () => enabled,
    isPhone: () => phone,
    reveal,
    applyPolicy(policy) {
      const previous = enabled;
      enabled = policy?.flagKey === "operator_phone_layout" && policy.enabled === true;
      update();
      return previous !== enabled;
    },
    reset() { enabled = false; update(); }
  });
  narrow.addEventListener("change", update);
  window.addEventListener("resize", update);
  window.addEventListener("pageshow", scheduleKeyboard);
  document.addEventListener("focusin", scheduleKeyboard);
  document.addEventListener("focusout", scheduleKeyboard);
  viewport?.addEventListener("resize", scheduleKeyboard);
  viewport?.addEventListener("scroll", scheduleKeyboard);
  const selections = {
    "select-receiving-line": ".receiving-detail-grid .selected-panel",
    "select-inventory-item": ".cycle-grid .selected-panel",
    "select-consolidation-item": ".consolidation-allocation-panel",
    "select-consolidation-review-order": ".consolidation-review-detail",
    "select-consolidation-review-line": ".consolidation-review-selected-line",
    "return-select-stock-line": ".return-selected-editor",
    "select-history": ".history-detail",
    "return-select-history": ".return-record-detail",
    "return-select-draft": ".return-record-detail"
  };
  document.addEventListener("click", (event) => {
    if (document.documentElement.dataset.operatorPhone !== "true") return;
    const button = event.target instanceof Element ? event.target.closest("#app button") : null;
    if (!button || button.disabled) return;
    const selector = selections[button.dataset.action]
      || (button.dataset.invAction === "count-item" ? ".cycle-grid .selected-panel" : null)
      || (button.dataset.invAction === "report" ? ".damage-review-details" : null)
      || (button.matches(".line-card[data-line]") ? ".work-area .selected-panel" : null);
    if (!selector) return;
    reveal(selector);
  }, true);
  update();
})();
