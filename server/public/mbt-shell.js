const app = document.getElementById("mbtApp");
const statusRegion = app?.querySelector(".mbt-status");
const surface = String(document.body.dataset.mbtSurface || "");
const token = localStorage.getItem("mbbs.staff.token") || "";

const surfaceDetails = {
  config: {
    endpoint: "/api/mbt/config",
    title: "Configuration is safely locked",
    allowed: new Set(["admin"])
  },
  frontdesk: {
    endpoint: "/api/mbt/frontdesk/status",
    title: "Front Desk is not yet operational",
    allowed: new Set(["admin", "mbt_frontdesk"])
  },
  billing: {
    endpoint: "/api/mbt/billing/status",
    title: "Local shadow billing is controlled",
    allowed: new Set(["admin", "mbt_billing"])
  }
};

const readinessState = {
  configurationHash: "",
  requirements: [],
  runtimeBinding: null,
  run: null,
  editingRequirement: null
};

const LOCAL_ITEM_ORDER = Object.freeze([
  "DELIVERY_CROSS_CHARGE",
  "14YD",
  "20YD",
  "40YD",
  "DUMP"
]);

const localItemState = {
  items: [],
  editingItem: null,
  pendingCommand: null
};

const phase3ConfigState = {
  customerPreview: null,
  localImportPreviews: {
    local_items: null,
    materials: null,
    dump_sites: null
  },
  customerEvidenceLoaded: false,
  materialsLoaded: false,
  dumpItems: [],
  dumpSites: [],
  editingDumpSiteCode: null,
  rateCardsLoaded: false
};

const rateCardState = {
  items: [],
  csvPreview: null,
  rateCardEditorMode: "create",
  selectedVersion: null,
  activePricingItemCode: "",
  itemPricing: new Map(),
  yardOptions: []
};

const customerChargeConfigurationState = {
  configuration: null,
  loadedRateCardVersionId: "",
  saveInFlight: false
};

let localItemSaveInFlight = false;
let rateCardSaveInFlight = false;
let readinessLoaded = false;
let readinessLoadPromise = null;
let foundationState = null;

function roles(operator) {
  return new Set([...(operator?.roles || []), operator?.role]
    .map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_"))
    .filter(Boolean));
}

async function api(path, { method = "GET", body, idempotencyKey = "" } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "This controlled surface is unavailable.");
    error.status = response.status;
    error.code = payload.code || "";
    error.redirect = payload.redirect || "";
    throw error;
  }
  return payload;
}

async function apiRaw(path, { bytes, contentType, headers = {} } = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": contentType,
      ...headers
    },
    body: bytes,
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "The import request failed safely.");
    error.status = response.status;
    error.code = payload.code || "";
    throw error;
  }
  return payload;
}

function replaceStatus(title, lines, tone = "safe") {
  if (!statusRegion) {
    return;
  }
  statusRegion.replaceChildren();
  statusRegion.dataset.tone = tone;
  statusRegion.setAttribute("aria-busy", "false");
  const heading = document.createElement("h2");
  heading.textContent = title;
  statusRegion.append(heading);
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    statusRegion.append(paragraph);
  }
}

function readinessElement(id) {
  return document.getElementById(id);
}

function setReadinessMessage(message, tone = "safe") {
  const region = readinessElement("readinessMessage");
  if (!region) {
    return;
  }
  region.textContent = message;
  region.dataset.tone = tone;
}

function setLocalItemMessage(message, tone = "safe") {
  const region = readinessElement("localItemMessage");
  if (!region) {
    return;
  }
  region.textContent = message;
  region.dataset.tone = tone;
}

function setConfigMessage(id, message, tone = "safe") {
  const region = readinessElement(id);
  if (!region) return;
  region.textContent = message;
  region.dataset.tone = tone;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function renderCustomerRuns(items) {
  const rows = readinessElement("customerSyncRunRows");
  if (!rows) return;
  rows.replaceChildren();
  if (!Array.isArray(items) || !items.length) {
    const row = document.createElement("tr");
    const cell = textCell("No customer synchronization evidence is available.");
    cell.colSpan = 4;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const run of items) {
    const row = document.createElement("tr");
    row.append(
      textCell(run.syncKind || "NetSuite read"),
      textCell(run.status || "unknown"),
      textCell(run.recordsSeen ?? 0),
      textCell(run.completedAt || run.requestedAt || "In progress")
    );
    rows.append(row);
  }
}

async function loadCustomerEvidence() {
  setConfigMessage("customerSyncMessage", "Loading source provenance and freshness…");
  try {
    const result = await api("/api/mbt/customers/sync/runs?limit=20");
    renderCustomerRuns(result.items);
    phase3ConfigState.customerEvidenceLoaded = true;
    setConfigMessage(
      "customerSyncMessage",
      `${Array.isArray(result.items) ? result.items.length : 0} synchronization run(s) loaded. Import previews retain aggregate evidence only.`
    );
  } catch (error) {
    setConfigMessage("customerSyncMessage", error.message, "attention");
  }
}

async function syncCustomers() {
  const button = readinessElement("syncCustomersButton");
  if (button) button.disabled = true;
  setConfigMessage("customerSyncMessage", "Starting the bounded read-only customer synchronization…");
  try {
    const result = await api("/api/mbt/customers/sync", {
      method: "POST",
      body: {
        syncKind: "incremental",
        reason: inputValue("customerSyncReason")
      },
      idempotencyKey: commandIdentity("mbt-customer-sync")
    });
    setConfigMessage("customerSyncMessage", `Customer synchronization ${result.status || "accepted"}.`);
    await loadCustomerEvidence();
  } catch (error) {
    setConfigMessage("customerSyncMessage", error.message, "attention");
  } finally {
    if (button) button.disabled = false;
  }
}

function importExportedAt() {
  const value = inputValue("customerImportExportedAt");
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new Error("Select the export date and time before previewing.");
  }
  return parsed.toISOString();
}

async function previewCustomerImport() {
  const fileInput = readinessElement("customerImportFile");
  const file = fileInput?.files?.[0];
  if (!file) {
    setConfigMessage("customerSyncMessage", "Select a CSV or supported XML .xls export first.", "attention");
    return;
  }
  const previewButton = readinessElement("previewCustomerImportButton");
  if (previewButton) previewButton.disabled = true;
  try {
    const isSpreadsheetMl = /\.xls$/i.test(file.name);
    const result = await apiRaw("/api/mbt/config/imports/customers/preview", {
      bytes: await file.arrayBuffer(),
      contentType: isSpreadsheetMl ? "application/vnd.ms-excel" : "text/csv",
      headers: {
        "x-mbt-source-filename": file.name,
        "x-mbt-source-account-id": inputValue("customerImportAccount"),
        "x-mbt-approved-subsidiary": inputValue("customerImportSubsidiary"),
        "x-mbt-default-currency": inputValue("customerImportCurrency").toUpperCase(),
        "x-mbt-exported-at": importExportedAt()
      }
    });
    phase3ConfigState.customerPreview = result;
    const summary = readinessElement("customerImportPreview");
    if (summary) {
      summary.textContent = safeJson({
        batchId: result.batchId,
        sourceKind: result.sourceKind,
        status: result.status,
        summary: result.summary,
        warnings: result.warnings,
        errors: result.errors
      });
    }
    const applyButton = readinessElement("applyCustomerImportButton");
    if (applyButton) applyButton.disabled = false;
    setConfigMessage("customerSyncMessage", "Import preview is ready. Review aggregate counts before applying.");
  } catch (error) {
    phase3ConfigState.customerPreview = null;
    const applyButton = readinessElement("applyCustomerImportButton");
    if (applyButton) applyButton.disabled = true;
    setConfigMessage("customerSyncMessage", error.message, "attention");
  } finally {
    if (previewButton) previewButton.disabled = false;
  }
}

async function applyCustomerImport() {
  const preview = phase3ConfigState.customerPreview;
  if (!preview) return;
  const button = readinessElement("applyCustomerImportButton");
  if (button) button.disabled = true;
  try {
    const result = await api(
      `/api/mbt/config/imports/customers/${encodeURIComponent(preview.batchId)}/apply`,
      {
        method: "POST",
        body: {
          normalizedHash: preview.normalizedHash,
          targetRevisionToken: preview.targetRevisionToken,
          reason: defaultCreationReason(
            inputValue("customerImportReason"),
            "Imported approved customers into the local customer directory"
          )
        },
        idempotencyKey: commandIdentity("mbt-customer-import")
      }
    );
    const summary = readinessElement("customerImportPreview");
    if (summary) summary.textContent = safeJson(result);
    phase3ConfigState.customerPreview = null;
    setConfigMessage("customerSyncMessage", "Approved customer preview applied locally. No NetSuite write occurred.");
    await loadCustomerEvidence();
  } catch (error) {
    setConfigMessage("customerSyncMessage", error.message, "attention");
    if (button) button.disabled = false;
  }
}

function syncCustomItemTypeFields() {
  const itemType = inputValue("customLocalItemType");
  const isBin = itemType === "bin";
  const isAggregate = itemType === "aggregate";
  for (const field of document.querySelectorAll("[data-bin-item-field]")) {
    field.hidden = !isBin;
    for (const control of field.querySelectorAll("input, select")) {
      control.disabled = !isBin;
      control.required = isBin;
    }
  }
  for (const field of document.querySelectorAll("[data-aggregate-item-field]")) {
    field.hidden = !isAggregate;
    for (const control of field.querySelectorAll("input, select")) {
      control.disabled = !isAggregate;
      control.required = isAggregate;
    }
  }
  const basis = readinessElement("customLocalItemChargeBasis");
  if (basis instanceof HTMLSelectElement) {
    const options = {
      bin: [["rental_period", "Rental period"]],
      surcharge: [["per_event", "Per event"]],
      dump: [["per_tonne", "Price per tonne"], ["per_bin", "Fixed price per bin"]],
      aggregate: [["per_yard", "Price per cubic yard"]],
      delivery_fee: [["distance", "Distance bands"]]
    }[itemType] || [];
    basis.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  }
}

async function saveCustomLocalItem(event) {
  event.preventDefault();
  if (localItemSaveInFlight) return;
  localItemSaveInFlight = true;
  const form = event.currentTarget;
  const submit = form?.querySelector("button[type='submit']");
  if (submit) submit.disabled = true;
  form?.setAttribute("aria-busy", "true");
  const active = readinessElement("customLocalItemActive")?.checked === true;
  const itemType = inputValue("customLocalItemType");
  const applicableServiceTypes = itemType === "bin"
    ? ["delivery", "final_pickup", "loaded_pickup", "dump_return", "exchange"]
    : itemType === "dump"
      ? ["dump_return"]
      : itemType === "aggregate"
        ? ["delivery", "exchange"]
      : itemType === "delivery_fee"
        ? ["delivery", "final_pickup", "loaded_pickup", "dump_return", "exchange"]
        : [];
  try {
    const result = await api("/api/mbt/config/local/items", {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-custom-local-item"),
      body: {
        itemCode: inputValue("customLocalItemCode"),
        displayName: inputValue("customLocalItemName"),
        description: inputValue("customLocalItemDescription"),
        itemType,
        chargeBasis: inputValue("customLocalItemChargeBasis"),
        densityLbsPerYard: itemType === "aggregate"
          ? Number(inputValue("customLocalItemDensityLbsPerYard"))
          : null,
        rentalPeriodDays: itemType === "bin" ? Number(inputValue("customLocalItemRentalDays")) : null,
        applicableServiceTypes,
        applicableLegacySourceTypes: [],
        binTypeCode: null,
        binCapacityYards: itemType === "bin"
          ? Number(inputValue("customLocalItemBinCapacityYards"))
          : null,
        netSuiteMappingLocalKey: null,
        active,
        reason: defaultCreationReason(
          "",
          `Created local ${itemType === "bin" ? "BIN" : itemType.replaceAll("_", " ")} item`
        )
      }
    });
    upsertLocalItem(result.entities?.[0]);
    form.reset();
    const activeField = readinessElement("customLocalItemActive");
    if (activeField) activeField.checked = true;
    fieldValue("customLocalItemRentalDays", "14");
    fieldValue("customLocalItemBinCapacityYards", "");
    fieldValue("customLocalItemDensityLbsPerYard", "");
    syncCustomItemTypeFields();
    setLocalItemMessage("Custom local item created. No NetSuite item was required.");
  } catch (error) {
    setLocalItemMessage(error.message, "attention");
  } finally {
    localItemSaveInFlight = false;
    form?.setAttribute("aria-busy", "false");
    if (submit) submit.disabled = false;
  }
}

function localImportControls(resource) {
  if (resource === "local_items") {
    return {
      fileId: "localItemImportFile",
      reasonId: "localItemImportReason",
      previewId: "localItemImportPreview",
      applyId: "applyLocalItemImportButton",
      previewButtonId: "previewLocalItemImportButton",
      messageId: "localItemMessage"
    };
  }
  return {
    fileId: "localMasterImportFile",
    reasonId: "localMasterImportReason",
    previewId: "localMasterImportPreview",
    applyId: "applyLocalMasterImportButton",
    previewButtonId: "previewLocalMasterImportButton",
    messageId: "masterDataMessage"
  };
}

function selectedLocalMasterResource() {
  return "dump_sites";
}

async function previewLocalImport(resource) {
  const controls = localImportControls(resource);
  const file = readinessElement(controls.fileId)?.files?.[0];
  if (!file) {
    setConfigMessage(controls.messageId, "Select the matching CSV file first.", "attention");
    return;
  }
  const button = readinessElement(controls.previewButtonId);
  if (button) button.disabled = true;
  try {
    const pathResource = resource.replaceAll("_", "-");
    const result = await apiRaw(`/api/mbt/config/imports/${pathResource}/preview`, {
      bytes: await file.arrayBuffer(),
      contentType: "text/csv",
      headers: { "x-mbt-source-filename": file.name }
    });
    phase3ConfigState.localImportPreviews[resource] = result;
    const output = readinessElement(controls.previewId);
    if (output) {
      output.textContent = safeJson({
        batchId: result.batchId,
        resource: result.resource,
        status: result.status,
        summary: result.summary,
        warnings: result.warnings,
        errors: result.errors
      });
    }
    const applyButton = readinessElement(controls.applyId);
    if (applyButton) applyButton.disabled = false;
    setConfigMessage(controls.messageId, "CSV preview is ready. Review the aggregate counts before applying.");
  } catch (error) {
    phase3ConfigState.localImportPreviews[resource] = null;
    const applyButton = readinessElement(controls.applyId);
    if (applyButton) applyButton.disabled = true;
    setConfigMessage(controls.messageId, error.message, "attention");
  } finally {
    if (button) button.disabled = false;
  }
}

