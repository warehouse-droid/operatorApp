const smartNetSuitePoApp = document.getElementById("smartNetSuitePoApp");

const netSuitePoState = {
  operator: null,
  loads: [],
  search: "",
  view: "pending",
  busy: "",
  notice: "",
  error: ""
};

function poEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function poNumber(value, places = 2) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: places }).format(amount);
}

function poMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(amount);
}

function poDate(value, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return poEscape(value);
  return new Intl.DateTimeFormat("en-CA", withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

function poPill(value, label = null) {
  const css = String(value || "unknown").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return `<span class="smart-pill ${css}">${poEscape(label || String(value || "unknown").replaceAll("_", " "))}</span>`;
}

function poRoles() {
  return new Set([
    ...(Array.isArray(netSuitePoState.operator?.roles) ? netSuitePoState.operator.roles : []),
    netSuitePoState.operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

function poCanWrite() {
  const roles = poRoles();
  return ["admin", "scm", "scm_staff"].some((role) => roles.has(role));
}

function poCanEditPallets(load) {
  return poCanWrite()
    && ["confirmed", "failed"].includes(String(load.status || ""))
    && !load.netsuitePurchaseOrderId
    && !load.netsuitePurchaseOrderRef;
}

async function poApi(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(url, { ...options, headers });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || payload || `Request failed (${response.status})`);
  return payload;
}

function poLinePrice(line) {
  const value = line.lastPurchasePrice ?? line.last_purchase_price;
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function poLineQuantity(line) {
  return Number(line.purchaseQuantity ?? line.salesQuantity ?? line.quantity ?? 0);
}

function poLineAmount(line) {
  const stagedAmount = line.purchaseAmount;
  if (stagedAmount !== null && stagedAmount !== undefined && Number.isFinite(Number(stagedAmount))) return Number(stagedAmount);
  const price = poLinePrice(line);
  return price === null || !Number.isFinite(price) ? null : poLineQuantity(line) * price;
}

function poMaterialLines(load) {
  return (load.lines || []).filter((line) => Number(line.confirmedPallets ?? line.confirmed_pallets ?? 0) > 0);
}

function poPalletLines(load) {
  if (Array.isArray(load.palletLines)) return load.palletLines;
  if (!load.palletItem) return [];
  const grouped = new Map();
  for (const line of poMaterialLines(load)) {
    const locationId = Number(line.destinationLocationId || load.destinationLocationId);
    const key = String(locationId);
    const current = grouped.get(key) || {
      itemId: load.palletItem.itemId || load.palletItem.id,
      itemName: load.palletItem.itemName || "PALLET",
      destinationLocationId: locationId,
      destinationName: line.destinationName || load.destinationName,
      confirmedPallets: 0,
      salesQuantity: 0,
      purchaseUnit: load.palletItem.purchaseUnit || load.palletItem.unit || "EACH",
      lastPurchasePrice: load.palletItem.lastPurchasePrice ?? null,
      lastPurchasePriceSyncedAt: load.palletItem.lastPurchasePriceSyncedAt || null,
      ancillaryPallet: true
    };
    const pallets = Number(line.confirmedPallets ?? line.confirmed_pallets ?? 0);
    current.confirmedPallets += pallets;
    current.salesQuantity += pallets;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function poRoute(load) {
  const stops = Array.isArray(load.routeStops) ? load.routeStops.map((stop) => stop.name).filter(Boolean) : [];
  return [load.sourceName || load.vendor || "Vendor", ...(stops.length ? stops : [load.destinationName])].filter(Boolean).join(" → ");
}

function poLoadBlockers(load) {
  if (Array.isArray(load.reviewBlockers)) {
    return [...new Set(load.reviewBlockers.map((blocker) => String(blocker?.message || "")).filter(Boolean))];
  }
  const explicit = Array.isArray(load.blockers) ? load.blockers.map(String).filter(Boolean) : [];
  const lines = [...poMaterialLines(load), ...poPalletLines(load)];
  if (lines.some((line) => !(poLinePrice(line) > 0))) explicit.push("Every PO item, including PALLET, needs a positive Last Purchase Price.");
  if (lines.some((line) => line.purchaseUnitMismatch)) explicit.push("At least one item purchase unit does not match the staged purchase quantity unit.");
  return [...new Set(explicit)];
}

function poLineRow(line, load) {
  const price = poLinePrice(line);
  const amount = poLineAmount(line);
  const pallets = Number(line.confirmedPallets ?? line.confirmed_pallets ?? 0);
  const syncedAt = line.lastPurchasePriceSyncedAt || line.priceSyncedAt || line.last_purchase_price_synced_at;
  const purchaseUnit = line.purchaseUnit || "";
  const canEditPallet = line.ancillaryPallet && poCanEditPallets(load);
  const automaticQuantity = Number(line.automaticQuantity ?? pallets);
  const palletQuantityControl = line.ancillaryPallet
    ? `<div class="smart-po-pallet-editor"><input data-po-pallet-quantity type="number" min="0" step="0.01" value="${poEscape(poLineQuantity(line))}" ${canEditPallet ? "" : "disabled"} aria-label="Official PALLET quantity for ${poEscape(line.destinationName || "destination")}" />${canEditPallet ? `<button class="smart-button blue" data-po-action="save-pallet" data-proposal-id="${load.id}" data-destination-location-id="${line.destinationLocationId}" type="button">Save</button><button class="smart-button" data-po-action="reset-pallet" data-proposal-id="${load.id}" data-destination-location-id="${line.destinationLocationId}" type="button" ${line.overridden ? "" : "disabled"}>Use automatic</button>` : ""}<span class="smart-po-line-meta">Automatic ${poNumber(automaticQuantity, 2)}${line.overridden ? " · manual override active" : ""}</span></div>`
    : `${poNumber(poLineQuantity(line), 4)} ${purchaseUnit ? poEscape(purchaseUnit) : "unit missing"}`;
  return `<tr class="${line.ancillaryPallet ? "smart-po-pallet-line" : ""}">
    <td><strong>${poEscape(line.itemName || line.item_name || line.itemId)}</strong>${line.ancillaryPallet ? ` ${poPill("reviewed", "Official PALLET")}` : ""}<span class="smart-po-line-meta">ID ${poEscape(line.itemId || line.item_id || "—")}${line.ancillaryPallet ? " · inserted once from confirmed material PLT" : ""}</span></td>
    <td><strong>${poEscape(line.destinationName || line.destination_name || "—")}</strong></td>
    <td class="numeric">${poNumber(pallets, 2)} PLT</td>
    <td class="numeric ${purchaseUnit ? "" : "smart-po-unit-missing"}">${palletQuantityControl}</td>
    <td class="numeric ${price > 0 ? "" : "smart-po-price-missing"}">${price > 0 ? poMoney(price) : "Missing"}<span class="smart-po-line-meta">${syncedAt ? `synced ${poDate(syncedAt, true)}` : "not synced"}</span></td>
    <td class="numeric">${amount === null ? "—" : poMoney(amount)}</td>
  </tr>`;
}

function poLoadCard(load) {
  const materialLines = poMaterialLines(load);
  const palletLines = poPalletLines(load);
  const lines = [...materialLines, ...palletLines];
  const blockers = poLoadBlockers(load);
  const calculatedAmount = lines.reduce((sum, line) => sum + Number(poLineAmount(line) || 0), 0);
  const amount = load.purchaseTotal !== null && load.purchaseTotal !== undefined && Number.isFinite(Number(load.purchaseTotal)) ? Number(load.purchaseTotal) : calculatedAmount;
  const canInsert = poCanWrite() && load.canInsertIntoNetSuite === true;
  const canRemove = poCanWrite() && load.canRemoveFromStaging === true;
  const insertAction = canInsert
    ? `<button class="smart-button primary" data-po-action="insert" data-proposal-id="${load.id}" type="button">${load.status === "executing" ? "Recover PO insertion" : "Insert PO into NetSuite"}</button>`
    : load.netsuitePurchaseOrderRef
      ? poPill("completed", "Inserted")
      : load.status === "cancelled"
        ? poPill("cancelled", "Removed")
        : `<button class="smart-button primary" type="button" disabled>Insert PO into NetSuite</button>`;
  const removeAction = canRemove
    ? `<button class="smart-button danger" data-po-action="remove" data-proposal-id="${load.id}" type="button">Remove staged PO</button>`
    : "";
  return `<article class="smart-proposal smart-po-review-card" data-po-review-load="${load.id}">
    <div class="smart-proposal-head smart-po-review-head">
      <div><strong>PO</strong><div>${poPill(load.status)}</div></div>
      <div class="smart-proposal-route"><strong>${poEscape(poRoute(load))}</strong><span>Review #${load.id}${load.parentProposalId ? ` · vendor load #${load.parentProposalId}` : ""} · plan #${load.runId || "—"}</span><span>Vendor ref ${poEscape(load.vendorReference || "—")} · ready ${poDate(load.vendorReadyDate || load.readyDate)}</span></div>
      <div class="smart-proposal-metric"><strong>${poNumber(load.totalPallets ?? materialLines.reduce((sum, line) => sum + Number(line.confirmedPallets || 0), 0), 2)} PLT</strong><span>Confirmed</span></div>
      <div class="smart-proposal-metric"><strong>${poMoney(amount)}</strong><span>Estimated total</span></div>
      <div class="smart-proposal-metric"><strong>${poEscape(load.netsuitePurchaseOrderRef || "—")}</strong><span>NetSuite PO</span></div>
      <div class="smart-po-review-action">${insertAction}${removeAction}</div>
    </div>
    ${load.poExecutionError ? `<div class="smart-po-error">${poEscape(load.poExecutionError)}</div>` : ""}
    ${blockers.length ? `<div class="smart-po-blockers"><strong>Insertion blocked</strong>${blockers.map((blocker) => `<span>${poEscape(blocker)}</span>`).join("")}</div>` : ""}
    <div class="smart-proposal-lines smart-table-wrap"><table class="smart-table smart-po-lines"><thead><tr><th>Item</th><th>Destination</th><th class="numeric">Confirmed</th><th class="numeric">Purchase quantity</th><th class="numeric">Last Purchase Price</th><th class="numeric">Amount</th></tr></thead><tbody>${lines.map((line) => poLineRow(line, load)).join("")}</tbody></table></div>
    <div class="smart-po-review-foot"><span>Last Purchase Price is snapshotted when the vendor load is confirmed. NetSuite remains the accounting source of truth.</span><strong>${lines.length} PO line${lines.length === 1 ? "" : "s"}</strong></div>
  </article>`;
}

function poHeader() {
  return `<header class="dispatch-topbar">
    <div class="smart-brand"><div class="smart-brand-mark">PO</div><div><p>Smart SCM accounting handoff</p><h1>NetSuite PO</h1></div></div>
    <span class="smart-mode">review before insert</span>
    <div class="topbar-actions"><span class="dispatch-user">${poEscape(netSuitePoState.operator?.display_name || netSuitePoState.operator?.username || "")}</span><button type="button" onclick="location.href='/scm/smart'">Smart SCM</button><button type="button" onclick="location.href='/scm'">SCM menu</button><button type="button" onclick="dispatchLogout()">Logout</button></div>
  </header>`;
}

function poRender() {
  const loads = netSuitePoState.loads || [];
  smartNetSuitePoApp.innerHTML = `${poHeader()}<div class="smart-main">
    ${netSuitePoState.error ? `<div class="smart-notice error">${poEscape(netSuitePoState.error)}</div>` : ""}
    ${netSuitePoState.notice ? `<div class="smart-notice">${poEscape(netSuitePoState.notice)}</div>` : ""}
    ${netSuitePoState.busy ? `<div class="smart-notice">${poEscape(netSuitePoState.busy)}…</div>` : ""}
    <section class="smart-section">
      <div class="smart-section-head"><div><h2>Staged purchase orders</h2><p>Review vendor-confirmed quantities, adjust Official PALLET lines when needed, and verify snapshotted Last Purchase Price before any accounting record is inserted.</p></div><span class="smart-help">${loads.length} load(s)</span></div>
      <div class="smart-toolbar smart-po-toolbar"><input id="smartPoSearch" type="search" value="${poEscape(netSuitePoState.search)}" placeholder="Search review, vendor, item, or yard" /><select id="smartPoView"><option value="pending" ${netSuitePoState.view === "pending" ? "selected" : ""}>Pending insertion</option><option value="completed" ${netSuitePoState.view === "completed" ? "selected" : ""}>Inserted</option><option value="removed" ${netSuitePoState.view === "removed" ? "selected" : ""}>Removed</option><option value="all" ${netSuitePoState.view === "all" ? "selected" : ""}>All reviews</option></select><button class="smart-button" data-po-action="refresh" type="button">Refresh</button></div>
      <div class="smart-proposals smart-po-review-list">${loads.map(poLoadCard).join("") || `<div class="smart-empty">No NetSuite PO review matches this filter. Confirm a vendor load to stage its confirmed lines here.</div>`}</div>
    </section>
  </div>`;
}

async function poLoad({ quiet = false } = {}) {
  if (!quiet) netSuitePoState.busy = "Loading staged purchase orders";
  netSuitePoState.error = "";
  poRender();
  try {
    const params = new URLSearchParams({ search: netSuitePoState.search, view: netSuitePoState.view, limit: "500" });
    const payload = await poApi(`/api/scm/smart/netsuite-purchase-orders?${params}`);
    netSuitePoState.loads = Array.isArray(payload) ? payload : (payload.loads || []);
  } catch (error) {
    netSuitePoState.error = error.message;
  } finally {
    netSuitePoState.busy = "";
    poRender();
  }
}

smartNetSuitePoApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-po-action]");
  if (!button || netSuitePoState.busy) return;
  if (button.dataset.poAction === "refresh") {
    netSuitePoState.search = document.getElementById("smartPoSearch")?.value || "";
    netSuitePoState.view = document.getElementById("smartPoView")?.value || "pending";
    await poLoad();
    return;
  }
  if (["save-pallet", "reset-pallet"].includes(button.dataset.poAction)) {
    const proposalId = Number(button.dataset.proposalId);
    const destinationLocationId = Number(button.dataset.destinationLocationId);
    const row = button.closest(".smart-po-pallet-line");
    const rawQuantity = row?.querySelector("[data-po-pallet-quantity]")?.value || "";
    const quantity = rawQuantity.trim() === "" ? Number.NaN : Number(rawQuantity);
    if (button.dataset.poAction === "save-pallet" && (!Number.isFinite(quantity) || quantity < 0)) {
      netSuitePoState.error = "PALLET quantity must be a number at or above zero.";
      poRender();
      return;
    }
    netSuitePoState.busy = button.dataset.poAction === "reset-pallet" ? "Restoring automatic PALLET quantity" : "Saving PALLET override";
    netSuitePoState.error = "";
    netSuitePoState.notice = "";
    poRender();
    try {
      const updated = await poApi(`/api/scm/smart/netsuite-purchase-orders/${proposalId}/pallets/${destinationLocationId}`, {
        method: "PATCH",
        body: button.dataset.poAction === "reset-pallet" ? { reset: true } : { quantity }
      });
      netSuitePoState.loads = netSuitePoState.loads.map((load) => Number(load.id) === proposalId ? updated : load);
      netSuitePoState.notice = button.dataset.poAction === "reset-pallet"
        ? `Official PALLET for ${updated.palletLines?.find((line) => Number(line.destinationLocationId) === destinationLocationId)?.destinationName || destinationLocationId} now follows the automatic quantity.`
        : `Official PALLET override saved at ${poNumber(quantity, 2)}.`;
    } catch (error) {
      netSuitePoState.error = error.message;
    } finally {
      netSuitePoState.busy = "";
      poRender();
    }
    return;
  }
  if (button.dataset.poAction === "remove") {
    const proposalId = Number(button.dataset.proposalId);
    if (!confirm(`Remove staged PO review #${proposalId}? No NetSuite record will be changed. The local review and its lines will remain in Removed for audit history.`)) return;
    netSuitePoState.busy = "Removing staged purchase order";
    netSuitePoState.error = "";
    netSuitePoState.notice = "";
    poRender();
    try {
      await poApi(`/api/scm/smart/netsuite-purchase-orders/${proposalId}`, { method: "DELETE" });
      netSuitePoState.notice = `Staged PO review #${proposalId} removed. No NetSuite transaction was created or changed.`;
      await poLoad({ quiet: true });
    } catch (error) {
      netSuitePoState.busy = "";
      netSuitePoState.error = error.message;
      poRender();
    }
    return;
  }
  if (button.dataset.poAction !== "insert") return;
  const proposalId = Number(button.dataset.proposalId);
  if (!confirm(`Insert staged PO review #${proposalId} into NetSuite using the displayed Last Purchase Prices?`)) return;
  netSuitePoState.busy = "Inserting purchase order into NetSuite";
  netSuitePoState.error = "";
  netSuitePoState.notice = "";
  poRender();
  try {
    const result = await poApi(`/api/scm/smart/netsuite-purchase-orders/${proposalId}/insert`, { method: "POST", body: {} });
    netSuitePoState.notice = `${result.purchaseOrderRef || `PO review #${proposalId}`} inserted successfully.`;
    await poLoad({ quiet: true });
  } catch (error) {
    netSuitePoState.busy = "";
    netSuitePoState.error = error.message;
    poRender();
  }
});

smartNetSuitePoApp.addEventListener("change", async (event) => {
  if (event.target.id !== "smartPoView") return;
  netSuitePoState.view = event.target.value;
  netSuitePoState.search = document.getElementById("smartPoSearch")?.value || "";
  await poLoad();
});

smartNetSuitePoApp.addEventListener("keydown", async (event) => {
  if (event.target.id !== "smartPoSearch" || event.key !== "Enter") return;
  event.preventDefault();
  netSuitePoState.search = event.target.value;
  await poLoad();
});

window.addEventListener("mbbs-language-changed", poRender);

requireDispatchLogin({
  mount: smartNetSuitePoApp,
  roles: ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"],
  async onReady(operator) {
    netSuitePoState.operator = operator;
    poRender();
    await poLoad();
  }
});
