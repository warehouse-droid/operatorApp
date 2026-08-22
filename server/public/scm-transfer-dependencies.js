const scmDependencyApp = document.getElementById("scmDependencyApp");
const DEPENDENCY_YARDS = [
  { id: 1, code: "3445" },
  { id: 28, code: "2967" },
  { id: 15, code: "12441" },
  { id: 26, code: "150" }
];
const DEPENDENCY_PROPOSAL_LINE_SELECTOR = ".scm-dependency-proposal-line[data-proposal-line-id]";

const dependencyState = {
  operator: null,
  candidates: [],
  selectedSalesOrderId: null,
  inventory: null,
  batch: null,
  reservationOverrideKeys: new Set(),
  selectedProposalIds: new Set(),
  search: "",
  reviewStatus: "open",
  mobilePanel: "candidates",
  busy: "",
  busyScopes: new Map(),
  notice: "",
  error: ""
};

let dependencyEventSource = null;
let dependencyRemoteRefreshTimer = null;
const dependencyManualItemEditors = new Map();
const dependencyManualItemSearchTimers = new Map();
const dependencyActions = new Map();
const dependencyPrintRequestIds = new Map();
const dependencyRevisionRequestIds = new Map();
let dependencyCandidateRequestVersion = 0;
let dependencyInventoryRequestVersion = 0;

function dependencyActionBusy(scope = "global") {
  return dependencyState.busyScopes.has("global") || dependencyState.busyScopes.has(scope);
}

function dependencyBusyLabel() {
  return dependencyState.busy || dependencyState.busyScopes.values().next().value || "";
}

function depEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function depNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function depQty(value) {
  const amount = depNumber(value);
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits: 3 }).format(amount);
}

function dependencyRequestId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function depReservationOverrideKey(itemId, locationId) {
  const item = Number(itemId);
  const location = Number(locationId);
  return Number.isSafeInteger(item) && item > 0 && Number.isSafeInteger(location) && location > 0
    ? `${item}:${location}`
    : "";
}

function depReservationOverrideApplied(item = {}, balance = {}) {
  const key = depReservationOverrideKey(item.itemId, balance.locationId);
  return Boolean(key && dependencyState.reservationOverrideKeys.has(key));
}

function depBalancePlanningAvailable(item = {}, balance = {}) {
  return depReservationOverrideApplied(item, balance)
    ? depNumber(balance.quantityAvailable)
    : depNumber(balance.effectiveAvailable);
}

function depReservationOverridePayload() {
  return [...dependencyState.reservationOverrideKeys].map((key) => {
    const [itemId, locationId] = key.split(":").map(Number);
    return { itemId, locationId };
  }).filter((entry) => Number.isSafeInteger(entry.itemId) && Number.isSafeInteger(entry.locationId));
}

function syncDependencyReservationOverridesFromBatch(batch = null) {
  dependencyState.reservationOverrideKeys = new Set((batch?.reservationOverrides || [])
    .map((entry) => depReservationOverrideKey(
      entry.itemId ?? entry.item_id,
      entry.locationId ?? entry.location_id
    ))
    .filter(Boolean));
}

function depDate(value) {
  if (!value) return "No delivery date";
  return window.MBBS_I18N?.displayDate?.(value) || String(value).slice(0, 10);
}

function depUnitText(line = {}, quantityField = "unresolvedQuantity") {
  const parts = [
    [line.palletQty, "PLT"],
    [line.layerQty, "LYR"],
    [line.sectionQty, "SEC"],
    [line.pieceQty, line.toPcs || line.to_pcs ? "PCS" : ""]
  ].filter(([value, unit]) => depNumber(value) > 0 && unit).map(([value, unit]) => `${depQty(value)} ${unit}`);
  return parts.length ? parts.join(" ") : `${depQty(line[quantityField])} ${line.unit || "UOM"}`;
}

function depProposalConversions(line = {}) {
  return {
    pallets: depNumber(line.conversions?.pallets ?? line.toPlt),
    layers: depNumber(line.conversions?.layers ?? line.toLyr),
    sections: depNumber(line.conversions?.sections ?? line.toSec),
    pieces: depNumber(line.conversions?.pieces ?? line.toPcs)
  };
}

function depProposalQuantities(line = {}) {
  if (line.quantities && typeof line.quantities === "object") return { ...line.quantities };
  const conversions = depProposalConversions(line);
  const hasConversion = Object.values(conversions).some((value) => value > 0);
  return hasConversion ? {
    pallets: depNumber(line.palletQty),
    layers: depNumber(line.layerQty),
    sections: depNumber(line.sectionQty),
    pieces: depNumber(line.pieceQty),
    salesQty: 0
  } : { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: depNumber(line.proposedQuantity) };
}

function depProposalSalesQuantity(values = {}, conversions = {}) {
  const converted = ["pallets", "layers", "sections", "pieces"].reduce(
    (sum, unit) => sum + ((unit === "layers" ? Math.round(depNumber(values[unit])) : depNumber(values[unit])) * depNumber(conversions[unit])),
    0
  );
  return Number((converted > 0 ? converted : depNumber(values.salesQty)).toFixed(6));
}

function updateProposalSalesEquivalent(row) {
  if (!row) return;
  const quantities = {};
  for (const input of row.querySelectorAll("[data-proposal-unit]")) {
    quantities[input.dataset.proposalUnit] = depNumber(input.value);
  }
  const conversions = {
    pallets: depNumber(row.dataset.toPlt),
    layers: depNumber(row.dataset.toLyr),
    sections: depNumber(row.dataset.toSec),
    pieces: depNumber(row.dataset.toPcs)
  };
  const equivalent = row.querySelector("[data-proposal-sales-equivalent]");
  if (equivalent) equivalent.textContent = `${depQty(depProposalSalesQuantity(quantities, conversions))} ${row.dataset.salesUnit || "UOM"}`;
}

function updateProposalPalletEstimate(card) {
  if (!card) return;
  let calculated = 0;
  let explicit = 0;
  let complete = true;
  const materialByItem = new Map();
  for (const row of card.querySelectorAll(DEPENDENCY_PROPOSAL_LINE_SELECTOR)) {
    const quantities = Object.fromEntries([...row.querySelectorAll("[data-proposal-unit]")]
      .map((input) => [input.dataset.proposalUnit, depNumber(input.value)]));
    const conversions = {
      pallets: depNumber(row.dataset.toPlt),
      layers: depNumber(row.dataset.toLyr),
      sections: depNumber(row.dataset.toSec),
      pieces: depNumber(row.dataset.toPcs)
    };
    const salesQuantity = depProposalSalesQuantity(quantities, conversions);
    if (salesQuantity <= 0) continue;
    if (String(row.dataset.itemName || "").trim().toUpperCase() === "PALLET") {
      explicit += salesQuantity;
      continue;
    }
    const itemKey = row.dataset.itemId || row.dataset.itemName || row.dataset.salesLineId;
    const material = materialByItem.get(itemKey) || { quantity: 0, toPlt: conversions.pallets };
    material.quantity += salesQuantity;
    if (!material.toPlt) material.toPlt = conversions.pallets;
    materialByItem.set(itemKey, material);
  }
  for (const material of materialByItem.values()) {
    if (material.toPlt <= 0) {
      complete = false;
      continue;
    }
    calculated += Math.ceil(Math.max(0, material.quantity - 0.000001) / material.toPlt);
  }
  calculated = Number(calculated.toFixed(6));
  explicit = Number(explicit.toFixed(6));
  const recommended = Math.max(calculated, explicit);
  const calculatedOutput = card.querySelector("[data-calculated-pallet]");
  if (calculatedOutput) calculatedOutput.textContent = depQty(calculated);
  const finalInput = card.querySelector('[data-proposal-field="palletTransferQuantity"]');
  if (finalInput && card.dataset.palletOverridden !== "true") {
    finalInput.value = complete ? String(recommended) : "";
    finalInput.placeholder = String(recommended);
  }
  const note = card.querySelector("[data-pallet-calculation-note]");
  if (note) {
    note.classList.toggle("warning-text", !complete);
    note.textContent = complete
      ? "One PALLET per full PLT, plus one for each SKU with loose remainder."
      : "Manual quantity required: at least one item has no PLT conversion.";
  }
}

function dependencyManualItemEditor(proposalId) {
  const key = String(proposalId);
  if (!dependencyManualItemEditors.has(key)) {
    dependencyManualItemEditors.set(key, {
      search: "",
      results: [],
      selectedItem: null,
      loading: false,
      error: "",
      requestVersion: 0
    });
  }
  return dependencyManualItemEditors.get(key);
}

function dependencyManualItemConversions(item = {}) {
  return {
    pallets: depNumber(item.conversions?.pallets ?? item.toPlt ?? item.to_plt),
    layers: depNumber(item.conversions?.layers ?? item.toLyr ?? item.to_lyr),
    sections: depNumber(item.conversions?.sections ?? item.toSec ?? item.to_sec),
    pieces: depNumber(item.conversions?.pieces ?? item.toPcs ?? item.to_pcs)
  };
}

function dependencyManualItemUnitOptions(item = {}) {
  const conversions = dependencyManualItemConversions(item);
  const options = [
    ["pallets", "PLT", conversions.pallets],
    ["layers", "LYR", conversions.layers],
    ["sections", "SEC", conversions.sections],
    ["pieces", "PCS", conversions.pieces]
  ].filter(([, , conversion]) => conversion > 0);
  if (!options.length) options.push(["salesQty", item.unit || item.stockUnit || "UOM", 1]);
  return options;
}

