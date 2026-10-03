let specialStageFilter = () => '';
const dispatchSpecialStockApp = document.getElementById("dispatchSpecialStockApp");
const dispatchSpecialState = { operator: null, enabled: null, handoffs: [], selected: null, search: "", status: "", stages: [], loading: true, busy: false, error: "", notice: "" };

function dispatchSpecialEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

async function dispatchSpecialApi(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
  if (!response.ok) {
    const error = new Error(payload?.error || payload || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function dispatchSpecialHeader() {
  const operator = dispatchSpecialState.operator || {};
  return `<header class="dispatch-topbar"><div><p>Dispatch · Special Item</p><h1>Special Item Handoffs</h1></div><div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div><div class="topbar-actions"><span class="dispatch-user">${dispatchSpecialEscape(operator.display_name || operator.username || "")}</span><button onclick="location.href='/dispatch'" type="button">Dispatch Menu</button><button onclick="dispatchLogout()" type="button">Logout</button></div></header>`;
}

function dispatchSpecialList() {
  if (dispatchSpecialState.loading) return `<div class="stock-request-empty"><strong>Loading handoffs…</strong></div>`;
  if (!dispatchSpecialState.handoffs.length) return `<div class="stock-request-empty"><strong>No Special Item handoffs</strong><span>A handoff appears after SCM links an exclusive PO to an approved SO.</span></div>`;
  return dispatchSpecialState.handoffs.map((detail) => `<button class="stock-request-card ${detail.id === dispatchSpecialState.selected?.id ? "selected" : ""}" data-dispatch-special-action="select" data-id="${detail.id}" type="button"><span class="stock-request-status-line"><strong>${dispatchSpecialEscape(detail.requestRef)}</strong><span class="stock-request-pill ${dispatchSpecialEscape(detail.handoff?.status)}">${dispatchSpecialEscape(detail.stageLabel)}</span></span><span>${dispatchSpecialEscape(detail.salesOrderRef)} · ${dispatchSpecialEscape(detail.purchaseOrderRef)}</span><small>${dispatchSpecialEscape(detail.customerName)} · ${dispatchSpecialEscape(detail.vendorName)}</small></button>`).join("");
}

function dispatchSpecialDetail() {
  const detail = dispatchSpecialState.selected;
  if (!detail) return `<div class="stock-request-empty"><strong>Select a handoff</strong><span>Review the linked sales order, purchase order, and accepted materials.</span></div>`;
  const handoff = detail.handoff;
  return `<div class="stock-request-heading"><div><h2>${dispatchSpecialEscape(detail.requestRef)}</h2><p>${dispatchSpecialEscape(detail.salesOrderRef)} · ${dispatchSpecialEscape(detail.purchaseOrderRef)}</p></div><span class="stock-request-pill ${dispatchSpecialEscape(handoff.status)}">${dispatchSpecialEscape(detail.stageLabel)}</span></div>
    <div class="stock-request-summary"><span><small>Pickup</small><strong>${dispatchSpecialEscape(handoff.pickupAddress)}</strong></span><span><small>Destination</small><strong>${dispatchSpecialEscape(handoff.destinationAddress)}</strong></span><span><small>Fulfillment</small><strong>${dispatchSpecialEscape(detail.fulfillmentMethod.replaceAll("_", " "))}</strong></span><span><small>Operational yard</small><strong>${dispatchSpecialEscape(String(handoff.operationalYardLocationId))}</strong></span></div>
    <section class="stock-request-section"><h3>Exact accepted materials</h3><div class="stock-request-lines">${detail.lines.filter((line) => line.salesDecision === "accepted").map((line) => `<article class="stock-request-line"><strong>${dispatchSpecialEscape(line.itemResolution?.description || line.productName)}</strong><span>${dispatchSpecialEscape(line.itemResolution?.itemName)} · ${line.itemResolution?.salesQuantity} ${dispatchSpecialEscape(line.itemResolution?.salesUom)}</span></article>`).join("")}</div></section>
    <div class="stock-request-notice">Plan the linked orders in Dispatch Planning. This notice clears when both the SO and PO are completed.</div>`;
}

function renderDispatchSpecial() {
  if (dispatchSpecialState.enabled === false) {
    dispatchSpecialStockApp.innerHTML = `${dispatchSpecialHeader()}<section class="stock-request-page"><div class="stock-request-empty"><strong>Special Item workflow is off</strong><span>The rollout gate must be enabled before handoffs can be used.</span></div></section>`;
    return;
  }
  dispatchSpecialStockApp.innerHTML = `${dispatchSpecialHeader()}<section class="stock-request-page"><div class="stock-request-toolbar"><div class="stock-request-actions"><input class="stock-request-search" data-dispatch-special-search value="${dispatchSpecialEscape(dispatchSpecialState.search)}" placeholder="Search SPREQ, SO, or PO" />${specialStageFilter(dispatchSpecialState.stages, "data-dispatch-special-status")}<button data-dispatch-special-action="refresh" type="button">Refresh</button></div></div><div class="stock-request-feedback">${dispatchSpecialState.notice ? `<div class="stock-request-notice">${dispatchSpecialEscape(dispatchSpecialState.notice)}</div>` : ""}${dispatchSpecialState.error ? `<div class="stock-request-notice stock-request-error">${dispatchSpecialEscape(dispatchSpecialState.error)}</div>` : ""}</div><div class="stock-request-workspace"><aside class="stock-request-panel stock-request-list">${dispatchSpecialList()}</aside><section class="stock-request-panel stock-request-detail">${dispatchSpecialDetail()}</section></div></section>`;
}

async function loadDispatchSpecial(selectedId = dispatchSpecialState.selected?.id) {
  dispatchSpecialState.loading = true;
  renderDispatchSpecial();
  try {
    const params = new URLSearchParams({ search: dispatchSpecialState.search, stages: dispatchSpecialState.stages.join(",") });
    const payload = await dispatchSpecialApi(`/api/dispatch/special-stock-handoffs?${params}`);
    dispatchSpecialState.handoffs = payload.handoffs || [];
    dispatchSpecialState.selected = dispatchSpecialState.handoffs.find((detail) => detail.id === Number(selectedId)) || dispatchSpecialState.handoffs[0] || null;
  } finally {
    dispatchSpecialState.loading = false;
    renderDispatchSpecial();
  }
}

dispatchSpecialStockApp.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.matches("[data-dispatch-special-search]")) return;
  event.preventDefault();
  dispatchSpecialState.search = event.target.value;
  loadDispatchSpecial(null).catch((error) => { dispatchSpecialState.error = error.message; renderDispatchSpecial(); });
});

