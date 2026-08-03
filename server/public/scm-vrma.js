const scmVrmaApp = document.getElementById("scmVrmaApp");
let scmVrmaOperator = null;
let scmVrmaRows = [];
let scmVrmaNotice = "";
let scmVrmaOptions = { ownYards: [], localVendors: [] };
let scmVrmaNextLineId = 1;
let scmVrmaEditingRef = "";
let scmVrmaSearch = "";
let scmVrmaBusy = false;
const scmVrmaSearchTimers = new Map();
const SCM_VRMA_MANUAL_STATUSES = ["Queued", "Urgent", "Hold", "Priority", "Surplus Only", "Book Appt"];

function newVrmaLine() {
  return {
    key: `vrma-line-${scmVrmaNextLineId++}`,
    item: null,
    itemQuery: "",
    suggestions: [],
    quantity: "",
    unit: "PLT",
    palletQty: "",
    layerQty: "",
    sectionQty: "",
    pieceQty: ""
  };
}

function newVrmaDraft() {
  return {
    vrmaRef: "",
    localVendor: "",
    pickupLocation: scmVrmaOptions.ownYards[0]?.code || "3445",
    dropoffLocation: "",
    status: "Queued",
    notes: "",
    concurrencyUpdatedAt: "",
    lines: [newVrmaLine()]
  };
}

let scmVrmaDraft = newVrmaDraft();

function vrmaEscape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function vrmaEditableNumber(value) {
  const quantity = Number(value || 0);
  return quantity > 0 ? quantity : "";
}

function vrmaNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(number, 0) : 0;
}

function vrmaWeightLabel(value) {
  return `${vrmaNumber(value).toLocaleString("en-CA", { maximumFractionDigits: 2 })} lb`;
}

function vrmaLineSalesQuantity(line = {}) {
  if (!line.item) return 0;
  const converted = (vrmaNumber(line.palletQty) * vrmaNumber(line.item.toPlt))
    + (vrmaNumber(line.layerQty) * vrmaNumber(line.item.toLyr))
    + (vrmaNumber(line.sectionQty) * vrmaNumber(line.item.toSec))
    + (vrmaNumber(line.pieceQty) * vrmaNumber(line.item.toPcs));
  return converted > 0 ? converted : vrmaNumber(line.quantity);
}

function vrmaLineWeight(line = {}) {
  return vrmaLineSalesQuantity(line) * vrmaNumber(line.item?.itemWeight);
}

function vrmaLineWeightText(line = {}) {
  return `Estimated line weight: ${vrmaWeightLabel(vrmaLineWeight(line))}`;
}

function vrmaLineFromOrder(line = {}) {
  const item = {
    itemId: line.itemId,
    sku: line.sku || "",
    itemName: line.itemName || line.sku || "",
    description: line.description || "",
    stockUnit: line.stockUnit || line.unit || "",
    itemWeight: Number(line.itemWeight || 0),
    toPlt: Number(line.toPlt || 0),
    toLyr: Number(line.toLyr || 0),
    toSec: Number(line.toSec || 0),
    toPcs: Number(line.toPcs || 0)
  };
  return {
    key: `vrma-line-${scmVrmaNextLineId++}`,
    item,
    itemQuery: `${item.sku} — ${item.itemName}`,
    suggestions: [],
    quantity: vrmaEditableNumber(line.quantity),
    unit: line.unit || "PLT",
    palletQty: vrmaEditableNumber(line.palletQty),
    layerQty: vrmaEditableNumber(line.layerQty),
    sectionQty: vrmaEditableNumber(line.sectionQty),
    pieceQty: vrmaEditableNumber(line.pieceQty)
  };
}

