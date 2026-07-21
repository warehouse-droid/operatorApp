const scmDependencyApp = document.getElementById("scmDependencyApp");
const DEPENDENCY_YARDS = [
  { id: 1, code: "3445" },
  { id: 28, code: "2967" },
  { id: 15, code: "12441" },
  { id: 26, code: "150" }
];

const dependencyState = {
  operator: null,
  candidates: [],
  selectedSalesOrderId: null,
  inventory: null,
  batch: null,
  search: "",
  reviewStatus: "open",
  busy: "",
  notice: "",
  error: ""
};

let dependencyEventSource = null;
let dependencyRemoteRefreshTimer = null;

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

function depDate(value) {
  if (!value) return "No delivery date";
  return window.MBBS_I18N?.formatDate?.(value) || String(value).slice(0, 10);
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
  for (const row of card.querySelectorAll("[data-sales-line-id]")) {
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

async function loadSelectedDependencyInventory({ forceRefresh = false, refreshUndercovered = true } = {}) {
  if (!dependencyState.selectedSalesOrderId) {
    dependencyState.inventory = null;
    return null;
  }
  const selectedOrder = depSelectedOrder();
  if (selectedOrder?.dependencyBatchId) {
    dependencyState.batch = await depApi(`/api/scm/transfer-dependencies/batches/${selectedOrder.dependencyBatchId}`);
  }
  const shouldRefresh = forceRefresh || (
    refreshUndercovered
    && dependencyState.reviewStatus === "open"
    && !selectedOrder?.completed
    && depNumber(selectedOrder?.uncoveredQuantity) > 0
  );
  const path = `/api/scm/transfer-dependencies/candidates/${dependencyState.selectedSalesOrderId}/${shouldRefresh ? "refresh-inventory" : "inventory"}`;
  dependencyState.inventory = await depApi(path, shouldRefresh ? { method: "POST", body: "{}" } : {});
  return dependencyState.inventory;
}

function depCandidateQuery() {
  const params = new URLSearchParams({ reviewStatus: dependencyState.reviewStatus });
  if (dependencyState.search) params.set("search", dependencyState.search);
  return `?${params.toString()}`;
}

function depYardOptions(selected) {
  return DEPENDENCY_YARDS.map((yard) => `<option value="${yard.id}" ${String(yard.id) === String(selected) ? "selected" : ""}>${yard.code}</option>`).join("");
}

function renderDependencyCandidates() {
  if (!dependencyState.candidates.length) {
    const emptyText = dependencyState.reviewStatus === "completed"
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
      <span class="scm-dependency-order-side"><b>${depQty(order.uncoveredQuantity)}</b><small>uncovered</small></span>
      <small>${depEscape(order.outboundLocation || "--")} | ${depEscape(depDate(order.expectedDeliveryDate))}${order.completionType === "reviewed_no_transfer" ? " | Reviewed - No Transfer" : order.workflowStage === "created" ? " | Waiting approval / print" : order.completionType === "transfer_approved_printed" ? " | Approved & printed" : ""}</small>
    </button>
  `).join("");
}

function depInventoryCoverage(order = {}, matrix = {}) {
  const byItem = new Map((matrix?.items || []).map((item) => [String(item.itemId), item]));
  const coverageByItem = new Map();
  for (const line of order.lines || []) {
    const key = String(line.itemId || line.salesLineId);
    const entry = coverageByItem.get(key) || { line, lines: [], required: 0 };
    entry.lines.push(line);
    entry.required += depNumber(line.unresolvedQuantity);
    coverageByItem.set(key, entry);
  }
  return [...coverageByItem.entries()].map(([itemKey, entry]) => {
    const item = byItem.get(itemKey);
    const sourceAvailable = (item?.balances || [])
      .filter((balance) => String(balance.locationId) !== String(order.outboundLocationId))
      .reduce((total, balance) => total + depNumber(balance.effectiveAvailable), 0);
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
    <div class="scm-dependency-review-action">
      <span>${order.workflowStage === "created"
        ? "Transfer Orders were created and are waiting for quantity verification, approval, and source-yard printing."
        : order.completionType === "transfer_approved_printed"
          ? `Transfer Orders were verified, approved, and printed${order.completedAt ? ` on ${depEscape(depDate(order.completedAt))}` : ""}.`
        : order.reviewed
          ? `Reviewed${order.reviewedAt ? ` on ${depEscape(depDate(order.reviewedAt))}` : ""}. This order cannot generate a transfer proposal.`
          : "No transfer needed? Mark only this SCM shortage review; dispatch and operator status stay unchanged."}</span>
      ${order.workflowStage !== "open" && !order.reviewed ? "" : `<button data-action="${order.reviewed ? "reopen-review" : "review-no-transfer"}" type="button" ${dependencyState.busy ? "disabled" : ""}>
        ${order.reviewed ? "Undo Review" : "Mark Reviewed - No Transfer"}
      </button>`}
    </div>
    <div class="scm-dependency-matrix-wrap">
      <div class="scm-dependency-matrix-head">
        <strong>Item / Required</strong>
        <strong class="scm-dependency-undercovered-head"><span>Undercovered</span><small>Not covered by linked TO</small></strong>
        ${DEPENDENCY_YARDS.map((yard) => `<strong class="${String(yard.id) === String(order.outboundLocationId) ? "outbound-yard" : ""}"><span>${yard.code}</span><small>${String(yard.id) === String(order.outboundLocationId) ? "Outbound · available" : "All available"}</small></strong>`).join("")}
      </div>
      ${coverage.map(({ line, lines, item, required, undercovered, sourceShortfall }) => {
        const requiredText = lines.length === 1
          ? depUnitText(line)
          : `${depQty(required)} ${line.unit || item?.unit || "UOM"} · ${lines.length} SO lines`;
        const undercoveredUnit = line.unit || item?.unit || "UOM";
        return `<div class="scm-dependency-matrix-row ${sourceShortfall > 0.000001 ? "coverage-impossible" : ""}">
          <div><strong>${depEscape(line.sku || line.itemName)}</strong><small>${depEscape(requiredText)}</small></div>
          <div class="scm-dependency-undercovered-cell ${undercovered > 0.000001 ? "has-shortfall" : "is-covered"}">
            <b>${depQty(undercovered)} ${depEscape(undercoveredUnit)}</b><small>${undercovered > 0.000001 ? "needs linked transfer" : "Covered by linked TO"}</small>
          </div>
          ${DEPENDENCY_YARDS.map((yard) => {
            const balance = item?.balances?.find((entry) => String(entry.locationId) === String(yard.id));
            const reserved = depNumber(balance?.reservedQuantity);
            const usable = depNumber(balance?.effectiveAvailable);
            const availabilityNote = reserved > 0.000001
              ? `${depQty(usable)} usable · ${depQty(reserved)} reserved`
              : "Full available quantity";
            return `<div class="${String(yard.id) === String(order.outboundLocationId) ? "outbound-yard" : ""}"><b>${depQty(balance?.quantityAvailable)}</b><small>${availabilityNote}</small></div>`;
          }).join("")}
        </div>`;
      }).join("")}
    </div>
  `;
}

function renderProposal(proposal) {
  const editable = !["created", "creating", "attention"].includes(proposal.creationStatus);
  const recoverable = proposal.creationStatus === "creating";
  const created = ["created", "attention"].includes(proposal.creationStatus) && proposal.transferOrderId;
  const printStatus = proposal.printJob?.status || "not queued";
  const printInProgress = ["queued", "leased", "printing"].includes(printStatus);
  const printed = printStatus === "printed";
  const approvalInProgress = proposal.approvalStatus === "approving";
  const approveLabel = ["failed", "uncertain"].includes(printStatus)
    ? "Retry Source-yard Print"
    : proposal.approvalStatus === "approved"
      ? "Get Ticket & Print"
      : "Verify, Approve & Print";
  return `
    <article class="scm-dependency-proposal" data-proposal-id="${proposal.id}" data-creation-status="${depEscape(proposal.creationStatus)}" data-pallet-overridden="${proposal.palletQuantityOverridden === true}">
      <header>
        <strong>${depEscape(proposal.transferOrderRef || `Proposed TO ${proposal.id}`)}</strong>
        <span class="dependency-status status-${depEscape(proposal.creationStatus)}">${depEscape(proposal.creationStatus)}</span>
      </header>
      <div class="scm-dependency-proposal-route">
        <label><span>Mode</span><select data-proposal-field="mode" ${editable ? "" : "disabled"}>
          <option value="yard_replenishment" ${proposal.mode === "yard_replenishment" ? "selected" : ""}>Replenish yard</option>
          <option value="direct_to_customer" ${proposal.mode === "direct_to_customer" ? "selected" : ""}>Direct pickup</option>
        </select></label>
        <label><span>From</span><select data-proposal-field="fromLocationId" ${editable ? "" : "disabled"}>${depYardOptions(proposal.fromLocationId)}</select></label>
        <label><span>Accounting To</span><select data-proposal-field="toLocationId" ${editable ? "" : "disabled"}>${depYardOptions(proposal.toLocationId)}</select></label>
        <div><span>Route score</span><strong>${proposal.routeScore === null ? "Fallback" : `${depQty(proposal.routeScore)} min`}</strong></div>
      </div>
      <label class="scm-dependency-memo"><span>Memo</span><input data-proposal-field="memo" value="${depEscape(proposal.memo || "")}" ${editable ? "" : "disabled"} /></label>
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
          return `<section class="scm-dependency-proposal-line link-quantity-line" data-sales-line-id="${line.salesLineId}"
            data-proposal-line-id="${line.id}" data-item-id="${depEscape(line.itemId)}" data-item-name="${depEscape(line.itemName)}"
            data-to-plt="${conversions.pallets}" data-to-lyr="${conversions.layers}"
            data-to-sec="${conversions.sections}" data-to-pcs="${conversions.pieces}"
            data-sales-unit="${depEscape(line.unit || "UOM")}">
            <div class="link-quantity-info scm-dependency-line-info">
              <span><strong>${depEscape(line.itemName)}</strong><small>Sales quantity</small></span>
              <div class="scm-dependency-line-controls">
                <em class="link-sales-equivalent" data-proposal-sales-equivalent>${depQty(salesQuantity)} ${depEscape(line.unit || "UOM")}</em>
                ${editable && !dependencyState.busy ? `<button class="scm-dependency-remove-line" data-action="remove-proposal-line"
                  data-proposal-id="${proposal.id}" data-proposal-line-id="${line.id}" data-item-name="${depEscape(line.itemName)}"
                  type="button">Remove line</button>` : ""}
              </div>
            </div>
            <div class="link-quantity-units">${units.map(([field, label]) => `<label>
              <span>${depEscape(label)}</span>
              <input id="proposal-${proposal.id}-${lineIndex}-${field}" data-proposal-unit="${field}" type="number"
                min="0" step="${field === "salesQty" ? "0.001" : "1"}" value="${depNumber(values[field])}" ${editable ? "" : "disabled"} />
            </label>`).join("")}</div>
          </section>`;
        }).join("")}
      </div>
      <div class="scm-dependency-pallet-summary">
        <div><span>Calculated PALLET</span><strong data-calculated-pallet>${depQty(proposal.calculatedPalletQuantity)}</strong></div>
        <label><span>Final PALLET quantity</span>
          <input data-proposal-field="palletTransferQuantity" type="number" min="0" step="1"
            value="${!proposal.palletCalculationComplete && !proposal.palletQuantityOverridden ? "" : depNumber(proposal.palletTransferQuantity)}"
            placeholder="${depNumber(proposal.palletTransferQuantity)}" ${editable ? "" : "disabled"} />
        </label>
        <small data-pallet-calculation-note class="${proposal.palletCalculationComplete ? "" : "warning-text"}">${proposal.palletCalculationComplete
          ? "One PALLET per full PLT, plus one for each SKU with loose remainder."
          : "Manual quantity required: at least one item has no PLT conversion."}</small>
      </div>
      ${proposal.creationError ? `<div class="scm-dependency-error">${depEscape(proposal.creationError)}</div>` : ""}
      ${created ? `<div class="scm-dependency-workflow">
        <div><span>Quantity check</span><strong>${depEscape(proposal.quantityVerificationStatus || "pending")}</strong></div>
        <div><span>NetSuite approval</span><strong>${depEscape(proposal.approvalStatus || "pending")}</strong></div>
        <div><span>Source-yard print</span><strong>${depEscape(printStatus)}</strong></div>
      </div>` : ""}
      ${proposal.quantityVerificationError ? `<div class="scm-dependency-error">${depEscape(proposal.quantityVerificationError)}</div>` : ""}
      ${proposal.approvalError ? `<div class="scm-dependency-error">${depEscape(proposal.approvalError)}</div>` : ""}
      ${proposal.printJob?.error ? `<div class="scm-dependency-error">${depEscape(proposal.printJob.error)}</div>` : ""}
      <footer class="scm-dependency-proposal-actions">
        <button data-action="save-proposal" data-proposal-id="${proposal.id}" type="button" ${editable && !dependencyState.busy ? "" : "disabled"}>Save Draft</button>
        ${(editable || recoverable) ? `<button class="primary-action" data-action="confirm-proposal" data-proposal-id="${proposal.id}" type="button" ${!dependencyState.busy ? "" : "disabled"}>
          ${recoverable ? "Recover Transfer Order" : proposal.creationStatus === "failed" ? "Retry Transfer Order" : "Create Transfer Order"}
        </button>` : ""}
        ${created && !printed ? `<button class="primary-action" data-action="approve-print" data-proposal-id="${proposal.id}" type="button" ${!dependencyState.busy && !printInProgress && !approvalInProgress ? "" : "disabled"}>${printInProgress ? `Print ${depEscape(printStatus)}` : depEscape(approveLabel)}</button>` : ""}
      </footer>
    </article>
  `;
}

function renderDependencyProposals() {
  const batch = dependencyState.batch;
  if (!batch) return `<div class="empty-state">Generate a suggestion to create editable transfer proposals.</div>`;
  return `
    <div class="scm-dependency-batch-head">
      <div><span>Batch</span><strong>#${batch.id} | ${depEscape(batch.status)}</strong></div>
      <div><span>Uncovered</span><strong class="${batch.uncoveredShortageQuantity > 0 ? "warning-text" : ""}">${depQty(batch.uncoveredShortageQuantity)}</strong></div>
    </div>
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
    <section class="scm-dependency-toolbar">
      <button data-action="refresh-inventory" type="button" ${dependencyState.reviewStatus === "open" && dependencyState.selectedSalesOrderId && !selectedOrder?.completed && !dependencyState.busy ? "" : "disabled"}>Refresh Inventory</button>
      <select data-field="suggest-mode">
        <option value="yard_replenishment">Replenish outbound yard</option>
        <option value="direct_to_customer">Direct pickup to customer</option>
      </select>
      <button class="primary-action" data-action="generate" type="button" ${dependencyState.reviewStatus === "open" && dependencyState.selectedSalesOrderId && !selectedOrder?.completed && !dependencyState.busy ? "" : "disabled"}>Generate Suggestion</button>
      <span class="scm-dependency-busy">${depEscape(dependencyState.busy)}</span>
    </section>
    <section class="scm-dependency-grid">
      <aside class="scm-dependency-panel scm-dependency-candidates">
        <div class="panel-title scm-dependency-candidate-title">
          <div><p>${dependencyState.reviewStatus === "completed" ? "Completed reviews" : dependencyState.reviewStatus === "created" ? "Created · action required" : "Open shortages"}</p><h2>Sales Orders</h2></div>
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
  const previousSelected = depSelectedOrder();
  dependencyState.candidates = await depApi(`/api/scm/transfer-dependencies/candidates${depCandidateQuery()}`);
  if (!preserveSelection || !dependencyState.candidates.some((order) => String(order.salesOrderId) === String(dependencyState.selectedSalesOrderId))) {
    dependencyState.selectedSalesOrderId = dependencyState.candidates[0]?.salesOrderId || null;
    dependencyState.batch = null;
  }
  const nextSelected = depSelectedOrder();
  const shortageChanged = previousSelected
    && nextSelected
    && String(previousSelected.salesOrderId) === String(nextSelected.salesOrderId)
    && previousSelected.shortageSignature
    && nextSelected.shortageSignature
    && previousSelected.shortageSignature !== nextSelected.shortageSignature;
  if (shortageChanged) {
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
    if (dependencyState.busy) {
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
    palletTransferQuantity: (() => {
      if (card.dataset.palletOverridden !== "true") return undefined;
      const value = card.querySelector('[data-proposal-field="palletTransferQuantity"]')?.value;
      return value === "" || value === undefined ? null : Number(value);
    })(),
    lines: [...card.querySelectorAll("[data-sales-line-id]")].map((row) => {
      const quantities = proposalUnitValues(row);
      return {
        salesLineId: Number(row.dataset.salesLineId),
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

async function runDependencyAction(label, action) {
  if (dependencyState.busy) return;
  dependencyState.busy = label;
  dependencyState.error = "";
  dependencyState.notice = "";
  renderDependencyPage();
  try {
    await action();
  } catch (error) {
    dependencyState.error = error.message;
  } finally {
    dependencyState.busy = "";
    renderDependencyPage();
  }
}

let dependencySearchTimer = null;
scmDependencyApp.addEventListener("input", (event) => {
  if (event.target.matches("[data-proposal-unit]")) {
    const row = event.target.closest("[data-sales-line-id]");
    updateProposalSalesEquivalent(row);
    updateProposalPalletEstimate(event.target.closest(".scm-dependency-proposal"));
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
  dependencySearchTimer = setTimeout(() => runDependencyAction("Searching...", () => loadDependencyCandidates({ preserveSelection: false })), 250);
});

scmDependencyApp.addEventListener("change", (event) => {
  if (!event.target.matches('[data-proposal-unit="layers"]')) return;
  event.target.value = String(Math.max(0, Math.round(depNumber(event.target.value))));
  const row = event.target.closest("[data-sales-line-id]");
  updateProposalSalesEquivalent(row);
  updateProposalPalletEstimate(event.target.closest(".scm-dependency-proposal"));
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
  if (action === "select-order") {
    dependencyState.selectedSalesOrderId = target.dataset.orderId;
    dependencyState.batch = null;
    dependencyState.inventory = null;
    await runDependencyAction("Refreshing NetSuite inventory...", () => loadSelectedDependencyInventory());
    return;
  }
  if (action === "set-review-filter") {
    const status = ["created", "completed"].includes(target.dataset.reviewStatus) ? target.dataset.reviewStatus : "open";
    if (status === dependencyState.reviewStatus) return;
    dependencyState.reviewStatus = status;
    await runDependencyAction("Loading shortages...", () => loadDependencyCandidates({ preserveSelection: false }));
    return;
  }
  if (action === "review-no-transfer") {
    const order = depSelectedOrder();
    if (!order || !window.confirm(`Mark ${order.salesOrderRef} as Reviewed - No Transfer? This does not change dispatch or operator eligibility.`)) return;
    await runDependencyAction("Saving review...", async () => {
      await depApi(`/api/scm/transfer-dependencies/candidates/${order.salesOrderId}/review`, { method: "POST", body: "{}" });
      dependencyState.notice = `${order.salesOrderRef} moved to Completed. Dispatch and operator status were not changed.`;
      await loadDependencyCandidates({ preserveSelection: false });
    });
    return;
  }
  if (action === "reopen-review") {
    const order = depSelectedOrder();
    if (!order) return;
    await runDependencyAction("Reopening shortage...", async () => {
      await depApi(`/api/scm/transfer-dependencies/candidates/${order.salesOrderId}/review`, { method: "DELETE" });
      dependencyState.notice = `${order.salesOrderRef} returned to the Open queue.`;
      await loadDependencyCandidates({ preserveSelection: false });
    });
    return;
  }
  if (action === "refresh-inventory") {
    await runDependencyAction("Refreshing NetSuite inventory...", async () => {
      await loadSelectedDependencyInventory({ forceRefresh: true });
      dependencyState.notice = "Inventory refreshed from NetSuite.";
    });
    return;
  }
  if (action === "generate") {
    const mode = scmDependencyApp.querySelector('[data-field="suggest-mode"]')?.value || "yard_replenishment";
    await runDependencyAction("Calculating routes and allocations...", async () => {
      dependencyState.batch = await depApi("/api/scm/transfer-dependencies/suggestions", {
        method: "POST",
        body: JSON.stringify({ salesOrderId: dependencyState.selectedSalesOrderId, mode, refreshInventory: true })
      });
      await loadSelectedDependencyInventory({ refreshUndercovered: false });
      dependencyState.notice = `Suggestion created for ${dependencyState.batch.salesOrderRef}.`;
    });
    return;
  }
  if (action === "remove-proposal-line") {
    if (!dependencyState.batch) return;
    const proposalId = Number(target.dataset.proposalId);
    const proposalLineId = Number(target.dataset.proposalLineId);
    const itemName = target.dataset.itemName || "this order line";
    if (!window.confirm(`Remove ${itemName} from this Transfer Order proposal? The quantity will return to Undercovered.`)) return;
    await runDependencyAction("Removing order line...", async () => {
      dependencyState.batch = await depApi(
        `/api/scm/transfer-dependencies/batches/${dependencyState.batch.id}/proposals/${proposalId}/lines/${proposalLineId}`,
        { method: "DELETE" }
      );
      dependencyState.notice = `${itemName} removed. The uncovered quantity and PALLET estimate were recalculated.`;
    });
    return;
  }
  if (action === "save-proposal") {
    const card = target.closest(".scm-dependency-proposal");
    if (!card || !dependencyState.batch) return;
    const payload = collectDependencyBatchPayload([card]);
    const proposalId = Number(card.dataset.proposalId);
    await runDependencyAction("Saving draft...", async () => {
      dependencyState.batch = await depApi(`/api/scm/transfer-dependencies/batches/${dependencyState.batch.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      dependencyState.notice = `Proposed TO ${proposalId} draft saved.`;
    });
    return;
  }
  if (action === "approve-print") {
    if (!dependencyState.batch) return;
    const proposalId = Number(target.dataset.proposalId);
    const proposal = dependencyState.batch.proposals.find((row) => Number(row.id) === proposalId);
    if (!proposal) return;
    const prompt = proposal.printJob && ["failed", "uncertain"].includes(proposal.printJob.status)
      ? `Requeue ${proposal.transferOrderRef} picking ticket to the ${proposal.fromLocation} printer?`
      : `Verify ${proposal.transferOrderRef} against the saved quantities, approve it in NetSuite, and print its picking ticket at ${proposal.fromLocation}?`;
    if (!window.confirm(prompt)) return;
    await runDependencyAction("Verifying, approving, and preparing source-yard print...", async () => {
      const result = await depApi(`/api/scm/transfer-dependencies/batches/${dependencyState.batch.id}/proposals/${proposalId}/approve-print`, { method: "POST", body: "{}" });
      dependencyState.batch = result.batch;
      dependencyState.notice = result.printJob?.status === "printed"
        ? `${proposal.transferOrderRef} was approved and printed.`
        : `${proposal.transferOrderRef} was approved; its picking ticket is ${result.printJob?.status || "queued"} at ${proposal.fromLocation}.`;
      await loadDependencyCandidates({ preserveSelection: true, refreshInventory: false });
    });
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
    await runDependencyAction(recovering ? "Recovering NetSuite Transfer Order..." : "Creating NetSuite Transfer Order...", async () => {
      if (payload) {
        dependencyState.batch = await depApi(`/api/scm/transfer-dependencies/batches/${dependencyState.batch.id}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
      }
      const result = await depApi(`/api/scm/transfer-dependencies/batches/${dependencyState.batch.id}/proposals/${proposalId}/confirm`, { method: "POST", body: "{}" });
      dependencyState.batch = result.batch;
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
      if (result.results.some((entry) => entry.transferOrderId)) dependencyState.reviewStatus = "created";
      await loadDependencyCandidates({ preserveSelection: false, refreshInventory: false });
    });
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
