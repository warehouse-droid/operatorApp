const dependencyApp = document.getElementById("scmDependencyManagementApp");

let dependencyOperator = null;
let dependencySearchTimer = null;
let dependencySearchAbortController = null;

const dependencyState = {
  search: "",
  targets: [],
  nextCursor: "",
  selectedRef: "",
  detail: null,
  toOptions: null,
  poOptions: null,
  toRef: "",
  toMode: "yard_replenishment",
  toQuantities: {},
  poRef: "",
  poSelections: {},
  poQuantities: {},
  command: null,
  preview: null,
  pendingRequest: null,
  loadingTargets: false,
  loadingDetail: false,
  busy: false,
  notice: "",
  noticeKind: ""
};

function dependencyRoles(operator = dependencyOperator) {
  return new Set([
    ...(Array.isArray(operator?.roles) ? operator.roles : []),
    operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

function canWriteDependencyManagement(operator = dependencyOperator) {
  const roles = dependencyRoles(operator);
  return ["admin", "scm", "scm_staff"].some((role) => roles.has(role));
}

function dependencyEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function dependencyNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function dependencyErrorMessage(error) {
  return error?.message || String(error || "Dependency request failed.");
}

async function dependencyFetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || response.statusText || "Request failed.");
    error.status = response.status;
    error.code = payload.code || "";
    error.details = payload.details || {};
    throw error;
  }
  return payload;
}

function newDependencyManagementRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === "x" ? random : ((random & 0x3) | 0x8)).toString(16);
  });
}

function dependencyStableValue(value) {
  if (Array.isArray(value)) return value.map(dependencyStableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = dependencyStableValue(value[key]);
    return result;
  }, {});
}