function vrmaDraftFromOrder(order = {}) {
  return {
    vrmaRef: order.vrmaRef || "",
    localVendor: order.localVendor || order.vendor || "",
    pickupLocation: order.pickupLocation || scmVrmaOptions.ownYards[0]?.code || "3445",
    dropoffLocation: order.dropoffLocation || "",
    status: SCM_VRMA_MANUAL_STATUSES.includes(order.status) ? order.status : "Queued",
    notes: order.notes || "",
    concurrencyUpdatedAt: order.concurrencyUpdatedAt || order.scheduleUpdatedAt || order.updatedAt || "",
    lines: Array.isArray(order.lines) && order.lines.length ? order.lines.map(vrmaLineFromOrder) : [newVrmaLine()]
  };
}

function activeVrmaRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    String(row.status || "").trim().toLowerCase() !== "cancelled");
}

function clearVrmaSearchTimers() {
  for (const timer of scmVrmaSearchTimers.values()) clearTimeout(timer);
  scmVrmaSearchTimers.clear();
}

function setVrmaBusy(message = "") {
  scmVrmaBusy = Boolean(message);
  const current = scmVrmaApp.querySelector(".vrma-busy-overlay");
  if (!scmVrmaBusy) {
    current?.remove();
    return;
  }
  if (current) {
    const label = current.querySelector("[data-busy-label]");
    if (label) label.textContent = message;
    return;
  }
  scmVrmaApp.insertAdjacentHTML("beforeend", `
    <div class="vrma-busy-overlay" aria-live="polite" aria-busy="true">
      <div class="vrma-busy-card">
        <span class="vrma-spinner" aria-hidden="true"></span>
        <strong data-busy-label>${vrmaEscape(message)}</strong>
        <small>The VRMA page will stay open while this finishes.</small>
      </div>
    </div>
  `);
}

async function vrmaApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || payload?.message || response.statusText;
    throw new Error(String(message || `Request failed (${response.status})`));
  }
  return payload;
}

async function loadVrma() {
  try {
    const [rows, options] = await Promise.all([
      vrmaApi("/api/scm/schedule?kind=VRMA"),
      vrmaApi("/api/scm/vrma-options")
    ]);
    scmVrmaRows = activeVrmaRows(rows);
    scmVrmaOptions = options;
    if (!scmVrmaOptions.ownYards.some((yard) => yard.code === scmVrmaDraft.pickupLocation)) {
      scmVrmaDraft.pickupLocation = scmVrmaOptions.ownYards[0]?.code || "3445";
    }
  } catch (error) {
    scmVrmaNotice = `VRMA data failed: ${error.message}`;
  }
  renderVrma();
}

async function openVrmaEditor(orderRef) {
  const ref = String(orderRef || "").trim();
  if (!ref || scmVrmaBusy) return;
  setVrmaBusy(`Opening ${ref}…`);
  try {
    const order = await vrmaApi(`/api/scm/vrma-orders/${encodeURIComponent(ref)}`);
    clearVrmaSearchTimers();
    scmVrmaEditingRef = order.vrmaRef;
    scmVrmaDraft = vrmaDraftFromOrder(order);
    scmVrmaNotice = `Editing ${order.vrmaRef}. Save will update this order.`;
  } catch (error) {
    scmVrmaNotice = `Could not open ${ref}: ${error.message}`;
  } finally {
    scmVrmaBusy = false;
    renderVrma();
    scmVrmaApp.querySelector('[data-field="localVendor"]')?.focus({ preventScroll: true });
  }
}

function startNewVrma() {
  if (scmVrmaBusy) return;
  clearVrmaSearchTimers();
  scmVrmaEditingRef = "";
  scmVrmaDraft = newVrmaDraft();
  scmVrmaNotice = "";
  renderVrma();
  scmVrmaApp.querySelector('[data-field="vrmaRef"]')?.focus({ preventScroll: true });
}

function selectedVrmaVendor() {
  return scmVrmaOptions.localVendors.find((vendor) => vendor.name === scmVrmaDraft.localVendor) || null;
}