async function applyLocalImport(resource) {
  const preview = phase3ConfigState.localImportPreviews[resource];
  if (!preview) return;
  const controls = localImportControls(resource);
  const button = readinessElement(controls.applyId);
  if (button) button.disabled = true;
  try {
    const pathResource = resource.replaceAll("_", "-");
    const result = await api(
      `/api/mbt/config/imports/${pathResource}/${encodeURIComponent(preview.batchId)}/apply`,
      {
        method: "POST",
        body: {
          normalizedHash: preview.normalizedHash,
          targetRevisionToken: preview.targetRevisionToken,
          reason: inputValue(controls.reasonId)
        },
        idempotencyKey: commandIdentity(`mbt-${resource}-import`)
      }
    );
    const output = readinessElement(controls.previewId);
    if (output) output.textContent = safeJson(result);
    phase3ConfigState.localImportPreviews[resource] = null;
    if (resource === "local_items") await loadLocalItems();
    else await loadMaterialsAndDumps();
    setConfigMessage(controls.messageId, "Approved CSV preview applied locally.");
  } catch (error) {
    setConfigMessage(controls.messageId, error.message, "attention");
    if (button) button.disabled = false;
  }
}

async function loadMaterialsAndDumps() {
  setConfigMessage("masterDataMessage", "Loading dump items and dump-site acceptance…");
  try {
    if (!localItemState.items.length) await loadLocalItems();
    const dumpSites = await api("/api/mbt/config/dump-sites");
    phase3ConfigState.dumpItems = localItemState.items.filter(
      (item) => item.itemType === "dump"
    );
    phase3ConfigState.dumpSites = Array.isArray(dumpSites.entities) ? dumpSites.entities : [];
    const summary = readinessElement("materialsDumpSummary");
    if (summary) summary.textContent = safeJson({
      dumpItems: phase3ConfigState.dumpItems,
      dumpSites: phase3ConfigState.dumpSites
    });
    renderDumpSiteList(phase3ConfigState.dumpSites);
    const editingSite = phase3ConfigState.dumpSites.find(
      (site) => site.dumpSiteCode === phase3ConfigState.editingDumpSiteCode
    ) || null;
    renderDumpSiteAcceptanceOptions(editingSite);
    hydrateDumpSiteOpeningHours(editingSite);
    phase3ConfigState.materialsLoaded = true;
    setConfigMessage("masterDataMessage", "Local dump items and dump sites loaded.");
  } catch (error) {
    setConfigMessage("masterDataMessage", error.message, "attention");
  }
}

