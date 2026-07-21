const routeRulesApp = document.getElementById("routeRulesApp");

const routeState = {
  operator: null,
  yards: [],
  rules: [],
  busy: "",
  notice: "",
  error: ""
};

function routeEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function routeRoles() {
  return new Set([
    ...(Array.isArray(routeState.operator?.roles) ? routeState.operator.roles : []),
    routeState.operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

function routeCanWrite() {
  const roles = routeRoles();
  return ["admin", "scm", "scm_staff"].some((role) => roles.has(role));
}

async function routeApi(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

function routeHeader() {
  return `<header class="dispatch-topbar">
    <div class="smart-brand"><div class="smart-brand-mark">RT</div><div><p>Smart SCM configuration</p><h1>PO Route Rules</h1></div></div>
    <span class="smart-mode">Source-specific routing</span>
    <div class="topbar-actions"><span class="dispatch-user">${routeEscape(routeState.operator?.display_name || routeState.operator?.username || "")}</span><button type="button" onclick="location.href='/scm/smart'">Smart SCM</button><button type="button" onclick="location.href='/scm'">SCM menu</button><button type="button" onclick="dispatchLogout()">Logout</button></div>
  </header>`;
}

function yardOptions(selected) {
  return routeState.yards.map((yard) => `<option value="${yard.locationId}" ${Number(selected) === Number(yard.locationId) ? "selected" : ""}>${routeEscape(yard.code)}</option>`).join("");
}

function ruleCard(rule, index) {
  const disabled = routeCanWrite() ? "" : "disabled";
  const order = Array.isArray(rule.stopOrder) ? rule.stopOrder : routeState.yards.map((yard) => yard.locationId);
  return `<article class="route-rule-card" data-route-rule="${index}">
    <div class="route-rule-card-head"><div><h3>${routeEscape(rule.sourceName)}</h3><p>${rule.configured ? "Saved rule" : "Using the built-in default until saved"}</p></div><label class="smart-check"><input data-route-enabled type="checkbox" ${rule.enabled ? "checked" : ""} ${disabled}> Enable source rule</label></div>
    <div class="route-rule-fields">
      <label class="smart-field"><span>Maximum drops</span><select data-route-max-drops ${disabled}><option value="1" ${Number(rule.maxDrops) === 1 ? "selected" : ""}>1 drop</option><option value="2" ${Number(rule.maxDrops) === 2 ? "selected" : ""}>2 drops</option></select></label>
      ${order.map((locationId, stopIndex) => `<label class="smart-field"><span>${stopIndex + 1}${stopIndex === 0 ? "st" : stopIndex === 1 ? "nd" : stopIndex === 2 ? "rd" : "th"} stop priority</span><select data-route-stop-order="${stopIndex}" ${disabled}>${yardOptions(locationId)}</select></label>`).join("")}
    </div>
    <div class="route-rule-options">
      <label class="smart-check"><input data-route-redirect type="checkbox" ${rule.partialRedirectEnabled ? "checked" : ""} ${disabled}> Redirect partial direct-yard quantities through a hub</label>
      <label class="smart-field"><span>Redirect hub</span><select data-route-hub ${disabled}><option value="">Select hub</option>${yardOptions(rule.partialRedirectHubLocationId)}</select></label>
      <div class="smart-field"><span>Direct yards tested independently</span><div class="route-rule-checks">${routeState.yards.map((yard) => `<label><input data-route-direct="${yard.locationId}" type="checkbox" ${(rule.partialRedirectDestinationIds || []).map(Number).includes(Number(yard.locationId)) ? "checked" : ""} ${disabled}> ${routeEscape(yard.code)}</label>`).join("")}</div></div>
    </div>
    <label class="smart-field route-rule-notes"><span>Rule notes</span><input data-route-notes value="${routeEscape(rule.notes || "")}" ${disabled}></label>
    <div class="route-rule-actions"><span class="smart-help">Priority controls route display and driving order. A single-stop route is still allowed.</span>${routeCanWrite() ? `<button class="smart-button primary" data-route-action="save" type="button">Save route rule</button>` : ""}</div>
  </article>`;
}

function routeRender() {
  routeRulesApp.innerHTML = `${routeHeader()}<div class="smart-main">
    ${routeState.error ? `<div class="smart-notice error">${routeEscape(routeState.error)}</div>` : ""}
    ${routeState.notice ? `<div class="smart-notice">${routeEscape(routeState.notice)}</div>` : ""}
    ${routeState.busy ? `<div class="smart-notice">${routeEscape(routeState.busy)}…</div>` : ""}
    <section class="smart-section"><div class="smart-section-head route-rule-intro"><div><h2>Vendor-yard route rules</h2><p>Rules apply to newly generated plans and PO Re-Calculate. Confirmed and requested loads are never changed automatically.</p></div>${routeCanWrite() ? `<div class="route-rule-add"><label class="smart-field"><span>Add pickup source</span><input id="routeNewSource" placeholder="Vendor yard name"></label><button class="smart-button" data-route-action="add" type="button">+ Add rule</button></div>` : ""}</div><div class="smart-section-body route-rule-grid">${routeState.rules.map(ruleCard).join("") || `<div class="smart-empty">No vendor pickup sources are available.</div>`}</div></section>
  </div>`;
}

async function routeLoad() {
  routeState.busy = "Loading route rules";
  routeRender();
  const data = await routeApi("/api/scm/smart/route-rules");
  routeState.yards = data.yards || [];
  routeState.rules = data.rules || [];
  routeState.busy = "";
  routeRender();
}

function routePayload(card, rule) {
  const stopOrder = [...card.querySelectorAll("[data-route-stop-order]")]
    .sort((left, right) => Number(left.dataset.routeStopOrder) - Number(right.dataset.routeStopOrder))
    .map((select) => Number(select.value));
  if (new Set(stopOrder).size !== routeState.yards.length) throw new Error("Select each yard exactly once in stop priority.");
  return {
    sourceName: rule.sourceName,
    enabled: card.querySelector("[data-route-enabled]").checked,
    maxDrops: Number(card.querySelector("[data-route-max-drops]").value),
    stopOrder,
    partialRedirectEnabled: card.querySelector("[data-route-redirect]").checked,
    partialRedirectHubLocationId: card.querySelector("[data-route-hub]").value || null,
    partialRedirectDestinationIds: [...card.querySelectorAll("[data-route-direct]:checked")].map((input) => Number(input.dataset.routeDirect)),
    notes: card.querySelector("[data-route-notes]").value
  };
}

routeRulesApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-route-action]");
  if (!button || routeState.busy) return;
  routeState.error = "";
  routeState.notice = "";
  try {
    if (button.dataset.routeAction === "add") {
      const sourceName = document.getElementById("routeNewSource")?.value.trim();
      if (!sourceName) throw new Error("Enter a pickup source name.");
      if (routeState.rules.some((rule) => rule.sourceName.toLowerCase() === sourceName.toLowerCase())) throw new Error("That pickup source already has a row.");
      routeState.rules.unshift({ sourceName, enabled: true, maxDrops: 2, stopOrder: [26, 15, 1, 28], partialRedirectEnabled: false, partialRedirectDestinationIds: [1, 28], partialRedirectHubLocationId: null, notes: "", configured: false });
      routeRender();
      return;
    }
    const card = button.closest("[data-route-rule]");
    const rule = routeState.rules[Number(card.dataset.routeRule)];
    const payload = routePayload(card, rule);
    routeState.busy = `Saving ${rule.sourceName}`;
    routeRender();
    await routeApi("/api/scm/smart/route-rules", { method: "PUT", body: payload });
    routeState.notice = `${rule.sourceName} route rule saved. It will apply to the next plan or PO Re-Calculate.`;
    await routeLoad();
  } catch (error) {
    routeState.busy = "";
    routeState.error = error.message;
    routeRender();
  }
});

window.addEventListener("mbbs-language-changed", routeRender);

requireDispatchLogin({
  mount: routeRulesApp,
  roles: ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"],
  async onReady(operator) {
    routeState.operator = operator;
    routeRender();
    try {
      await routeLoad();
    } catch (error) {
      routeState.busy = "";
      routeState.error = error.message;
      routeRender();
    }
  }
});