function conversionInputs(item) {
  return [
    { factorKey: "toPlt", field: "palletQty", unit: "PLT" },
    { factorKey: "toLyr", field: "layerQty", unit: "LYR" },
    { factorKey: "toSec", field: "sectionQty", unit: "SEC" },
    { factorKey: "toPcs", field: "pieceQty", unit: "PCS" }
  ].filter((entry) => Number(item?.[entry.factorKey] || 0) > 0);
}

function renderVrmaQuantityInputs(line) {
  if (!line.item) return `<p class="vrma-line-hint">Select an item to enter its dispatch reference quantity.</p>`;
  const inputs = conversionInputs(line.item);
  if (!inputs.length) {
    return `
      <div class="vrma-quantity-fields">
        <label class="vrma-quantity-field"><span>Quantity</span><input data-line-field="quantity" type="number" min="0" step="0.01" value="${vrmaEscape(line.quantity)}" placeholder="0" /></label>
        <label class="vrma-quantity-field"><span>UOM</span><select data-line-field="unit">${["PLT", "SQFT", "PC"].map((unit) => `<option value="${unit}" ${line.unit === unit ? "selected" : ""}>${unit}</option>`).join("")}</select></label>
      </div>
      <p class="vrma-line-hint">No item conversion is configured; this quantity is dispatch and driver reference only.</p>
    `;
  }
  return `
    <div class="vrma-quantity-fields">
      ${inputs.map((entry) => `
        <label class="vrma-quantity-field">
          <span>${entry.unit}</span>
          <input data-line-field="${entry.field}" type="number" min="0" step="0.01" value="${vrmaEscape(line[entry.field])}" placeholder="0" />
          <small>1 ${entry.unit} = ${vrmaEscape(line.item[entry.factorKey])} ${vrmaEscape(line.item.stockUnit || "stock unit")}</small>
        </label>
      `).join("")}
    </div>
  `;
}

function renderVrmaLine(line, index) {
  const selectedLabel = line.item ? `${line.item.sku} — ${line.item.itemName}` : "";
  return `
    <article class="vrma-line" data-line-key="${vrmaEscape(line.key)}">
      <div class="vrma-line-top">
        <strong>Item ${index + 1}</strong>
        ${scmVrmaDraft.lines.length > 1 ? `<button class="vrma-remove-line" data-action="remove-line" data-line-key="${vrmaEscape(line.key)}" type="button">Remove</button>` : ""}
      </div>
      <label class="vrma-item-picker">
        <span>Item</span>
        <input data-line-field="itemQuery" autocomplete="off" value="${vrmaEscape(line.itemQuery || selectedLabel)}" placeholder="Search item ID, name, or description" />
        ${line.suggestions.length ? `
          <div class="vrma-item-suggestions" role="listbox">
            ${line.suggestions.map((item) => `
              <button data-action="select-item" data-line-key="${vrmaEscape(line.key)}" data-item-id="${vrmaEscape(item.itemId)}" type="button">
                <strong>${vrmaEscape(item.sku)} · ${vrmaEscape(item.itemName)}</strong>
                <span>${vrmaEscape(item.description || "No description")}</span>
                <small>Unit weight: ${vrmaEscape(vrmaWeightLabel(item.itemWeight))} / ${vrmaEscape(item.stockUnit || "stock unit")}</small>
              </button>
            `).join("")}
          </div>
        ` : ""}
      </label>
      ${line.item ? `
        <div class="vrma-line-meta">
          <strong>${vrmaEscape(line.item.sku)}</strong>
          <span>${vrmaEscape(line.item.description || line.item.itemName)}</span>
          <small>Stock UOM: ${vrmaEscape(line.item.stockUnit || "--")} · Unit weight: ${vrmaEscape(vrmaWeightLabel(line.item.itemWeight))}</small>
        </div>
      ` : ""}
      ${renderVrmaQuantityInputs(line)}
      ${line.item ? `<div class="vrma-line-weight" data-vrma-line-weight>${vrmaEscape(vrmaLineWeightText(line))}</div>` : ""}
    </article>
  `;
}