const dumpSiteWeekdayNames = Object.freeze(["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

function renderDumpSiteAcceptanceOptions(site = null) {
  const container = readinessElement("dumpSiteItemAcceptances");
  if (!container) return;
  container.replaceChildren();
  const existing = new Map((site?.dumpItems || []).map((entry) => [String(entry.itemCode), entry]));
  const available = phase3ConfigState.dumpItems.filter((item) => item.active !== false || existing.has(String(item.itemCode)));
  for (const item of available) {
    const acceptance = existing.get(String(item.itemCode));
    const row = document.createElement("div");
    row.className = "mbt-dump-acceptance-row";
    const acceptsLabel = document.createElement("label");
    acceptsLabel.className = "mbt-checkbox";
    const accepts = document.createElement("input");
    accepts.type = "checkbox";
    accepts.value = String(item.itemCode);
    accepts.dataset.dumpAcceptanceItem = "true";
    accepts.checked = acceptance?.accepted === true && acceptance?.active !== false;
    accepts.disabled = item.active === false && !accepts.checked;
    const acceptsText = document.createElement("span");
    acceptsText.textContent = `${item.displayName || item.itemCode} · ${item.itemCode}`;
    acceptsLabel.append(accepts, acceptsText);
    const ticketLabel = document.createElement("label");
    ticketLabel.className = "mbt-checkbox";
    const ticket = document.createElement("input");
    ticket.type = "checkbox";
    ticket.dataset.dumpTicketItem = String(item.itemCode);
    ticket.checked = acceptance ? acceptance.scaleTicketRequired === true : true;
    ticket.disabled = !accepts.checked;
    const ticketText = document.createElement("span");
    ticketText.textContent = "Scale ticket required";
    ticketLabel.append(ticket, ticketText);
    accepts.addEventListener("change", () => { ticket.disabled = !accepts.checked; });
    row.append(acceptsLabel, ticketLabel);
    container.append(row);
  }
  if (!available.length) {
    const empty = document.createElement("p");
    empty.className = "mbt-field-help";
    empty.textContent = "Create an active dump item before adding a dump site.";
    container.append(empty);
  }
}

function hydrateDumpSiteOpeningHours(site = null) {
  const existing = new Map((site?.openingHours || []).map((entry) => [Number(entry.isoWeekday), entry]));
  document.querySelectorAll(".mbt-dump-hours-row").forEach((row) => {
    const day = row.querySelector("[data-dump-opening-day]");
    const opens = row.querySelector("[data-dump-opens]");
    const closes = row.querySelector("[data-dump-closes]");
    if (!(day instanceof HTMLInputElement) || !(opens instanceof HTMLInputElement) || !(closes instanceof HTMLInputElement)) return;
    const configured = existing.get(Number(day.value));
    day.checked = site ? Boolean(configured) : Number(day.value) <= 5;
    opens.value = configured?.opensAt || (Number(day.value) <= 5 ? "07:00" : "08:00");
    closes.value = configured?.closesAt || (Number(day.value) <= 5 ? "17:00" : "13:00");
    const sync = () => {
      opens.disabled = !day.checked;
      closes.disabled = !day.checked;
      opens.required = day.checked;
      closes.required = day.checked;
    };
    if (day.dataset.hoursBound !== "true") {
      day.addEventListener("change", sync);
      day.dataset.hoursBound = "true";
    }
    sync();
  });
}

function newDumpSiteEditor() {
  phase3ConfigState.editingDumpSiteCode = null;
  const form = readinessElement("dumpSiteForm");
  if (form instanceof HTMLFormElement) form.reset();
  fieldValue("dumpSiteRevision", "");
  const code = readinessElement("dumpSiteCode");
  if (code instanceof HTMLInputElement) code.readOnly = false;
  const mode = readinessElement("dumpSiteEditorMode");
  if (mode) mode.textContent = "Creating a new dump site.";
  const save = readinessElement("saveDumpSiteButton");
  if (save) save.textContent = "Create dump site";
  syncUpdateReasonField("dumpSiteReasonField", "dumpSiteReason", false);
  renderDumpSiteAcceptanceOptions();
  hydrateDumpSiteOpeningHours();
  code?.focus({ preventScroll: true });
}

function resetTableRows(id, emptyText) {
  const rows = readinessElement(id);
  if (!rows) return null;
  rows.replaceChildren();
  if (!rows.children.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4; cell.textContent = emptyText; row.append(cell); rows.append(row);
  }
  return rows;
}

function renderDumpSiteList(sites) {
  const rows = readinessElement("dumpSiteRows");
  if (!rows) return;
  rows.replaceChildren();
  for (const site of sites) {
    const row = document.createElement("tr");
    for (const value of [
      `${site.dumpSiteCode} · ${site.displayName}${site.active === false ? " · Inactive" : ""}`,
      (site.dumpItems || []).filter((entry) => entry.accepted && entry.active !== false).map((entry) => entry.itemCode).join(", ") || "None",
      (site.openingHours || []).map((entry) => `${dumpSiteWeekdayNames[Number(entry.isoWeekday)]} ${entry.opensAt}–${entry.closesAt}`).join(", ") || "Not set"
    ]) {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    }
    const action = document.createElement("button"); action.type = "button"; action.textContent = "Edit";
    action.addEventListener("click", () => {
      phase3ConfigState.editingDumpSiteCode = site.dumpSiteCode;
      const set = (id, value) => { const field = readinessElement(id); if (field) field.value = String(value ?? ""); };
      set("dumpSiteCode", site.dumpSiteCode); set("dumpSiteName", site.displayName); set("dumpSiteAddress", site.addressLine1); set("dumpSiteCity", site.city); set("dumpSiteRegion", site.region); set("dumpSitePostal", site.postalCode); set("dumpSiteRevision", site.revision);
      const active = readinessElement("dumpSiteActive"); if (active) active.checked = site.active === true;
      renderDumpSiteAcceptanceOptions(site);
      hydrateDumpSiteOpeningHours(site);
      const code = readinessElement("dumpSiteCode"); if (code instanceof HTMLInputElement) code.readOnly = true;
      const mode = readinessElement("dumpSiteEditorMode"); if (mode) mode.textContent = `Updating ${site.displayName || site.dumpSiteCode}.`;
      const save = readinessElement("saveDumpSiteButton"); if (save) save.textContent = "Update dump site";
      syncUpdateReasonField("dumpSiteReasonField", "dumpSiteReason", true);
      readinessElement("dumpSiteCode")?.focus();
    });
    const stateButton = document.createElement("button");
    stateButton.type = "button";
    stateButton.className = "mbt-button-secondary";
    stateButton.textContent = site.active === true ? "Inactivate" : "Activate";
    stateButton.addEventListener("click", () => setDumpSiteActive(site, site.active !== true));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "mbt-button-secondary";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => deleteDumpSite(site));
    const actionCell = document.createElement("td");
    actionCell.className = "mbt-table-actions";
    actionCell.append(action, stateButton, deleteButton);
    row.append(actionCell); rows.append(row);
  }
  if (!sites.length) resetTableRows("dumpSiteRows", "No local dump sites configured.");
}

async function setDumpSiteActive(site, active) {
  try {
    await api(`/api/mbt/config/dump-sites/${encodeURIComponent(site.dumpSiteCode)}/state`, {
      method: "PATCH",
      idempotencyKey: commandIdentity("mbt-dump-site-state"),
      body: { active, expectedRevision: Number(site.revision) }
    });
    await loadMaterialsAndDumps();
    setConfigMessage("masterDataMessage", `${site.displayName || site.dumpSiteCode} is now ${active ? "active" : "inactive"}.`);
  } catch (error) {
    setConfigMessage("masterDataMessage", error.message, "attention");
  }
}

async function deleteDumpSite(site) {
  if (!globalThis.confirm(`Delete ${site.displayName || site.dumpSiteCode}? Linked operational records will prevent deletion.`)) return;
  try {
    await api(`/api/mbt/config/dump-sites/${encodeURIComponent(site.dumpSiteCode)}`, {
      method: "DELETE",
      idempotencyKey: commandIdentity("mbt-dump-site-delete"),
      body: { expectedRevision: Number(site.revision) }
    });
    await loadMaterialsAndDumps();
    newDumpSiteEditor();
    setConfigMessage("masterDataMessage", "Unused dump site deleted.");
  } catch (error) {
    setConfigMessage("masterDataMessage", error.message, "attention");
  }
}

async function saveDumpSite(event) {
  event.preventDefault();
  const revision = Number(inputValue("dumpSiteRevision"));
  try {
    const itemAcceptances = [...document.querySelectorAll("[data-dump-acceptance-item]")]
      .filter((control) => control instanceof HTMLInputElement && control.checked)
      .map((control) => {
        const ticket = [...document.querySelectorAll("[data-dump-ticket-item]")]
          .find((candidate) => candidate.dataset.dumpTicketItem === control.value);
        return {
          itemCode: control.value,
          accepted: true,
          scaleTicketRequired: ticket?.checked === true,
          notes: "",
          active: true
        };
      });
    const openingHours = [...document.querySelectorAll(".mbt-dump-hours-row")]
      .filter((row) => row.querySelector("[data-dump-opening-day]")?.checked === true)
      .map((row) => ({
        isoWeekday: Number(row.querySelector("[data-dump-opening-day]").value),
        opensAt: row.querySelector("[data-dump-opens]").value,
        closesAt: row.querySelector("[data-dump-closes]").value
      }));
    if (!itemAcceptances.length) throw new Error("Select at least one accepted dump item.");
    if (!openingHours.length) throw new Error("Select at least one opening day.");
    await api("/api/mbt/config/dump-sites", {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-dump-site"),
      body: {
        dumpSiteCode: inputValue("dumpSiteCode"),
        displayName: inputValue("dumpSiteName"),
        addressLine1: inputValue("dumpSiteAddress"),
        addressLine2: "",
        city: inputValue("dumpSiteCity"),
        region: inputValue("dumpSiteRegion"),
        postalCode: inputValue("dumpSitePostal"),
        countryCode: "CA",
        phone: "",
        latitude: null,
        longitude: null,
        itemAcceptances,
        openingHours,
        notes: "",
        active: readinessElement("dumpSiteActive")?.checked === true,
        ...(revision > 0 ? { expectedRevision: revision } : {}),
        reason: revision > 0
          ? inputValue("dumpSiteReason")
          : defaultCreationReason("", "Created local dump site")
      }
    });
    await loadMaterialsAndDumps();
    newDumpSiteEditor();
    setConfigMessage("masterDataMessage", revision > 0 ? "Dump site updated." : "Dump site created.");
  } catch (error) {
    setConfigMessage("masterDataMessage", error.message, "attention");
  }
}

async function loadRateCards() {
  setConfigMessage("rateCardsMessage", "Loading local rate cards…");
  try {
    const result = await api("/api/mbt/config/rate-cards");
    rateCardState.items = Array.isArray(result.items) ? result.items : [];
    rateCardState.yardOptions = Array.isArray(result.yardOptions) ? result.yardOptions : [];
    renderRateCards();
    renderRatePricingItemOptions(rateCardState.activePricingItemCode);
    phase3ConfigState.rateCardsLoaded = true;
    setConfigMessage("rateCardsMessage", "Local rate cards loaded.");
  } catch (error) {
    setConfigMessage("rateCardsMessage", error.message, "attention");
  }
}

function renderCustomerChargeRateCardOptions() {
  const select = readinessElement("customerChargeRateCardVersion");
  if (!select) return;
  const prior = select.value || customerChargeConfigurationState.loadedRateCardVersionId;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a named rate card";
  select.append(placeholder);
  for (const item of rateCardState.items) {
    const option = document.createElement("option");
    option.value = String(item.rateCardVersionId || "");
    option.textContent = `${item.displayName || item.rateCardCode || "Rate card"} · v${item.versionNumber || 1} · ${item.status || "draft"}`;
    select.append(option);
  }
  select.value = [...select.options].some((option) => option.value === prior) ? prior : "";
}

function setCustomerChargeInput(row, selector, value) {
  const input = row?.querySelector(selector);
  if (input instanceof HTMLInputElement) input.value = value === null || value === undefined ? "" : String(value);
}

function customerChargeBandInput(attribute, value, { readOnly = false, label = "" } = {}) {
  const input = document.createElement("input");
  input.setAttribute(attribute, "");
  input.value = value === null || value === undefined ? "" : String(value);
  input.readOnly = readOnly;
  input.required = attribute !== "data-band-maximum-km";
  if (label) input.setAttribute("aria-label", label);
  return input;
}

function appendAggregateDistanceBandRow(band = {}) {
  const rows = readinessElement("aggregateDistanceBandRows");
  if (!rows) return;
  const existingRows = [...rows.querySelectorAll("[data-aggregate-distance-band]")];
  const priorMaximum = existingRows.at(-1)?.querySelector("[data-band-maximum-km]")?.value || "30";
  const minimumMetres = Number.isSafeInteger(band.minimumMetres)
    ? Number(band.minimumMetres)
    : Math.round(Number(priorMaximum || 30) * 1_000);
  const isBase = band.minimumMetres === 0 || existingRows.length === 0;
  const row = document.createElement("tr");
  row.dataset.aggregateDistanceBand = "";
  if (isBase) row.dataset.baseBand = "true";
  const code = isBase ? "AGG_0_30" : String(band.bandCode || `AGG_${minimumMetres / 1_000}_PLUS`)
    .toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_");
  const values = [
    customerChargeBandInput("data-band-code", code, { readOnly: isBase, label: "Aggregate distance band code" }),
    customerChargeBandInput("data-band-minimum-km", (minimumMetres / 1_000).toString(), {
      readOnly: isBase,
      label: "Aggregate distance from kilometres"
    }),
    customerChargeBandInput(
      "data-band-maximum-km",
      isBase ? "30" : band.maximumMetres === null ? "" : Number.isSafeInteger(band.maximumMetres)
        ? (Number(band.maximumMetres) / 1_000).toString()
        : "",
      { readOnly: isBase, label: "Aggregate distance through kilometres" }
    ),
    customerChargeBandInput(
      "data-band-amount-cad",
      isBase ? "150.00" : band.amountMinor === null || band.amountMinor === undefined
        ? ""
        : cadInputValue(band.amountMinor),
      { readOnly: isBase, label: "Aggregate distance charge CAD" }
    )
  ];
  const cells = values.map((input) => {
    const cell = document.createElement("td");
    cell.append(input);
    return cell;
  });
  const action = document.createElement("td");
  if (isBase) {
    action.textContent = "Required";
  } else {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mbt-button-secondary";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => row.remove());
    action.append(remove);
  }
  row.append(...cells, action);
  rows.append(row);
}

function renderCustomerChargeDistanceBands(bands) {
  const rows = readinessElement("aggregateDistanceBandRows");
  if (!rows) return;
  rows.replaceChildren();
  const configured = Array.isArray(bands) && bands.length
    ? bands
    : [{ bandCode: "AGG_0_30", minimumMetres: 0, maximumMetres: 30_000, amountMinor: 15_000 }];
  for (const band of configured) appendAggregateDistanceBandRow(band);
}

function populateCustomerChargeConfiguration(configuration) {
  customerChargeConfigurationState.configuration = configuration;
  customerChargeConfigurationState.loadedRateCardVersionId = String(configuration.rateCardVersionId || "");
  const revision = readinessElement("customerChargeConfigurationRevision");
  if (revision instanceof HTMLInputElement) revision.value = String(configuration.revision || 0);
  for (const row of document.querySelectorAll("[data-aggregate-charge-code]")) {
    const item = (configuration.aggregateItems || []).find(
      (candidate) => candidate.itemCode === row.dataset.aggregateChargeCode
    );
    setCustomerChargeInput(row, "[data-charge-amount-cad]", item?.amountMinor === null || item?.amountMinor === undefined
      ? "" : cadInputValue(item.amountMinor));
    setCustomerChargeInput(row, "[data-charge-density]", item?.densityLbsPerYard ?? "");
  }
  for (const row of document.querySelectorAll("[data-fixed-dump-charge-code]")) {
    const item = (configuration.fixedDumpItems || []).find(
      (candidate) => candidate.itemCode === row.dataset.fixedDumpChargeCode
    );
    setCustomerChargeInput(row, "[data-charge-amount-cad]", item?.amountMinor === null || item?.amountMinor === undefined
      ? "" : cadInputValue(item.amountMinor));
  }
  renderCustomerChargeDistanceBands(configuration.aggregateDistanceBands);
  const select = readinessElement("customerChargeRateCardVersion");
  if (select instanceof HTMLSelectElement) select.value = customerChargeConfigurationState.loadedRateCardVersionId;
}

async function loadCustomerChargeConfiguration(versionId) {
  const normalizedVersionId = String(versionId || "");
  if (!normalizedVersionId) {
    setConfigMessage("customerChargesMessage", "Select a rate card to load customer charges.");
    return;
  }
  setConfigMessage("customerChargesMessage", "Loading dump and aggregate customer charges…");
  try {
    const configuration = await api(
      `/api/mbt/config/customer-charges/${encodeURIComponent(normalizedVersionId)}`
    );
    populateCustomerChargeConfiguration(configuration);
    setConfigMessage(
      "customerChargesMessage",
      configuration.complete
        ? `Complete customer-charge sheet loaded at revision ${configuration.revision}.`
        : "This rate card has no complete customer-charge sheet yet. Enter every rate before saving.",
      configuration.complete ? "safe" : "attention"
    );
  } catch (error) {
    setConfigMessage("customerChargesMessage", error.message, "attention");
  }
}

async function ensureCustomerChargeConfigurationLoaded() {
  if (!phase3ConfigState.rateCardsLoaded) await loadRateCards();
  renderCustomerChargeRateCardOptions();
  const select = readinessElement("customerChargeRateCardVersion");
  if (!(select instanceof HTMLSelectElement)) return;
  if (!select.value && rateCardState.items.length) {
    const preferred = rateCardState.items.find((item) => item.status === "active") || rateCardState.items[0];
    select.value = String(preferred?.rateCardVersionId || "");
  }
  if (select.value !== customerChargeConfigurationState.loadedRateCardVersionId) {
    await loadCustomerChargeConfiguration(select.value);
  }
}

function positiveCustomerChargeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive whole number.`);
  return parsed;
}

function customerChargeKilometres(value, label, { nullable = false } = {}) {
  const text = String(value ?? "").trim();
  if (nullable && !text) return null;
  const match = /^(\d{1,6})(?:\.(\d{1,3}))?$/u.exec(text);
  if (!match) {
    throw new Error(`${label} must use kilometres with at most three decimals.`);
  }
  return (Number(match[1]) * 1_000) + Number((match[2] || "").padEnd(3, "0"));
}

function customerChargeConfigurationInput() {
  const aggregateItems = [...document.querySelectorAll("[data-aggregate-charge-code]")].map((row) => ({
    itemCode: row.dataset.aggregateChargeCode,
    amountMinor: cadMinorFromValue(row.querySelector("[data-charge-amount-cad]")?.value, `${row.cells[0].textContent} price`),
    densityLbsPerYard: positiveCustomerChargeInteger(
      row.querySelector("[data-charge-density]")?.value,
      `${row.cells[0].textContent} density`
    )
  }));
  const fixedDumpItems = [...document.querySelectorAll("[data-fixed-dump-charge-code]")].map((row) => ({
    itemCode: row.dataset.fixedDumpChargeCode,
    amountMinor: cadMinorFromValue(row.querySelector("[data-charge-amount-cad]")?.value, `${row.cells[0].textContent} price`)
  }));
  const aggregateDistanceBands = [...document.querySelectorAll("[data-aggregate-distance-band]")].map((row, index) => ({
    bandCode: String(row.querySelector("[data-band-code]")?.value || "").trim().toUpperCase(),
    minimumMetres: customerChargeKilometres(
      row.querySelector("[data-band-minimum-km]")?.value,
      `Distance band ${index + 1} start`
    ),
    maximumMetres: customerChargeKilometres(
      row.querySelector("[data-band-maximum-km]")?.value,
      `Distance band ${index + 1} end`,
      { nullable: true }
    ),
    amountMinor: cadMinorFromValue(
      row.querySelector("[data-band-amount-cad]")?.value,
      `Distance band ${index + 1} price`
    )
  }));
  return { aggregateItems, fixedDumpItems, aggregateDistanceBands };
}

async function saveCustomerChargeConfiguration(event) {
  event.preventDefault();
  if (customerChargeConfigurationState.saveInFlight) return;
  const select = readinessElement("customerChargeRateCardVersion");
  const versionId = String(select?.value || "");
  if (!versionId) {
    setConfigMessage("customerChargesMessage", "Select a rate card before saving.", "attention");
    return;
  }
  customerChargeConfigurationState.saveInFlight = true;
  try {
    const body = {
      expectedRevision: Number(readinessElement("customerChargeConfigurationRevision")?.value || 0),
      ...customerChargeConfigurationInput(),
      reason: inputValue("customerChargeConfigurationReason")
    };
    setConfigMessage("customerChargesMessage", "Saving the complete local customer-charge sheet…");
    const result = await api(`/api/mbt/config/customer-charges/${encodeURIComponent(versionId)}`, {
      method: "PUT",
      body,
      idempotencyKey: commandIdentity("mbt-customer-charge-configuration")
    });
    populateCustomerChargeConfiguration(result.configuration);
    setConfigMessage(
      "customerChargesMessage",
      `Customer-charge sheet saved at revision ${result.configuration.revision}. No NetSuite work was created.`
    );
  } catch (error) {
    setConfigMessage("customerChargesMessage", error.message, "attention");
  } finally {
    customerChargeConfigurationState.saveInFlight = false;
  }
}

function preserveRateCardEditorFocus(render) {
  const activeElement = document.activeElement;
  const panel = readinessElement("rateCardsPanel");
  const preserve = activeElement instanceof HTMLInputElement
    && panel?.contains(activeElement)
    && Boolean(activeElement.id);
  const activeId = preserve ? activeElement.id : "";
  const selectionStart = preserve ? activeElement.selectionStart : null;
  const selectionEnd = preserve ? activeElement.selectionEnd : null;
  render();
  if (!activeId) return;
  const restored = readinessElement(activeId);
  if (!(restored instanceof HTMLInputElement)) return;
  restored.focus({ preventScroll: true });
  if (selectionStart !== null && selectionEnd !== null) {
    restored.setSelectionRange(selectionStart, selectionEnd);
  }
}

function renderRateCardRows() {
  const rows = readinessElement("rateCardRows");
  if (!rows) return;
  rows.replaceChildren();
  for (const item of rateCardState.items) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = String(item.displayName || item.rateCardCode || "Rate card");
    const code = document.createElement("span");
    code.className = "mbt-cell-detail";
    const pricedItems = Array.isArray(item.itemCodes) ? item.itemCodes : (item.itemCode ? [item.itemCode] : []);
    code.textContent = `${String(item.rateCardCode || "")} · ${pricedItems.length} priced item${pricedItems.length === 1 ? "" : "s"}${pricedItems.length ? ` · ${pricedItems.join(", ")}` : ""}`;
    identity.append(name, code);
    const effective = item.effectiveFrom
      ? new Date(item.effectiveFrom).toLocaleDateString("en-CA", { timeZone: "America/Toronto" })
      : "Not set";
    const actionCell = document.createElement("td");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "mbt-button-secondary";
    edit.textContent = item.editable === true ? "Edit draft" : "View / clone";
    edit.addEventListener("click", () => {
      const select = readinessElement("rateCardVersionSelect");
      if (select) select.value = String(item.rateCardVersionId || "");
      void loadRateCardForEdit(String(item.rateCardVersionId || ""));
    });
    const stateButton = document.createElement("button");
    stateButton.type = "button";
    stateButton.className = "mbt-button-secondary";
    stateButton.textContent = item.cardActive === false ? "Activate" : "Inactivate";
    stateButton.addEventListener("click", () => setRateCardActive(item, item.cardActive === false));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "mbt-button-secondary";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => deleteRateCard(item));
    actionCell.className = "mbt-table-actions";
    actionCell.append(edit, stateButton, deleteButton);
    row.append(
      identity,
      textCell(`v${item.versionNumber || 1}`),
      textCell(`${item.status || "draft"}${item.cardActive === false ? " · card inactive" : ""}`),
      textCell(effective),
      actionCell
    );
    rows.append(row);
  }
  if (!rateCardState.items.length) {
    const row = document.createElement("tr");
    const cell = textCell("No rate cards configured.");
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
  }
}

async function setRateCardActive(item, active) {
  try {
    await api(`/api/mbt/config/rate-cards/${encodeURIComponent(item.rateCardVersionId)}/state`, {
      method: "PATCH",
      idempotencyKey: commandIdentity("mbt-rate-card-state"),
      body: { active, expectedRevision: Number(item.cardRevision) }
    });
    await loadRateCards();
    setConfigMessage("rateCardsMessage", `${item.displayName || item.rateCardCode} is now ${active ? "active" : "inactive"}.`);
  } catch (error) {
    setConfigMessage("rateCardsMessage", error.message, "attention");
  }
}

async function deleteRateCard(item) {
  if (!globalThis.confirm(`Delete the complete ${item.displayName || item.rateCardCode} rate card? Any linked evidence will prevent deletion.`)) return;
  try {
    await api(`/api/mbt/config/rate-cards/${encodeURIComponent(item.rateCardVersionId)}`, {
      method: "DELETE",
      idempotencyKey: commandIdentity("mbt-rate-card-delete"),
      body: { expectedRevision: Number(item.cardRevision) }
    });
    await loadRateCards();
    newRateCardEditor();
    setConfigMessage("rateCardsMessage", "Unused rate card deleted.");
  } catch (error) {
    setConfigMessage("rateCardsMessage", error.message, "attention");
  }
}

function renderRateCards() {
  preserveRateCardEditorFocus(renderRateCardRows);
  const select = readinessElement("rateCardVersionSelect");
  if (select) {
    const prior = select.value;
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a named rate card";
    select.append(placeholder);
    for (const item of rateCardState.items) {
      const option = document.createElement("option");
      option.value = item.rateCardVersionId || "";
      option.textContent = `${item.displayName || item.rateCardCode || "Rate card"} · v${item.versionNumber || 1} · ${item.status || "draft"}`;
      select.append(option);
    }
    const selectedVersionId = String(rateCardState.selectedVersion?.rateCardVersionId || "");
    const desired = prior || selectedVersionId;
    select.value = [...select.options].some((option) => option.value === desired)
      ? desired : "";
    if (select.value) updateRateLifecycle(rateCardState.items.find((item) => item.rateCardVersionId === select.value));
  }
}

function upsertRateCardVersion(version) {
  if (!version?.rateCardVersionId) return;
  const existing = rateCardState.items.findIndex(
    (candidate) => candidate.rateCardVersionId === version.rateCardVersionId
  );
  if (existing >= 0) {
    rateCardState.items.splice(existing, 1, version);
  } else {
    rateCardState.items.push(version);
  }
  renderRateCards();
}

function integerInput(id, { nullable = false } = {}) {
  const value = inputValue(id);
  if (nullable && value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Rate-card cents and metres must be non-negative safe integers.");
  }
  return number;
}

function rateEffectiveFrom() {
  const value = inputValue("rateCardEffectiveFrom");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("Select an effective Toronto date and time.");
  const [, year, month, day, hour, minute] = match.map(Number);
  const localWallTime = Date.UTC(year, month - 1, day, hour, minute);
  let instant = localWallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = torontoDateParts(new Date(instant));
    instant += localWallTime - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  }
  const resolved = torontoDateParts(new Date(instant));
  if (![year, month, day, hour, minute].every((part, index) => part === [resolved.year, resolved.month, resolved.day, resolved.hour, resolved.minute][index])) {
    throw new Error("That Toronto local time does not exist. Choose another time around the daylight-saving change.");
  }
  return new Date(instant).toISOString();
}

function torontoDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function valueFromRow(row, field) {
  return String(row.querySelector(`[data-rate-field="${field}"]`)?.value || "").trim();
}

function originYardCodesFromRow(row) {
  const priceGroup = String(row.querySelector("[data-rate-origin-group]")?.value || "all");
  if (priceGroup === "standard") return ["2967", "3445"];
  if (priceGroup === "150") return ["150"];
  if (priceGroup === "all") return [];
  return [...row.querySelectorAll("[data-rate-yard-code]:checked")]
    .map((input) => String(input.value || "").trim())
    .filter(Boolean)
    .sort();
}

function rateRowInput(type, field, label, { value = "", inputType = "text", min, step, required = true } = {}) {
  const labelElement = document.createElement("label");
  labelElement.textContent = label;
  const input = document.createElement("input");
  input.type = inputType;
  input.value = value;
  input.required = required;
  input.dataset.rateField = field;
  if (min !== undefined) input.min = String(min);
  if (step !== undefined) input.step = String(step);
  labelElement.append(input);
  return labelElement;
}

function itemPricingDefaults(item) {
  if (item.itemType === "bin") return { rentalCad: "", extensionCad: "" };
  if (item.itemType === "dump") return { amountCad: "", minimumCad: "0.00" };
  if (item.itemType === "aggregate") return { amountCad: "", minimumCad: "0.00" };
  if (item.itemType === "delivery_fee") return { bands: [] };
  return {};
}

function pricingItem(itemCode) {
  return localItemState.items.find((item) => item.itemCode === itemCode) || null;
}

function initializeItemPricingState() {
  rateCardState.itemPricing = new Map(localItemState.items.map((item) => [
    item.itemCode,
    itemPricingDefaults(item)
  ]));
}

function appendItemDistanceBandRow(container, values = {}) {
  if (!container) return;
  const row = document.createElement("div");
  row.className = "mbt-form-grid mbt-rate-band-row";
  row.dataset.rateKind = "item_distance";
  const purposeLabel = document.createElement("label");
  purposeLabel.textContent = "Pricing purpose";
  const purpose = document.createElement("select");
  purpose.dataset.rateField = "serviceCode";
  for (const [value, label] of [
    ["delivery", "BIN delivery"],
    ["aggregate_delivery", "Aggregate delivery"],
    ["mbbs_cross_charge", "MBBS cross charge"]
  ]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; purpose.append(option);
  }
  purpose.value = values.serviceCode || "delivery";
  purposeLabel.append(purpose);
  const binLabel = document.createElement("label");
  binLabel.textContent = "BIN size";
  const bin = document.createElement("select");
  bin.dataset.rateField = "binTypeCode";
  const binItems = localItemState.items.filter((item) => (
    item.itemType === "bin" && item.active === true && item.binTypeCode
  ));
  for (const item of binItems) {
    const option = document.createElement("option");
    option.value = item.binTypeCode;
    option.textContent = `${item.displayName || item.itemCode} · ${item.binTypeCode}`;
    bin.append(option);
  }
  bin.value = values.binTypeCode || binItems[0]?.binTypeCode || "";
  binLabel.append(bin);
  const syncPurpose = () => {
    const binDelivery = purpose.value === "delivery";
    binLabel.hidden = !binDelivery;
    bin.disabled = !binDelivery;
  };
  purpose.addEventListener("change", syncPurpose);
  syncPurpose();
  const yardScope = document.createElement("label");
  yardScope.className = "mbt-rate-yard-scope";
  const yardLegend = document.createElement("span");
  yardLegend.textContent = "Origin price table";
  const originGroup = document.createElement("select");
  originGroup.dataset.rateOriginGroup = "true";
  originGroup.append(
    new Option("Standard price · 3445 / 2967", "standard"),
    new Option("150 price", "150"),
    new Option("All yards · legacy", "all")
  );
  const hasSavedYardScope = Array.isArray(values.originYardCodes);
  const selectedYards = new Set(values.originYardCodes || []);
  const standardYards = ["2967", "3445"];
  if (!hasSavedYardScope) {
    originGroup.value = "standard";
  } else if (selectedYards.size === 1 && selectedYards.has("150")) {
    originGroup.value = "150";
  } else if (selectedYards.size === standardYards.length
      && standardYards.every((yardCode) => selectedYards.has(yardCode))) {
    originGroup.value = "standard";
  } else {
    originGroup.value = "all";
  }
  yardScope.append(yardLegend, originGroup);
  const boundaryRule = document.createElement("input");
  boundaryRule.type = "hidden";
  boundaryRule.dataset.rateField = "boundaryRule";
  boundaryRule.value = values.boundaryRule || "upper_inclusive";
  const basisLabel = document.createElement("label");
  basisLabel.textContent = "Charge method";
  const pricingBasis = document.createElement("select");
  pricingBasis.dataset.rateField = "pricingBasis";
  pricingBasis.append(
    new Option("Flat amount", "flat"),
    new Option("CAD per kilometre", "per_km")
  );
  pricingBasis.value = values.pricingBasis || "flat";
  basisLabel.append(pricingBasis);
  const amountField = rateRowInput(
    "item_distance",
    "amountCad",
    pricingBasis.value === "per_km" ? "CAD per kilometre" : "Flat CAD amount",
    { value: values.amountCad || "", inputType: "number", min: 0, step: "0.01" }
  );
  const syncAmountLabel = () => {
    amountField.firstChild.textContent = pricingBasis.value === "per_km"
      ? "CAD per kilometre"
      : "Flat CAD amount";
  };
  pricingBasis.addEventListener("change", syncAmountLabel);
  row.append(
    purposeLabel,
    binLabel,
    yardScope,
    rateRowInput("item_distance", "minimumKm", "From kilometres (exclusive after the first)", { value: values.minimumKm || "0", inputType: "number", min: 0, step: "0.001" }),
    rateRowInput("item_distance", "maximumKm", "To kilometres (inclusive; blank = open)", { value: values.maximumKm || "", inputType: "number", min: 0, step: "0.001", required: false }),
    basisLabel,
    amountField,
    boundaryRule
  );
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "mbt-button-secondary";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => row.remove());
  row.append(remove);
  container.append(row);
}

function captureActiveRatePricingItem() {
  const item = pricingItem(rateCardState.activePricingItemCode);
  const editor = readinessElement("rateItemEditor");
  if (!item || !editor) return;
  if (item.itemType === "bin") {
    rateCardState.itemPricing.set(item.itemCode, {
      rentalCad: valueFromRow(editor, "rentalCad"),
      extensionCad: valueFromRow(editor, "extensionCad")
    });
  } else if (["dump", "aggregate"].includes(item.itemType)) {
    rateCardState.itemPricing.set(item.itemCode, {
      amountCad: valueFromRow(editor, "amountCad"),
      minimumCad: valueFromRow(editor, "minimumCad")
    });
  } else if (item.itemType === "delivery_fee") {
    rateCardState.itemPricing.set(item.itemCode, {
      bands: [...editor.querySelectorAll("[data-rate-kind='item_distance']")].map((row) => ({
        serviceCode: valueFromRow(row, "serviceCode"),
        binTypeCode: valueFromRow(row, "serviceCode") === "delivery"
          ? valueFromRow(row, "binTypeCode") : null,
        minimumKm: valueFromRow(row, "minimumKm"),
        maximumKm: valueFromRow(row, "maximumKm"),
        amountCad: valueFromRow(row, "amountCad"),
        pricingBasis: valueFromRow(row, "pricingBasis"),
        boundaryRule: valueFromRow(row, "boundaryRule"),
        originYardCodes: originYardCodesFromRow(row)
      }))
    });
  }
}

function renderRatePricingItemOptions(selectedCode = "") {
  const select = readinessElement("ratePricingItem");
  if (!(select instanceof HTMLSelectElement)) return;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = ""; placeholder.textContent = "Select a local item"; select.append(placeholder);
  for (const item of localItemState.items) {
    const option = document.createElement("option");
    option.value = item.itemCode;
    option.textContent = `${item.displayName} · ${localItemIdentity(item)}`;
    option.disabled = item.active === false;
    if (rateItemConfigured(item.itemCode)) option.textContent += " · configured";
    select.append(option);
  }
  select.value = selectedCode;
}

function rateItemConfigured(itemCode) {
  const values = rateCardState.itemPricing.get(itemCode) || {};
  return Boolean(values.rentalCad || values.extensionCad || values.amountCad || values.bands?.length);
}

function firstAvailableRateItemCode() {
  return localItemState.items.find((item) => item.active === true)?.itemCode || "";
}

function renderRateItemEditor(itemCode) {
  const editor = readinessElement("rateItemEditor");
  if (!editor) return;
  editor.replaceChildren();
  const item = pricingItem(itemCode);
  if (!item) {
    const empty = document.createElement("p"); empty.textContent = "Select an item to configure its price."; editor.append(empty); return;
  }
  const heading = document.createElement("h4");
  heading.textContent = `${item.displayName} · ${item.itemCode}`;
  editor.append(heading);
  const values = rateCardState.itemPricing.get(item.itemCode) || itemPricingDefaults(item);
  switch (item.itemType) {
    case "bin": {
      const help = document.createElement("p");
      help.className = "mbt-field-help";
      help.textContent = `Fixed ${Number(item.rentalPeriodDays || 14)}-day rental, then a daily extension price.`;
      const fields = document.createElement("div"); fields.className = "mbt-form-grid";
      fields.append(
        rateRowInput("bin", "rentalCad", `${Number(item.rentalPeriodDays || 14)}-day rental CAD`, { value: values.rentalCad || "", inputType: "number", min: 0, step: "0.01", required: false }),
        rateRowInput("bin", "extensionCad", "Extension CAD / day", { value: values.extensionCad || "", inputType: "number", min: 0, step: "0.01", required: false })
      );
      editor.append(help, fields);
      break;
    }
    case "surcharge": {
      const help = document.createElement("p");
      help.textContent = "Surcharges are added manually to an order. No automatic pricing rule is configured here yet.";
      editor.append(help);
      break;
    }
    case "dump": {
      const help = document.createElement("p"); help.className = "mbt-field-help";
      const fixedPerBin = item.chargeBasis === "per_bin";
      help.textContent = fixedPerBin
        ? "Fixed customer charge for each bin. Garbage orders add no dumping-fee line."
        : "Customer charge per tonne. The actual dump-site receipt remains separate cost evidence.";
      const fields = document.createElement("div"); fields.className = "mbt-form-grid";
      fields.append(rateRowInput(
        "dump", "amountCad", fixedPerBin ? "CAD / bin" : "CAD / tonne",
        { value: values.amountCad || "", inputType: "number", min: 0, step: "0.01", required: false }
      ));
      if (!fixedPerBin) {
        fields.append(rateRowInput("dump", "minimumCad", "Minimum CAD", { value: values.minimumCad || "0.00", inputType: "number", min: 0, step: "0.01", required: false }));
      }
      editor.append(help, fields);
      break;
    }
    case "aggregate": {
      const help = document.createElement("p"); help.className = "mbt-field-help";
      help.textContent = `Customer charge per cubic yard. Dispatch weight uses ${Number(item.densityLbsPerYard)} lb per yard.`;
      const fields = document.createElement("div"); fields.className = "mbt-form-grid";
      fields.append(rateRowInput(
        "aggregate", "amountCad", "CAD / yard",
        { value: values.amountCad || "", inputType: "number", min: 0, step: "0.01", required: false }
      ));
      editor.append(help, fields);
      break;
    }
    case "delivery_fee": {
      const help = document.createElement("p"); help.className = "mbt-field-help";
      help.textContent = "Create one or more yard-specific price series. Quoted upper limits are inclusive: exactly 30 km stays in Within 30; the next band starts above 30. The final band has no maximum.";
      const list = document.createElement("div"); list.className = "mbt-rate-band-list";
      for (const band of values.bands || []) appendItemDistanceBandRow(list, band);
      const add = document.createElement("button"); add.type = "button"; add.className = "mbt-button-secondary"; add.textContent = "Add distance band";
      add.addEventListener("click", () => appendItemDistanceBandRow(list));
      editor.append(help, list, add);
      break;
    }
    default: {
      const unsupported = document.createElement("p"); unsupported.textContent = "This item type has no supported charging mechanism."; editor.append(unsupported);
    }
  }
}

function activateRatePricingItem(itemCode, { captureCurrent = true } = {}) {
  if (captureCurrent) captureActiveRatePricingItem();
  rateCardState.activePricingItemCode = itemCode;
  renderRatePricingItemOptions(itemCode);
  renderRateItemEditor(itemCode);
}

function kmToMetres(value, label, { nullable = false } = {}) {
  if (!value && nullable) return null;
  const kilometres = Number(value);
  if (!Number.isFinite(kilometres) || kilometres < 0 || Math.round(kilometres * 1000) !== kilometres * 1000) {
    throw new Error(`${label} must be a non-negative distance in kilometres to three decimal places.`);
  }
  return Math.round(kilometres * 1000);
}

function assertNonOverlappingDistanceBands(bands, label) {
  const grouped = new Map();
  for (const band of bands) {
    const key = `${band.itemCode || "legacy"}|${band.serviceCode}|${band.binTypeCode || "all"}|${(band.originYardCodes || []).join("|")}`;
    const group = grouped.get(key) || [];
    group.push(band);
    grouped.set(key, group);
  }
  for (const [binTypeCode, group] of grouped) {
    const ordered = [...group].sort((left, right) => left.minimumMetres - right.minimumMetres);
    if (ordered[0]?.minimumMetres !== 0) {
      throw new Error(`${label} ${binTypeCode} bands must start at 0 km.`);
    }
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      if (current.maximumMetres !== null && current.maximumMetres <= current.minimumMetres) {
        throw new Error(`${label} ${binTypeCode} band end must be greater than its start.`);
      }
      const next = ordered[index + 1];
      if (!next) {
        if (current.maximumMetres !== null) {
          throw new Error(`${label} ${binTypeCode} final band must be open-ended.`);
        }
        continue;
      }
      if (current.maximumMetres === null) {
        throw new Error(`${label} ${binTypeCode} only the final band may be open-ended.`);
      }
      if (current.maximumMetres < next.minimumMetres) {
        throw new Error(`${label} ${binTypeCode} bands have a gap. The next band must start where the prior one ends.`);
      }
      if (current.maximumMetres > next.minimumMetres) {
        throw new Error(`${label} ${binTypeCode} bands overlap. The next band must start where the prior one ends.`);
      }
    }
  }
}

function cadMinorFromValue(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || Math.round(amount * 100) !== amount * 100) throw new Error(`${label} must be valid CAD.`);
  return Math.round(amount * 100);
}

function cadInputValue(minor) {
  return (Number(minor || 0) / 100).toFixed(2);
}

function populateSimplifiedRateEditor(detail) {
  const graph = detail?.graph;
  if (!graph) return;
  rateCardState.rateCardEditorMode = "edit";
  syncUpdateReasonField("rateCardReasonField", "rateCardReason", true);
  rateCardState.selectedVersion = detail.version;
  const header = graph.rateCard || {};
  const version = graph.version || {};
  const set = (id, value) => { const field = readinessElement(id); if (field) field.value = String(value ?? ""); };
  set("rateCardCode", header.rateCardCode);
  set("rateCardDisplayName", header.displayName);
  set("rateCardNotes", version.calculationNotes);
  if (version.effectiveFrom) set("rateCardEffectiveFrom", new Date(version.effectiveFrom).toISOString().slice(0, 16));
  initializeItemPricingState();
  for (const component of graph.components || []) {
    const itemCode = component.itemCode || localItemState.items.find(
      (item) => item.itemType === "bin" && item.binTypeCode === component.binTypeCode
    )?.itemCode;
    const item = pricingItem(itemCode);
    if (!item || item.itemType !== "bin") continue;
    const values = rateCardState.itemPricing.get(itemCode) || itemPricingDefaults(item);
    if (component.componentKind === "rental") values.rentalCad = cadInputValue(component.amountMinor);
    if (component.componentKind === "extension") values.extensionCad = cadInputValue(component.amountMinor);
    rateCardState.itemPricing.set(itemCode, values);
  }
  for (const band of graph.distanceBands || []) {
    const itemCode = band.itemCode || "DELIVERY_CROSS_CHARGE";
    const item = pricingItem(itemCode);
    if (!item || item.itemType !== "delivery_fee") continue;
    const values = rateCardState.itemPricing.get(itemCode) || { bands: [] };
    values.bands.push({
      serviceCode: band.serviceCode,
      binTypeCode: band.binTypeCode,
      minimumKm: (Number(band.minimumMetres) / 1000).toFixed(3),
      maximumKm: band.maximumMetres === null ? "" : (Number(band.maximumMetres) / 1000).toFixed(3),
      amountCad: cadInputValue(band.amountMinor),
      pricingBasis: band.pricingBasis || "flat",
      boundaryRule: band.boundaryRule || "lower_inclusive",
      originYardCodes: Array.isArray(band.originYardCodes) ? band.originYardCodes : []
    });
    rateCardState.itemPricing.set(itemCode, values);
  }
  for (const tariff of graph.dumpTariffs || []) {
    const itemCode = tariff.itemCode || tariff.materialCode || "DUMP";
    const item = pricingItem(itemCode);
    if (!item || !["dump", "aggregate"].includes(item.itemType)) continue;
    rateCardState.itemPricing.set(itemCode, {
      amountCad: cadInputValue(tariff.amountMinor),
      minimumCad: cadInputValue(tariff.minimumAmountMinor)
    });
  }
  const firstConfigured = header.itemCode || [...rateCardState.itemPricing.entries()].find(([, values]) => (
    values.rentalCad || values.amountCad || values.bands?.length
  ))?.[0] || localItemState.items.find((item) => item.active)?.itemCode || "";
  // Loading a saved graph replaces the editor draft. Do not let activation
  // capture the previously rendered (often empty) item and overwrite the
  // values that were just hydrated above.
  rateCardState.activePricingItemCode = "";
  activateRatePricingItem(firstConfigured, { captureCurrent: false });
  updateRateLifecycle(detail.version);
  setSimplifiedRateEditorEditable({
    editable: detail.version?.editable === true,
    identityLocked: true
  });
}

function setSimplifiedRateEditorEditable({ editable, identityLocked }) {
  const form = readinessElement("rateCardForm");
  if (!form) return;
  for (const field of form.querySelectorAll("input, textarea")) {
    field.readOnly = !editable || (identityLocked && ["rateCardCode", "rateCardDisplayName"].includes(field.id));
  }
  for (const field of form.querySelectorAll("select")) field.disabled = !editable;
  for (const button of form.querySelectorAll("button")) button.disabled = !editable;
  const submit = form.querySelector("button[type='submit']");
  if (submit) submit.textContent = editable ? "Save draft changes" : "Use “Clone as new draft” to edit";
}

async function loadRateCardForEdit(versionId) {
  if (!versionId) return;
  setConfigMessage("rateCardsMessage", "Loading the selected local rate card…");
  try {
    const detail = await api(`/api/mbt/config/rate-cards/${encodeURIComponent(versionId)}`);
    populateSimplifiedRateEditor(detail);
    setConfigMessage("rateCardsMessage", "Draft loaded. Save updates with its current revision, or clone an active/used version first.");
  } catch (error) {
    setConfigMessage("rateCardsMessage", error.message, "attention");
  }
}

function newRateCardEditor() {
  rateCardState.rateCardEditorMode = "create";
  rateCardState.selectedVersion = null;
  syncUpdateReasonField("rateCardReasonField", "rateCardReason", false);
  const select = readinessElement("rateCardVersionSelect"); if (select) select.value = "";
  updateRateLifecycle(null);
  for (const id of [
    "rateCardCode", "rateCardDisplayName", "rateCardEffectiveFrom", "rateCardNotes"
  ]) {
    const field = readinessElement(id); if (field) { field.value = ""; field.readOnly = false; }
  }
  initializeItemPricingState();
  const submit = readinessElement("rateCardForm")?.querySelector("button[type='submit']");
  if (submit) submit.textContent = "Save draft";
  activateRatePricingItem(firstAvailableRateItemCode(), {
    captureCurrent: false
  });
  setSimplifiedRateEditorEditable({ editable: true, identityLocked: false });
  readinessElement("rateCardCode")?.focus({ preventScroll: true });
}

function simplifiedRateCardGraph() {
  captureActiveRatePricingItem();
  const selectedItem = pricingItem(rateCardState.activePricingItemCode);
  if (!selectedItem || selectedItem.active === false) {
    throw new Error("Select an active local item for this rate card.");
  }
  const configuredItems = localItemState.items.filter((item) => (
    item.active === true && rateItemConfigured(item.itemCode)
  ));
  if (!configuredItems.length) {
    throw new Error("Configure at least one local item before saving this rate card.");
  }
  const components = [];
  const distanceBands = [];
  const dumpTariffs = [];
  for (const item of configuredItems) {
    const values = rateCardState.itemPricing.get(item.itemCode) || itemPricingDefaults(item);
    const slug = item.itemCode.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
    if (item.itemType === "bin" && (values.rentalCad || values.extensionCad)) {
      if (!values.rentalCad || !values.extensionCad) throw new Error(`${item.itemCode} requires both rental and extension prices.`);
      const rentalDays = Number(item.rentalPeriodDays || 14);
      components.push(
        { itemCode: item.itemCode, componentCode: `rental_${slug}`, componentKind: "rental", serviceCode: "delivery", binTypeCode: item.binTypeCode, rateBasis: "flat", amountMinor: cadMinorFromValue(values.rentalCad, `${item.itemCode} rental`), percentageBasisPoints: null, defaultQuantity: 1, currency: "CAD", taxable: true, active: true, description: `${item.displayName} fixed ${rentalDays}-day rental` },
        { itemCode: item.itemCode, componentCode: `extension_${slug}`, componentKind: "extension", serviceCode: "extension", binTypeCode: item.binTypeCode, rateBasis: "per_day", amountMinor: cadMinorFromValue(values.extensionCad, `${item.itemCode} extension`), percentageBasisPoints: null, defaultQuantity: 1, currency: "CAD", taxable: true, active: true, description: `${item.displayName} extension per Toronto calendar day` }
      );
    }
    if (item.itemType === "delivery_fee" && values.bands?.length) {
      for (const [sequenceNumber, band] of values.bands.entries()) {
        distanceBands.push({
          itemCode: item.itemCode,
          serviceCode: band.serviceCode || "delivery",
          binTypeCode: band.serviceCode === "delivery" ? (band.binTypeCode || "14YD") : null,
          sequenceNumber,
          minimumMetres: kmToMetres(band.minimumKm, `${item.itemCode} band start`),
          maximumMetres: kmToMetres(band.maximumKm, `${item.itemCode} band end`, { nullable: true }),
          amountMinor: cadMinorFromValue(band.amountCad, `${item.itemCode} band amount`),
          pricingBasis: band.pricingBasis || "flat",
          boundaryRule: band.boundaryRule || "upper_inclusive",
          originYardCodes: [...new Set(band.originYardCodes || [])].sort(),
          downtownSurchargeMinor: 0, currency: "CAD", description: `${item.displayName} distance band ${sequenceNumber + 1}`
        });
      }
    }
    if (item.itemType === "dump" && values.amountCad) {
      const fixedPerBin = item.chargeBasis === "per_bin";
      dumpTariffs.push({
        itemCode: item.itemCode, dumpSiteCode: null, materialCode: null,
        tariffCode: `customer_${slug}`,
        pricingBasis: fixedPerBin ? "per_quantity" : "per_weight",
        unitOfMeasure: fixedPerBin ? "BIN" : "TONNE",
        amountMinor: cadMinorFromValue(values.amountCad, `${item.itemCode} dump tariff`),
        minimumAmountMinor: fixedPerBin
          ? 0
          : cadMinorFromValue(values.minimumCad || "0", `${item.itemCode} dump minimum`),
        currency: "CAD", active: true,
        description: `${item.displayName} customer tariff ${fixedPerBin ? "per bin" : "per tonne"}`
      });
    }
    if (item.itemType === "aggregate" && values.amountCad) {
      dumpTariffs.push({
        itemCode: item.itemCode, dumpSiteCode: null, materialCode: null,
        tariffCode: `customer_${slug}`, pricingBasis: "per_quantity", unitOfMeasure: "YARD",
        amountMinor: cadMinorFromValue(values.amountCad, `${item.itemCode} aggregate tariff`),
        minimumAmountMinor: 0,
        currency: "CAD", active: true, description: `${item.displayName} customer tariff per yard`
      });
    }
  }
  if (distanceBands.length) assertNonOverlappingDistanceBands(distanceBands, "Distance");
  return {
    rateCard: {
      rateCardCode: inputValue("rateCardCode").toUpperCase(),
      displayName: inputValue("rateCardDisplayName"),
      itemCode: null,
      description: "Local manual rate card",
      customerNetSuiteId: null,
      subsidiaryNetSuiteId: null,
      serviceTemplateCode: null,
      currency: "CAD",
      active: true
    },
    version: {
      versionNumber: Number(rateCardState.selectedVersion?.versionNumber || 1),
      effectiveFrom: rateEffectiveFrom(),
      effectiveTo: null,
      defaultRentalCalendarDays: 14,
      calculationNotes: inputValue("rateCardNotes") || "Fixed 14 Toronto calendar day rental."
    },
    distanceBands,
    components,
    dumpTariffs,
    depositRules: []
  };
}

function updateRateLifecycle(version) {
  const versionInput = readinessElement("rateCardVersionId");
  const revisionInput = readinessElement("rateCardExpectedRevision");
  if (versionInput) versionInput.value = version?.rateCardVersionId || "";
  if (revisionInput) revisionInput.value = version?.revision || "";
  const select = readinessElement("rateCardVersionSelect");
  if (select && version?.rateCardVersionId) select.value = version.rateCardVersionId;
}

async function saveRateCardDraft(event) {
  event.preventDefault();
  if (rateCardSaveInFlight) return;
  rateCardSaveInFlight = true;
  const form = event.currentTarget;
  const submit = form?.querySelector("button[type='submit']");
  if (submit) submit.disabled = true;
  form?.setAttribute("aria-busy", "true");
  setConfigMessage("rateCardsMessage", "Saving the local draft graph…");
  try {
    const editing = rateCardState.rateCardEditorMode === "edit" && rateCardState.selectedVersion?.rateCardVersionId;
    const versionId = rateCardState.selectedVersion?.rateCardVersionId;
    const result = await api(editing
      ? `/api/mbt/config/rate-cards/${encodeURIComponent(versionId)}`
      : "/api/mbt/config/rate-cards", {
      method: editing ? "PUT" : "POST",
      idempotencyKey: commandIdentity("mbt-rate-card-draft"),
      body: {
        sourceKind: "manual",
        graph: simplifiedRateCardGraph(),
        ...(editing ? { expectedRevision: Number(rateCardState.selectedVersion.revision) } : {}),
        reason: editing
          ? inputValue("rateCardReason")
          : defaultCreationReason("", "Created local rate-card draft")
      }
    });
    rateCardState.selectedVersion = result.version;
    rateCardState.rateCardEditorMode = "edit";
    upsertRateCardVersion(result.version);
    syncUpdateReasonField("rateCardReasonField", "rateCardReason", true);
    updateRateLifecycle(result.version);
    setConfigMessage("rateCardsMessage", editing ? "Draft changes saved. Validate it before activation." : "Local draft saved. Validate it before activation.");
  } catch (error) {
    setConfigMessage("rateCardsMessage", error.message, "attention");
  } finally {
    rateCardSaveInFlight = false;
    form?.setAttribute("aria-busy", "false");
    if (submit) submit.disabled = false;
  }
}

async function runRateCardLifecycle(action) {
  const versionId = inputValue("rateCardVersionId");
  const expectedRevision = integerInput("rateCardExpectedRevision");
  if (!versionId || expectedRevision < 1) {
    setConfigMessage("rateCardsMessage", "Select a rate-card version and positive revision.", "attention");
    return;
  }
  setConfigMessage("rateCardsMessage", `${action === "clone" ? "Cloning" : `${action}ing`} rate-card version…`);
  try {
    const result = await api(
      `/api/mbt/config/rate-cards/${encodeURIComponent(versionId)}/${action}`,
      {
        method: "POST",
        idempotencyKey: commandIdentity(`mbt-rate-card-${action}`),
        body: {
          expectedRevision,
          reason: inputValue("rateCardLifecycleReason")
        }
      }
    );
    updateRateLifecycle(result.version);
    await loadRateCards();
    await loadRateCardForEdit(String(result.version?.rateCardVersionId || versionId));
    setConfigMessage("rateCardsMessage", `Rate-card ${action} completed locally.`);
  } catch (error) {
    setConfigMessage("rateCardsMessage", error.message, "attention");
  }
}

async function previewRateCardCsv() {
  const controls = [
    ["rate_cards", "rateCardHeaderCsv"],
    ["distance_bands", "rateCardBandsCsv"],
    ["components", "rateCardComponentsCsv"],
    ["dump_tariffs", "rateCardTariffsCsv"],
    ["deposit_rules", "rateCardDepositsCsv"]
  ];
  const files = controls.map(([, id]) => readinessElement(id)?.files?.[0] || null);
  const preview = readinessElement("rateCardCsvPreview");
  const previewButton = readinessElement("previewRateCardCsvButton");
  const applyButton = readinessElement("applyRateCardCsvButton");
  if (files.some((file) => !file)) {
    rateCardState.csvPreview = null;
    if (applyButton) applyButton.disabled = true;
    if (preview) preview.textContent = "Select all five CSV files before previewing the complete graph.";
    setConfigMessage("rateCardsMessage", "The atomic CSV graph requires all five files.", "attention");
    return;
  }
  if (previewButton) previewButton.disabled = true;
  if (applyButton) applyButton.disabled = true;
  setConfigMessage("rateCardsMessage", "Validating all five CSV files on the server…");
  try {
    const content = await Promise.all(files.map((file) => file.text()));
    const bundle = Object.fromEntries(controls.map(([key], index) => [key, {
      fileName: files[index].name,
      content: content[index]
    }]));
    const result = await api("/api/mbt/config/rate-card-imports/preview", {
      method: "POST",
      body: { files: bundle }
    });
    rateCardState.csvPreview = result;
    if (preview) {
      preview.textContent = safeJson({
        batchId: result.batchId,
        normalizedHash: result.normalizedHash,
        targetRevisionToken: result.targetRevisionToken,
        summary: result.summary,
        graph: result.graph
      });
    }
    const readyApplyRateCardCsvButton = readinessElement("applyRateCardCsvButton");
    if (readyApplyRateCardCsvButton) readyApplyRateCardCsvButton.disabled = false;
    setConfigMessage("rateCardsMessage", "Server preview is ready. Review the complete graph before applying it.");
  } catch (error) {
    rateCardState.csvPreview = null;
    if (applyButton) applyButton.disabled = true;
    setConfigMessage("rateCardsMessage", error.message, "attention");
  } finally {
    if (previewButton) previewButton.disabled = false;
  }
}

async function applyRateCardCsv() {
  if (!rateCardState.csvPreview) return;
  const { batchId, normalizedHash, targetRevisionToken } = rateCardState.csvPreview;
  const applyButton = readinessElement("applyRateCardCsvButton");
  if (applyButton) applyButton.disabled = true;
  setConfigMessage("rateCardsMessage", "Applying the validated five-file graph atomically…");
  try {
    const result = await api("/api/mbt/config/rate-card-imports/apply", {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-rate-card-csv-apply"),
      body: {
        batchId,
        normalizedHash,
        targetRevisionToken,
        reason: defaultCreationReason(
          inputValue("rateCardCsvReason"),
          "Created local rate card from approved CSV import"
        )
      }
    });
    updateRateLifecycle(result.version);
    rateCardState.csvPreview = null;
    const preview = readinessElement("rateCardCsvPreview");
    if (preview) preview.textContent = safeJson(result);
    await loadRateCards();
    setConfigMessage("rateCardsMessage", "Five-file rate-card draft applied locally. Validate it before activation.");
  } catch (error) {
    if (applyButton) applyButton.disabled = false;
    setConfigMessage("rateCardsMessage", error.message, "attention");
  }
}

function localItemPriceLabel(item) {
  return ({
    bin: `Fixed ${Number(item.rentalPeriodDays || 14)}-day rental + extension`,
    surcharge: "Manually added charge",
    dump: item.chargeBasis === "per_bin" ? "Fixed price per bin" : "Price per tonne",
    aggregate: "Price per cubic yard",
    delivery_fee: "Item-specific distance bands"
  })[String(item.itemType || "")] || "Server configured";
}

function localItemIdentity(item) {
  const type = ({
    bin: "Bin",
    surcharge: "Surcharge",
    dump: "Dump",
    aggregate: "Aggregate",
    delivery_fee: "Delivery fee"
  })[String(item.itemType || "")] || "Local item";
  return item.itemType === "bin"
    ? `${type} · ${Number(item.binCapacityYards || 0) || "?"} cubic yards`
    : type;
}

function localItemFutureStatus(item) {
  if (!item.netSuiteMappingLocalKey || item.futureNetSuiteStatus === "not_applicable") {
    return "No exact future NetSuite item";
  }
  if (item.futureNetSuiteStatus === "verified") {
    return "Future mapping verified";
  }
  if (item.futureNetSuiteStatus === "unverified") {
    return "Future mapping needs verification";
  }
  return "Future mapping optional";
}

function orderedLocalItems(items) {
  const order = new Map(LOCAL_ITEM_ORDER.map((itemCode, index) => [itemCode, index]));
  return [...items].sort((left, right) => (
    (order.get(String(left.itemCode)) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(String(right.itemCode)) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function upsertLocalItem(item) {
  if (!item?.itemCode) return;
  const existing = localItemState.items.findIndex((candidate) => candidate.itemCode === item.itemCode);
  if (existing >= 0) {
    localItemState.items.splice(existing, 1, item);
  } else {
    localItemState.items.push(item);
  }
  localItemState.items = orderedLocalItems(localItemState.items);
  if (!rateCardState.itemPricing.has(item.itemCode)) {
    rateCardState.itemPricing.set(item.itemCode, itemPricingDefaults(item));
  }
  renderLocalItems();
  renderRatePricingItemOptions(rateCardState.activePricingItemCode);
}

function renderLocalItems() {
  const rows = readinessElement("localItemRows");
  if (!rows) {
    return;
  }
  rows.replaceChildren();
  const items = orderedLocalItems(localItemState.items);
  if (!items.length) {
    const row = document.createElement("tr");
    const empty = textCell("No local item settings are available.");
    empty.colSpan = 5;
    row.append(empty);
    rows.append(row);
    return;
  }
  for (const item of items) {
    const row = document.createElement("tr");

    const itemCell = document.createElement("td");
    const name = document.createElement("strong");
    name.textContent = String(item.displayName || item.itemCode || "Local item");
    const code = document.createElement("span");
    code.className = "mbt-cell-detail";
    code.textContent = `${item.itemCode} · revision ${item.revision}`;
    const description = document.createElement("span");
    description.className = "mbt-cell-description";
    description.textContent = String(item.description || "No local description.");
    itemCell.append(name, code, description);

    const identityCell = document.createElement("td");
    identityCell.textContent = localItemIdentity(item);
    const identityPolicy = document.createElement("span");
    identityPolicy.className = "mbt-cell-detail";
    identityPolicy.textContent = "Server-owned identity";
    identityCell.append(identityPolicy);

    const pricingCell = textCell(localItemPriceLabel(item));

    const readinessCell = document.createElement("td");
    const localStatus = document.createElement("strong");
    localStatus.textContent = item.active === false
      ? "Inactive"
      : item.localReady === true
        ? "Local ready"
        : "Needs review";
    const futureStatus = document.createElement("span");
    futureStatus.className = "mbt-cell-detail";
    futureStatus.textContent = localItemFutureStatus(item);
    readinessCell.dataset.status = item.active === false
      ? "inactive"
      : item.localReady === true
        ? "local_ready"
        : "needs_review";
    readinessCell.append(localStatus, futureStatus);

    const actionCell = document.createElement("td");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "mbt-button-secondary";
    editButton.textContent = `Edit ${item.itemCode}`;
    editButton.addEventListener("click", () => openLocalItemEditor(item.itemCode));
    const stateButton = document.createElement("button");
    stateButton.type = "button";
    stateButton.className = "mbt-button-secondary";
    stateButton.textContent = item.active === true ? "Inactivate" : "Activate";
    stateButton.addEventListener("click", () => setLocalItemActive(item, item.active !== true));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "mbt-button-secondary";
    deleteButton.textContent = "Delete";
    deleteButton.disabled = item.systemOwned === true;
    deleteButton.title = item.systemOwned === true
      ? "System-owned items can be made inactive but cannot be deleted."
      : "Deletion is allowed only when no record links this item.";
    deleteButton.addEventListener("click", () => deleteLocalItem(item));
    actionCell.className = "mbt-table-actions";
    actionCell.append(editButton, stateButton, deleteButton);

    row.append(itemCell, identityCell, pricingCell, readinessCell, actionCell);
    rows.append(row);
  }
}

async function setLocalItemActive(item, active) {
  try {
    await api(`/api/mbt/config/local/items/${encodeURIComponent(item.itemCode)}/state`, {
      method: "PATCH",
      idempotencyKey: commandIdentity("mbt-local-item-state"),
      body: { active, expectedRevision: Number(item.revision) }
    });
    await loadLocalItems();
    setLocalItemMessage(`${item.itemCode} is now ${active ? "active" : "inactive"}.`);
  } catch (error) {
    setLocalItemMessage(error.message, "attention");
  }
}

async function deleteLocalItem(item) {
  if (item.systemOwned === true) return;
  if (!globalThis.confirm(`Delete ${item.itemCode}? Any linked asset, rate, billing, dump-site, or delivery record will prevent deletion.`)) return;
  try {
    await api(`/api/mbt/config/local/items/${encodeURIComponent(item.itemCode)}`, {
      method: "DELETE",
      idempotencyKey: commandIdentity("mbt-local-item-delete"),
      body: { expectedRevision: Number(item.revision) }
    });
    await loadLocalItems();
    setLocalItemMessage(`${item.itemCode} was unused and has been deleted.`);
  } catch (error) {
    setLocalItemMessage(error.message, "attention");
  }
}

function openLocalItemEditor(itemCode) {
  const item = localItemState.items.find((candidate) => candidate.itemCode === itemCode);
  if (!item) {
    return;
  }
  localItemState.editingItem = item;
  localItemState.pendingCommand = null;
  fieldValue("localItemCode", item.itemCode);
  fieldValue("localItemRevision", item.revision);
  fieldValue("localItemDisplayName", item.displayName);
  fieldValue("localItemDescription", item.description);
  fieldValue("localItemChargeBasis", item.chargeBasis);
  const chargeBasisField = readinessElement("localItemChargeBasisField");
  const chargeBasis = readinessElement("localItemChargeBasis");
  if (chargeBasisField) chargeBasisField.hidden = item.itemType !== "dump";
  if (chargeBasis instanceof HTMLSelectElement) chargeBasis.disabled = item.itemType !== "dump";
  fieldValue("localItemReason", "");
  const active = readinessElement("localItemActive");
  if (active) {
    active.checked = item.active === true;
  }
  const title = readinessElement("localItemEditorTitle");
  if (title) {
    title.textContent = `Edit ${item.itemCode}`;
  }
  const help = readinessElement("localItemIdentityHelp");
  if (help) {
    help.textContent = `${localItemIdentity(item)} · ${localItemPriceLabel(item)}. Existing activated rate versions keep their stored unit and amount.`;
  }
  const editor = readinessElement("localItemEditor");
  if (editor) {
    editor.hidden = false;
  }
  setLocalItemMessage(`Editing ${item.itemCode}. Unsaved text stays in this form until you save or cancel.`);
  readinessElement("localItemDisplayName")?.focus({ preventScroll: true });
}

function closeLocalItemEditor() {
  if (localItemSaveInFlight) {
    return;
  }
  localItemState.editingItem = null;
  localItemState.pendingCommand = null;
  const editor = readinessElement("localItemEditor");
  if (editor) {
    editor.hidden = true;
  }
}

function localItemCommandIdentity(itemCode, body) {
  const fingerprint = JSON.stringify([itemCode, body]);
  if (localItemState.pendingCommand?.fingerprint === fingerprint) {
    return localItemState.pendingCommand.idempotencyKey;
  }
  const pendingCommand = {
    fingerprint,
    idempotencyKey: commandIdentity("mbt-local-item")
  };
  localItemState.pendingCommand = pendingCommand;
  return pendingCommand.idempotencyKey;
}

async function saveLocalItem(event) {
  event.preventDefault();
  if (localItemSaveInFlight) {
    return;
  }
  const item = localItemState.editingItem;
  if (!item) {
    return;
  }
  const activeField = readinessElement("localItemActive");
  const body = {
    displayName: inputValue("localItemDisplayName"),
    description: inputValue("localItemDescription"),
    active: activeField?.checked === true,
    ...(item.itemType === "dump" ? { chargeBasis: inputValue("localItemChargeBasis") } : {}),
    expectedRevision: Number(item.revision),
    reason: inputValue("localItemReason")
  };
  const idempotencyKey = localItemCommandIdentity(item.itemCode, body);
  const form = readinessElement("localItemForm");
  const saveButton = readinessElement("saveLocalItemButton");
  localItemSaveInFlight = true;
  if (form) {
    form.setAttribute("aria-busy", "true");
  }
  if (saveButton) {
    saveButton.disabled = true;
  }
  setLocalItemMessage(`Saving ${item.itemCode}…`);
  try {
    const result = await api(
      `/api/mbt/config/local/items/${encodeURIComponent(item.itemCode)}`,
      { method: "PUT", body, idempotencyKey }
    );
    const savedItem = result?.item && typeof result.item === "object"
      ? { ...item, ...result.item }
      : { ...item, ...body, revision: Number(item.revision) + 1 };
    localItemState.items = localItemState.items.map((candidate) => (
      candidate.itemCode === item.itemCode ? savedItem : candidate
    ));
    localItemState.editingItem = savedItem;
    localItemState.pendingCommand = null;
    renderLocalItems();
    const editor = readinessElement("localItemEditor");
    if (editor) {
      editor.hidden = true;
    }
    localItemState.editingItem = null;
    setLocalItemMessage(`Local item saved. ${item.itemCode} is now at revision ${savedItem.revision}.`);
  } catch (error) {
    if (error.status !== undefined && Number(error.status) < 500) {
      localItemState.pendingCommand = null;
    }
    setLocalItemMessage(
      error.code === "MBT_STALE_REVISION"
        ? "This local item changed elsewhere. Your draft is still here; refresh and review before saving again."
        : error.message,
      "attention"
    );
  } finally {
    localItemSaveInFlight = false;
    if (form) {
      form.setAttribute("aria-busy", "false");
    }
    if (saveButton) {
      saveButton.disabled = false;
    }
  }
}

async function loadLocalItems() {
  setLocalItemMessage("Loading local item settings.");
  const result = await api("/api/mbt/config/local/items");
  if (!Array.isArray(result?.items)) {
    throw new Error("The local item settings response is incomplete.");
  }
  localItemState.items = orderedLocalItems(result.items);
  renderLocalItems();
  for (const item of localItemState.items) {
    if (!rateCardState.itemPricing.has(item.itemCode)) {
      rateCardState.itemPricing.set(item.itemCode, itemPricingDefaults(item));
    }
  }
  const selectedPricingItem = localItemState.items.some(
    (item) => item.itemCode === rateCardState.activePricingItemCode
  )
    ? rateCardState.activePricingItemCode
    : localItemState.items.find((item) => item.active)?.itemCode || "";
  rateCardState.activePricingItemCode = selectedPricingItem;
  renderRatePricingItemOptions(selectedPricingItem);
  renderRateItemEditor(selectedPricingItem);
  setLocalItemMessage(`${localItemState.items.length} local items loaded. NetSuite setup was not requested.`);
}

function displayLabel(requirement) {
  return String(requirement?.display?.label || requirement?.checkCode || "Required mapping");
}

function currentMapping(requirement) {
  return requirement?.mapping || requirement?.currentMapping || null;
}

function textCell(value) {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "");
  return cell;
}

function mappingStatus(mapping) {
  if (!mapping) {
    return "Missing";
  }
  if (!mapping.active) {
    return "Inactive";
  }
  return mapping.validationStatus === "valid" ? "Verified" : "Needs preflight";
}

function runtimeText(id, value) {
  const element = readinessElement(id);
  if (element) {
    element.textContent = value === null || value === undefined || value === ""
      ? "Unavailable"
      : String(value);
  }
}

function normalizedAccount(value) {
  return String(value || "").trim().toUpperCase();
}

function renderRuntimeBinding(runtimeBinding) {
  const binding = runtimeBinding && typeof runtimeBinding === "object"
    ? runtimeBinding
    : {};
  const accountId = String(binding.accountId || "").trim();
  const allowlist = Array.isArray(binding.sandboxAccountAllowlist)
    ? binding.sandboxAccountAllowlist.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const allowlistMatched = typeof binding.allowlistMatched === "boolean"
    ? binding.allowlistMatched
    : Boolean(accountId && allowlist.some((value) => normalizedAccount(value) === normalizedAccount(accountId)));
  const readTimeoutMs = Number(binding.readTimeoutMs);
  const effectiveLeaseSeconds = Number(
    binding.effectivePreflightLeaseSeconds ?? binding.preflightLeaseSeconds
  );

  runtimeText("runtimeAccountId", accountId);
  runtimeText("runtimeEnvironment", binding.environmentName);
  runtimeText(
    "runtimeRestRoot",
    binding.normalizedRestRoot || binding.restBaseUrl || binding.restRoot
  );
  runtimeText(
    "runtimeDirectAccess",
    typeof binding.directAccessEnabled === "boolean"
      ? (binding.directAccessEnabled ? "Enabled" : "Disabled")
      : null
  );
  runtimeText(
    "runtimeAllowlistStatus",
    allowlist.length || typeof binding.allowlistMatched === "boolean"
      ? (allowlistMatched ? "Matched" : "Not matched")
      : null
  );
  runtimeText("runtimeAllowlist", allowlist.length ? allowlist.join(", ") : null);
  runtimeText(
    "runtimeReadTimeout",
    Number.isFinite(readTimeoutMs) && readTimeoutMs >= 0
      ? `${readTimeoutMs.toLocaleString("en-CA")} ms`
      : null
  );
  runtimeText(
    "runtimePreflightLease",
    Number.isFinite(effectiveLeaseSeconds) && effectiveLeaseSeconds >= 0
      ? `${effectiveLeaseSeconds.toLocaleString("en-CA")} seconds`
      : null
  );
}

function renderMappings() {
  const rows = readinessElement("mappingRows");
  const hash = readinessElement("configurationHash");
  if (!rows || !hash) {
    return;
  }
  hash.textContent = readinessState.configurationHash
    ? `Configuration hash: ${readinessState.configurationHash}`
    : "Configuration hash unavailable.";
  rows.replaceChildren();
  for (const requirement of readinessState.requirements) {
    const mapping = currentMapping(requirement);
    const row = document.createElement("tr");
    const requirementCell = document.createElement("td");
    const label = document.createElement("strong");
    label.textContent = displayLabel(requirement);
    const key = document.createElement("span");
    key.className = "mbt-cell-detail";
    key.textContent = `${requirement.mappingType} · ${requirement.localKey}`;
    requirementCell.append(label, key);
    const mappingCell = document.createElement("td");
    mappingCell.textContent = mapping
      ? `${mapping.externalName || mapping.externalId} · ${mapping.externalId}`
      : "Not configured";
    const statusCell = textCell(mappingStatus(mapping));
    statusCell.dataset.status = mappingStatus(mapping).toLowerCase().replaceAll(" ", "_");
    const actionCell = document.createElement("td");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "mbt-button-secondary";
    editButton.textContent = `Edit ${displayLabel(requirement)} mapping`;
    editButton.addEventListener("click", () => openMappingEditor(requirement));
    actionCell.append(editButton);
    row.append(requirementCell, mappingCell, statusCell, actionCell);
    rows.append(row);
  }
}

function fieldValue(id, value) {
  const field = readinessElement(id);
  if (field) {
    field.value = value === null || value === undefined ? "" : String(value);
  }
}

const OFFICIAL_EVIDENCE_LABELS = Object.freeze({
  baseCurrency: "currency"
});

function naturalLanguageList(values) {
  if (values.length < 2) {
    return values[0] || "";
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function semanticEvidenceHelp(requirement) {
  const suppliedGuidance = String(requirement?.display?.guidance || "").trim();
  if (suppliedGuidance) {
    return suppliedGuidance;
  }
  const fields = Array.isArray(requirement?.requiredExpectedFields)
    ? requirement.requiredExpectedFields
      .map((field) => String(field || "").trim())
      .filter(Boolean)
      .map((field) => OFFICIAL_EVIDENCE_LABELS[field] || field)
    : [];
  return fields.length
    ? `Required official REST evidence: ${naturalLanguageList(fields)}.`
    : "";
}

function openMappingEditor(requirement) {
  readinessState.editingRequirement = requirement;
  const mapping = currentMapping(requirement);
  fieldValue("mappingType", requirement.mappingType);
  fieldValue("mappingLocalKey", requirement.localKey);
  fieldValue("mappingRevision", mapping?.revision || 0);
  fieldValue("mappingExternalId", mapping?.externalId || "");
  fieldValue("mappingExternalName", mapping?.externalName || "");
  fieldValue("mappingRecordType", mapping?.externalRecordType || requirement.expectedRecordType);
  fieldValue("mappingScriptId", mapping?.externalScriptId || "");
  fieldValue("mappingSubsidiaryId", mapping?.subsidiaryNetSuiteId || "");
  fieldValue(
    "mappingConfiguration",
    JSON.stringify(mapping?.configuration || {
      expected: requirement.expected || {},
      caseInsensitiveFields: []
    }, null, 2)
  );
  fieldValue("mappingReason", "");
  const semanticHelp = readinessElement("mappingSemanticHelp");
  const semanticMessage = semanticEvidenceHelp(requirement);
  if (semanticHelp) {
    semanticHelp.textContent = semanticMessage;
    semanticHelp.hidden = !semanticMessage;
  }
  const subsidiaryField = readinessElement("mappingSubsidiaryId");
  const subsidiaryHelp = readinessElement("mappingSubsidiaryHelp");
  const subsidiaryRequired = requirement.requiresSubsidiaryNetSuiteId === true;
  if (subsidiaryField) {
    subsidiaryField.required = subsidiaryRequired;
  }
  if (subsidiaryHelp) {
    subsidiaryHelp.textContent = subsidiaryRequired
      ? "Required for this customer or item mapping."
      : "Not required for this mapping.";
  }
  const editor = readinessElement("mappingEditor");
  const title = readinessElement("mappingEditorTitle");
  if (title) {
    title.textContent = `Edit ${displayLabel(requirement)} mapping`;
  }
  if (editor) {
    editor.hidden = false;
  }
  readinessElement("mappingExternalId")?.focus();
}

function closeMappingEditor() {
  readinessState.editingRequirement = null;
  const editor = readinessElement("mappingEditor");
  if (editor) {
    editor.hidden = true;
  }
}

function normalizedSignoff(signoff) {
  if (!signoff) {
    return null;
  }
  return {
    ...signoff,
    current: signoff.current === true,
    auditNote: signoff.auditNote || signoff.note || "",
    note: signoff.note || signoff.auditNote || ""
  };
}

function renderPreflight(run) {
  readinessState.run = run || null;
  const summary = readinessElement("latestRunSummary");
  const rows = readinessElement("preflightRows");
  const links = readinessElement("reportLinks");
  const signoffButton = readinessElement("signoffButton");
  if (!summary || !rows || !links || !signoffButton) {
    return;
  }
  rows.replaceChildren();
  if (!run) {
    summary.textContent = "No preflight evidence is available.";
    const empty = textCell("No preflight has run.");
    empty.colSpan = 4;
    const row = document.createElement("tr");
    row.append(empty);
    rows.append(row);
    links.hidden = true;
    signoffButton.disabled = true;
    return;
  }
  const status = String(run.status || "unknown");
  const current = run.current === true ? "current" : "historical";
  summary.textContent = `Status: ${status} · ${current} · ${run.generatedAt || "time unavailable"}`;
  const checks = Array.isArray(run.checks) ? run.checks : [];
  for (const check of checks) {
    const row = document.createElement("tr");
    row.append(
      textCell(check.checkCode),
      textCell(check.severity),
      textCell(check.status),
      textCell(check.message)
    );
    rows.append(row);
  }
  if (!checks.length) {
    const row = document.createElement("tr");
    const empty = textCell("This run has no persisted checks.");
    empty.colSpan = 4;
    row.append(empty);
    rows.append(row);
  }
  const jsonLink = readinessElement("jsonReportLink");
  const csvLink = readinessElement("csvReportLink");
  const reportBase = `/api/mbt/config/netsuite/preflight/${encodeURIComponent(run.runId)}/export`;
  if (jsonLink && csvLink) {
    jsonLink.href = `${reportBase}?format=json`;
    csvLink.href = `${reportBase}?format=csv`;
  }
  links.hidden = false;
  const signoff = normalizedSignoff(run.signoff);
  signoffButton.disabled = run.ready !== true || run.current !== true || Boolean(signoff?.current);
}

function inputValue(id) {
  return String(readinessElement(id)?.value || "").trim();
}

function defaultCreationReason(enteredReason, fallback) {
  return String(enteredReason || "").trim() || String(fallback || "Created local MBT record").trim();
}

function syncUpdateReasonField(fieldId, inputId, updating) {
  const field = readinessElement(fieldId);
  const input = readinessElement(inputId);
  if (field) field.hidden = !updating;
  if (input) {
    input.required = updating;
    input.value = "";
  }
}

function commandIdentity(prefix) {
  const unique = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${unique}`;
}

