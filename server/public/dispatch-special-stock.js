const dispatchSpecialStockApp = document.getElementById("dispatchSpecialStockApp");
const dispatchSpecialState = { operator: null, enabled: null, handoffs: [], selected: null, search: "", status: "", loading: true, busy: false, error: "", notice: "" };

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
  return dispatchSpecialState.handoffs.map((detail) => `<button class="stock-request-card ${detail.id === dispatchSpecialState.selected?.id ? "selected" : ""}" data-dispatch-special-action="select" data-id="${detail.id}" type="button"><span class="stock-request-status-line"><strong>${dispatchSpecialEscape(detail.requestRef)}</strong><span class="stock-request-pill ${dispatchSpecialEscape(detail.handoff?.status)}">${dispatchSpecialEscape(detail.handoff?.status?.replaceAll("_", " "))}</span></span><span>${dispatchSpecialEscape(detail.salesOrderRef)} · ${dispatchSpecialEscape(detail.purchaseOrderRef)}</span><small>${dispatchSpecialEscape(detail.customerName)} · ${dispatchSpecialEscape(detail.vendorName)}</small></button>`).join("");
}

function dispatchSpecialDetail() {
  const detail = dispatchSpecialState.selected;
  if (!detail) return `<div class="stock-request-empty"><strong>Select a handoff</strong><span>Review exact order and route evidence before enabling Planning.</span></div>`;
  const handoff = detail.handoff;
  const ready = handoff?.status === "ready";
  return `<div class="stock-request-heading"><div><h2>${dispatchSpecialEscape(detail.requestRef)}</h2><p>${dispatchSpecialEscape(detail.salesOrderRef)} · ${dispatchSpecialEscape(detail.purchaseOrderRef)}</p></div><span class="stock-request-pill ${dispatchSpecialEscape(handoff.status)}">${dispatchSpecialEscape(handoff.status.replaceAll("_", " "))}</span></div>
    <div class="stock-request-summary"><span><small>Pickup</small><strong>${dispatchSpecialEscape(handoff.pickupAddress)}</strong></span><span><small>Destination</small><strong>${dispatchSpecialEscape(handoff.destinationAddress)}</strong></span><span><small>Fulfillment</small><strong>${dispatchSpecialEscape(detail.fulfillmentMethod.replaceAll("_", " "))}</strong></span><span><small>Operational yard</small><strong>${dispatchSpecialEscape(String(handoff.operationalYardLocationId))}</strong></span></div>
    <section class="stock-request-section"><h3>Exact accepted materials</h3><div class="stock-request-lines">${detail.lines.filter((line) => line.salesDecision === "accepted").map((line) => `<article class="stock-request-line"><strong>${dispatchSpecialEscape(line.itemResolution?.description || line.productName)}</strong><span>${dispatchSpecialEscape(line.itemResolution?.itemName)} · ${line.itemResolution?.salesQuantity} ${dispatchSpecialEscape(line.itemResolution?.salesUom)}</span></article>`).join("")}</div></section>
    ${handoff.status === "waiting_route" ? `<div class="stock-request-notice">Choose the physical route. Until then, this page does not provide an active Planning link.</div><div class="stock-request-actions">${detail.fulfillmentMethod === "mbt_delivery" ? `<button class="primary" data-dispatch-special-action="route" data-route="direct" type="button">Direct vendor → customer</button>` : ""}<button class="primary" data-dispatch-special-action="route" data-route="via_yard" type="button">Via MBBS yard</button></div>` : ""}
    ${ready ? `<div class="stock-request-notice">Route locked as <strong>${dispatchSpecialEscape(handoff.route.replaceAll("_", " "))}</strong>. The SO remains in the global order pool and can now be searched in Planning.</div><div class="stock-request-actions"><button class="primary" onclick="location.href='/dispatch/planning?search=${encodeURIComponent(detail.salesOrderRef)}'" type="button">Open ${dispatchSpecialEscape(detail.salesOrderRef)} in Planning</button></div>` : ""}`;
}

function renderDispatchSpecial() {
  if (dispatchSpecialState.enabled === false) {
    dispatchSpecialStockApp.innerHTML = `${dispatchSpecialHeader()}<section class="stock-request-page"><div class="stock-request-empty"><strong>Special Item workflow is off</strong><span>The rollout gate must be enabled before handoffs can be used.</span></div></section>`;
    return;
  }
  dispatchSpecialStockApp.innerHTML = `${dispatchSpecialHeader()}<section class="stock-request-page"><div class="stock-request-toolbar"><div class="stock-request-actions"><input class="stock-request-search" data-dispatch-special-search value="${dispatchSpecialEscape(dispatchSpecialState.search)}" placeholder="Search SPREQ, SO, or PO" /><select data-dispatch-special-status><option value="">All statuses</option>${["waiting_route", "ready", "planned", "in_progress", "completed", "attention"].map((status) => `<option value="${status}" ${dispatchSpecialState.status === status ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`).join("")}</select><button data-dispatch-special-action="refresh" type="button">Refresh</button></div></div><div class="stock-request-feedback">${dispatchSpecialState.notice ? `<div class="stock-request-notice">${dispatchSpecialEscape(dispatchSpecialState.notice)}</div>` : ""}${dispatchSpecialState.error ? `<div class="stock-request-notice stock-request-error">${dispatchSpecialEscape(dispatchSpecialState.error)}</div>` : ""}</div><div class="stock-request-workspace"><aside class="stock-request-panel stock-request-list">${dispatchSpecialList()}</aside><section class="stock-request-panel stock-request-detail">${dispatchSpecialDetail()}</section></div></section>`;
}

async function loadDispatchSpecial(selectedId = dispatchSpecialState.selected?.id) {
  dispatchSpecialState.loading = true;
  renderDispatchSpecial();
  try {
    const params = new URLSearchParams({ search: dispatchSpecialState.search, status: dispatchSpecialState.status });
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
  dispatchSpecialState.status = event.target.value;
  loadDispatchSpecial(null).catch((error) => { dispatchSpecialState.error = error.message; renderDispatchSpecial(); });
});

dispatchSpecialStockApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-dispatch-special-action]");
  if (!button || dispatchSpecialState.busy) return;
  try {
    if (button.dataset.dispatchSpecialAction === "select") {
      dispatchSpecialState.selected = dispatchSpecialState.handoffs.find((detail) => detail.id === Number(button.dataset.id));
      return renderDispatchSpecial();
    }
    if (button.dataset.dispatchSpecialAction === "refresh") return loadDispatchSpecial();
    if (button.dataset.dispatchSpecialAction === "route") {
      dispatchSpecialState.busy = true;
      const detail = await dispatchSpecialApi(`/api/dispatch/special-stock-handoffs/${dispatchSpecialState.selected.id}/handoff-route`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: dispatchSpecialState.selected.revision, requestedRoute: button.dataset.route })
      });
      dispatchSpecialState.notice = `Route saved as ${detail.handoffRoute.replaceAll("_", " ")}.`;
      await loadDispatchSpecial(detail.id);
    }
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