function renderDependencyManualItemEditor(proposal) {
  const editor = dependencyManualItemEditor(proposal.id);
  const selected = editor.selectedItem;
  const options = selected ? dependencyManualItemUnitOptions(selected) : [];
  const resultMarkup = editor.loading
    ? `<div class="scm-dependency-manual-item-message">Searching items...</div>`
    : editor.error
      ? `<div class="scm-dependency-manual-item-message error">${depEscape(editor.error)}</div>`
      : editor.results.length
        ? `<div class="scm-dependency-manual-item-results" role="listbox">${editor.results.map((item) => `
            <button data-action="select-manual-item" data-proposal-id="${proposal.id}" data-item-id="${depEscape(item.itemId)}" type="button" role="option">
              <strong>${depEscape(item.sku || item.itemName)}</strong>
              <span>${depEscape(item.itemName || item.description || "")}</span>
              <small>${depQty(item.effectiveAvailable ?? item.quantityAvailable)} available at ${depEscape(proposal.fromLocation)}</small>
            </button>`).join("")}</div>`
        : editor.search.trim().length >= 2 && !selected
          ? `<div class="scm-dependency-manual-item-message">No matching transferable item.</div>`
          : "";
  return `
    <section class="scm-dependency-manual-item-editor" data-manual-item-editor data-proposal-id="${proposal.id}">
      <div class="scm-dependency-manual-item-heading">
        <div><strong>Add item manually</strong><small>Type an item name, SKU, or NetSuite internal ID, then choose a match.</small></div>
      </div>
      <div class="scm-dependency-manual-item-grid">
        <label class="scm-dependency-manual-item-search"><span>Item</span>
          <input id="manualItemSearch-${proposal.id}" data-field="manual-item-search" data-proposal-id="${proposal.id}"
            value="${depEscape(editor.search)}" placeholder="Start typing an item..." autocomplete="off" />
          ${resultMarkup}
        </label>
        ${selected ? `
          <div class="scm-dependency-manual-item-selected">
            <strong>${depEscape(selected.sku || selected.itemName)}</strong>
            <span>${depEscape(selected.itemName || selected.description || "")}</span>
            <small>${depQty(selected.effectiveAvailable ?? selected.quantityAvailable)} available at ${depEscape(proposal.fromLocation)}</small>
          </div>
          <label><span>Unit</span><select data-field="manual-item-unit">${options.map(([value, label, conversion]) =>
            `<option value="${value}">${depEscape(label)}${conversion > 0 ? ` = ${depQty(conversion)} ${depEscape(selected.unit || selected.stockUnit || "UOM")}` : ""}</option>`
          ).join("")}</select></label>
          <label><span>Quantity</span><input data-field="manual-item-quantity" type="number" min="0.001" step="0.001" value="1" /></label>
          <button class="primary-action" data-action="add-manual-item" data-proposal-id="${proposal.id}" type="button">Add item</button>
        ` : ""}
      </div>
    </section>`;
}

async function depApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || response.statusText || "Request failed");
  return payload;
}

function depSelectedOrder() {
  return dependencyState.candidates.find((order) => String(order.salesOrderId) === String(dependencyState.selectedSalesOrderId)) || null;
}

function dependencyBatchViewIsCurrent(batchId, salesOrderId) {
  return Number(dependencyState.batch?.id) === Number(batchId)
    && String(dependencyState.selectedSalesOrderId) === String(salesOrderId);
}

async function loadSelectedDependencyInventory({ forceRefresh = false, refreshUndercovered = true } = {}) {
  const requestVersion = ++dependencyInventoryRequestVersion;
  const selectedSalesOrderId = dependencyState.selectedSalesOrderId;
  if (!selectedSalesOrderId) {
    dependencyState.inventory = null;
    return null;
  }
  const selectedOrder = depSelectedOrder();
  const shouldRefresh = forceRefresh || (
    refreshUndercovered
    && dependencyState.reviewStatus === "open"
    && !selectedOrder?.completed
    && depNumber(selectedOrder?.uncoveredQuantity) > 0
  );
  const batchPromise = selectedOrder?.dependencyBatchId
    ? depApi(`/api/scm/transfer-dependencies/batches/${selectedOrder.dependencyBatchId}`)
    : Promise.resolve(null);
  const path = `/api/scm/transfer-dependencies/candidates/${selectedSalesOrderId}/${shouldRefresh ? "refresh-inventory" : "inventory"}`;
  const inventoryPromise = depApi(path, shouldRefresh
    ? { method: "POST", body: JSON.stringify({ force: forceRefresh, includeCandidate: true }) }
    : {});
  const [loadedBatch, payload] = await Promise.all([batchPromise, inventoryPromise]);
  if (requestVersion !== dependencyInventoryRequestVersion
      || String(dependencyState.selectedSalesOrderId) !== String(selectedSalesOrderId)) {
    return null;
  }
  if (loadedBatch) {
    clearDependencyProposalSelection();
    dependencyState.batch = loadedBatch;
    syncDependencyReservationOverridesFromBatch(loadedBatch);
  }
  dependencyState.inventory = payload?.inventory || payload;
  if (shouldRefresh && payload && Object.hasOwn(payload, "candidate")) {
    const currentIndex = dependencyState.candidates.findIndex((order) =>
      String(order.salesOrderId) === String(selectedSalesOrderId));
    if (payload.candidate && currentIndex >= 0) {
      dependencyState.candidates.splice(currentIndex, 1, payload.candidate);
    } else if (!payload.candidate && currentIndex >= 0) {
      const removed = dependencyState.candidates[currentIndex];
      dependencyState.candidates.splice(currentIndex, 1);
      dependencyState.selectedSalesOrderId = dependencyState.candidates[0]?.salesOrderId || null;
      dependencyState.inventory = null;
      dependencyState.batch = null;
      clearDependencyProposalSelection();
      dependencyState.notice = `${removed.salesOrderRef} is now fully committed in NetSuite and was removed from Open shortages.`;
      if (dependencyState.selectedSalesOrderId) {
        return loadSelectedDependencyInventory({ refreshUndercovered: false });
      }
    }
  }
  return dependencyState.inventory;
}

function depCandidateQuery({
  reviewStatus = dependencyState.reviewStatus,
  search = dependencyState.search
} = {}) {
  const params = new URLSearchParams({ reviewStatus: search ? "all" : reviewStatus });
  if (search) params.set("search", search);
  return `?${params.toString()}`;
}

function depYardOptions(selected) {
  return DEPENDENCY_YARDS.map((yard) => `<option value="${yard.id}" ${String(yard.id) === String(selected) ? "selected" : ""}>${yard.code}</option>`).join("");
}

function clearDependencyProposalSelection() {
  dependencyState.selectedProposalIds.clear();
}

function pruneDependencyProposalSelection() {
  const selectableIds = new Set((dependencyState.batch?.proposals || [])
    .filter((proposal) => proposal.creationStatus === "draft")
    .map((proposal) => Number(proposal.id)));
  for (const proposalId of dependencyState.selectedProposalIds) {
    if (!selectableIds.has(Number(proposalId))) dependencyState.selectedProposalIds.delete(proposalId);
  }
}

function dependencyMergeEntry(entry = {}) {
  const fieldValue = (name, fallback) => entry.querySelector?.(`[data-proposal-field="${name}"]`)?.value ?? entry[fallback];
  return {
    id: Number(entry.dataset?.proposalId ?? entry.id),
    mode: String(fieldValue("mode", "mode") || ""),
    fromLocationId: String(fieldValue("fromLocationId", "fromLocationId") || ""),
    toLocationId: String(fieldValue("toLocationId", "toLocationId") || "")
  };
}

function dependencyProposalMergeCompatibility(entries = []) {
  const selected = entries.map(dependencyMergeEntry);
  if (selected.length < 2) {
    return { eligible: false, selected, reason: selected.length ? "Select at least one more draft TO." : "Select two or more draft TOs to merge." };
  }
  const target = selected[0];
  if (selected.some((entry) => !entry.fromLocationId || !entry.toLocationId)) {
    return { eligible: false, selected, target, reason: "Select a From and Accounting To yard for every selected TO." };
  }
  if (selected.some((entry) => entry.fromLocationId === entry.toLocationId)) {
    return { eligible: false, selected, target, reason: "A Transfer Order cannot use the same yard as both From and Accounting To." };
  }
  if (selected.some((entry) => entry.fromLocationId !== target.fromLocationId || entry.toLocationId !== target.toLocationId)) {
    return { eligible: false, selected, target, reason: "Selected TOs must use the same From and Accounting To yards." };
  }
  if (selected.some((entry) => entry.mode !== target.mode)) {
    return { eligible: false, selected, target, reason: "Selected TOs must use the same dispatch Mode." };
  }
  return {
    eligible: true,
    selected,
    target,
    reason: `Ready to combine ${selected.length} drafts; the first selected TO's memo is retained.`
  };
}

function selectedDependencyProposalCards() {
  return [...dependencyState.selectedProposalIds]
    .map((proposalId) => scmDependencyApp.querySelector(`.scm-dependency-proposal[data-proposal-id="${proposalId}"]`))
    .filter(Boolean);
}

function updateDependencyProposalMergeState() {
  const cards = selectedDependencyProposalCards();
  const compatibility = dependencyProposalMergeCompatibility(cards);
  for (const card of scmDependencyApp.querySelectorAll(".scm-dependency-proposal")) {
    card.classList.toggle("merge-selected", dependencyState.selectedProposalIds.has(Number(card.dataset.proposalId)));
  }
  const button = scmDependencyApp.querySelector('[data-action="merge-proposals"]');
  if (button) {
    button.textContent = `Merge selected (${cards.length})`;
    button.disabled = dependencyState.busyScopes.size > 0 || !compatibility.eligible;
  }
  const hint = scmDependencyApp.querySelector("[data-merge-proposal-hint]");
  if (hint) hint.textContent = compatibility.reason;
  return compatibility;
}