async function saveMapping(event) {
  event.preventDefault();
  const requirement = readinessState.editingRequirement;
  if (!requirement) {
    return;
  }
  const subsidiaryText = inputValue("mappingSubsidiaryId");
  const subsidiaryId = subsidiaryText ? Number(subsidiaryText) : null;
  if (subsidiaryText && (!Number.isSafeInteger(subsidiaryId) || subsidiaryId <= 0)) {
    setReadinessMessage("Enter a valid positive subsidiary internal ID.", "attention");
    return;
  }
  const existing = currentMapping(requirement);
  let configuration;
  try {
    configuration = JSON.parse(inputValue("mappingConfiguration"));
  } catch {
    setReadinessMessage("Verification configuration must be a valid JSON object.", "attention");
    return;
  }
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    setReadinessMessage("Verification configuration must be a JSON object.", "attention");
    return;
  }
  const body = {
    mappingType: requirement.mappingType,
    localKey: requirement.localKey,
    mapping: {
      externalId: inputValue("mappingExternalId"),
      externalScriptId: inputValue("mappingScriptId") || null,
      externalName: inputValue("mappingExternalName"),
      externalRecordType: inputValue("mappingRecordType"),
      subsidiaryNetSuiteId: subsidiaryId,
      configuration,
      active: true
    },
    expectedRevision: Number(existing?.revision || 0),
    reason: inputValue("mappingReason")
  };
  try {
    setReadinessMessage("Saving mapping…");
    const result = await api("/api/mbt/config/netsuite/mappings", {
      method: "PUT",
      body,
      idempotencyKey: commandIdentity("mbt-mapping")
    });
    requirement.mapping = result.mapping;
    requirement.currentMapping = result.mapping;
    readinessState.configurationHash = result.configurationHash;
    renderMappings();
    renderPreflight(readinessState.run ? { ...readinessState.run, current: false, ready: false } : null);
    closeMappingEditor();
    setReadinessMessage("Mapping saved. Run the read-only preflight to verify this configuration.");
  } catch (error) {
    setReadinessMessage(error.message, "attention");
  }
}

