const scheduleFormattingApp = document.getElementById("scheduleFormattingApp");

let scheduleFormattingOperator = null;
let scheduleFormattingPayload = null;
let scheduleFormattingBusy = false;
let scheduleFormattingNotice = "";
let scheduleFormattingActiveSection = "status";

const SCHEDULE_FORMAT_DEFAULT_BACKGROUND = "#ffffff";
const SCHEDULE_FORMAT_DEFAULT_COLOR = "#20313a";

function scheduleFormattingEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function scheduleFormattingApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function scheduleFormattingDefaultRule() {
  return {
    cellEnabled: false,
    cellBackground: SCHEDULE_FORMAT_DEFAULT_BACKGROUND,
    cellColor: SCHEDULE_FORMAT_DEFAULT_COLOR,
    rowEnabled: false,
    rowBackground: SCHEDULE_FORMAT_DEFAULT_BACKGROUND,
    rowColor: SCHEDULE_FORMAT_DEFAULT_COLOR
  };
}

function scheduleFormattingRule(category, key) {
  const rule = scheduleFormattingPayload?.rules?.[category]?.[key];
  return { ...scheduleFormattingDefaultRule(), ...(rule || {}) };
}

function scheduleFormattingHex(value, fallback) {
  const clean = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(clean) ? clean : fallback;
}