function renderDependencyCandidates() {
  if (!dependencyState.candidates.length) {
    const emptyText = dependencyState.search
      ? "No matching Sales Orders in Open, Created, or Completed."
      : dependencyState.reviewStatus === "completed"
      ? "No completed Auto Transfer reviews."
      : dependencyState.reviewStatus === "created"
        ? "No created Transfer Orders waiting for approval or printing."
        : "No open Sales Order shortages.";
    return `<div class="empty-state">${emptyText}</div>`;
  }
  return dependencyState.candidates.map((order) => `
    <button class="scm-dependency-order ${String(order.salesOrderId) === String(dependencyState.selectedSalesOrderId) ? "selected" : ""}"
      data-action="select-order" data-order-id="${order.salesOrderId}" type="button">
      <span><strong class="scm-dependency-order-ref">${depEscape(order.salesOrderRef)}${order.testFixture ? `<b class="scm-dependency-test-badge">TEST</b>` : ""}</strong><small>${depEscape(order.customer || "")}</small></span>
      <span class="scm-dependency-order-side">${dependencyState.search ? `<em class="dependency-status status-${depEscape(order.workflowStage || "open")}">${depEscape(order.workflowStage || "open")}</em>` : ""}<b>${depQty(order.uncoveredQuantity)}</b><small>uncovered</small></span>
      <small>${depEscape(order.outboundLocation || "--")} | ${depEscape(depDate(order.expectedDeliveryDate))}${order.completionType === "reviewed_no_transfer" ? " | Reviewed - No Transfer" : order.completionType === "transfer_manually_reviewed" ? " | Created TO reviewed" : order.workflowStage === "created" ? " | Waiting approval / print" : order.completionType === "transfer_approved_printed" ? " | Approved & printed" : ""}</small>
    </button>
  `).join("");
}

function depInventoryCoverage(order = {}, matrix = {}) {
  const byItem = new Map((matrix?.items || []).map((item) => [String(item.itemId), item]));
  const coverageByItem = new Map();
  const orderLines = Array.isArray(matrix?.orderLines) ? matrix.orderLines : (order.lines || []);
  for (const line of orderLines) {
    const key = String(line.itemId || line.salesLineId);
    const entry = coverageByItem.get(key) || {
      line,
      lines: [],
      required: 0,
      ordered: 0,
      committed: 0,
      backordered: 0
    };
    entry.lines.push(line);
    entry.required += depNumber(line.unresolvedQuantity);
    entry.ordered += depNumber(line.quantity);
    entry.committed += depNumber(line.committedQuantity);
    entry.backordered += depNumber(line.backorderedQuantity);
    coverageByItem.set(key, entry);
  }
  return [...coverageByItem.entries()].map(([itemKey, entry]) => {
    const item = byItem.get(itemKey);
    const sourceAvailable = (item?.balances || [])
      .filter((balance) => String(balance.locationId) !== String(order.outboundLocationId))
      .reduce((total, balance) => total + depBalancePlanningAvailable(item, balance), 0);
    return {
      ...entry,
      item,
      undercovered: entry.required,
      sourceAvailable,
      sourceShortfall: Math.max(0, entry.required - sourceAvailable)
    };
  });
}

function renderInventoryMatrix() {
  const order = depSelectedOrder();
  if (!order) return `<div class="empty-state">Select a Sales Order to review shortages.</div>`;
  const matrix = dependencyState.inventory;
  if (!matrix) return `<div class="empty-state">Loading inventory coverage...</div>`;
  const coverage = depInventoryCoverage(order, matrix);
  const impossible = coverage.filter((entry) => entry.sourceShortfall > 0.000001);
  const reservationOverrideCount = dependencyState.reservationOverrideKeys.size;
  return `
    <div class="scm-dependency-order-summary">
      <div><span>Sales Order</span><strong>${depEscape(order.salesOrderRef)}</strong></div>
      <div><span>Outbound Yard</span><strong>${depEscape(order.outboundLocation || "--")}</strong></div>
      <div><span>Uncovered</span><strong>${depQty(order.uncoveredQuantity)}</strong></div>
    </div>
    ${impossible.length ? `<div class="scm-dependency-coverage-warning" role="alert">
      <strong>Cannot fully cover this Sales Order from the other yards</strong>
      <span>${impossible.map(({ line, required, sourceAvailable, sourceShortfall }) => `${depEscape(line.sku || line.itemName)}: required ${depQty(required)}, usable source stock ${depQty(sourceAvailable)}, source stock short ${depQty(sourceShortfall)}`).join("<br>")}</span>
    </div>` : ""}
    ${reservationOverrideCount ? `<div class="scm-dependency-reservation-warning" role="status">
      <strong>NetSuite Available override selected</strong>
      <span>${reservationOverrideCount} item-and-yard selection${reservationOverrideCount === 1 ? "" : "s"} will ignore other unsent local draft proposal reservations when the suggestion is regenerated. The override is saved and audited with the proposal.</span>
    </div>` : ""}
    <div class="scm-dependency-review-action">
      <span>${order.workflowStage === "created"
        ? "Transfer Orders were created and are waiting for quantity verification, approval, and source-yard printing. If no further action is required, mark this order reviewed manually."
        : order.completionType === "transfer_manually_reviewed"
          ? `Created Transfer Orders were manually reviewed${order.completedAt ? ` on ${depEscape(depDate(order.completedAt))}` : ""}.`
        : order.completionType === "transfer_approved_printed"
          ? `Transfer Orders were verified, approved, and printed${order.completedAt ? ` on ${depEscape(depDate(order.completedAt))}` : ""}.`
        : order.reviewed
          ? `Reviewed${order.reviewedAt ? ` on ${depEscape(depDate(order.reviewedAt))}` : ""}. This order cannot generate a transfer proposal.`
          : "No transfer needed? Mark only this SCM shortage review; dispatch and operator status stay unchanged."}</span>
      ${order.workflowStage === "completed" && !order.reviewed ? "" : `<button data-action="${order.reviewed ? "reopen-review" : "review-no-transfer"}" type="button" ${dependencyState.busyScopes.size > 0 ? "disabled" : ""}>
        ${order.reviewed ? "Undo Review" : order.workflowStage === "created" ? "Mark Reviewed" : "Mark Reviewed - No Transfer"}
      </button>`}
    </div>
    <div class="scm-dependency-matrix-wrap">
      <div class="scm-dependency-matrix-head">
        <strong>Order item / quantity</strong>
        <strong class="scm-dependency-undercovered-head"><span>Undercovered</span><small>Not covered by linked TO</small></strong>
        ${DEPENDENCY_YARDS.map((yard) => `<strong class="${String(yard.id) === String(order.outboundLocationId) ? "outbound-yard" : ""}"><span>${yard.code}</span><small>${String(yard.id) === String(order.outboundLocationId) ? "Outbound · available" : "All available"}</small></strong>`).join("")}
      </div>
      ${coverage.map(({ line, lines, item, ordered, committed, backordered, undercovered, sourceShortfall }) => {
        const undercoveredUnit = line.unit || item?.unit || "UOM";
        const requiredText = [
          `${depQty(ordered)} ${undercoveredUnit} ordered`,
          `${depQty(committed)} committed`,
          `${depQty(backordered)} backordered`,
          lines.length > 1 ? `${lines.length} SO lines` : ""
        ].filter(Boolean).join(" · ");
        const coverageStatus = undercovered > 0.000001
          ? "needs linked transfer"
          : depNumber(backordered) > 0.000001
            ? "Covered by linked TO"
            : "No backorder";
        return `<div class="scm-dependency-matrix-row ${sourceShortfall > 0.000001 ? "coverage-impossible" : ""}">
          <div><strong>${depEscape(line.sku || line.itemName)}</strong><small>${depEscape(requiredText)}</small></div>
          <div class="scm-dependency-undercovered-cell ${undercovered > 0.000001 ? "has-shortfall" : "is-covered"}">
            <b>${depQty(undercovered)} ${depEscape(undercoveredUnit)}</b><small>${coverageStatus}</small>
          </div>
          ${DEPENDENCY_YARDS.map((yard) => {
            const balance = item?.balances?.find((entry) => String(entry.locationId) === String(yard.id));
            const reserved = depNumber(balance?.reservedQuantity);
            const linkedTransfer = depNumber(balance?.linkedTransferQuantity);
            const overrideApplied = depReservationOverrideApplied(item, balance);
            const usable = depBalancePlanningAvailable(item, balance);
            const linkedTransferNote = linkedTransfer > 0.000001
              ? ` · ${depQty(linkedTransfer)} linked TO already protected by NetSuite`
              : "";
            const availabilityNote = overrideApplied
              ? `${depQty(usable)} usable · ${depQty(reserved)} unsent draft reserved ignored${linkedTransferNote}`
              : reserved > 0.000001
              ? `${depQty(usable)} usable · ${depQty(reserved)} unsent draft reserved${linkedTransferNote}`
              : linkedTransfer > 0.000001
                ? `NetSuite available is usable${linkedTransferNote}`
                : "Full available quantity";
            const canOverride = reserved > 0.000001
              && depNumber(balance?.quantityAvailable) > depNumber(balance?.effectiveAvailable) + 0.000001
              && String(yard.id) !== String(order.outboundLocationId);
            return `<div class="${String(yard.id) === String(order.outboundLocationId) ? "outbound-yard" : ""} ${overrideApplied ? "reservation-overridden" : ""}">
              <b>${depQty(balance?.quantityAvailable)}</b>
              <small>${availabilityNote}</small>
              ${canOverride ? `<button class="scm-dependency-reservation-override ${overrideApplied ? "active" : ""}"
                data-action="toggle-reservation-override"
                data-item-id="${depEscape(item?.itemId)}"
                data-item-name="${depEscape(line.sku || line.itemName)}"
                data-location-id="${yard.id}"
                data-location="${yard.code}"
                data-available="${depNumber(balance?.quantityAvailable)}"
                data-reserved="${reserved}"
                type="button" ${dependencyState.busyScopes.size > 0 ? "disabled" : ""}>${overrideApplied ? "Undo full-available override" : "Use full NetSuite available"}</button>` : ""}
            </div>`;
          }).join("")}
        </div>`;
      }).join("")}
    </div>
  `;
}