async function runPreflight() {
  const button = readinessElement("runPreflightButton");
  if (button) {
    button.disabled = true;
  }
  try {
    setReadinessMessage("Running the read-only sandbox preflight…");
    const result = await api("/api/mbt/config/netsuite/preflight", {
      method: "POST",
      body: {}
    });
    renderPreflight(result.run);
    setReadinessMessage(
      result.run?.status === "passed" ? "Preflight passed." : "Preflight completed with required checks to resolve.",
      result.run?.status === "passed" ? "safe" : "attention"
    );
  } catch (error) {
    setReadinessMessage(error.message, "attention");
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function signoffPreflight(event) {
  event.preventDefault();
  const run = readinessState.run;
  if (!run) {
    return;
  }
  const auditNote = inputValue("signoffNote");
  try {
    setReadinessMessage("Recording immutable preflight signoff…");
    const result = await api(
      `/api/mbt/config/netsuite/preflight/${encodeURIComponent(run.runId)}/signoff`,
      {
        method: "POST",
        body: { auditNote },
        idempotencyKey: commandIdentity("mbt-preflight-signoff")
      }
    );
    renderPreflight({ ...run, signoff: normalizedSignoff(result.signoff) });
    setReadinessMessage("Preflight signed off. NetSuite writes remain disabled.");
  } catch (error) {
    setReadinessMessage(error.message, "attention");
  }
}

function reportFilename(response, fallback) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/i);
  return match?.[1] || fallback;
}