function renderVrmaLines() {
  return scmVrmaDraft.lines.map(renderVrmaLine).join("");
}

function updateVrmaLineWeightDisplay(line) {
  const card = scmVrmaApp.querySelector(`[data-line-key="${CSS.escape(String(line?.key || ""))}"]`);
  const weight = card?.querySelector("[data-vrma-line-weight]");
  if (weight) weight.textContent = vrmaLineWeightText(line);
}

function renderVrmaLineRegion(focusKey = "") {
  const container = scmVrmaApp.querySelector(".vrma-lines");
  if (!container) return;
  container.innerHTML = renderVrmaLines();
  if (focusKey) {
    const input = container.querySelector(`[data-line-key="${CSS.escape(focusKey)}"] [data-line-field="itemQuery"]`);
    if (input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

function renderVrmaList() {
  const search = scmVrmaSearch.trim().toLowerCase();
  const rows = search
    ? scmVrmaRows.filter((row) => [
      row.displayRef, row.orderRef, row.status, row.party, row.brand,
      row.pickupPoint, row.dropoffPoint, row.content
    ].some((value) => String(value || "").toLowerCase().includes(search)))
    : scmVrmaRows;
  return rows.map((row) => {
    const ref = row.displayRef || row.orderRef;
    const active = scmVrmaEditingRef && String(row.orderRef || "").toLowerCase() === scmVrmaEditingRef.toLowerCase();
    return `
      <button class="scm-schedule-row vrma-order-row ${active ? "active" : ""}" data-action="edit-vrma" data-order-ref="${vrmaEscape(row.orderRef)}" type="button" aria-pressed="${active ? "true" : "false"}">
        <strong>${vrmaEscape(ref)}</strong>
        <span>Local VRMA · ${vrmaEscape(row.status)}</span>
        <small>${vrmaEscape(row.pickupPoint || "--")} → ${vrmaEscape(row.dropoffPoint || "--")}</small>
        <small>${vrmaEscape(row.content || "")}</small>
        <span class="vrma-order-edit-label">${active ? "Editing now" : "Open to edit"}</span>
      </button>
    `;
  }).join("") || `<div class="empty-state">${search ? "No VRMA orders match this search." : "No VRMA orders yet."}</div>`;
}

function renderVrmaListRegion() {
  const container = scmVrmaApp.querySelector(".vrma-order-list-results");
  if (container) container.innerHTML = renderVrmaList();
}

function renderVrma() {
  scmVrmaBusy = false;
  const operator = scmVrmaOperator || {};
  const vendor = selectedVrmaVendor();
  const vendorYards = vendor?.yards || [];
  scmVrmaApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>SCM</p><h1>VRMA</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${vrmaEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/scm'" type="button">SCM Menu</button>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    ${scmVrmaNotice ? `<div class="route-notice scm-notice">${vrmaEscape(scmVrmaNotice)}</div>` : ""}
    <section class="scm-vrma-grid">
      <section class="scm-vrma-form">
        <div class="scm-detail-header">
          <div><p>Local Vendor Return</p><h2>${scmVrmaEditingRef ? `Edit ${vrmaEscape(scmVrmaEditingRef)}` : "Create VRMA"}</h2></div>
          <div class="vrma-form-actions">
            ${scmVrmaEditingRef ? `<button class="secondary" data-action="new-vrma" type="button">New VRMA</button>` : ""}
            ${scmVrmaEditingRef ? `<button class="danger" data-action="delete-vrma" type="button">Delete VRMA</button>` : ""}
            <button data-action="save-vrma" type="button">${scmVrmaEditingRef ? "Update VRMA" : "Save VRMA"}</button>
          </div>
        </div>
        <div class="vrma-route-note">
          <strong>Local route only</strong>
          <span>Pickup is one of our yards and drop-off is a yard belonging to the selected local vendor. Items are dispatch/driver reference only and do not deduct inventory.</span>
        </div>
        ${scmVrmaEditingRef ? `<div class="vrma-editing-note"><strong>Editing saved order ${vrmaEscape(scmVrmaEditingRef)}</strong><span>Update the route, status, notes, items, or quantities below, then select Update VRMA.</span></div>` : ""}
        <div class="scm-schedule-form">
          <label><span>VRMA Ref</span><input data-field="vrmaRef" value="${vrmaEscape(scmVrmaDraft.vrmaRef)}" placeholder="VRMA-0001" ${scmVrmaEditingRef ? "readonly aria-readonly='true'" : ""} /></label>
          <label><span>Local Vendor</span><select data-field="localVendor">
            <option value="">Select local vendor</option>
            ${scmVrmaOptions.localVendors.map((item) => `<option value="${vrmaEscape(item.name)}" ${scmVrmaDraft.localVendor === item.name ? "selected" : ""}>${vrmaEscape(item.name)}</option>`).join("")}
          </select></label>
          <label><span>Pickup (Our Yard)</span><select data-field="pickupLocation">
            ${scmVrmaOptions.ownYards.map((yard) => `<option value="${vrmaEscape(yard.code)}" ${scmVrmaDraft.pickupLocation === yard.code ? "selected" : ""}>${vrmaEscape(yard.code)} · ${vrmaEscape(yard.label || yard.address || "Local Yard")}</option>`).join("")}
          </select></label>
          <label><span>Drop Off (Vendor Yard)</span><select data-field="dropoffLocation" ${vendor ? "" : "disabled"}>
            <option value="">${vendor ? "Select vendor yard" : "Select local vendor first"}</option>
            ${vendorYards.map((yard) => `<option value="${vrmaEscape(yard.name)}" ${scmVrmaDraft.dropoffLocation === yard.name ? "selected" : ""}>${vrmaEscape(yard.name)}${yard.address ? ` · ${vrmaEscape(yard.address)}` : ""}</option>`).join("")}
          </select></label>
          <label><span>Method</span><input value="MBT · Local Dispatch" disabled /></label>
          <label><span>Status</span><select data-field="status">${SCM_VRMA_MANUAL_STATUSES.map((item) => `<option value="${item}" ${scmVrmaDraft.status === item ? "selected" : ""}>${item}</option>`).join("")}</select></label>
          <label class="wide"><span>Notes</span><textarea data-field="notes">${vrmaEscape(scmVrmaDraft.notes)}</textarea></label>
        </div>
        <div class="vrma-lines-head">
          <div><strong>Items</strong><small>Autocomplete uses the local inventory item master.</small></div>
          <button data-action="add-line" type="button">+ Line</button>
        </div>
        <div class="vrma-lines">${renderVrmaLines()}</div>
      </section>
      <aside class="scm-vrma-list">
        <h2>Current VRMA</h2>
        <p class="vrma-list-hint">Select an order below to reopen and edit it.</p>
        <label class="vrma-order-search">
          <span>Search VRMA orders</span>
          <input data-vrma-search type="search" value="${vrmaEscape(scmVrmaSearch)}" placeholder="Ref, vendor, yard, status, or item" autocomplete="off" />
        </label>
        <div class="vrma-order-list-results">${renderVrmaList()}</div>
      </aside>
    </section>
  `;
}

function lineByKey(key) {
  return scmVrmaDraft.lines.find((line) => line.key === key) || null;
}

function collectVrmaPayload() {
  return {
    vrmaRef: scmVrmaDraft.vrmaRef,
    vendor: scmVrmaDraft.localVendor,
    localVendor: scmVrmaDraft.localVendor,
    pickupLocation: scmVrmaDraft.pickupLocation,
    dropoffLocation: scmVrmaDraft.dropoffLocation,
    method: "MBT",
    status: scmVrmaDraft.status,
    notes: scmVrmaDraft.notes,
    lines: scmVrmaDraft.lines.filter((line) => line.item).map((line) => ({
      itemId: line.item.itemId,
      quantity: line.quantity,
      unit: line.unit,
      palletQty: line.palletQty,
      layerQty: line.layerQty,
      sectionQty: line.sectionQty,
      pieceQty: line.pieceQty
    })),
    audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
  };
}

function queueVrmaItemSearch(line) {
  clearTimeout(scmVrmaSearchTimers.get(line.key));
  const query = line.itemQuery.trim();
  if (query.length < 2) {
    line.suggestions = [];
    renderVrmaLineRegion(line.key);
    return;
  }
  const timer = setTimeout(async () => {
    try {
      const results = await vrmaApi(`/api/scm/vrma-items?search=${encodeURIComponent(query)}&limit=20`);
      if (!scmVrmaDraft.lines.includes(line) || line.itemQuery.trim() !== query) return;
      line.suggestions = results;
      renderVrmaLineRegion(line.key);
    } catch (error) {
      scmVrmaNotice = `Item search failed: ${error.message}`;
      renderVrma();
    }
  }, 250);
  scmVrmaSearchTimers.set(line.key, timer);
}

scmVrmaApp.addEventListener("input", (event) => {
  const orderSearch = event.target.closest("[data-vrma-search]");
  if (orderSearch) {
    scmVrmaSearch = orderSearch.value;
    renderVrmaListRegion();
    return;
  }
  const field = event.target.closest("[data-field]");
  if (field) {
    scmVrmaDraft[field.dataset.field] = field.value;
    return;
  }
  const lineField = event.target.closest("[data-line-field]");
  if (!lineField) return;
  const line = lineByKey(lineField.closest("[data-line-key]")?.dataset.lineKey);
  if (!line) return;
  const name = lineField.dataset.lineField;
  line[name] = lineField.value;
  if (name === "itemQuery") {
    const selectedLabel = line.item ? `${line.item.sku} — ${line.item.itemName}` : "";
    if (line.item && line.itemQuery !== selectedLabel) line.item = null;
    queueVrmaItemSearch(line);
    return;
  }
  updateVrmaLineWeightDisplay(line);
});

scmVrmaApp.addEventListener("change", (event) => {
  const field = event.target.closest("[data-field]");
  if (field) {
    scmVrmaDraft[field.dataset.field] = field.value;
    if (field.dataset.field === "localVendor") {
      scmVrmaDraft.dropoffLocation = "";
      renderVrma();
    }
    return;
  }
  const lineField = event.target.closest("[data-line-field]");
  if (!lineField) return;
  const line = lineByKey(lineField.closest("[data-line-key]")?.dataset.lineKey);
  if (line) {
    line[lineField.dataset.lineField] = lineField.value;
    updateVrmaLineWeightDisplay(line);
  }
});

scmVrmaApp.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "edit-vrma") {
    await openVrmaEditor(target.dataset.orderRef);
    return;
  }
  if (target.dataset.action === "new-vrma") {
    startNewVrma();
    return;
  }
  if (scmVrmaBusy) return;
  if (target.dataset.action === "delete-vrma" && scmVrmaEditingRef) {
    const ref = scmVrmaEditingRef;
    const note = window.prompt(
      `Why should ${ref} be deleted?\n\nThe record and audit history will be retained, but it will be cancelled and removed from active VRMA lists.`
    );
    if (note === null) return;
    if (!String(note).trim()) {
      scmVrmaNotice = "Delete failed: enter an audit note explaining why this VRMA should be removed.";
      renderVrma();
      return;
    }
    if (!window.confirm(`Delete ${ref} from active VRMA?\n\nThis cannot proceed if Dispatch planning, packing, or loading has started.`)) return;
    setVrmaBusy(`Deleting ${ref}…`);
    try {
      const result = await vrmaApi(`/api/scm/vrma-orders/${encodeURIComponent(ref)}`, {
        method: "DELETE",
        body: JSON.stringify({
          confirm: true,
          note: String(note).trim(),
          expectedUpdatedAt: scmVrmaDraft.concurrencyUpdatedAt,
          audit: { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" }
        })
      });
      if (Array.isArray(result.schedule)) {
        scmVrmaRows = activeVrmaRows(result.schedule.filter((row) => row.orderKind === "VRMA"));
      } else {
        scmVrmaRows = scmVrmaRows.filter((row) =>
          String(row.orderRef || "").trim().toLowerCase() !== ref.toLowerCase());
      }
      clearVrmaSearchTimers();
      scmVrmaEditingRef = "";
      scmVrmaDraft = newVrmaDraft();
      scmVrmaNotice = `Deleted ${ref} from active VRMA. Its audit and Operator history were retained.`;
    } catch (error) {
      scmVrmaNotice = `Delete failed: ${error.message}`;
    } finally {
      scmVrmaBusy = false;
      renderVrma();
    }
    return;
  }
  if (target.dataset.action === "add-line") {
    scmVrmaDraft.lines.push(newVrmaLine());
    renderVrmaLineRegion();
    return;
  }
  if (target.dataset.action === "remove-line") {
    scmVrmaDraft.lines = scmVrmaDraft.lines.filter((line) => line.key !== target.dataset.lineKey);
    renderVrmaLineRegion();
    return;
  }
  if (target.dataset.action === "select-item") {
    const line = lineByKey(target.dataset.lineKey);
    const item = line?.suggestions.find((candidate) => String(candidate.itemId) === target.dataset.itemId);
    if (!line || !item) return;
    line.item = item;
    line.itemQuery = `${item.sku} — ${item.itemName}`;
    line.suggestions = [];
    line.quantity = "";
    line.unit = "PLT";
    line.palletQty = "";
    line.layerQty = "";
    line.sectionQty = "";
    line.pieceQty = "";
    renderVrmaLineRegion();
    return;
  }
  if (target.dataset.action === "save-vrma") {
    const wasEditing = Boolean(scmVrmaEditingRef);
    const payload = collectVrmaPayload();
    const endpoint = wasEditing
      ? `/api/scm/vrma-orders/${encodeURIComponent(scmVrmaEditingRef)}`
      : "/api/scm/vrma-orders";
    target.disabled = true;
    setVrmaBusy(wasEditing ? `Updating ${scmVrmaEditingRef}…` : `Saving ${payload.vrmaRef || "VRMA"}…`);
    try {
      const result = await vrmaApi(endpoint, {
        method: wasEditing ? "PUT" : "POST",
        body: JSON.stringify(payload)
      });
      if (Array.isArray(result.schedule)) {
        scmVrmaRows = activeVrmaRows(result.schedule.filter((row) => row.orderKind === "VRMA"));
      }
      const savedRef = String(payload.vrmaRef || "").trim();
      if (wasEditing) {
        scmVrmaEditingRef = savedRef;
        scmVrmaDraft.vrmaRef = savedRef;
        scmVrmaNotice = `Updated ${savedRef}. It remains open for further edits and is available in dispatch.`;
      } else {
        scmVrmaEditingRef = "";
        scmVrmaDraft = newVrmaDraft();
        scmVrmaNotice = `Saved ${savedRef}. Ready for the next VRMA order.`;
      }
    } catch (error) {
      scmVrmaNotice = `${wasEditing ? "Update" : "Save"} failed: ${error.message}`;
    } finally {
      scmVrmaBusy = false;
      renderVrma();
      if (!wasEditing) scmVrmaApp.querySelector('[data-field="vrmaRef"]')?.focus({ preventScroll: true });
    }
    return;
  }
});

window.addEventListener("mbbs-language-changed", renderVrma);

requireDispatchLogin({
  mount: scmVrmaApp,
  roles: ["admin", "scm", "scm_staff"],
  async onReady(operator) {
    scmVrmaOperator = operator;
    await loadVrma();
  }
});