function depIsPalletItem(item = {}) {
  return [item.sku, item.itemName, item.item_name]
    .some((value) => String(value || "").trim().toUpperCase() === "PALLET");
}

function depProposalSourceAvailability(proposal = {}) {
  const requestedByItem = new Map();
  const addRequested = (itemId, itemName, quantity) => {
    const key = String(itemId || "");
    const requested = depNumber(quantity);
    if (!key || requested <= 0) return;
    const current = requestedByItem.get(key) || { itemId, itemName: itemName || key, requestedQuantity: 0 };
    current.requestedQuantity += requested;
    requestedByItem.set(key, current);
  };
  for (const line of proposal.lines || []) {
    if (depIsPalletItem(line)) continue;
    addRequested(line.itemId, line.itemName || line.sku, line.proposedQuantity);
  }
  if (depNumber(proposal.palletTransferQuantity) > 0) {
    addRequested(proposal.palletItemId, proposal.palletItemName || "PALLET", proposal.palletTransferQuantity);
  }
  const inventoryByItem = new Map((dependencyState.inventory?.items || [])
    .map((item) => [String(item.itemId), item]));
  return [...requestedByItem.values()].map((request) => {
    const inventory = inventoryByItem.get(String(request.itemId));
    const balance = (inventory?.balances || []).find((entry) =>
      String(entry.locationId) === String(proposal.fromLocationId));
    const availableQuantity = balance
      ? depNumber(balance.effectiveAvailable ?? balance.quantityAvailable)
      : null;
    return {
      ...request,
      availableQuantity,
      backorderQuantity: availableQuantity === null
        ? null
        : Math.max(0, request.requestedQuantity - availableQuantity)
    };
  });
}

function renderProposalSourceBackorder(proposal, { editable = false } = {}) {
  const availability = depProposalSourceAvailability(proposal);
  const shortages = availability.filter((entry) => depNumber(entry.backorderQuantity) > 0);
  const unresolved = availability.filter((entry) => entry.availableQuantity === null);
  const enabled = proposal.allowSourceBackorder === true;
  const shortageText = shortages.map((entry) =>
    `${depEscape(entry.itemName)}: ${depQty(entry.requestedQuantity)} requested − ${depQty(entry.availableQuantity)} available = ${depQty(entry.backorderQuantity)} backorder`
  ).join("; ");
  const detail = shortageText
    ? `${enabled ? "Authorized current source shortfall" : "Current source shortfall blocks creation"}: ${shortageText}.`
    : unresolved.length
      ? `Current availability is not loaded for ${unresolved.map((entry) => depEscape(entry.itemName)).join(", ")}; creation will perform the authoritative check.`
      : enabled
        ? "Current quantities fit source Available; the authorization remains effective if availability drops before creation."
        : "Creation remains protected by current NetSuite Available quantity.";
  return `
    <label class="scm-dependency-source-backorder ${enabled ? "enabled" : ""}">
      <input data-proposal-field="allowSourceBackorder" type="checkbox" ${enabled ? "checked" : ""}
        ${editable ? "" : "disabled"} />
      <span><strong>Allow source stock backorder</strong><small>${detail}</small></span>
    </label>`;
}

function renderProposal(proposal) {
  const mergeSelectable = proposal.creationStatus === "draft";
  const mergeSelected = dependencyState.selectedProposalIds.has(Number(proposal.id));
  const draftEditable = !["created", "creating", "attention"].includes(proposal.creationStatus);
  const recoverable = proposal.creationStatus === "creating";
  const created = ["created", "attention"].includes(proposal.creationStatus) && proposal.transferOrderId;
  const actionScope = `proposal:${proposal.id}`;
  const controlsBusy = dependencyActionBusy(actionScope);
  const revisionPending = ["updating", "attention"].includes(proposal.revisionStatus);
  const createdQuantityEditable = created && !proposal.revisionBlockedReason && !revisionPending;
  const quantityEditable = (draftEditable || createdQuantityEditable) && !controlsBusy;
  const printStatus = proposal.printJob?.status || "not queued";
  const printInProgress = ["queued", "leased", "printing"].includes(printStatus);
  const printed = printStatus === "printed";
  const approvalInProgress = proposal.approvalStatus === "approving";
  const approveLabel = printed
    ? "Reprint Source-yard Ticket"
    : ["failed", "uncertain"].includes(printStatus)
    ? "Retry Source-yard Print"
    : proposal.approvalStatus === "approved"
      ? "Get Ticket & Print"
      : "Verify, Approve & Print";
  return `
    <article class="scm-dependency-proposal ${mergeSelected ? "merge-selected" : ""}" data-proposal-id="${proposal.id}" data-creation-status="${depEscape(proposal.creationStatus)}" data-pallet-overridden="${proposal.palletQuantityOverridden === true}">
      <header>
        <div class="scm-dependency-proposal-heading">
          ${mergeSelectable ? `<label class="scm-dependency-proposal-select">
            <input data-field="merge-proposal" type="checkbox" ${mergeSelected ? "checked" : ""} ${controlsBusy ? "disabled" : ""} aria-label="Select Proposed TO ${proposal.id} for merge" />
            <span>Select</span>
          </label>` : ""}
          <strong>${depEscape(proposal.transferOrderRef || `Proposed TO ${proposal.id}`)}</strong>
        </div>
        <span class="dependency-status status-${depEscape(proposal.creationStatus)}">${depEscape(proposal.creationStatus)}</span>
      </header>
      <div class="scm-dependency-proposal-route">
        <label><span>Mode</span><select data-proposal-field="mode" ${draftEditable && !controlsBusy ? "" : "disabled"}>
          <option value="yard_replenishment" ${proposal.mode === "yard_replenishment" ? "selected" : ""}>Replenish yard</option>
          <option value="direct_to_customer" ${proposal.mode === "direct_to_customer" ? "selected" : ""}>Direct pickup</option>
        </select></label>
        <label><span>From</span><select data-proposal-field="fromLocationId" ${draftEditable && !controlsBusy ? "" : "disabled"}>${depYardOptions(proposal.fromLocationId)}</select></label>
        <label><span>Accounting To</span><select data-proposal-field="toLocationId" ${draftEditable && !controlsBusy ? "" : "disabled"}>${depYardOptions(proposal.toLocationId)}</select></label>
        <div><span>Route score</span><strong>${proposal.routeScore === null ? "Fallback" : `${depQty(proposal.routeScore)} min`}</strong></div>
      </div>
      <label class="scm-dependency-memo"><span>Memo</span><input data-proposal-field="memo" value="${depEscape(proposal.memo || "")}" ${draftEditable && !controlsBusy ? "" : "disabled"} /></label>
      ${renderProposalSourceBackorder(proposal, { editable: draftEditable && !controlsBusy })}
      <div class="scm-dependency-proposal-lines">
        ${proposal.lines.map((line, lineIndex) => {
          const conversions = depProposalConversions(line);
          const values = depProposalQuantities(line);
          const units = [
            ["pallets", "PLT", conversions.pallets],
            ["layers", "LYR", conversions.layers],
            ["sections", "SEC", conversions.sections],
            ["pieces", "PCS", conversions.pieces]
          ].filter(([, , conversion]) => conversion > 0);
          if (!units.length) units.push(["salesQty", line.unit || "UOM", 0]);
          const salesQuantity = depProposalSalesQuantity(values, conversions);
          return `<section class="scm-dependency-proposal-line link-quantity-line" data-sales-line-id="${line.salesLineId ?? ""}"
            data-proposal-line-id="${line.id}" data-item-id="${depEscape(line.itemId)}" data-item-name="${depEscape(line.itemName)}"
            data-to-plt="${conversions.pallets}" data-to-lyr="${conversions.layers}"
            data-to-sec="${conversions.sections}" data-to-pcs="${conversions.pieces}"
            data-sales-unit="${depEscape(line.unit || "UOM")}">
            <div class="link-quantity-info scm-dependency-line-info">
              <span><strong>${depEscape(line.sku || line.itemName)}${line.lineSource === "manual" ? `<b class="scm-dependency-manual-badge">Manual</b>` : ""}</strong><small>${line.lineSource === "manual" ? depEscape(line.itemName || "Manually added item") : "Sales quantity"}</small></span>
              <div class="scm-dependency-line-controls">
                <em class="link-sales-equivalent" data-proposal-sales-equivalent>${depQty(salesQuantity)} ${depEscape(line.unit || "UOM")}</em>
                ${draftEditable && !controlsBusy ? `<button class="scm-dependency-remove-line" data-action="remove-proposal-line"
                  data-proposal-id="${proposal.id}" data-proposal-line-id="${line.id}" data-item-name="${depEscape(line.itemName)}"
                  type="button">Remove line</button>` : ""}
              </div>
            </div>
            <div class="link-quantity-units">${units.map(([field, label]) => `<label>
              <span>${depEscape(label)}</span>
              <input id="proposal-${proposal.id}-${lineIndex}-${field}" data-proposal-unit="${field}" type="number"
                min="0" step="${field === "salesQty" ? "0.001" : "1"}" value="${depNumber(values[field])}" ${quantityEditable ? "" : "disabled"} />
            </label>`).join("")}</div>
          </section>`;
        }).join("")}
      </div>
      ${draftEditable && !controlsBusy ? renderDependencyManualItemEditor(proposal) : ""}
      <div class="scm-dependency-pallet-summary">
        <div><span>Calculated PALLET</span><strong data-calculated-pallet>${depQty(proposal.calculatedPalletQuantity)}</strong></div>
        <label><span>Final PALLET quantity</span>
          <input data-proposal-field="palletTransferQuantity" type="number" min="0" step="1"
            value="${!proposal.palletCalculationComplete && !proposal.palletQuantityOverridden ? "" : depNumber(proposal.palletTransferQuantity)}"
            placeholder="${depNumber(proposal.palletTransferQuantity)}" ${quantityEditable ? "" : "disabled"} />
        </label>
        <small data-pallet-calculation-note class="${proposal.palletCalculationComplete ? "" : "warning-text"}">${proposal.palletCalculationComplete
          ? "One PALLET per full PLT, plus one for each SKU with loose remainder."
          : "Manual quantity required: at least one item has no PLT conversion."}</small>
      </div>
      ${proposal.creationError ? `<div class="scm-dependency-error">${depEscape(proposal.creationError)}</div>` : ""}
      ${proposal.revisionBlockedReason ? `<div class="scm-dependency-error">Quantity update unavailable: ${depEscape(proposal.revisionBlockedReason)}</div>` : ""}
      ${proposal.revisionError ? `<div class="scm-dependency-error">Quantity revision needs recovery: ${depEscape(proposal.revisionError)}</div>` : ""}
      ${created ? `<div class="scm-dependency-workflow">
        <div><span>Quantity check</span><strong>${depEscape(proposal.quantityVerificationStatus || "pending")}</strong></div>
        <div><span>NetSuite approval</span><strong>${depEscape(proposal.approvalStatus || "pending")}</strong></div>
        <div><span>Source-yard print</span><strong>${depEscape(printStatus)}</strong></div>
      </div>` : ""}
      ${proposal.quantityVerificationError ? `<div class="scm-dependency-error">${depEscape(proposal.quantityVerificationError)}</div>` : ""}
      ${proposal.approvalError ? `<div class="scm-dependency-error">${depEscape(proposal.approvalError)}</div>` : ""}
      ${proposal.printJob?.error ? `<div class="scm-dependency-error">${depEscape(proposal.printJob.error)}</div>` : ""}
      <footer class="scm-dependency-proposal-actions">
        ${draftEditable ? `<button data-action="save-proposal" data-proposal-id="${proposal.id}" type="button" ${!controlsBusy ? "" : "disabled"}>Save Draft</button>` : ""}
        ${created ? `<button data-action="save-created-proposal" data-proposal-id="${proposal.id}" data-revision="${proposal.revision || 1}" type="button" ${(!proposal.revisionBlockedReason && !controlsBusy) ? "" : "disabled"}>${revisionPending ? "Recover Quantity Update" : "Update NetSuite Quantity"}</button>` : ""}
        ${(draftEditable || recoverable) ? `<button class="primary-action" data-action="confirm-proposal" data-proposal-id="${proposal.id}" type="button" ${!controlsBusy ? "" : "disabled"}>
          ${recoverable ? "Recover Transfer Order" : proposal.creationStatus === "failed" ? "Retry Transfer Order" : "Create Transfer Order"}
        </button>` : ""}
        ${created ? `<button class="primary-action" data-action="approve-print" data-proposal-id="${proposal.id}" type="button" ${!controlsBusy && !revisionPending && !printInProgress && !approvalInProgress ? "" : "disabled"}>${printInProgress ? `Print ${depEscape(printStatus)}` : depEscape(approveLabel)}</button>` : ""}
      </footer>
    </article>
  `;
}