function templateFilename(response, fallback) {
  const disposition = response.headers.get("content-disposition") || "";
  const quoted = disposition.match(/filename="([^"]+)"/i);
  const encoded = disposition.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      // The safe fallback below avoids trusting a malformed response header.
    }
  }
  return quoted?.[1] || fallback;
}

async function downloadProtectedTemplate(event) {
  event.preventDefault();
  const link = event.currentTarget;
  const target = String(link?.href || "");
  if (!target) return;
  try {
    const response = await fetch(target, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      cache: "no-store"
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "The protected template could not be downloaded.");
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const download = document.createElement("a");
    download.href = blobUrl;
    download.download = templateFilename(response, "mbt-import-template.csv");
    document.body.append(download);
    download.click();
    download.remove();
    URL.revokeObjectURL(blobUrl);
    setConfigMessage("localItemMessage", "Template downloaded. Preview it on the server before applying.");
  } catch (error) {
    setConfigMessage("localItemMessage", error.message, "attention");
  }
}

async function downloadReport(event) {
  event.preventDefault();
  const link = event.currentTarget;
  try {
    const response = await fetch(link.href, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      cache: "no-store"
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "The preflight report could not be downloaded.");
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const download = document.createElement("a");
    download.href = blobUrl;
    download.download = reportFilename(response, "netsuite-preflight-report");
    document.body.append(download);
    download.click();
    download.remove();
    URL.revokeObjectURL(blobUrl);
  } catch (error) {
    setReadinessMessage(error.message, "attention");
  }
}

