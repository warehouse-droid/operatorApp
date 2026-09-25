(function (root) {
  "use strict";
  const roles = ["headings", "itemNames", "descriptions", "labels", "quantities"];
  const areas = ["general", "detail"];
  const roleNames = { headings: "Headings", itemNames: "Item names", descriptions: "Descriptions", labels: "Labels", quantities: "Quantities" };
  const defaults = {
    general: { headings: [24, "#0b1115"], itemNames: [20, "#0b1115"], descriptions: [15, "#39464e"], labels: [11, "#39464e"], quantities: [17, "#0b1115"] },
    detail: { headings: [23, "#0b1115"], itemNames: [17, "#0b1115"], descriptions: [12, "#39464e"], labels: [11, "#39464e"], quantities: [17, "#0b1115"] }
  };
  const selectors = {
    headings: "h1,h2,h3,.module-tile>strong,.panel-title,.return-panel-heading strong",
    itemNames: ".line-info>strong,.selected-header>strong,.order-card>strong,.fulfillment-lines b,.history-line-name>strong,.inventory-card strong,.return-line-identity>strong",
    descriptions: ".module-tile>span,.line-info>span,.selected-header>p,.topbar-title>span,.order-card>.muted,.history-line-name>span,.return-line-identity>span,.full-order-note p",
    labels: "label>span,.measure>span,.progress-strip span,.selected-header>span,.linked-supply-breakdown span,.cycle-count-field>span,.consolidation-review-quantity>span,.return-unit-field>span",
    quantities: ".measure>b,.progress-strip strong,.stepper input,.cycle-count-field>strong,.cycle-variance strong,.return-quantity-stepper>output,[data-return-calculated-value],[data-return-line-proposed],.linked-supply-breakdown b,.consolidation-review-quantity>strong,.return-stock-balance-grid strong,.return-line-card-measures b"
  };
  const gaps = [
    [".topbar", 12, "8px 14px"], [".topbar-actions", 8], [".module-menu", 14], [".module-tile", 8, "18px"],
    [".detail-panel", 8, "10px"], [".detail-header", 10], [".work-area", 10], [".line-list", 7],
    [".line-card", 7, "8px"], [".compact-line-list", 5], [".compact-line-list .line-card", 6, "5px 7px"],
    [".line-info", 3], [".compact-line-list .line-info", 1], [".required-measures", 6],
    [".selected-measures", 6], [".selected-header", 3], [".selected-actions", 8], [".measure", null, "5px"],
    [".order-list", 7, "8px"], [".order-card", 2, "10px 52px 10px 10px"], [".return-card", 10, "14px"],
    [".fulfillment-card", 10, "14px"], [".return-stock-lines", 8], [".stepper-field", 4]
  ];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const t = (key, fallback) => root.MBBS_I18N?.t(key, fallback) || fallback;
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

  // Cache and response values are untrusted; only these primitives reach CSS.
  function normalize(value = {}) {
    if (!isObject(value)) value = {};
    const result = { styles: {}, spacing: { general: "standard", detail: "inherit" }, useDeviceKeyboard: value.useDeviceKeyboard === true };
    for (const area of areas) {
      result.styles[area] = {};
      for (const role of roles) {
        const style = value.styles?.[area]?.[role];
        result.styles[area][role] = {
          fontSizePx: Number.isInteger(style?.fontSizePx) && style.fontSizePx >= 8 && style.fontSizePx <= 48 ? style.fontSizePx : null,
          color: typeof style?.color === "string" && /^#[0-9a-f]{6}$/i.test(style.color) ? style.color.toLowerCase() : null
        };
      }
      if (["compact", "standard", "spacious", ...(area === "detail" ? ["inherit"] : [])].includes(value.spacing?.[area])) result.spacing[area] = value.spacing[area];
    }
    return result;
  }

  function effective(value, area, role) {
    const style = value.styles[area][role];
    const general = value.styles.general[role];
    return {
      fontSizePx: style.fontSizePx ?? general.fontSizePx ?? defaults[area][role][0],
      color: style.color ?? general.color ?? defaults[area][role][1]
    };
  }

  function styleCss(value) {
    const scope = '#app:not([data-module="settings"])';
    const css = [];
    for (const area of areas) {
      const prefix = area === "general" ? scope : `${scope} .detail-panel`;
      for (const role of roles) {
        const style = value.styles[area][role];
        const target = `${prefix} :is(${selectors[role]})`;
        if (style.fontSizePx !== null) css.push(`${target}{font-size:${style.fontSizePx}px!important;}`);
        if (style.color !== null) css.push(`${target}:not(:where(.sync-alert *,.line-alert *,.status-pill *,.status-pill,.confirmed-measure *,.danger-button *,.danger-button)){color:${style.color}!important;}`);
      }
      const measureSize = Math.max(effective(value, area, "labels").fontSizePx, effective(value, area, "quantities").fontSizePx);
      if (measureSize > 20) {
        // Large measurements need room for the label and its unit on one line.
        css.push(`${prefix} .line-card{grid-template-columns:minmax(0,1fr);}`);
        css.push(`${prefix} :is(.required-measures,.selected-measures){grid-template-columns:repeat(auto-fit,minmax(min(100%,${measureSize * 5 + 20}px),1fr));}`);
      }
      if (roles.some((role) => effective(value, area, role).fontSizePx > 32)) {
        // Let the detail panel scroll as a whole instead of shrinking its editors.
        css.push(`${prefix} .work-area{flex:0 0 auto;min-height:320px;overflow:visible!important;}`);
      }
    }
    const ratio = { compact: 0.8, standard: 1, spacious: 1.25 };
    for (const area of areas) {
      const setting = value.spacing[area];
      if (setting === "inherit" || (area === "general" && setting === "standard")) continue;
      const prefix = area === "general" ? scope : `${scope} .detail-panel`;
      const scale = ratio[setting];
      for (const [selector, gap, padding] of gaps) {
        const target = area === "detail" && selector === ".detail-panel" ? prefix : `${prefix} ${selector}`;
        const declarations = [gap === null ? "" : `gap:${gap * scale}px!important;`, padding ? `padding:${padding.replace(/([\d.]+)px/g, (_, size) => `${Number(size) * scale}px`)}!important;` : ""].join("");
        css.push(`${target}{${declarations}}`);
      }
      css.push(`${prefix} :is(.line-info,.selected-header,.order-card,label,p){line-height:${setting === "compact" ? 1.1 : setting === "spacious" ? 1.5 : 1.2};}`);
    }
    return css.join("\n");
  }

  function create({ app, api, accountId, isOpen, shell, onClose }) {
    let saved = normalize();
    let draft = null;
    let owner = "";
    let generation = 0;
    let dirty = false;
    let saving = false;
    let loading = false;
    let message = "";
    const styleElement = document.createElement("style");
    styleElement.id = "operator-account-styles";
    document.head.append(styleElement);
    const cacheKey = (id) => `mbbs.operator.preferences.${id}`;

    function apply() {
      styleElement.textContent = styleCss(saved);
      app.dataset.customDisplay = String(Boolean(styleElement.textContent));
      for (const id of ["customerPickupScan", "returnOrderLookup"]) {
        const input = document.getElementById(id);
        if (input) input.inputMode = saved.useDeviceKeyboard ? "text" : "none";
      }
    }
    function cache() {
      try { localStorage.setItem(cacheKey(owner), JSON.stringify(saved)); } catch { /* Server remains authoritative. */ }
    }
    async function load() {
      const id = String(accountId() || "");
      if (!id || saving || (isOpen() && dirty)) return;
      if (owner !== id) {
        owner = id;
        saved = normalize();
        try { saved = normalize(JSON.parse(localStorage.getItem(cacheKey(id)) || "{}")); } catch { /* Use defaults. */ }
        apply();
      }
      const request = ++generation;
      loading = true;
      try {
        const response = await api("/api/operator/preferences");
        if (request !== generation || String(accountId() || "") !== id || saving || (isOpen() && dirty)) return;
        saved = normalize(response);
        cache();
        apply();
        message = "";
        if (isOpen()) draft = copy(saved);
      } catch {
        if (request === generation && String(accountId() || "") === id) message = t("operator.preferencesLoadFailed", "Could not load account settings. Showing the last saved settings; reopen Settings to retry.");
      } finally {
        if (request === generation) {
          loading = false;
          if (isOpen()) render();
        }
      }
    }

    function samples(role) {
      return {
        headings: t("operator.preferencesSampleHeading", "Order details"),
        itemNames: "SOB001234 · " + t("operator.preferencesSampleItem", "Paving stone"),
        descriptions: t("operator.preferencesSampleDescription", "Product description · ABC 123"),
        labels: t("operator.preferencesSampleLabel", "Remaining quantity"),
        quantities: root.MBBS_I18N?.language() === "zh-CN" ? "12 板 · 3 层 · 2 组 · 8 件" : "12 PLT · 3 LYR · 2 SEC · 8 PCS"
      }[role];
    }
    function row(area, role) {
      const style = draft.styles[area][role];
      const shown = effective(draft, area, role);
      const name = t(`operator.preferencesRole.${role}`, roleNames[role]);
      return `<div class="display-style-row" data-style-row data-area="${area}" data-role="${role}">
        <div class="display-style-controls"><strong>${name}</strong>
          <label><span>${t("operator.preferencesFontSize", "Font size")}</span><div class="display-px-control">
            <button type="button" data-pref-step="-1" aria-label="${escape(t("operator.preferencesDecrease", "Decrease font size"))}" ${shown.fontSizePx <= 8 ? "disabled" : ""}>−</button>
            <input type="number" min="8" max="48" step="1" value="${shown.fontSizePx}" data-pref-size aria-label="${escape(name)} (px)"/><span>px</span>
            <button type="button" data-pref-step="1" aria-label="${escape(t("operator.preferencesIncrease", "Increase font size"))}" ${shown.fontSizePx >= 48 ? "disabled" : ""}>+</button>
          </div></label>
          <label><span>${t("operator.preferencesFontColor", "Font colour")}</span><div class="display-color-control">
            <input type="color" value="${shown.color}" data-pref-color aria-label="${escape(name)} ${escape(t("operator.preferencesFontColor", "Font colour"))}"/>
            <input value="${shown.color}" data-pref-hex pattern="#[0-9a-fA-F]{6}" maxlength="7" spellcheck="false" aria-label="${escape(name)} HEX"/>
          </div></label>
          <small data-pref-origin>${style.fontSizePx === null && style.color === null ? t("operator.preferencesOriginal", "Default / inherited style") : t("operator.preferencesCustom", "Custom style")}</small>
        </div>
        <div class="display-style-demo"><small>${t("operator.preferencesPreview", "Live preview")}</small><div data-pref-demo style="font-size:${shown.fontSizePx}px;color:${shown.color}">${escape(samples(role))}</div></div>
      </div>`;
    }
    function spacingSelect(area) {
      const options = [["compact", "Compact"], ["standard", "Standard"], ["spacious", "Spacious"]];
      if (area === "detail") options.unshift(["inherit", "Follow general"]);
      return `<label class="display-spacing"><span>${t("operator.preferencesSpacing", "Spacing")}</span><select data-pref-spacing="${area}">${options.map(([key, label]) => `<option value="${key}" ${draft.spacing[area] === key ? "selected" : ""}>${t(`operator.preferencesSpacing.${key}`, label)}</option>`).join("")}</select><div class="display-spacing-demo" data-spacing-demo="${area}"><span>${t("operator.preferencesSampleHeading", "Order details")}</span><span>${t("operator.preferencesSampleLabel", "Remaining quantity")}: 12</span></div></label>`;
    }
    function render() {
      if (!draft) draft = copy(saved);
      shell(t("operator.displaySettings", "Display and input settings"), t("operator.preferencesAccount", "Saved with your operator account"), `<section class="display-settings">
        <form data-display-settings-form>
          <p>${t("operator.preferencesHelp", "Adjust each text style. Empty overrides retain the original layout; detail settings override general settings.")}</p>
          <div class="display-settings-message" role="status">${escape(message || (loading ? t("common.loading", "Loading") : ""))}</div>
          <fieldset ${saving ? "disabled" : ""}>
            ${areas.map((area) => `<section class="display-settings-group"><h2>${t(`operator.preferencesArea.${area}`, area === "general" ? "General interface" : "Detail panel")}</h2>${roles.map((role) => row(area, role)).join("")}${spacingSelect(area)}</section>`).join("")}
            <label class="display-keyboard-setting"><input type="checkbox" data-pref-keyboard ${draft.useDeviceKeyboard ? "checked" : ""}/><span>${t("operator.preferencesKeyboard", "Use device keyboard")}</span></label>
            <p>${t("operator.preferencesKeyboardHelp", "For customer pickup and return order numbers. The application keypad is always available.")}</p>
            <div class="display-settings-actions"><button class="primary-button" type="submit">${saving ? t("common.loading", "Loading") : t("common.save", "Save")}</button><button type="button" data-pref-action="cancel">${t("common.cancel", "Cancel")}</button><button type="button" data-pref-action="reset">${t("operator.preferencesReset", "Reset default styles")}</button></div>
          </fieldset>
        </form></section>`, `<button class="secondary-button display-settings-back" data-pref-action="back" type="button" ${saving ? "disabled" : ""}><span aria-hidden="true">←</span> ${t("common.back", "Back")}</button>`);
      updatePreviews();
    }
    function updatePreviews() {
      for (const element of app.querySelectorAll("[data-style-row]")) {
        const { area, role } = element.dataset;
        const shown = effective(draft, area, role);
        const demo = element.querySelector("[data-pref-demo]");
        demo.style.fontSize = `${shown.fontSizePx}px`;
        demo.style.color = shown.color;
        for (const [selector, value] of [["[data-pref-size]", shown.fontSizePx], ["[data-pref-color]", shown.color], ["[data-pref-hex]", shown.color]]) {
          const input = element.querySelector(selector);
          if (input !== document.activeElement) input.value = value;
        }
        element.querySelector('[data-pref-step="-1"]').disabled = shown.fontSizePx <= 8;
        element.querySelector('[data-pref-step="1"]').disabled = shown.fontSizePx >= 48;
        const style = draft.styles[area][role];
        element.querySelector("[data-pref-origin]").textContent = style.fontSizePx === null && style.color === null ? t("operator.preferencesOriginal", "Default / inherited style") : t("operator.preferencesCustom", "Custom style");
      }
      for (const element of app.querySelectorAll("[data-spacing-demo]")) {
        let setting = draft.spacing[element.dataset.spacingDemo];
        if (setting === "inherit") setting = draft.spacing.general;
        element.dataset.density = setting;
      }
    }
    app.addEventListener("click", (event) => {
      if (!isOpen() || saving) return;
      const button = event.target.closest("button");
      if (!button) return;
      if (["cancel", "back"].includes(button.dataset.prefAction)) { draft = null; dirty = false; message = ""; onClose(); return; }
      if (button.dataset.prefAction === "reset") {
        draft = { ...normalize(), useDeviceKeyboard: draft.useDeviceKeyboard };
        dirty = true;
        message = t("operator.preferencesResetPreview", "Default styles restored in the preview. Save to apply.");
        render();
      }
      if (button.dataset.prefStep) {
        const { area, role } = button.closest("[data-style-row]").dataset;
        draft.styles[area][role].fontSizePx = Math.min(48, Math.max(8, effective(draft, area, role).fontSizePx + Number(button.dataset.prefStep)));
        dirty = true;
        const input = button.closest("[data-style-row]").querySelector("[data-pref-size]");
        input.setCustomValidity("");
        updatePreviews();
      }
    });
    app.addEventListener("input", (event) => {
      if (!isOpen() || saving || !draft) return;
      const input = event.target;
      const rowElement = input.closest("[data-style-row]");
      if (rowElement) {
        const { area, role } = rowElement.dataset;
        if (input.matches("[data-pref-size]")) {
          const value = Number(input.value);
          const valid = input.value !== "" && Number.isInteger(value) && value >= 8 && value <= 48;
          input.setCustomValidity(valid ? "" : t("operator.preferencesSizeInvalid", "Enter a whole number from 8 to 48."));
          if (!valid) { dirty = true; return; }
          draft.styles[area][role].fontSizePx = value;
        } else if (input.matches("[data-pref-color],[data-pref-hex]")) {
          const valid = /^#[0-9a-f]{6}$/i.test(input.value);
          input.setCustomValidity(valid ? "" : t("operator.preferencesColorInvalid", "Enter a colour such as #123456."));
          if (!valid) { dirty = true; return; }
          draft.styles[area][role].color = input.value.toLowerCase();
          rowElement.querySelector("[data-pref-hex]").setCustomValidity("");
        } else return;
      } else if (input.matches("[data-pref-spacing]")) draft.spacing[input.dataset.prefSpacing] = input.value;
      else if (input.matches("[data-pref-keyboard]")) draft.useDeviceKeyboard = input.checked;
      else return;
      dirty = true;
      updatePreviews();
    });
    app.addEventListener("submit", async (event) => {
      if (!event.target.matches("[data-display-settings-form]")) return;
      event.preventDefault();
      if (saving || !event.target.reportValidity()) return;
      const id = String(accountId() || "");
      if (!id || id !== owner) return;
      ++generation;
      loading = false;
      saving = true;
      const submitted = copy(draft);
      render();
      try {
        const response = await api("/api/operator/preferences", { method: "PUT", body: JSON.stringify(submitted) });
        if (String(accountId() || "") !== id) return;
        saved = normalize(response);
        cache();
        apply();
        dirty = false;
        draft = copy(saved);
        message = t("operator.preferencesSaved", "Settings saved to your account.");
      } catch {
        message = t("operator.preferencesSaveFailed", "Settings were not saved. Check the connection and press Save to retry.");
      } finally {
        saving = false;
        if (isOpen() && String(accountId() || "") === id) render();
      }
    });
    return {
      load, render,
      open() { draft = copy(saved); dirty = false; message = ""; render(); return load(); },
      refresh() { if (!isOpen()) return load(); },
      inputMode() { return saved.useDeviceKeyboard ? "text" : "none"; }
    };
  }
  root.OperatorDisplaySettings = { create, normalize, effective, styleCss };
})(globalThis);