dispatchSpecialStockApp.addEventListener("change", (event) => {
  if (!event.target.matches("[data-dispatch-special-status]")) return;
  dispatchSpecialState.stages = [...dispatchSpecialStockApp.querySelectorAll("[data-dispatch-special-status]:checked")].map(input => input.value);
  loadDispatchSpecial(null).catch((error) => { dispatchSpecialState.error = error.message; renderDispatchSpecial(); });
});

dispatchSpecialStockApp.addEventListener("click", async (event) => {
  if (event.target.closest('[data-special-clear-stages]')) { dispatchSpecialState.stages = []; await loadDispatchSpecial(null); return; }
  const button = event.target.closest("[data-dispatch-special-action]");
  if (!button || dispatchSpecialState.busy) return;
  try {
    if (button.dataset.dispatchSpecialAction === "select") {
      dispatchSpecialState.selected = dispatchSpecialState.handoffs.find((detail) => detail.id === Number(button.dataset.id));
      return renderDispatchSpecial();
    }
    if (button.dataset.dispatchSpecialAction === "refresh") return loadDispatchSpecial();
  } catch (error) {
    dispatchSpecialState.error = error.message;
  } finally {
    dispatchSpecialState.busy = false;
    renderDispatchSpecial();
  }
});

requireDispatchLogin({
  mount: dispatchSpecialStockApp,
  roles: ["admin", "dispatcher"],
  async onReady(operator) {
    specialStageFilter = (await import("/special-stock-workflow.js")).stageFilterHtml;
    dispatchSpecialState.operator = operator;
    try {
      const policy = await dispatchSpecialApi("/api/dispatch/special-stock-handoffs/policy");
      dispatchSpecialState.enabled = policy.enabled === true;
      if (dispatchSpecialState.enabled) await loadDispatchSpecial();
      else { dispatchSpecialState.loading = false; renderDispatchSpecial(); }
    } catch (error) {
      dispatchSpecialState.error = error.message;
      dispatchSpecialState.loading = false;
      renderDispatchSpecial();
    }
  }
});