function bindReadinessControls() {
  readinessElement("mappingForm")?.addEventListener("submit", saveMapping);
  readinessElement("cancelMappingButton")?.addEventListener("click", closeMappingEditor);
  readinessElement("runPreflightButton")?.addEventListener("click", runPreflight);
  readinessElement("signoffForm")?.addEventListener("submit", signoffPreflight);
  readinessElement("jsonReportLink")?.addEventListener("click", downloadReport);
  readinessElement("csvReportLink")?.addEventListener("click", downloadReport);
}

function bindLocalItemControls() {
  readinessElement("localItemForm")?.addEventListener("submit", saveLocalItem);
  readinessElement("customLocalItemForm")?.addEventListener("submit", saveCustomLocalItem);
  readinessElement("cancelLocalItemButton")?.addEventListener("click", closeLocalItemEditor);
  readinessElement("customLocalItemType")?.addEventListener("change", syncCustomItemTypeFields);
  syncCustomItemTypeFields();
  readinessElement("previewLocalItemImportButton")?.addEventListener(
    "click",
    () => previewLocalImport("local_items")
  );
  readinessElement("applyLocalItemImportButton")?.addEventListener(
    "click",
    () => applyLocalImport("local_items")
  );
}

function bindPhase3ConfigurationControls() {
  readinessElement("syncCustomersButton")?.addEventListener("click", syncCustomers);
  readinessElement("refreshCustomerEvidenceButton")?.addEventListener("click", loadCustomerEvidence);
  readinessElement("previewCustomerImportButton")?.addEventListener("click", previewCustomerImport);
  readinessElement("applyCustomerImportButton")?.addEventListener("click", applyCustomerImport);
      readinessElement("refreshMaterialsButton")?.addEventListener("click", loadMaterialsAndDumps);
      readinessElement("dumpSiteForm")?.addEventListener("submit", saveDumpSite);
      readinessElement("newDumpSiteButton")?.addEventListener("click", newDumpSiteEditor);
  readinessElement("previewLocalMasterImportButton")?.addEventListener(
    "click",
    () => previewLocalImport(selectedLocalMasterResource())
  );
  readinessElement("applyLocalMasterImportButton")?.addEventListener(
    "click",
    () => applyLocalImport(selectedLocalMasterResource())
  );
  readinessElement("refreshRateCardsButton")?.addEventListener("click", loadRateCards);
  readinessElement("rateCardForm")?.addEventListener("submit", saveRateCardDraft);
  initializeItemPricingState();
  activateRatePricingItem(localItemState.items.find((item) => item.active)?.itemCode || "", {
    captureCurrent: false
  });
  readinessElement("ratePricingItem")?.addEventListener("change", (event) => {
    activateRatePricingItem(event.currentTarget.value);
  });
  readinessElement("rateCardVersionSelect")?.addEventListener("change", (event) => {
    const versionId = event.currentTarget.value;
    if (!versionId) return;
    loadRateCardForEdit(versionId);
  });
  readinessElement("newRateCardButton")?.addEventListener("click", newRateCardEditor);
  readinessElement("validateRateCardButton")?.addEventListener("click", () => runRateCardLifecycle("validate"));
  readinessElement("activateRateCardButton")?.addEventListener("click", () => runRateCardLifecycle("activate"));
  readinessElement("cloneRateCardButton")?.addEventListener("click", () => runRateCardLifecycle("clone"));
  readinessElement("previewRateCardCsvButton")?.addEventListener("click", previewRateCardCsv);
  readinessElement("applyRateCardCsvButton")?.addEventListener("click", applyRateCardCsv);
  document.querySelectorAll("[data-mbt-template-download]").forEach((link) => {
    link.addEventListener("click", downloadProtectedTemplate);
  });
}