function renderDependencyProposals() {
  const batch = dependencyState.batch;
  if (!batch) return `<div class="empty-state">Generate a suggestion to create editable transfer proposals.</div>`;
  const savedReservationOverrides = Array.isArray(batch.reservationOverrides)
    ? batch.reservationOverrides
    : [];
  pruneDependencyProposalSelection();
  const selectedProposals = [...dependencyState.selectedProposalIds]
    .map((proposalId) => batch.proposals.find((proposal) => Number(proposal.id) === Number(proposalId)))
    .filter(Boolean);
  const mergeCompatibility = dependencyProposalMergeCompatibility(selectedProposals);
  return `
    <div class="scm-dependency-batch-head">
      <div><span>Batch</span><strong>#${batch.id} | ${depEscape(batch.status)}</strong></div>
      <div><span>Uncovered</span><strong class="${batch.uncoveredShortageQuantity > 0 ? "warning-text" : ""}">${depQty(batch.uncoveredShortageQuantity)}</strong></div>
      <div class="scm-dependency-merge-actions">
        <button data-action="merge-proposals" type="button" ${dependencyState.busyScopes.size === 0 && mergeCompatibility.eligible ? "" : "disabled"}>Merge selected (${selectedProposals.length})</button>
        <small data-merge-proposal-hint>${depEscape(mergeCompatibility.reason)}</small>
      </div>
    </div>
    ${savedReservationOverrides.length ? `<div class="scm-dependency-reservation-warning" role="alert">
      <strong>Creating with full NetSuite Available override</strong>
      <span>${savedReservationOverrides.map((entry) =>
        `${depEscape(entry.itemName || entry.itemId)} at ${depEscape(entry.location || entry.locationId)}: ${depQty(entry.quantityAvailable)} available; ${depQty(entry.reservedQuantity)} unsent draft reservation ignored`
      ).join("<br>")}</span>
    </div>` : ""}
    <div class="scm-dependency-proposal-list">${batch.proposals.map(renderProposal).join("") || `<div class="empty-state">No source yard has available stock.</div>`}</div>
    <label class="scm-dependency-incomplete">
      <input data-field="allow-incomplete" type="checkbox" ${batch.allowIncompleteCoverage ? "checked" : ""} />
      <span>I understand this creates only partial shortage coverage.</span>
    </label>
  `;
}

