(function (root) {
  "use strict";
  // Tapping a read-only stepper quantity opens an on-screen number pad, so the operator
  // can type the quantity directly instead of pressing + / - repeatedly. The device
  // keyboard is not used: tablets default to the application keypads.
  const MAX_WHOLE_DIGITS = 7;
  const MAX_DECIMALS = 4;
  const t = (key, fallback) => root.MBBS_I18N?.t(key, fallback) || fallback;
  const format = (key, fallback, values) => root.MBBS_I18N?.format?.(key, fallback, values)
    || fallback.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const number = (value) => Number(Number(value).toFixed(MAX_DECIMALS));
  const display = (value) => String(Number.isFinite(Number(value)) ? number(value) : 0);

  /** One key press. `fresh` means the shown value is the current quantity, which the first digit replaces. */
  function edit(state, key, decimals = false) {
    const current = String(state?.text ?? "");
    const fresh = Boolean(state?.fresh);
    if (key === "clear") return { text: "", fresh: false };
    if (key === "back") return { text: current.slice(0, -1), fresh: false };
    const text = fresh ? "" : current;
    if (key === ".") {
      if (!decimals || text.includes(".")) return { text: current, fresh };
      return { text: (text || "0") + ".", fresh: false };
    }
    if (!/^\d$/.test(key)) return { text: current, fresh };
    const next = text === "0" ? key : text + key;
    const [whole, fraction = ""] = next.split(".");
    if (whole.length > MAX_WHOLE_DIGITS || fraction.length > MAX_DECIMALS) return { text: current, fresh };
    return { text: next, fresh: false };
  }

  function parse(text) {
    const value = Number(String(text ?? "").replace(/\.$/, "") || 0);
    return Number.isFinite(value) && value >= 0 ? number(value) : 0;
  }

  let active = null;

  /** Resolves with the entered quantity, or null when the operator cancels. */
  function open({ label = "", value = 0, max = Number.POSITIVE_INFINITY, decimals = false } = {}) {
    if (active) return Promise.resolve(null);
    const limit = Number.isFinite(Number(max)) ? Math.max(0, number(max)) : Number.POSITIVE_INFINITY;
    let state = { text: display(value), fresh: true };
    const key = (value, text = value, extra = "") => `<button type="button" data-stepper-key="${value}"${extra}>${escape(text)}</button>`;
    const dialog = document.createElement("dialog");
    dialog.className = "stepper-keypad-dialog";
    dialog.setAttribute("aria-labelledby", "stepperKeypadTitle");
    dialog.innerHTML = `<form method="dialog" class="stepper-keypad">
      <div class="stepper-keypad-header">
        <h2 id="stepperKeypadTitle">${escape(label || t("operator.enterQuantity", "Enter quantity"))}</h2>
        ${Number.isFinite(limit) ? `<span data-stepper-keypad-limit>${escape(format("operator.maxQuantity", "Max {max}", { max: display(limit) }))}</span>` : ""}
      </div>
      <div class="stepper-keypad-display">
        <output data-stepper-keypad-value aria-live="polite"></output>
        ${key("clear", t("common.clear", "Clear"), ' class="stepper-keypad-clear"')}
      </div>
      <p class="stepper-keypad-error" data-stepper-keypad-error role="alert"></p>
      <div class="stepper-keypad-keys${decimals ? " decimals" : ""}">
        ${["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => key(digit)).join("")}
        ${decimals ? key(".") : ""}${key("0")}${key("back", t("common.backspace", "Back"))}
      </div>
      <div class="stepper-keypad-actions">
        <button class="secondary-button" value="cancel" type="submit">${escape(t("common.cancel", "Cancel"))}</button>
        <button class="primary-button" value="ok" type="submit" data-stepper-keypad-ok autofocus>${escape(t("common.confirm", "Confirm"))}</button>
      </div>
    </form>`;
    const output = dialog.querySelector("[data-stepper-keypad-value]");
    const error = dialog.querySelector("[data-stepper-keypad-error]");
    const ok = dialog.querySelector("[data-stepper-keypad-ok]");
    const update = () => {
      output.textContent = state.text || "0";
      output.classList.toggle("fresh", state.fresh);
      const over = parse(state.text) > limit;
      error.textContent = over ? format("operator.quantityAboveMax", "Cannot be more than {max}", { max: display(limit) }) : "";
      ok.disabled = over;
    };
    const press = (value) => { state = edit(state, value, decimals); update(); };
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) return dialog.close("cancel");
      const button = event.target.closest("[data-stepper-key]");
      if (button) press(button.dataset.stepperKey);
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (/^\d$/.test(event.key) || (event.key === "." && decimals)) press(event.key);
      else if (event.key === "Backspace") press("back");
      else if (event.key === "Delete") press("clear");
      else if (event.key === "Enter") { if (!ok.disabled) dialog.close("ok"); }
      else return;
      event.preventDefault();
    });
    update();
    active = dialog;
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        active = null;
        dialog.remove();
        resolve(dialog.returnValue === "ok" && parse(state.text) <= limit ? parse(state.text) : null);
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
    });
  }

  /**
   * `target(input)` returns { label, value, max, decimals, apply(value) } for a stepper
   * quantity, or null when the input is not a quantity the operator may set.
   */
  function install(app, target) {
    const start = (input) => {
      if (!input || input.disabled || active) return;
      const field = target(input);
      if (!field) return;
      void open(field).then((value) => { if (value !== null) field.apply(value); });
    };
    const stepperInput = (element) => element?.closest?.(".stepper input[readonly]");
    app.addEventListener("click", (event) => start(stepperInput(event.target)));
    app.addEventListener("keydown", (event) => {
      const input = stepperInput(event.target);
      if (!input || event.key !== "Enter") return;
      event.preventDefault();
      start(input);
    });
  }

  root.OperatorStepperKeypad = { edit, parse, open, install, isOpen: () => Boolean(active) };
})(globalThis);