function scheduleFormattingLuminance(hex) {
  const channels = scheduleFormattingHex(hex, "#000000").slice(1).match(/.{2}/g)
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function scheduleFormattingContrast(background, color) {
  const first = scheduleFormattingLuminance(background);
  const second = scheduleFormattingLuminance(color);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function scheduleFormattingPresetOptions() {
  const presets = Array.isArray(scheduleFormattingPayload?.presets)
    ? scheduleFormattingPayload.presets
    : [];
  return `<option value="">Choose a suggested pair…</option>${presets.map((preset) =>
    `<option value="${scheduleFormattingEscape(preset.id)}">${scheduleFormattingEscape(preset.label)}</option>`
  ).join("")}`;
}

function scheduleFormattingPairEditor({ category, key, scope, enabled, background, color }) {
  const contrast = scheduleFormattingContrast(background, color);
  const title = scope === "row" ? "Whole row" : "Cell";
  return `<div class="schedule-format-pair" data-format-pair data-category="${scheduleFormattingEscape(category)}" data-key="${scheduleFormattingEscape(key)}" data-scope="${scope}">
    <label class="schedule-format-enabled">
      <input data-format-field="${scope}Enabled" type="checkbox" ${enabled ? "checked" : ""} />
      <span>${title} formatting</span>
    </label>
    <div class="schedule-format-colors">
      <label><span>Background</span><span class="schedule-format-color-input">
        <input data-format-color-picker="background" type="color" value="${scheduleFormattingEscape(background)}" />
        <input data-format-field="${scope}Background" type="text" value="${scheduleFormattingEscape(background)}" maxlength="7" spellcheck="false" />
      </span></label>
      <label><span>Font</span><span class="schedule-format-color-input">
        <input data-format-color-picker="color" type="color" value="${scheduleFormattingEscape(color)}" />
        <input data-format-field="${scope}Color" type="text" value="${scheduleFormattingEscape(color)}" maxlength="7" spellcheck="false" />
      </span></label>
    </div>
    <select data-format-preset aria-label="${title} suggested color combination">${scheduleFormattingPresetOptions()}</select>
    <div class="schedule-format-preview" data-format-preview style="background:${scheduleFormattingEscape(background)};color:${scheduleFormattingEscape(color)}">
      <strong>Sample</strong><span data-format-contrast class="${contrast >= 4.5 ? "good" : "low"}">${contrast.toFixed(1)}:1 ${contrast >= 4.5 ? "Good contrast" : "Low contrast"}</span>
    </div>
  </div>`;
}

function scheduleFormattingRuleCard(category, key, { allowRow = false } = {}) {
  const rule = scheduleFormattingRule(category, key);
  return `<article class="schedule-format-rule" data-format-rule data-category="${scheduleFormattingEscape(category)}" data-key="${scheduleFormattingEscape(key)}">
    <header><strong>${scheduleFormattingEscape(key)}</strong><button data-action="reset-rule" type="button">Reset rule</button></header>
    <div class="schedule-format-rule-pairs ${allowRow ? "two-column" : ""}">
      ${scheduleFormattingPairEditor({
        category,
        key,
        scope: "cell",
        enabled: rule.cellEnabled,
        background: rule.cellBackground,
        color: rule.cellColor
      })}
      ${allowRow ? scheduleFormattingPairEditor({
        category,
        key,
        scope: "row",
        enabled: rule.rowEnabled,
        background: rule.rowBackground,
        color: rule.rowColor
      }) : ""}
    </div>
  </article>`;
}

function scheduleFormattingPresetGallery() {
  return `<div class="schedule-format-preset-gallery">
    ${(scheduleFormattingPayload?.presets || []).map((preset) =>
      `<div style="background:${scheduleFormattingEscape(preset.background)};color:${scheduleFormattingEscape(preset.color)}"><strong>${scheduleFormattingEscape(preset.label)}</strong><span>${scheduleFormattingEscape(preset.background)} / ${scheduleFormattingEscape(preset.color)}</span></div>`
    ).join("")}
  </div>`;
}

function renderScheduleFormatting() {
  const operator = scheduleFormattingOperator || {};
  if (!scheduleFormattingPayload) {
    scheduleFormattingApp.innerHTML = `<section class="dispatch-login-panel"><h1>Schedule Formatting</h1><p>Loading company formatting rules…</p></section>`;
    return;
  }
  const statuses = scheduleFormattingPayload.options?.statuses || [];
  const types = scheduleFormattingPayload.options?.types || [];
  const dropoffs = scheduleFormattingPayload.options?.dropoffPoints || [];
  scheduleFormattingApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>MBBS Transportation</p><h1>Schedule Formatting</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${scheduleFormattingEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/scm'" type="button">SCM Menu</button>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    ${scheduleFormattingNotice ? `<div class="route-notice"><span>${scheduleFormattingEscape(scheduleFormattingNotice)}</span></div>` : ""}
    <section class="schedule-formatting-page">
      <div class="schedule-formatting-heading">
        <div><h2>PO / TO Schedule conditional formatting</h2>
          <p>These company-wide rules apply to SCM, Dispatch, and Sales schedule views. Cell rules take priority over whole-row status rules; reconciliation keeps its gold safety outline.</p>
        </div>
        <div class="schedule-formatting-actions">
          <button data-action="reset-all" type="button" ${scheduleFormattingBusy ? "disabled" : ""}>Restore defaults</button>
          <button class="primary" data-action="save-formatting" type="button" ${scheduleFormattingBusy ? "disabled" : ""}>${scheduleFormattingBusy ? "Saving…" : "Save formatting"}</button>
        </div>
      </div>
      <nav class="schedule-formatting-tabs" role="tablist" aria-label="Conditional formatting category">
        <button class="${scheduleFormattingActiveSection === "status" ? "active" : ""}" data-action="show-section" data-section="status" role="tab" aria-selected="${scheduleFormattingActiveSection === "status"}" type="button">
          <strong>Status</strong><span>${statuses.length} rules · cell and whole row</span>
        </button>
        <button class="${scheduleFormattingActiveSection === "type" ? "active" : ""}" data-action="show-section" data-section="type" role="tab" aria-selected="${scheduleFormattingActiveSection === "type"}" type="button">
          <strong>Type &amp; Sp.O</strong><span>${types.length} Type-cell rules</span>
        </button>
        <button class="${scheduleFormattingActiveSection === "dropoffPoint" ? "active" : ""}" data-action="show-section" data-section="dropoffPoint" role="tab" aria-selected="${scheduleFormattingActiveSection === "dropoffPoint"}" type="button">
          <strong>Drop-off Point</strong><span>${dropoffs.length} location rules</span>
        </button>
      </nav>
      <details class="schedule-formatting-presets">
        <summary><span><strong>Suggested color combinations</strong><small>Deep red/white, navy/white, amber/dark, and more</small></span></summary>
        <p>Choose these from any rule’s preset list, then adjust the colors if needed. A contrast ratio below 4.5:1 is flagged.</p>
        ${scheduleFormattingPresetGallery()}
      </details>
      <section class="schedule-formatting-section" data-format-section="status" ${scheduleFormattingActiveSection === "status" ? "" : "hidden"}>
        <div class="schedule-formatting-section-head"><h3>Order Status</h3><p>Style the Status cell and, independently, the entire schedule row.</p></div>
        <div class="schedule-formatting-rules">${statuses.map((status) => scheduleFormattingRuleCard("status", status, { allowRow: true })).join("")}</div>
      </section>
      <section class="schedule-formatting-section" data-format-section="type" ${scheduleFormattingActiveSection === "type" ? "" : "hidden"}>
        <div class="schedule-formatting-section-head"><h3>Order Type &amp; Sp.O</h3><p>Style PO, TO, and VRMA Type cells. Sp.O applies to a PO marked Special Order and takes priority over its PO color.</p></div>
        <div class="schedule-formatting-rules compact">${types.map((type) => scheduleFormattingRuleCard("type", type)).join("")}</div>
      </section>
      <section class="schedule-formatting-section" data-format-section="dropoffPoint" ${scheduleFormattingActiveSection === "dropoffPoint" ? "" : "hidden"}>
        <div class="schedule-formatting-section-head">
          <div><h3>Drop-off Point</h3><p>Style the Drop-off Point cell. Current schedule, PO, TO, and VRMA locations are listed automatically.</p></div>
          <form data-form="add-dropoff" class="schedule-format-add"><input name="dropoff" type="text" maxlength="120" placeholder="Add another Drop-off Point" /><button type="submit">Add</button></form>
        </div>
        <div class="schedule-formatting-rules compact">${dropoffs.map((dropoff) => scheduleFormattingRuleCard("dropoffPoint", dropoff)).join("")}</div>
      </section>
    </section>
  `;
}

function collectScheduleFormattingRules() {
  const rules = { status: {}, type: {}, dropoffPoint: {} };
  scheduleFormattingApp.querySelectorAll("[data-format-rule]").forEach((card) => {
    const category = card.dataset.category;
    const key = card.dataset.key;
    if (!rules[category] || !key) return;
    const rule = scheduleFormattingDefaultRule();
    card.querySelectorAll("[data-format-field]").forEach((input) => {
      const field = input.dataset.formatField;
      rule[field] = input.type === "checkbox"
        ? input.checked
        : scheduleFormattingHex(input.value, rule[field]);
    });
    rules[category][key] = rule;
  });
  return rules;
}

function syncScheduleFormattingPayloadFromForm() {
  if (!scheduleFormattingPayload || !scheduleFormattingApp.querySelector("[data-format-rule]")) return;
  scheduleFormattingPayload.rules = collectScheduleFormattingRules();
}

function updateScheduleFormattingPair(pair) {
  const backgroundInput = pair.querySelector('[data-format-field$="Background"]');
  const colorInput = pair.querySelector('[data-format-field$="Color"]');
  const backgroundPicker = pair.querySelector('[data-format-color-picker="background"]');
  const colorPicker = pair.querySelector('[data-format-color-picker="color"]');
  const background = scheduleFormattingHex(backgroundInput?.value, SCHEDULE_FORMAT_DEFAULT_BACKGROUND);
  const color = scheduleFormattingHex(colorInput?.value, SCHEDULE_FORMAT_DEFAULT_COLOR);
  if (backgroundPicker) backgroundPicker.value = background;
  if (colorPicker) colorPicker.value = color;
  const preview = pair.querySelector("[data-format-preview]");
  if (preview) {
    preview.style.background = background;
    preview.style.color = color;
  }
  const contrast = scheduleFormattingContrast(background, color);
  const contrastElement = pair.querySelector("[data-format-contrast]");
  if (contrastElement) {
    contrastElement.textContent = `${contrast.toFixed(1)}:1 ${contrast >= 4.5 ? "Good contrast" : "Low contrast"}`;
    contrastElement.className = contrast >= 4.5 ? "good" : "low";
  }
}

scheduleFormattingApp.addEventListener("input", (event) => {
  const picker = event.target.closest("[data-format-color-picker]");
  if (picker) {
    const pair = picker.closest("[data-format-pair]");
    const suffix = picker.dataset.formatColorPicker === "background" ? "Background" : "Color";
    const textInput = pair?.querySelector(`[data-format-field$="${suffix}"]`);
    if (textInput) textInput.value = picker.value.toLowerCase();
    updateScheduleFormattingPair(pair);
    return;
  }
  const colorText = event.target.closest('[data-format-field$="Background"], [data-format-field$="Color"]');
  if (colorText && /^#[0-9a-f]{6}$/i.test(colorText.value.trim())) {
    updateScheduleFormattingPair(colorText.closest("[data-format-pair]"));
  }
});

scheduleFormattingApp.addEventListener("change", (event) => {
  const presetSelect = event.target.closest("[data-format-preset]");
  if (!presetSelect?.value) return;
  const preset = (scheduleFormattingPayload?.presets || []).find((item) => item.id === presetSelect.value);
  const pair = presetSelect.closest("[data-format-pair]");
  if (!preset || !pair) return;
  pair.querySelector('[data-format-field$="Background"]').value = preset.background;
  pair.querySelector('[data-format-field$="Color"]').value = preset.color;
  pair.querySelector('[data-format-field$="Enabled"]').checked = true;
  updateScheduleFormattingPair(pair);
});

scheduleFormattingApp.addEventListener("submit", (event) => {
  const form = event.target.closest('[data-form="add-dropoff"]');
  if (!form) return;
  event.preventDefault();
  syncScheduleFormattingPayloadFromForm();
  const value = String(new FormData(form).get("dropoff") || "").replace(/\s+/g, " ").trim();
  if (!value) return;
  const options = scheduleFormattingPayload.options.dropoffPoints;
  if (!options.includes(value)) options.push(value);
  options.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
  scheduleFormattingPayload.rules.dropoffPoint[value] = scheduleFormattingDefaultRule();
  renderScheduleFormatting();
  const card = [...scheduleFormattingApp.querySelectorAll('[data-format-rule][data-category="dropoffPoint"]')]
    .find((candidate) => candidate.dataset.key === value);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
});

scheduleFormattingApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || scheduleFormattingBusy) return;
  const action = button.dataset.action;
  if (action === "show-section") {
    syncScheduleFormattingPayloadFromForm();
    const section = button.dataset.section || "";
    if (["status", "type", "dropoffPoint"].includes(section)) {
      scheduleFormattingActiveSection = section;
      renderScheduleFormatting();
    }
    return;
  }
  if (action === "reset-rule") {
    syncScheduleFormattingPayloadFromForm();
    const card = button.closest("[data-format-rule]");
    if (!card) return;
    const category = card.dataset.category;
    const key = card.dataset.key;
    scheduleFormattingPayload.rules[category][key] = {
      ...scheduleFormattingDefaultRule(),
      ...(scheduleFormattingPayload.defaults?.[category]?.[key] || {})
    };
    renderScheduleFormatting();
    return;
  }
  if (action === "save-formatting") {
    const rules = collectScheduleFormattingRules();
    scheduleFormattingPayload.rules = rules;
    scheduleFormattingBusy = true;
    scheduleFormattingNotice = "";
    renderScheduleFormatting();
    try {
      scheduleFormattingPayload = await scheduleFormattingApi("/api/scm/schedule-formatting", {
        method: "PUT",
        body: JSON.stringify({ rules })
      });
      scheduleFormattingNotice = "Schedule formatting saved. Open schedule pages will use it after refresh.";
    } catch (error) {
      scheduleFormattingNotice = `Formatting was not saved: ${error.message}`;
    } finally {
      scheduleFormattingBusy = false;
      renderScheduleFormatting();
    }
    return;
  }
  if (action === "reset-all") {
    if (!window.confirm("Restore the original MBBS schedule colors for every Status, Type, and Drop-off Point rule?")) return;
    scheduleFormattingBusy = true;
    renderScheduleFormatting();
    try {
      scheduleFormattingPayload = await scheduleFormattingApi("/api/scm/schedule-formatting", {
        method: "PUT",
        body: JSON.stringify({ reset: true })
      });
      scheduleFormattingNotice = "Original schedule formatting restored.";
    } catch (error) {
      scheduleFormattingNotice = `Formatting was not reset: ${error.message}`;
    } finally {
      scheduleFormattingBusy = false;
      renderScheduleFormatting();
    }
  }
});

window.addEventListener("mbbs-language-changed", () => {
  syncScheduleFormattingPayloadFromForm();
  renderScheduleFormatting();
});

requireDispatchLogin({
  mount: scheduleFormattingApp,
  roles: ["admin", "scm", "scm_staff"],
  async onReady(operator) {
    scheduleFormattingOperator = operator;
    try {
      scheduleFormattingPayload = await scheduleFormattingApi("/api/scm/schedule-formatting");
      renderScheduleFormatting();
    } catch (error) {
      scheduleFormattingApp.innerHTML = `<section class="dispatch-login-panel"><h1>Schedule Formatting</h1><p>Formatting settings could not be loaded: ${scheduleFormattingEscape(error.message)}</p><button onclick="location.href='/scm'" type="button">SCM Menu</button></section>`;
    }
  }
});