function renderDependencyPage() {
  const activeId = document.activeElement?.id;
  const selection = document.activeElement?.selectionStart;
  const scrollPositions = new Map([...scmDependencyApp.querySelectorAll("[data-preserve-scroll]")]
    .map((element) => [element.dataset.preserveScroll, element.scrollTop]));
  const operator = dependencyState.operator || {};
  const selectedOrder = depSelectedOrder();
  scmDependencyApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>SCM</p><h1>Auto Transfer</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${depEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/scm'" type="button">SCM Menu</button>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    ${dependencyState.notice || dependencyState.error ? `<div class="route-notice scm-notice ${dependencyState.error ? "error" : ""}">
      <span>${depEscape(dependencyState.error || dependencyState.notice)}</span>
      <button class="scm-notice-close" data-action="close-notice" type="button" aria-label="Close">&times;</button>
    </div>` : ""}
    <nav class="scm-dependency-mobile-steps" aria-label="Auto Transfer steps">
      <button class="${dependencyState.mobilePanel === "candidates" ? "active" : ""}" data-action="set-mobile-panel" data-mobile-panel="candidates" type="button"><span>1</span>Orders</button>
      <button class="${dependencyState.mobilePanel === "inventory" ? "active" : ""}" data-action="set-mobile-panel" data-mobile-panel="inventory" type="button"><span>2</span>Inventory</button>
      <button class="${dependencyState.mobilePanel === "proposals" ? "active" : ""}" data-action="set-mobile-panel" data-mobile-panel="proposals" type="button"><span>3</span>Proposals</button>
    </nav>
    <section class="scm-dependency-toolbar">
      <button data-action="refresh-inventory" type="button" ${dependencyState.reviewStatus === "open" && dependencyState.selectedSalesOrderId && !selectedOrder?.completed && dependencyState.busyScopes.size === 0 ? "" : "disabled"}>Refresh Inventory</button>
      <select data-field="suggest-mode">
        <option value="yard_replenishment">Replenish outbound yard</option>
        <option value="direct_to_customer">Direct pickup to customer</option>
      </select>
      <button class="primary-action" data-action="generate" type="button" ${dependencyState.reviewStatus === "open" && dependencyState.selectedSalesOrderId && !selectedOrder?.completed && dependencyState.busyScopes.size === 0 ? "" : "disabled"}>Generate Suggestion</button>
      <span class="scm-dependency-busy">${depEscape(dependencyBusyLabel())}</span>
    </section>
    <section class="scm-dependency-grid" data-mobile-panel="${depEscape(dependencyState.mobilePanel)}">
      <aside class="scm-dependency-panel scm-dependency-candidates">
        <div class="panel-title scm-dependency-candidate-title">
          <div><p>${dependencyState.search ? "Search · all statuses" : dependencyState.reviewStatus === "completed" ? "Completed reviews" : dependencyState.reviewStatus === "created" ? "Created · action required" : "Open shortages"}</p><h2>Sales Orders</h2></div>
          <div class="scm-dependency-review-tabs" role="group" aria-label="Review status">
            <button class="${dependencyState.reviewStatus === "open" ? "active" : ""}" data-action="set-review-filter" data-review-status="open" type="button">Open</button>
            <button class="${dependencyState.reviewStatus === "created" ? "active" : ""}" data-action="set-review-filter" data-review-status="created" type="button">Created</button>
            <button class="${dependencyState.reviewStatus === "completed" ? "active" : ""}" data-action="set-review-filter" data-review-status="completed" type="button">Completed</button>
          </div>
        </div>
        <div class="scm-dependency-search"><input id="dependencySearch" data-field="candidate-search" value="${depEscape(dependencyState.search)}" placeholder="SO / customer / item" /></div>
        <div class="scm-dependency-order-list" data-preserve-scroll="orders">${renderDependencyCandidates()}</div>
      </aside>
      <section class="scm-dependency-panel scm-dependency-inventory">
        <div class="panel-title"><div><p>Base quantity</p><h2>Shortage & Inventory</h2></div></div>
        <div class="scm-dependency-panel-scroll" data-preserve-scroll="inventory">${renderInventoryMatrix()}</div>
      </section>
      <section class="scm-dependency-panel scm-dependency-proposals">
        <div class="panel-title">
          <div><p>NetSuite Transfer Orders</p><h2>Proposals</h2></div>
        </div>
        <div class="scm-dependency-panel-scroll" data-preserve-scroll="proposals">${renderDependencyProposals()}</div>
      </section>
    </section>
  `;
  for (const [key, scrollTop] of scrollPositions) {
    const element = scmDependencyApp.querySelector(`[data-preserve-scroll="${key}"]`);
    if (element) element.scrollTop = scrollTop;
  }
  if (activeId) {
    const next = document.getElementById(activeId);
    next?.focus();
    if (next && Number.isInteger(selection)) next.setSelectionRange(selection, selection);
  }
}

async function loadDependencyCandidates({ preserveSelection = true, refreshInventory = true } = {}) {
  const requestVersion = ++dependencyCandidateRequestVersion;
  const requestedReviewStatus = dependencyState.reviewStatus;
  const requestedSearch = dependencyState.search;
  const previousSelected = depSelectedOrder();
  const candidates = await depApi(`/api/scm/transfer-dependencies/candidates${depCandidateQuery({
    reviewStatus: requestedReviewStatus,
    search: requestedSearch
  })}`);
  if (requestVersion !== dependencyCandidateRequestVersion
      || dependencyState.reviewStatus !== requestedReviewStatus
      || dependencyState.search !== requestedSearch) {
    return { stale: true };
  }
  dependencyState.candidates = candidates;
  if (!preserveSelection || !dependencyState.candidates.some((order) => String(order.salesOrderId) === String(dependencyState.selectedSalesOrderId))) {
    dependencyState.selectedSalesOrderId = dependencyState.candidates[0]?.salesOrderId || null;
    clearDependencyProposalSelection();
    dependencyState.batch = null;
    dependencyState.reservationOverrideKeys.clear();
  }
  const nextSelected = depSelectedOrder();
  const shortageChanged = previousSelected
    && nextSelected
    && String(previousSelected.salesOrderId) === String(nextSelected.salesOrderId)
    && previousSelected.shortageSignature
    && nextSelected.shortageSignature
    && previousSelected.shortageSignature !== nextSelected.shortageSignature
    && nextSelected.completionType !== "reviewed_no_transfer";
  if (shortageChanged) {
    clearDependencyProposalSelection();
    dependencyState.batch = null;
    dependencyState.notice = `${nextSelected.salesOrderRef} backorder changed in NetSuite. Generate a new proposal from the updated shortage.`;
  }
  if (dependencyState.selectedSalesOrderId) {
    await loadSelectedDependencyInventory({ refreshUndercovered: refreshInventory });
  } else {
    dependencyState.inventory = null;
  }
}

function scheduleDependencyRemoteRefresh(delayMs = 450) {
  window.clearTimeout(dependencyRemoteRefreshTimer);
  dependencyRemoteRefreshTimer = window.setTimeout(async () => {
    if (dependencyState.busyScopes.size > 0) {
      scheduleDependencyRemoteRefresh(1000);
      return;
    }
    try {
      const previousSelected = depSelectedOrder();
      await loadDependencyCandidates({ preserveSelection: true, refreshInventory: false });
      if (previousSelected
          && !dependencyState.candidates.some((order) => String(order.salesOrderId) === String(previousSelected.salesOrderId))) {
        dependencyState.notice = previousSelected.workflowStage === "created"
          ? `${previousSelected.salesOrderRef} completed approval and source-yard printing.`
          : `${previousSelected.salesOrderRef} no longer has an uncovered NetSuite backorder.`;
      }
      dependencyState.error = "";
    } catch (error) {
      dependencyState.error = `Shortage auto-refresh failed: ${error.message}`;
    }
    renderDependencyPage();
  }, delayMs);
}

function connectDependencyEvents() {
  if (dependencyEventSource) return;
  dependencyEventSource = new EventSource("/api/events?client=scm-transfer-dependencies");
  dependencyEventSource.addEventListener("app-event", (message) => {
    let event;
    try {
      event = JSON.parse(message.data || "{}");
    } catch {
      return;
    }
    const isDependencyEvent = event.type === "scm.transfer_dependency.updated";
    const isOrderRefresh = event.type === "dispatch.orders.updated";
    if (isDependencyEvent || isOrderRefresh) scheduleDependencyRemoteRefresh();
  });
}

function proposalUnitValues(row) {
  return Object.fromEntries([...row.querySelectorAll("[data-proposal-unit]")]
    .map((input) => [
      input.dataset.proposalUnit,
      input.dataset.proposalUnit === "layers" ? Math.max(0, Math.round(depNumber(input.value))) : depNumber(input.value)
    ]));
}

function collectDependencyProposalPayload(card) {
  return {
    id: Number(card.dataset.proposalId),
    mode: card.querySelector('[data-proposal-field="mode"]')?.value,
    fromLocationId: Number(card.querySelector('[data-proposal-field="fromLocationId"]')?.value),
    toLocationId: Number(card.querySelector('[data-proposal-field="toLocationId"]')?.value),
    memo: card.querySelector('[data-proposal-field="memo"]')?.value,
    allowSourceBackorder: card.querySelector('[data-proposal-field="allowSourceBackorder"]')?.checked === true,
    palletTransferQuantity: (() => {
      if (card.dataset.palletOverridden !== "true") return undefined;
      const value = card.querySelector('[data-proposal-field="palletTransferQuantity"]')?.value;
      return value === "" || value === undefined ? null : Number(value);
    })(),
    lines: [...card.querySelectorAll(DEPENDENCY_PROPOSAL_LINE_SELECTOR)].map((row) => {
      const quantities = proposalUnitValues(row);
      return {
        proposalLineId: Number(row.dataset.proposalLineId),
        salesLineId: row.dataset.salesLineId ? Number(row.dataset.salesLineId) : null,
        quantities,
        proposedQuantity: depProposalSalesQuantity(quantities, {
          pallets: depNumber(row.dataset.toPlt),
          layers: depNumber(row.dataset.toLyr),
          sections: depNumber(row.dataset.toSec),
          pieces: depNumber(row.dataset.toPcs)
        })
      };
    })
  };
}

function collectDependencyBatchPayload(cards = [...scmDependencyApp.querySelectorAll(".scm-dependency-proposal")]) {
  return {
    allowIncompleteCoverage: scmDependencyApp.querySelector('[data-field="allow-incomplete"]')?.checked === true,
    proposals: cards.map(collectDependencyProposalPayload)
  };
}

async function runDependencyAction(label, action, options = {}) {
  const scope = String(options.scope || "global");
  const active = dependencyActions.get(scope);
  if (active) return active;
  dependencyState.busyScopes.set(scope, label);
  if (scope === "global") dependencyState.busy = label;
  dependencyState.error = "";
  dependencyState.notice = "";
  renderDependencyPage();
  const task = Promise.resolve()
    .then(action)
    .catch((error) => {
      dependencyState.error = error.message;
    })
    .finally(() => {
      dependencyActions.delete(scope);
      dependencyState.busyScopes.delete(scope);
      if (scope === "global") dependencyState.busy = "";
      renderDependencyPage();
    });
  dependencyActions.set(scope, task);
  return task;
}

let dependencySearchTimer = null;
scmDependencyApp.addEventListener("input", (event) => {
  if (event.target.matches("[data-proposal-unit]")) {
    const row = event.target.closest(DEPENDENCY_PROPOSAL_LINE_SELECTOR);
    updateProposalSalesEquivalent(row);
    updateProposalPalletEstimate(event.target.closest(".scm-dependency-proposal"));
    return;
  }
  if (event.target.matches('[data-field="manual-item-search"]')) {
    const proposalId = Number(event.target.dataset.proposalId);
    const editor = dependencyManualItemEditor(proposalId);
    editor.search = event.target.value;
    editor.selectedItem = null;
    editor.loading = false;
    editor.error = "";
    editor.results = [];
    editor.requestVersion += 1;
    const requestVersion = editor.requestVersion;
    const previousTimer = dependencyManualItemSearchTimers.get(String(proposalId));
    if (previousTimer) clearTimeout(previousTimer);
    if (editor.search.trim().length < 2) return;
    const timer = setTimeout(async () => {
      const requestedSearch = editor.search.trim();
      editor.loading = true;
      renderDependencyPage();
      try {
        if (!dependencyState.batch) return;
        const payload = await depApi(
          `/api/scm/transfer-dependencies/batches/${dependencyState.batch?.id}/proposals/${proposalId}/items?search=${encodeURIComponent(requestedSearch)}&limit=12`
        );
        if (editor.requestVersion !== requestVersion || editor.search.trim() !== requestedSearch) return;
        editor.results = Array.isArray(payload) ? payload : payload.items || [];
        editor.error = "";
      } catch (error) {
        if (editor.requestVersion !== requestVersion || editor.search.trim() !== requestedSearch) return;
        editor.results = [];
        editor.error = error.message;
      } finally {
        if (editor.requestVersion === requestVersion && editor.search.trim() === requestedSearch) {
          editor.loading = false;
          renderDependencyPage();
        }
      }
    }, 300);
    dependencyManualItemSearchTimers.set(String(proposalId), timer);
    return;
  }
  if (event.target.matches('[data-proposal-field="palletTransferQuantity"]')) {
    const card = event.target.closest(".scm-dependency-proposal");
    if (card) card.dataset.palletOverridden = "true";
    return;
  }
  if (event.target.dataset.field !== "candidate-search") return;
  dependencyState.search = event.target.value;
  clearTimeout(dependencySearchTimer);
  dependencySearchTimer = setTimeout(() => runDependencyAction(
    "Searching...",
    () => loadDependencyCandidates({ preserveSelection: false, refreshInventory: false }),
    { scope: dependencyRequestId("search") }
  ), 250);
});

scmDependencyApp.addEventListener("change", (event) => {
  if (event.target.matches('[data-field="merge-proposal"]')) {
    const proposalId = Number(event.target.closest(".scm-dependency-proposal")?.dataset.proposalId);
    if (Number.isInteger(proposalId)) {
      if (event.target.checked) dependencyState.selectedProposalIds.add(proposalId);
      else dependencyState.selectedProposalIds.delete(proposalId);
    }
    updateDependencyProposalMergeState();
    return;
  }
  if (event.target.matches('[data-proposal-field="mode"], [data-proposal-field="fromLocationId"], [data-proposal-field="toLocationId"]')) {
    updateDependencyProposalMergeState();
    return;
  }
  if (event.target.matches('[data-proposal-unit="layers"]')) {
    event.target.value = String(Math.max(0, Math.round(depNumber(event.target.value))));
    const row = event.target.closest(DEPENDENCY_PROPOSAL_LINE_SELECTOR);
    updateProposalSalesEquivalent(row);
    updateProposalPalletEstimate(event.target.closest(".scm-dependency-proposal"));
  }
});

scmDependencyApp.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "close-notice") {
    dependencyState.notice = "";
    dependencyState.error = "";
    renderDependencyPage();
    return;
  }
  if (action === "set-mobile-panel") {
    const panel = target.dataset.mobilePanel;
    if (!["candidates", "inventory", "proposals"].includes(panel)) return;
    dependencyState.mobilePanel = panel;
    renderDependencyPage();
    return;
  }
  if (action === "select-order") {
    const selectedCandidate = dependencyState.candidates.find((order) =>
      String(order.salesOrderId) === String(target.dataset.orderId));
    dependencyState.selectedSalesOrderId = target.dataset.orderId;
    if (["open", "created", "completed"].includes(selectedCandidate?.workflowStage)) {
      dependencyState.reviewStatus = selectedCandidate.workflowStage;
    }
    if (window.matchMedia?.("(max-width: 760px)").matches) dependencyState.mobilePanel = "inventory";
    clearDependencyProposalSelection();
    dependencyState.batch = null;
    dependencyState.inventory = null;
    dependencyState.reservationOverrideKeys.clear();
    await runDependencyAction(
      "Refreshing NetSuite inventory...",
      () => loadSelectedDependencyInventory(),
      { scope: dependencyRequestId("selection") }
    );
    return;
  }
  if (action === "set-review-filter") {
    const status = ["created", "completed"].includes(target.dataset.reviewStatus) ? target.dataset.reviewStatus : "open";
    if (status === dependencyState.reviewStatus) return;
    dependencyState.reviewStatus = status;
    dependencyState.mobilePanel = "candidates";
    await runDependencyAction(
      "Loading shortages...",
      () => loadDependencyCandidates({ preserveSelection: false, refreshInventory: false }),
      { scope: dependencyRequestId("tab") }
    );
    return;
  }
  if (action === "toggle-reservation-override") {
    const key = depReservationOverrideKey(target.dataset.itemId, target.dataset.locationId);
    if (!key) return;
    if (dependencyState.reservationOverrideKeys.has(key)) {
      dependencyState.reservationOverrideKeys.delete(key);
      dependencyState.notice = `Full-available override removed for ${target.dataset.itemName || target.dataset.itemId} at ${target.dataset.location || target.dataset.locationId}. Regenerate the suggestion to apply the change.`;
      renderDependencyPage();
      return;
    }
    const itemName = target.dataset.itemName || `Item ${target.dataset.itemId}`;
    const location = target.dataset.location || target.dataset.locationId;
    const available = depQty(target.dataset.available);
    const reserved = depQty(target.dataset.reserved);
    const confirmed = window.confirm(
      `Use the full NetSuite Available quantity (${available}) for ${itemName} at ${location} and ignore ${reserved} reserved by other unsent local draft proposals?\n\nThis can allocate the same stock to more than one draft order. The override will be saved and audited with this proposal.`
    );
    if (!confirmed) return;
    dependencyState.reservationOverrideKeys.add(key);
    dependencyState.notice = `Full NetSuite Available selected for ${itemName} at ${location}. Regenerate the suggestion to apply and save this override.`;
    renderDependencyPage();
    return;
  }
  if (action === "select-manual-item") {
    const proposalId = Number(target.dataset.proposalId);
    const editor = dependencyManualItemEditor(proposalId);
    const selected = editor.results.find((item) => String(item.itemId) === String(target.dataset.itemId));
    if (!selected) return;
    editor.selectedItem = selected;
    editor.search = selected.sku || selected.itemName || String(selected.itemId);
    editor.results = [];
    editor.error = "";
    renderDependencyPage();
    return;
  }
  if (action === "add-manual-item") {
    if (!dependencyState.batch) return;
    const batchId = Number(dependencyState.batch.id);
    const salesOrderId = dependencyState.selectedSalesOrderId;
    const proposalId = Number(target.dataset.proposalId);
    const editor = dependencyManualItemEditor(proposalId);
    if (!editor.selectedItem) return;
    const wrapper = target.closest("[data-manual-item-editor]");
    const unit = wrapper?.querySelector('[data-field="manual-item-unit"]')?.value || "salesQty";
    const quantity = depNumber(wrapper?.querySelector('[data-field="manual-item-quantity"]')?.value);
    if (quantity <= 0) {
      editor.error = "Enter a quantity above zero.";
      renderDependencyPage();
      return;
    }
    const quantities = { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: 0, [unit]: quantity };
    const itemName = editor.selectedItem.sku || editor.selectedItem.itemName || `Item ${editor.selectedItem.itemId}`;
    await runDependencyAction("Adding item to proposal...", async () => {
      const updatedBatch = await depApi(
        `/api/scm/transfer-dependencies/batches/${batchId}/proposals/${proposalId}/lines`,
        {
          method: "POST",
          body: JSON.stringify({ itemId: editor.selectedItem.itemId, quantities })
        }
      );
      if (dependencyBatchViewIsCurrent(batchId, salesOrderId)) dependencyState.batch = updatedBatch;
      dependencyManualItemEditors.delete(String(proposalId));
      dependencyState.notice = `${itemName} added manually. Review and save the Transfer Order before creation.`;
    }, { scope: `proposal:${proposalId}` });
    return;
  }
  if (action === "review-no-transfer") {
    const order = depSelectedOrder();
    const createdReview = order?.workflowStage === "created";
    const prompt = createdReview
      ? `Mark ${order.salesOrderRef} as reviewed and move it to Completed? Existing Transfer Orders and their records will be kept.`
      : `Mark ${order?.salesOrderRef} as Reviewed - No Transfer? This does not change dispatch or operator eligibility.`;
    if (!order || !window.confirm(prompt)) return;
    await runDependencyAction("Saving review...", async () => {
      await depApi(`/api/scm/transfer-dependencies/candidates/${order.salesOrderId}/review`, { method: "POST", body: "{}" });
      dependencyState.notice = createdReview
        ? `${order.salesOrderRef} moved to Completed. Its created Transfer Orders were kept.`
        : `${order.salesOrderRef} moved to Completed. Dispatch and operator status were not changed.`;
      await loadDependencyCandidates({ preserveSelection: false });
    });
    return;
  }
  if (action === "reopen-review") {
    const order = depSelectedOrder();
    if (!order) return;
    const returnStage = order.completionType === "transfer_manually_reviewed" ? "Created" : "Open";
    await runDependencyAction("Reopening shortage...", async () => {
      await depApi(`/api/scm/transfer-dependencies/candidates/${order.salesOrderId}/review`, { method: "DELETE" });
      dependencyState.notice = `${order.salesOrderRef} returned to the ${returnStage} queue.`;
      await loadDependencyCandidates({ preserveSelection: false });
    });
    return;
  }
  if (action === "refresh-inventory") {
    await runDependencyAction("Refreshing NetSuite inventory...", async () => {
      await loadSelectedDependencyInventory({ forceRefresh: true });
      await loadDependencyCandidates({ preserveSelection: true, refreshInventory: false });
      dependencyState.notice = "Sales Order commitment and yard inventory refreshed from NetSuite.";
    });
    return;
  }
  if (action === "generate") {
    const mode = scmDependencyApp.querySelector('[data-field="suggest-mode"]')?.value || "yard_replenishment";
    await runDependencyAction("Calculating routes and allocations...", async () => {
      clearDependencyProposalSelection();
      dependencyState.batch = await depApi("/api/scm/transfer-dependencies/suggestions", {
        method: "POST",
        body: JSON.stringify({
          salesOrderId: dependencyState.selectedSalesOrderId,
          mode,
          refreshInventory: true,
          reservationOverrides: depReservationOverridePayload()
        })
      });
      syncDependencyReservationOverridesFromBatch(dependencyState.batch);
      await loadSelectedDependencyInventory({ refreshUndercovered: false });
      dependencyState.mobilePanel = "proposals";
      const overrideCount = dependencyState.batch.reservationOverrides?.length || 0;
      dependencyState.notice = `Suggestion created for ${dependencyState.batch.salesOrderRef}.${overrideCount ? ` ${overrideCount} full-available override${overrideCount === 1 ? "" : "s"} saved.` : ""}`;
    });
    return;
  }
  if (action === "merge-proposals") {
    if (!dependencyState.batch) return;
    const cards = selectedDependencyProposalCards();
    const compatibility = dependencyProposalMergeCompatibility(cards);
    if (!compatibility.eligible) {
      updateDependencyProposalMergeState();
      return;
    }
    const proposalIds = compatibility.selected.map((proposal) => proposal.id);
    const targetProposalId = compatibility.target.id;
    const targetCard = cards[0];
    const fromYard = targetCard.querySelector('[data-proposal-field="fromLocationId"]')?.selectedOptions?.[0]?.textContent?.trim() || compatibility.target.fromLocationId;
    const toYard = targetCard.querySelector('[data-proposal-field="toLocationId"]')?.selectedOptions?.[0]?.textContent?.trim() || compatibility.target.toLocationId;
    const confirmation = `Merge ${proposalIds.length} proposed TOs from ${fromYard} to ${toYard}? A new draft will keep the first selected TO's memo, and nothing is sent to NetSuite yet.`;
    if (!window.confirm(confirmation)) return;
    const payload = {
      ...collectDependencyBatchPayload(cards),
      proposalIds,
      targetProposalId
    };
    await runDependencyAction("Merging proposed Transfer Orders...", async () => {
      const result = await depApi(`/api/scm/transfer-dependencies/batches/${dependencyState.batch.id}/proposals/merge`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      dependencyState.batch = result.batch;
      clearDependencyProposalSelection();
      dependencyState.notice = result.reused
        ? `The existing merged draft for ${fromYard} → ${toYard} was recovered safely.`
        : `${proposalIds.length} proposed TOs merged into one new draft for ${fromYard} → ${toYard}. Review it before creation.`;
    });
    return;
  }
  if (action === "remove-proposal-line") {
    if (!dependencyState.batch) return;
    const batchId = Number(dependencyState.batch.id);
    const salesOrderId = dependencyState.selectedSalesOrderId;
    const proposalId = Number(target.dataset.proposalId);
    const proposalLineId = Number(target.dataset.proposalLineId);
    const itemName = target.dataset.itemName || "this order line";
    const manual = target.closest(DEPENDENCY_PROPOSAL_LINE_SELECTOR)?.dataset.salesLineId === "";
    const consequence = manual
      ? "This manually added item will be removed; Sales Order undercoverage will not change."
      : "The quantity will return to Undercovered.";
    if (!window.confirm(`Remove ${itemName} from this Transfer Order proposal? ${consequence}`)) return;
    await runDependencyAction("Removing order line...", async () => {
      const updatedBatch = await depApi(
        `/api/scm/transfer-dependencies/batches/${batchId}/proposals/${proposalId}/lines/${proposalLineId}`,
        { method: "DELETE" }
      );
      if (dependencyBatchViewIsCurrent(batchId, salesOrderId)) dependencyState.batch = updatedBatch;
      dependencyState.notice = manual
        ? `${itemName} removed. The PALLET estimate was recalculated.`
        : `${itemName} removed. The uncovered quantity and PALLET estimate were recalculated.`;
    }, { scope: `proposal:${proposalId}` });
    return;
  }
  if (action === "save-proposal") {
    const card = target.closest(".scm-dependency-proposal");
    if (!card || !dependencyState.batch) return;
    const payload = collectDependencyBatchPayload([card]);
    const proposalId = Number(card.dataset.proposalId);
    const batchId = Number(dependencyState.batch.id);
    const salesOrderId = dependencyState.selectedSalesOrderId;
    await runDependencyAction("Saving draft...", async () => {
      const updatedBatch = await depApi(`/api/scm/transfer-dependencies/batches/${batchId}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      if (dependencyBatchViewIsCurrent(batchId, salesOrderId)) dependencyState.batch = updatedBatch;
      dependencyState.notice = `Proposed TO ${proposalId} draft saved.`;
    }, { scope: `proposal:${proposalId}` });
    return;
  }
  if (action === "save-created-proposal") {
    const card = target.closest(".scm-dependency-proposal");
    if (!card || !dependencyState.batch) return;
    const batchId = Number(dependencyState.batch.id);
    const salesOrderId = dependencyState.selectedSalesOrderId;
    const proposalId = Number(card.dataset.proposalId);
    const proposal = dependencyState.batch.proposals.find((row) => Number(row.id) === proposalId);
    if (!proposal) return;
    const recovering = ["updating", "attention"].includes(proposal.revisionStatus)
      && proposal.revisionRequestId;
    const requestId = recovering
      ? proposal.revisionRequestId
      : dependencyRevisionRequestIds.get(String(proposalId))
        || dependencyRequestId(`transfer-dependency-revision:${proposalId}`);
    dependencyRevisionRequestIds.set(String(proposalId), requestId);
    const payload = {
      ...collectDependencyProposalPayload(card),
      requestId,
      expectedRevision: Number(proposal.revision || card.dataset.revision || 1)
    };
    const confirmation = recovering
      ? `Recover the interrupted quantity update for ${proposal.transferOrderRef}? NetSuite will be checked before any retry.`
      : `Update quantities on existing NetSuite order ${proposal.transferOrderRef}? This will not create a new TO, and you must print a new ticket afterward.`;
    if (!window.confirm(confirmation)) return;
    await runDependencyAction(recovering ? "Recovering quantity update..." : "Updating NetSuite quantities...", async () => {
      const result = await depApi(
        `/api/scm/transfer-dependencies/batches/${batchId}/proposals/${proposalId}/quantities`,
        { method: "PATCH", body: JSON.stringify(payload) }
      );
      dependencyRevisionRequestIds.delete(String(proposalId));
      if (dependencyBatchViewIsCurrent(batchId, salesOrderId)) dependencyState.batch = result.batch;
      dependencyState.notice = result.recovered
        ? `${proposal.transferOrderRef} quantity update was recovered and verified. Print a new source-yard ticket.`
        : `${proposal.transferOrderRef} quantities were updated and verified. Print a new source-yard ticket.`;
      await loadDependencyCandidates({ preserveSelection: true, refreshInventory: false });
    }, { scope: `proposal:${proposalId}` });
    return;
  }
  if (action === "approve-print") {
    if (!dependencyState.batch) return;
    const batchId = Number(dependencyState.batch.id);
    const salesOrderId = dependencyState.selectedSalesOrderId;
    const proposalId = Number(target.dataset.proposalId);
    const proposal = dependencyState.batch.proposals.find((row) => Number(row.id) === proposalId);
    if (!proposal) return;
    const reprint = proposal.printJob?.status === "printed";
    const printRequestId = dependencyPrintRequestIds.get(String(proposalId))
      || dependencyRequestId(`transfer-dependency-print:${proposalId}`);
    dependencyPrintRequestIds.set(String(proposalId), printRequestId);
    const prompt = proposal.printJob && ["failed", "uncertain"].includes(proposal.printJob.status)
      ? `Requeue ${proposal.transferOrderRef} picking ticket to the ${proposal.fromLocation} printer?`
      : reprint
        ? `Verify current quantities and print a new ${proposal.transferOrderRef} picking ticket at ${proposal.fromLocation}? The earlier print remains in history.`
      : `Verify ${proposal.transferOrderRef} against the saved quantities, approve it in NetSuite, and print its picking ticket at ${proposal.fromLocation}?`;
    if (!window.confirm(prompt)) return;
    await runDependencyAction("Verifying, approving, and preparing source-yard print...", async () => {
      const result = await depApi(`/api/scm/transfer-dependencies/batches/${batchId}/proposals/${proposalId}/approve-print`, {
        method: "POST",
        body: JSON.stringify({
          reprint,
          requestId: printRequestId
        })
      });
      dependencyPrintRequestIds.delete(String(proposalId));
      if (dependencyBatchViewIsCurrent(batchId, salesOrderId)) dependencyState.batch = result.batch;
      dependencyState.notice = result.printJob?.status === "printed"
        ? `${proposal.transferOrderRef} was ${reprint ? "reprinted" : "approved and printed"}.`
        : `${proposal.transferOrderRef} was approved; its picking ticket is ${result.printJob?.status || "queued"} at ${proposal.fromLocation}.`;
      await loadDependencyCandidates({ preserveSelection: true, refreshInventory: false });
    }, { scope: `proposal:${proposalId}` });
    return;
  }
  if (action === "confirm-proposal") {
    const card = target.closest(".scm-dependency-proposal");
    if (!card || !dependencyState.batch) return;
    const proposalId = Number(card.dataset.proposalId);
    const recovering = card.dataset.creationStatus === "creating";
    const payload = recovering ? null : collectDependencyBatchPayload([card]);
    const confirmation = recovering
      ? "Recover the Transfer Order already created by the interrupted request? This will not create a duplicate if the existing order is found."
      : "Create this Transfer Order in NetSuite? A successful order cannot be rolled back from this screen.";
    if (!window.confirm(confirmation)) return;
    const batchId = Number(dependencyState.batch.id);
    const salesOrderId = dependencyState.selectedSalesOrderId;
    await runDependencyAction(recovering ? "Recovering NetSuite Transfer Order..." : "Creating NetSuite Transfer Order...", async () => {
      if (payload) {
        const savedBatch = await depApi(`/api/scm/transfer-dependencies/batches/${batchId}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        if (dependencyBatchViewIsCurrent(batchId, salesOrderId)) dependencyState.batch = savedBatch;
      }
      const result = await depApi(`/api/scm/transfer-dependencies/batches/${batchId}/proposals/${proposalId}/confirm`, { method: "POST", body: "{}" });
      if (dependencyBatchViewIsCurrent(batchId, salesOrderId)) dependencyState.batch = result.batch;
      const createdCount = result.results.filter((entry) => entry.status === "created").length;
      const attentionCount = result.results.filter((entry) => entry.status === "attention").length;
      const failedCount = result.results.filter((entry) => entry.status === "failed").length;
      const recoveredCount = result.results.filter((entry) => entry.recovered).length;
      dependencyState.notice = recoveredCount
        ? "Existing Transfer Order recovered and linked without creating a duplicate."
        : createdCount
        ? "Transfer Order created in NetSuite."
        : attentionCount
          ? "Transfer Order was created but needs attention; review its NetSuite status below."
          : failedCount
            ? "Transfer Order creation failed. Correct this proposal and retry."
            : "Transfer Order proposal is already created.";
      if (result.results.some((entry) => entry.transferOrderId)) {
        dependencyState.reviewStatus = "created";
        dependencyState.mobilePanel = "proposals";
      }
      await loadDependencyCandidates({ preserveSelection: true, refreshInventory: false });
    }, { scope: `proposal:${proposalId}` });
    return;
  }
});

window.addEventListener("mbbs-language-changed", renderDependencyPage);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && dependencyState.operator) scheduleDependencyRemoteRefresh(100);
});
window.addEventListener("beforeunload", () => dependencyEventSource?.close());

requireDispatchLogin({
  mount: scmDependencyApp,
  roles: ["admin", "scm", "scm_staff"],
  async onReady(operator) {
    dependencyState.operator = operator;
    await runDependencyAction("Loading shortages...", () => loadDependencyCandidates({ preserveSelection: false }));
    connectDependencyEvents();
  }
});