function configurationTabs() {
  return [...document.querySelectorAll(".mbt-tabs [role='tab']")];
}

function activateConfigurationTab(tab, { focus = false } = {}) {
  const tabs = configurationTabs();
  if (!tabs.includes(tab)) {
    return;
  }
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    const panel = readinessElement(candidate.getAttribute("aria-controls"));
    if (panel) {
      panel.hidden = !selected;
    }
  }
  if (focus) {
    tab.focus();
  }
  if (tab.id === "netSuiteReadinessTab") {
    void ensureReadinessLoaded();
  }
  if (tab.id === "customerSyncTab" && !phase3ConfigState.customerEvidenceLoaded) {
    void loadCustomerEvidence();
  }
  if (tab.id === "materialsDumpSitesTab" && !phase3ConfigState.materialsLoaded) {
    void loadMaterialsAndDumps();
  }
  if (tab.id === "rateCardsTab" && !phase3ConfigState.rateCardsLoaded) {
    void (async () => {
      if (!phase3ConfigState.materialsLoaded) await loadMaterialsAndDumps();
      await loadRateCards();
    })();
  }
}

function handleConfigurationTabKeydown(event) {
  const tabs = configurationTabs();
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) {
    return;
  }
  let nextIndex = currentIndex;
  if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  activateConfigurationTab(tabs[nextIndex], { focus: true });
}

function bindConfigurationTabs() {
  for (const tab of configurationTabs()) {
    tab.addEventListener("click", () => activateConfigurationTab(tab));
    tab.addEventListener("keydown", handleConfigurationTabKeydown);
  }
}

async function loadReadiness(foundation) {
  const [controlled, mappings, latest] = await Promise.all([
    api("/api/mbt/config"),
    api("/api/mbt/config/netsuite/mappings"),
    api("/api/mbt/config/netsuite/preflight/latest")
  ]);
  const disabledCapabilities = Object.values(foundation.capabilities || {})
    .filter((capability) => capability?.enabled !== true).length;
  replaceStatus("Configuration is safely locked", [
    controlled.message || "NetSuite sandbox readiness configuration is available to Admins.",
    `${disabledCapabilities} operational safety gates are closed.`,
    "NetSuite readiness is read-only; no NetSuite operational write is available."
  ]);
  readinessState.configurationHash = String(mappings.configurationHash || "");
  readinessState.requirements = Array.isArray(mappings.requirements) ? mappings.requirements : [];
  readinessState.runtimeBinding = mappings.runtimeBinding || mappings.runtime || null;
  renderRuntimeBinding(readinessState.runtimeBinding);
  renderMappings();
  renderPreflight(latest.run || null);
  const runButton = readinessElement("runPreflightButton");
  if (runButton) {
    runButton.disabled = false;
  }
  setReadinessMessage("NetSuite readiness loaded. Operational and posting gates remain closed.");
}

async function ensureReadinessLoaded() {
  if (readinessLoaded) {
    return;
  }
  if (readinessLoadPromise) {
    return readinessLoadPromise;
  }
  setReadinessMessage("Loading future NetSuite readiness…");
  readinessLoadPromise = (async () => {
    try {
      await loadReadiness(foundationState || { capabilities: {} });
      readinessLoaded = true;
    } catch (error) {
      setReadinessMessage(error.message, "attention");
    } finally {
      readinessLoadPromise = null;
    }
  })();
  return readinessLoadPromise;
}

async function load() {
  const details = surfaceDetails[surface];
  if (!details || !token) {
    location.replace("/");
    return;
  }
  try {
    const [{ operator }, foundation] = await Promise.all([
      api("/api/auth/me"),
      api("/api/mbt/status")
    ]);
    const granted = roles(operator);
    if (![...details.allowed].some((role) => granted.has(role))) {
      location.replace(operator?.homeRoute || "/");
      return;
    }
    if (surface === "config") {
      foundationState = foundation;
      const disabledCapabilities = Object.values(foundation.capabilities || {})
        .filter((capability) => capability?.enabled !== true).length;
      replaceStatus("Configuration is safely locked", [
        "Local item settings are available without NetSuite setup.",
        `${disabledCapabilities} operational safety gates are closed.`,
        "Local configuration creates no external work; no NetSuite operational write is available."
      ]);
      await loadLocalItems();
      return;
    }
    const controlled = await api(details.endpoint);
    const disabledCapabilities = Object.values(foundation.capabilities || {})
      .filter((capability) => capability?.enabled !== true).length;
    replaceStatus(details.title, [
      controlled.message || "Operational commands remain disabled.",
      `${disabledCapabilities} operational safety gates are closed.`,
      surface === "billing"
        ? "Retained evidence remains readable; local approval creates no NetSuite work."
        : "Phase 1 stores foundation data only; no NetSuite operational write is available."
    ]);
  } catch (error) {
    if (error.status === 401) {
      location.replace("/");
      return;
    }
    replaceStatus("This surface is unavailable", [error.message], "attention");
    setLocalItemMessage(error.message, "attention");
    setReadinessMessage(error.message, "attention");
  }
}

bindConfigurationTabs();
bindLocalItemControls();
bindPhase3ConfigurationControls();
bindReadinessControls();
load();
