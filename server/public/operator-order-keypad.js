(function (root) {
  "use strict";
  const targets = new Set(["customerPickupScan", "returnOrderLookup"]);
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const t = (key, fallback) => root.MBBS_I18N?.t(key, fallback) || fallback;

  function edit(value, key, start = value.length, end = start) {
    if (["SOB", "SOA", "SOM"].includes(key)) {
      const digits = value.replace(/^SO[ABM]/i, "");
      return { value: key + digits, caret: key.length + digits.length };
    }
    if (key === "clear") return { value: "", caret: 0 };
    if (key === "back") {
      const from = start === end ? Math.max(0, start - 1) : start;
      return { value: value.slice(0, from) + value.slice(end), caret: from };
    }
    if (!/^\d$/.test(key)) return { value, caret: start };
    return { value: value.slice(0, start) + key + value.slice(end), caret: start + 1 };
  }

  function html(target) {
    if (!targets.has(target)) return "";
    const key = (value, label = value) => `<button type="button" data-order-key="${value}" data-order-target="${target}" aria-controls="${target}">${escape(label)}</button>`;
    return `<div class="order-keypad" role="group" aria-label="${escape(t("operator.orderKeypad", "Order number keypad"))}">
      <div class="order-keypad-prefixes">${["SOB", "SOA", "SOM"].map((value) => key(value)).join("")}</div>
      <div class="order-keypad-digits">${["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((value) => key(value)).join("")}
        ${key("clear", t("common.clear", "Clear"))}${key("0")}${key("back", t("common.backspace", "Backspace"))}</div>
    </div>`;
  }

  function install(app) {
    const selections = new Map();
    // Remember the caret before touch moves focus to a keypad button.
    app.addEventListener("pointerdown", (event) => {
      const button = event.target.closest("[data-order-key]");
      if (!button) return;
      const input = document.getElementById(button.dataset.orderTarget);
      if (input) selections.set(input.id, [input.selectionStart, input.selectionEnd]);
      if (event.pointerType === "mouse") event.preventDefault();
    });
    app.addEventListener("click", (event) => {
      const button = event.target.closest("[data-order-key]");
      if (!button || button.disabled) return;
      const input = document.getElementById(button.dataset.orderTarget);
      if (!input || input.disabled) return;
      const [start, end] = selections.get(input.id) || [input.selectionStart, input.selectionEnd];
      selections.delete(input.id);
      const result = edit(input.value, button.dataset.orderKey, start ?? input.value.length, end ?? input.value.length);
      input.value = result.value;
      input.focus({ preventScroll: true });
      input.setSelectionRange(result.caret, result.caret);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  root.OperatorOrderKeypad = { html, edit, install };
})(globalThis);