async function dependencyPayloadHash(command = {}) {
  const payloadHashInput = {
    action: command.action || "",
    targetRef: command.targetRef || "",
    targetSignature: command.targetSignature || "",
    planId: command.planId || null,
    planDate: command.planDate || "",
    expectedPlanRevision: command.expectedPlanRevision ?? null,
    expectedPlanDigest: command.expectedPlanDigest || "",
    payload: command.payload || {}
  };
  const bytes = new TextEncoder().encode(JSON.stringify(dependencyStableValue(payloadHashInput)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dependencyTargetSummary(target = {}) {
  const card = target.card || {};
  const customer = card.customer || card.name || "";
  const members = Array.isArray(card.childOrders) ? card.childOrders : [];
  return [customer, members.length ? `${members.length} grouped orders` : ""].filter(Boolean).join(" · ");
}

function renderDependencyTargets() {
  if (dependencyState.loadingTargets && !dependencyState.targets.length) {
    return '<div class="dependency-empty">Loading current orders…</div>';
  }
  if (!dependencyState.targets.length) {
    return '<div class="dependency-empty">No current SO, group, or split target matches this search.</div>';
  }
  return dependencyState.targets.map((target) => `
    <button class="dependency-target-card ${target.ref === dependencyState.selectedRef ? "active" : ""}"
      data-action="select-target" data-target-ref="${dependencyEscape(target.ref)}" type="button">
      <strong>${dependencyEscape(target.ref)}</strong>
      <span>${dependencyEscape(target.kind)}${target.planDate ? ` · plan ${dependencyEscape(target.planDate)}` : ""}</span>
      <span>${dependencyEscape(dependencyTargetSummary(target))}</span>
    </button>
  `).join("");
}

function renderTargetLineTable() {
  const lines = dependencyState.detail?.lines || [];
  if (!lines.length) return '<p class="dependency-muted">No current item lines are available.</p>';
  return `
    <div class="dependency-line-scroll">
      <table class="dependency-line-table">
        <thead><tr><th>Source order</th><th>Item</th><th>Exact target line key</th><th>Qty</th><th>TO linked</th><th>PO linked</th></tr></thead>
        <tbody>${lines.map((line) => `
          <tr>
            <td>${dependencyEscape(line.sourceOrderRef)}</td>
            <td><strong>${dependencyEscape(line.sku || line.itemName)}</strong><br><span class="dependency-muted">${dependencyEscape(line.description || line.unit || "")}</span></td>
            <td><code>${dependencyEscape(line.targetLineKey)}</code></td>
            <td>${dependencyEscape(line.quantity)} ${dependencyEscape(line.unit || "")}</td>
            <td>${dependencyEscape(line.dependencyAllocatedQuantity || 0)}</td>
            <td>${dependencyEscape([
              line.poAllocatedPallets ? `${line.poAllocatedPallets} PLT` : "",
              line.poAllocatedLayers ? `${line.poAllocatedLayers} LYR` : "",
              line.poAllocatedSections ? `${line.poAllocatedSections} SEC` : "",
              line.poAllocatedPieces ? `${line.poAllocatedPieces} PCS` : "",
              line.poAllocatedSalesQty ? `${line.poAllocatedSalesQty} ${line.unit || "QTY"}` : ""
            ].filter(Boolean).join(" + ") || "0")}</td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;
}

function dependencyQuantityInputs({ prefix, key, quantities = {}, disabled = false, salesQuantityOnly = false } = {}) {
  const units = salesQuantityOnly
    ? [["salesQty", "Sales qty"]]
    : [["pallets", "PLT"], ["layers", "LYR"], ["sections", "SEC"], ["pieces", "PCS"], ["salesQty", "Sales qty"]];
  return units.map(([unit, label]) => `
    <label class="dependency-quantity-field">${label}
      <input type="number" min="0" step="any" value="${dependencyEscape(quantities[unit] || 0)}"
        data-${prefix}-quantity="${unit}" data-target-line-key="${dependencyEscape(key)}" ${disabled ? "disabled" : ""} />
    </label>
  `).join("");
}

function renderToLinkLines() {
  const options = dependencyState.toOptions;
  if (!dependencyState.toRef) return '<p class="dependency-muted">Enter a Transfer Order and choose Match current lines.</p>';
  if (options?.matchError) return `<p class="dependency-notice error">${dependencyEscape(options.matchError)}</p>`;
  const lines = options?.matchingLines || [];
  if (!lines.length) return '<p class="dependency-muted">Match the Transfer Order to show allocatable lines.</p>';
  for (const line of lines) {
    if (!dependencyState.toQuantities[line.targetLineKey]) {
      dependencyState.toQuantities[line.targetLineKey] = { ...(line.suggestedQuantities || {}) };
    }
  }
  return `
    <div class="dependency-line-scroll">
      <table class="dependency-line-table">
        <thead><tr><th>Source / item</th><th>Available SO</th><th>Available TO</th><th>Allocation</th></tr></thead>
        <tbody>${lines.map((line) => `
          <tr data-to-line="${dependencyEscape(line.targetLineKey)}">
            <td><strong>${dependencyEscape(line.sourceOrderRef)}</strong><br>${dependencyEscape(line.sku || line.itemName)}</td>
            <td>${dependencyEscape(line.shortageQuantity)} ${dependencyEscape(line.unit || "")}</td>
            <td>${dependencyEscape(line.transferQuantity)} ${dependencyEscape(line.unit || "")}</td>
            <td><div class="dependency-button-row">${dependencyQuantityInputs({
              prefix: "to",
              key: line.targetLineKey,
              quantities: dependencyState.toQuantities[line.targetLineKey],
              disabled: !canWriteDependencyManagement()
            })}</div></td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;
}

function poLineById(id) {
  return (dependencyState.poOptions?.poLines || []).find((line) => String(line.id) === String(id));
}

function dependencyPoEntryRefs(entry) {
  return [...new Set([
    entry?.poRef,
    entry?.originalPoRef,
    ...(Array.isArray(entry?.poAliases) ? entry.poAliases : [])
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function dependencyPoRefMatches(entry, poRef) {
  const normalizedRef = String(poRef || "").trim().toLowerCase();
  return Boolean(normalizedRef)
    && dependencyPoEntryRefs(entry).some((ref) => ref.toLowerCase() === normalizedRef);
}

function renderPoLinkLines() {
  const options = dependencyState.poOptions;
  const salesLines = options?.salesLines || [];
  if (!salesLines.length) return '<p class="dependency-muted">No operational SO lines are available for PO linkage.</p>';
  const poRef = dependencyState.poRef.trim().toLowerCase();
  if (!poRef) return '<p class="dependency-muted">Enter the exact PO or split-PO ref, then choose Find current PO lines.</p>';
  return `
    <div class="dependency-line-scroll">
      <table class="dependency-line-table">
        <thead><tr><th>SO source / item</th><th>Exact PO line</th><th>Available SO</th><th>Allocation</th></tr></thead>
        <tbody>${salesLines.map((line) => {
          const candidates = (line.poCandidates || [])
            .map((candidate) => ({ ...candidate, line: poLineById(candidate.poLineId) }))
            .filter((candidate) => dependencyPoRefMatches(candidate.line, poRef)
              || dependencyPoRefMatches(candidate, poRef));
          if (!dependencyState.poSelections[line.targetLineKey] && candidates.length === 1) {
            dependencyState.poSelections[line.targetLineKey] = String(candidates[0].poLineId);
          }
          dependencyState.poQuantities[line.targetLineKey] ||= {};
          return `
            <tr data-po-line="${dependencyEscape(line.targetLineKey)}">
              <td><strong>${dependencyEscape(line.sourceOrderRef)}</strong><br>${dependencyEscape(line.sku || line.itemName)}</td>
              <td><select data-po-selection="${dependencyEscape(line.targetLineKey)}" ${canWriteDependencyManagement() ? "" : "disabled"}>
                <option value="">${candidates.length ? "Select PO line" : "No matching current line"}</option>
                ${candidates.map((candidate) => `<option value="${dependencyEscape(candidate.poLineId)}" ${String(dependencyState.poSelections[line.targetLineKey] || "") === String(candidate.poLineId) ? "selected" : ""}>${dependencyEscape(candidate.line?.poRef)} · ${dependencyEscape(candidate.line?.sku || candidate.line?.itemName)} · line ${dependencyEscape(candidate.line?.lineId || candidate.line?.id)}</option>`).join("")}
              </select></td>
              <td>${dependencyEscape(Object.entries(line.available || {}).filter(([, value]) => dependencyNumber(value)).map(([unit, value]) => `${value} ${unit}`).join(" + ") || "0")}</td>
              <td><div class="dependency-button-row">${dependencyQuantityInputs({
                prefix: "po",
                key: line.targetLineKey,
                quantities: dependencyState.poQuantities[line.targetLineKey],
                disabled: !canWriteDependencyManagement(),
                salesQuantityOnly: line.salesQuantityOnly === true
              })}</div></td>
            </tr>
          `;
        }).join("")}</tbody>
      </table>
    </div>
  `;
}

function renderExistingRelationships() {
  const relationships = dependencyState.detail?.relationships || {};
  const transferOrders = relationships.transferOrders || [];
  const purchaseOrders = relationships.purchaseOrders || [];
  if (!transferOrders.length && !purchaseOrders.length) {
    return '<p class="dependency-muted">No active TO or PO relationships.</p>';
  }
  return `
    <div class="dependency-relation-list">
      ${transferOrders.map((relationship) => `
        <div class="dependency-relation-row">
          <div><strong>${dependencyEscape(relationship.transferOrderRef)}</strong><br><span class="dependency-muted">${dependencyEscape(relationship.allocatedQuantity)} allocated · ${dependencyEscape(relationship.status)}</span></div>
          <select data-existing-mode="${relationship.id}" ${canWriteDependencyManagement() ? "" : "disabled"}>
            <option value="yard_replenishment" ${relationship.mode === "yard_replenishment" ? "selected" : ""}>Yard replenishment</option>
            <option value="direct_to_customer" ${relationship.mode === "direct_to_customer" ? "selected" : ""}>Direct pickup / drop ship</option>
          </select>
          ${canWriteDependencyManagement() ? `<div class="dependency-button-row">
            <button data-action="preview-mode" data-dependency-id="${relationship.id}" type="button">Preview mode</button>
            <button class="danger" data-action="preview-unlink-to" data-dependency-id="${relationship.id}" type="button">Preview unlink</button>
          </div>` : '<span class="dependency-badge dependency-read-only">Read only</span>'}
        </div>
      `).join("")}
      ${purchaseOrders.map((relationship) => `
        <div class="dependency-relation-row">
          <div><strong>${dependencyEscape(relationship.poOrderRef)}</strong><br><span class="dependency-muted">PO allocation #${relationship.id} · ${dependencyEscape(Object.entries(relationship.allocated || {}).filter(([, value]) => dependencyNumber(value)).map(([unit, value]) => `${value} ${unit}`).join(" + "))}</span></div>
          <span class="dependency-badge">PO link</span>
          ${canWriteDependencyManagement() ? `<div class="dependency-button-row"><button class="danger" data-action="preview-unlink-po" data-allocation-id="${relationship.id}" type="button">Preview unlink</button></div>` : '<span class="dependency-badge dependency-read-only">Read only</span>'}
        </div>
      `).join("")}
    </div>
  `;
}

function renderDependencyPreview() {
  const preview = dependencyState.preview;
  const request = dependencyState.pendingRequest;
  if (!preview && !request) return "";
  const blockers = preview?.blockers || [];
  const waitingDriver = request?.status === "waiting_driver" || preview?.routeReadiness?.pendingRequestRequired;
  const devices = request?.devices || preview?.affectedDriverDevices || [];
  const allowed = preview?.allowed === true;
  return `
    <section class="dependency-preview ${allowed ? "" : "blocked"}">
      <div><strong>${allowed ? "Preview passed" : waitingDriver ? "Driver readiness required" : "Preview blocked"}</strong>
        <div class="dependency-muted">${dependencyEscape(dependencyState.command?.action || request?.action || "")} · ${dependencyEscape(dependencyState.selectedRef)}</div>
      </div>
      ${waitingDriver ? '<p>No plan data was changed. A suspended, offline, or stale Driver PWA only receives a visible pending request.</p>' : ""}
      ${blockers.length ? `<ul class="dependency-blocker-list">${blockers.map((blocker) => `<li><strong>${dependencyEscape(blocker.code)}</strong> — ${dependencyEscape(blocker.message)}<br><code>${dependencyEscape(JSON.stringify(blocker.details || {}))}</code></li>`).join("")}</ul>` : ""}
      ${devices.length ? `<div><strong>Route-bearing devices</strong><ul class="dependency-blocker-list">${devices.map((device) => `<li>${dependencyEscape(device.driverLogin || "Driver")} · ${dependencyEscape(device.deviceId || "device")} · ${dependencyEscape(device.state || (device.visible ? "visible" : "offline"))}</li>`).join("")}</ul></div>` : ""}
      ${request ? `<div class="dependency-muted">Request ${dependencyEscape(request.requestId)} · ${dependencyEscape(request.status)} · expires ${dependencyEscape(request.expiresAt || "")}</div>` : ""}
      <div class="dependency-button-row">
        ${canWriteDependencyManagement() && allowed ? '<button class="primary" data-action="apply-preview" type="button">Apply</button>' : ""}
        ${canWriteDependencyManagement() && !allowed && preview?.routeReadiness?.pendingRequestRequired && !request ? '<button class="primary" data-action="apply-preview" type="button">Request Driver Readiness</button>' : ""}
        ${dependencyState.command ? '<button data-action="repreview" type="button">Re-preview</button>' : ""}
        ${request && canWriteDependencyManagement() ? '<button class="danger" data-action="cancel-pending-request" type="button">Cancel pending request</button>' : ""}
        <button data-action="clear-preview" type="button">Close preview</button>
      </div>
    </section>
  `;
}

function renderDependencyWorkspace() {
  if (dependencyState.loadingDetail) return '<section class="dependency-panel dependency-empty">Loading exact current order structure…</section>';
  const detail = dependencyState.detail;
  if (!detail) return '<section class="dependency-panel dependency-empty">Select a current SO, group, or split order to inspect its relationships.</section>';
  const target = detail.target || {};
  const members = target.memberRefs || [];
  const readOnly = !canWriteDependencyManagement();
  return `
    <section class="dependency-panel dependency-workspace">
      <header class="dependency-workspace-head">
        <div>
          <h2>${dependencyEscape(target.ref)}</h2>
          <div class="dependency-muted">${dependencyEscape(target.kind)} · ${dependencyEscape(target.customer || "")} · source ${dependencyEscape(target.outboundLocation || "not set")}</div>
          <div class="dependency-muted">${members.length ? `Members: ${members.map(dependencyEscape).join(", ")}` : "Single current order"}${target.planDate ? ` · plan ${dependencyEscape(target.planDate)}` : " · not currently planned"}</div>
        </div>
        <span class="dependency-badge ${readOnly ? "dependency-read-only" : ""}">${readOnly ? "Dispatcher read-only" : "SCM edit"}</span>
      </header>
      ${dependencyState.notice ? `<div class="dependency-notice ${dependencyState.noticeKind === "error" ? "error" : ""}">${dependencyEscape(dependencyState.notice)}</div>` : ""}
      ${renderDependencyPreview()}
      <section class="dependency-action-section">
        <h3>Current exact order lines</h3>
        <p class="dependency-muted">Group and split relationships stay attached to their exact source order and target line key.</p>
        ${renderTargetLineTable()}
      </section>
      <section class="dependency-action-section">
        <h3>Existing relationships</h3>
        ${renderExistingRelationships()}
      </section>
      ${readOnly ? "" : `
        <section class="dependency-action-section">
          <h3>Link or extend Transfer Order</h3>
          <div class="dependency-form-row">
            <label>Transfer Order
              <input id="dependencyToRef" list="dependencyToRefs" value="${dependencyEscape(dependencyState.toRef)}" placeholder="TOB…" />
              <datalist id="dependencyToRefs">${(dependencyState.toOptions?.transferOrders || []).map((order) => `<option value="${dependencyEscape(order.ref)}">${dependencyEscape(order.fromLocation)} → ${dependencyEscape(order.toLocation)}</option>`).join("")}</datalist>
            </label>
            <label>Execution mode
              <select id="dependencyToMode">
                <option value="yard_replenishment" ${dependencyState.toMode === "yard_replenishment" ? "selected" : ""}>Yard replenishment</option>
                <option value="direct_to_customer" ${dependencyState.toMode === "direct_to_customer" ? "selected" : ""}>Direct pickup / drop ship</option>
              </select>
            </label>
            <button data-action="load-to-options" type="button">Match current lines</button>
          </div>
          ${renderToLinkLines()}
          ${(dependencyState.toOptions?.matchingLines || []).length ? '<div class="dependency-button-row"><button class="primary" data-action="preview-link-to" type="button">Preview TO link / extension</button></div>' : ""}
        </section>
        <section class="dependency-action-section">
          <h3>Link Purchase Order pickup</h3>
          <div class="dependency-form-row">
            <label>Exact PO or split-PO ref
              <input id="dependencyPoRef" value="${dependencyEscape(dependencyState.poRef)}" placeholder="POB… or SN…" />
            </label>
            <span class="dependency-muted">Only active, item-matching PO lines are offered.</span>
            <button data-action="load-po-options" type="button">Find current PO lines</button>
          </div>
          ${renderPoLinkLines()}
          ${dependencyState.poRef ? '<div class="dependency-button-row"><button class="primary" data-action="preview-link-po" type="button">Preview PO link</button></div>' : ""}
        </section>
      `}
    </section>
  `;
}

function renderDependencyManagement() {
  const operator = dependencyOperator || {};
  dependencyApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>MBBS Transportation</p><h1>SCM Dependency Manager</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${dependencyEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/scm'" type="button">SCM Menu</button>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    <div class="dependency-management-main">
      <aside class="dependency-panel dependency-target-panel">
        <div class="dependency-target-search">
          <label for="dependencyTargetSearch"><strong>Current order pool</strong></label>
          <input id="dependencyTargetSearch" value="${dependencyEscape(dependencyState.search)}" placeholder="SO, group, split, customer…" autocomplete="off" />
          <span class="dependency-muted">Indexed current ledgers; saved plan snapshots are not scanned.</span>
        </div>
        <div class="dependency-target-list">${renderDependencyTargets()}</div>
        ${dependencyState.nextCursor ? '<button class="dependency-load-more" data-action="load-more-targets" type="button">Load more</button>' : ""}
      </aside>
      ${renderDependencyWorkspace()}
    </div>
  `;
}

async function loadDependencyTargets({ reset = true } = {}) {
  if (dependencySearchAbortController) dependencySearchAbortController.abort();
  dependencySearchAbortController = new AbortController();
  dependencyState.loadingTargets = true;
  if (reset) {
    dependencyState.targets = [];
    dependencyState.nextCursor = "";
  }
  renderDependencyManagement();
  const params = new URLSearchParams({ search: dependencyState.search, limit: "50" });
  if (!reset && dependencyState.nextCursor) params.set("cursor", dependencyState.nextCursor);
  try {
    const payload = await dependencyFetchJson(`/api/scm/dependency-management/targets?${params}`, {
      signal: dependencySearchAbortController.signal,
      headers: { "Cache-Control": "no-cache" }
    });
    dependencyState.targets = reset ? payload.targets || [] : [...dependencyState.targets, ...(payload.targets || [])];
    dependencyState.nextCursor = payload.nextCursor || "";
  } catch (error) {
    if (error.name !== "AbortError") {
      dependencyState.notice = dependencyErrorMessage(error);
      dependencyState.noticeKind = "error";
    }
  } finally {
    dependencyState.loadingTargets = false;
    renderDependencyManagement();
  }
}

async function loadDependencyTarget(targetRef) {
  dependencyState.selectedRef = String(targetRef || "");
  dependencyState.loadingDetail = true;
  dependencyState.detail = null;
  dependencyState.preview = null;
  dependencyState.command = null;
  dependencyState.pendingRequest = null;
  dependencyState.notice = "";
  dependencyState.toRef = "";
  dependencyState.poRef = "";
  dependencyState.toQuantities = {};
  dependencyState.poSelections = {};
  dependencyState.poQuantities = {};
  renderDependencyManagement();
  try {
    const detail = await dependencyFetchJson(`/api/scm/dependency-management/targets/${encodeURIComponent(dependencyState.selectedRef)}`);
    dependencyState.detail = detail;
    const planDate = detail.target?.planDate || "";
    const params = new URLSearchParams({ planDate });
    const [toOptions, poOptions] = await Promise.all([
      dependencyFetchJson(`/api/scm/dependency-management/targets/${encodeURIComponent(dependencyState.selectedRef)}/to-options?${params}`),
      dependencyFetchJson(`/api/scm/dependency-management/targets/${encodeURIComponent(dependencyState.selectedRef)}/po-options?${params}`)
    ]);
    dependencyState.toOptions = toOptions;
    dependencyState.poOptions = poOptions;
  } catch (error) {
    dependencyState.notice = dependencyErrorMessage(error);
    dependencyState.noticeKind = "error";
  } finally {
    dependencyState.loadingDetail = false;
    renderDependencyManagement();
  }
}

async function loadDependencyToOptions() {
  const planDate = dependencyState.detail?.target?.planDate || "";
  const params = new URLSearchParams({
    planDate,
    transferOrderRef: dependencyState.toRef.trim()
  });
  dependencyState.toOptions = await dependencyFetchJson(
    `/api/scm/dependency-management/targets/${encodeURIComponent(dependencyState.selectedRef)}/to-options?${params}`
  );
  dependencyState.toQuantities = {};
}

async function loadDependencyPoOptions() {
  const params = new URLSearchParams({ planDate: dependencyState.detail?.target?.planDate || "" });
  dependencyState.poOptions = await dependencyFetchJson(
    `/api/scm/dependency-management/targets/${encodeURIComponent(dependencyState.selectedRef)}/po-options?${params}`
  );
}

function dependencyCommand(action, payload = {}) {
  return {
    requestId: newDependencyManagementRequestId(),
    action,
    targetRef: dependencyState.detail?.target?.ref || dependencyState.selectedRef,
    targetSignature: dependencyState.detail?.signature || "",
    planId: dependencyState.detail?.target?.planId || null,
    planDate: dependencyState.detail?.target?.planDate || "",
    expectedPlanRevision: null,
    expectedPlanDigest: "",
    payload
  };
}

function collectToAllocations() {
  return (dependencyState.toOptions?.matchingLines || []).map((line) => ({
    targetLineKey: line.targetLineKey,
    quantities: { ...(dependencyState.toQuantities[line.targetLineKey] || {}) }
  })).filter((line) => Object.values(line.quantities).some((value) => dependencyNumber(value) > 0));
}

function collectPoAllocations() {
  return (dependencyState.poOptions?.salesLines || []).map((line) => ({
    salesLineId: line.id,
    targetLineKey: line.targetLineKey,
    poLineId: dependencyState.poSelections[line.targetLineKey] || "",
    quantities: { ...(dependencyState.poQuantities[line.targetLineKey] || {}) }
  })).filter((line) => line.poLineId && Object.values(line.quantities).some((value) => dependencyNumber(value) > 0));
}

async function previewDependencyCommand(command, { reuse = false } = {}) {
  if (!canWriteDependencyManagement()) throw new Error("Dispatcher access is read-only.");
  dependencyState.busy = true;
  dependencyState.notice = reuse ? "Refreshing blocker and Driver readiness evidence…" : "Building atomic change preview…";
  dependencyState.noticeKind = "";
  renderDependencyManagement();
  try {
    const preview = await dependencyFetchJson("/api/scm/dependency-management/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command)
    });
    if (preview.affectedPlan) {
      command.planId = preview.affectedPlan.id || command.planId;
      command.planDate = preview.affectedPlan.planDate || command.planDate;
      command.expectedPlanRevision = preview.affectedPlan.revision ?? null;
      command.expectedPlanDigest = preview.affectedPlan.digest || "";
    }
    command.payloadHash = await dependencyPayloadHash(command);
    dependencyState.command = command;
    dependencyState.preview = preview;
    dependencyState.notice = preview.allowed
      ? "Preview passed. Review the exact change, then click Apply."
      : preview.routeReadiness?.pendingRequestRequired
        ? "Driver readiness is required. Requesting readiness does not change the plan."
        : "Preview is blocked. No data was changed.";
  } finally {
    dependencyState.busy = false;
    renderDependencyManagement();
  }
}

async function refreshPendingDependencyRequest() {
  if (!dependencyState.command?.requestId) return null;
  try {
    dependencyState.pendingRequest = await dependencyFetchJson(
      `/api/scm/dependency-management/requests/${encodeURIComponent(dependencyState.command.requestId)}`
    );
  } catch (error) {
    if (error.status !== 404) throw error;
    dependencyState.pendingRequest = null;
  }
  return dependencyState.pendingRequest;
}

async function applyDependencyPreview() {
  if (!canWriteDependencyManagement()) throw new Error("Dispatcher access is read-only.");
  if (!dependencyState.command || !dependencyState.preview) throw new Error("Preview the relationship change first.");
  dependencyState.busy = true;
  dependencyState.notice = dependencyState.preview.allowed
    ? "Applying relationship, plan, Operator state, and Driver route fence atomically…"
    : "Creating a pending Driver readiness request. No plan data is changing…";
  dependencyState.noticeKind = "";
  renderDependencyManagement();
  try {
    const result = await dependencyFetchJson("/api/scm/dependency-management/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dependencyState.command)
    });
    if (result.pending || result.status === "waiting_driver") {
      await refreshPendingDependencyRequest();
      dependencyState.notice = "Driver readiness request created. No plan data was changed. After every route-bearing device is ready, click Re-preview and then Apply.";
      return;
    }
    dependencyState.preview = null;
    dependencyState.command = null;
    dependencyState.pendingRequest = null;
    await loadDependencyTarget(dependencyState.selectedRef);
    dependencyState.notice = "Dependency change applied atomically. Dispatch, Operator, and Driver route fencing now share the saved revision.";
    dependencyState.noticeKind = "success";
  } finally {
    dependencyState.busy = false;
    renderDependencyManagement();
  }
}

async function cancelPendingDependencyRequest() {
  const requestId = dependencyState.pendingRequest?.requestId;
  if (!requestId) return;
  await dependencyFetchJson(`/api/scm/dependency-management/requests/${encodeURIComponent(requestId)}`, {
    method: "DELETE"
  });
  dependencyState.pendingRequest = null;
  dependencyState.preview = null;
  dependencyState.command = null;
  dependencyState.notice = "Pending route change cancelled. No plan data was changed.";
}

dependencyApp.addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "dependencyTargetSearch") {
    dependencyState.search = target.value;
    window.clearTimeout(dependencySearchTimer);
    dependencySearchTimer = window.setTimeout(() => loadDependencyTargets({ reset: true }), 225);
    return;
  }
  if (target.id === "dependencyToRef") dependencyState.toRef = target.value;
  if (target.id === "dependencyPoRef") dependencyState.poRef = target.value;
  if (target.id === "dependencyToMode") dependencyState.toMode = target.value;
  if (target.dataset.toQuantity) {
    const key = target.dataset.targetLineKey;
    dependencyState.toQuantities[key] ||= {};
    dependencyState.toQuantities[key][target.dataset.toQuantity] = target.value;
  }
  if (target.dataset.poQuantity) {
    const key = target.dataset.targetLineKey;
    dependencyState.poQuantities[key] ||= {};
    dependencyState.poQuantities[key][target.dataset.poQuantity] = target.value;
  }
  if (target.dataset.poSelection) dependencyState.poSelections[target.dataset.poSelection] = target.value;
});

dependencyApp.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "dependencyToMode") dependencyState.toMode = target.value;
  if (target.dataset.poSelection) dependencyState.poSelections[target.dataset.poSelection] = target.value;
});

dependencyApp.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || dependencyState.busy) return;
  const action = button.dataset.action;
  try {
    if (action === "select-target") await loadDependencyTarget(button.dataset.targetRef);
    if (action === "load-more-targets") await loadDependencyTargets({ reset: false });
    if (action === "load-to-options") {
      if (!dependencyState.toRef.trim()) throw new Error("Enter a Transfer Order ref first.");
      await loadDependencyToOptions();
      renderDependencyManagement();
    }
    if (action === "load-po-options") {
      if (!dependencyState.poRef.trim()) throw new Error("Enter an exact PO or split-PO ref first.");
      await loadDependencyPoOptions();
      renderDependencyManagement();
    }
    if (action === "preview-link-to") {
      const allocations = collectToAllocations();
      if (!allocations.length) throw new Error("Enter at least one TO allocation quantity.");
      await previewDependencyCommand(dependencyCommand("link_to", {
        transferOrderRef: dependencyState.toRef.trim(),
        mode: dependencyState.toMode,
        allocations
      }));
    }
    if (action === "preview-link-po") {
      const lines = collectPoAllocations();
      if (!lines.length) throw new Error("Select exact PO lines and enter at least one allocation quantity.");
      await previewDependencyCommand(dependencyCommand("link_po", {
        poRef: dependencyState.poRef.trim(),
        lines
      }));
    }
    if (action === "preview-mode") {
      const dependencyId = Number(button.dataset.dependencyId);
      const mode = dependencyApp.querySelector(`[data-existing-mode="${dependencyId}"]`)?.value;
      await previewDependencyCommand(dependencyCommand("change_mode", { dependencyId, mode }));
    }
    if (action === "preview-unlink-to") {
      await previewDependencyCommand(dependencyCommand("unlink_to", {
        dependencyId: Number(button.dataset.dependencyId)
      }));
    }
    if (action === "preview-unlink-po") {
      await previewDependencyCommand(dependencyCommand("unlink_po", {
        allocationId: Number(button.dataset.allocationId)
      }));
    }
    if (action === "apply-preview") await applyDependencyPreview();
    if (action === "repreview") {
      await refreshPendingDependencyRequest();
      await previewDependencyCommand(dependencyState.command, { reuse: true });
    }
    if (action === "cancel-pending-request") {
      if (window.confirm("Cancel this pending Driver route change request?")) {
        await cancelPendingDependencyRequest();
        renderDependencyManagement();
      }
    }
    if (action === "clear-preview") {
      dependencyState.preview = null;
      dependencyState.command = null;
      dependencyState.pendingRequest = null;
      renderDependencyManagement();
    }
  } catch (error) {
    dependencyState.busy = false;
    dependencyState.notice = dependencyErrorMessage(error);
    dependencyState.noticeKind = "error";
    renderDependencyManagement();
  }
});

window.addEventListener("mbbs-language-changed", renderDependencyManagement);

requireDispatchLogin({
  mount: dependencyApp,
  roles: ["admin", "scm", "scm_staff", "dispatcher"],
  onReady(operator) {
    dependencyOperator = operator;
    renderDependencyManagement();
    loadDependencyTargets({ reset: true });
  }
});
