const assetSurfaceDetails = {
  assets: {
    endpoint: "/api/mbt/assets",
    allowed: new Set(["admin", "dispatcher"])
  }
};

const app = document.getElementById("mbtApp");
const statusRegion = app?.querySelector(".mbt-status");
const token = localStorage.getItem("mbbs.staff.token") || "";
const state = {
  items: [],
  selectedAssetId: "",
  loading: false,
  openingOptions: null,
  csvPreview: null,
  csvFileVersion: 0,
  csvBusy: false
};

function element(id) {
  return document.getElementById(id);
}

function secureNonce() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function setMessage(id, message, tone = "safe") {
  const region = element(id);
  if (!region) return;
  region.textContent = message;
  region.dataset.tone = tone;
}

function setStatus(title, detail, tone = "safe") {
  if (!statusRegion) return;
  statusRegion.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = detail;
  statusRegion.append(heading, paragraph);
  statusRegion.dataset.tone = tone;
  statusRegion.setAttribute("aria-busy", "false");
}

async function assetApi(path, { method = "GET", body, idempotencyKey = "" } = {}) {
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
    const error = new Error(payload.error || "The asset request failed.");
    error.status = response.status;
    error.code = payload.code || "";
    error.redirect = payload.redirect || "";
    throw error;
  }
  return payload;
}

async function assetCsvRequest(path, { method = "GET", body, fileName = "" } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(fileName ? {
        "content-type": "text/csv",
        "x-mbt-source-filename": fileName
      } : {})
    },
    body,
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || "The asset CSV request failed.");
    error.status = response.status;
    error.code = payload.code || "";
    throw error;
  }
  return response;
}

function displayTime(value) {
  if (!value) return "Time unavailable";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : new Intl.DateTimeFormat("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Toronto"
    }).format(date);
}

function textCell(value) {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "");
  return cell;
}

function replaceOptions(selectId, items, { valueKey, labelFor, datasetFor, placeholderText } = {}) {
  const select = element(selectId);
  if (!select) return;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = placeholderText || "Select an option";
  select.append(placeholder);
  for (const item of Array.isArray(items) ? items : []) {
    const option = document.createElement("option");
    option.value = String(item?.[valueKey] || "");
    option.textContent = labelFor(item);
    for (const [key, value] of Object.entries(datasetFor?.(item) || {})) {
      if (value !== undefined && value !== null) option.dataset[key] = String(value);
    }
    select.append(option);
  }
  select.disabled = !Array.isArray(items) || items.length === 0;
}

function renderOpeningOptions(payload) {
  state.openingOptions = payload || null;
  replaceOptions("assetItemCode", payload?.binItems, {
    valueKey: "itemCode",
    labelFor: (item) => `${item.displayName || item.itemCode || "Bin"} (${item.itemCode || "unknown"})`,
    placeholderText: "Select a Bin item"
  });
  replaceOptions("assetCurrentLocationId", payload?.currentLocations, {
    valueKey: "locationId",
    labelFor: (item) => `${item.displayName || item.locationCode || "Location"} · ${item.address || "Address unavailable"}`,
    datasetFor: (item) => ({
      locationKind: item.locationKind || "yard",
      locationCode: item.locationCode || "",
      address: item.address || ""
    }),
    placeholderText: "Select the current address"
  });
}

async function loadOpeningOptions() {
  try {
    const payload = await assetApi("/api/mbt/assets/opening-options");
    renderOpeningOptions(payload);
  } catch (error) {
    replaceOptions("assetItemCode", [], { valueKey: "itemCode", labelFor: () => "" });
    replaceOptions("assetCurrentLocationId", [], { valueKey: "locationId", labelFor: () => "" });
    setMessage("assetRegistrationMessage", `Registration options unavailable: ${error.message}`, "warning");
  }
}

function assetIdentityCell(asset) {
  const cell = document.createElement("td");
  const code = document.createElement("strong");
  code.textContent = String(asset.assetCode || "Unnamed asset");
  cell.append(code);
  return cell;
}

async function setAssetActive(asset, active) {
  try {
    await assetApi(`${assetSurfaceDetails.assets.endpoint}/${encodeURIComponent(asset.assetId)}`, {
      method: "PATCH",
      body: { active, expectedRevision: Number(asset.revision) },
      idempotencyKey: `mbt-asset-state-${secureNonce()}`
    });
    await loadAssets(String(element("assetSearch")?.value || "").trim());
    setMessage("assetListMessage", `${asset.assetCode} is now ${active ? "active" : "inactive"}.`);
  } catch (error) {
    setMessage("assetListMessage", error.message, "warning");
  }
}

async function deleteAsset(asset) {
  if (!globalThis.confirm(`Delete ${asset.assetCode}? Only an unused opening registration can be deleted.`)) return;
  try {
    await assetApi(`${assetSurfaceDetails.assets.endpoint}/${encodeURIComponent(asset.assetId)}`, {
      method: "DELETE",
      body: { expectedRevision: Number(asset.revision) },
      idempotencyKey: `mbt-asset-delete-${secureNonce()}`
    });
    if (state.selectedAssetId === asset.assetId) {
      state.selectedAssetId = "";
      element("assetTimeline")?.replaceChildren();
      if (element("assetTimelineSummary")) element("assetTimelineSummary").textContent = "Select an asset to inspect every movement.";
    }
    await loadAssets(String(element("assetSearch")?.value || "").trim());
    setMessage("assetListMessage", `${asset.assetCode} was unused and has been deleted.`);
  } catch (error) {
    setMessage("assetListMessage", error.message, "warning");
  }
}

function renderAssets() {
  const rows = element("assetRows");
  if (!rows) return;
  rows.replaceChildren();
  if (!state.items.length) {
    const row = document.createElement("tr");
    const empty = textCell("No matching assets.");
    empty.colSpan = 6;
    row.append(empty);
    rows.append(row);
    return;
  }
  for (const asset of state.items) {
    const row = document.createElement("tr");
    row.dataset.assetId = String(asset.assetId || "");
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Timeline";
    button.addEventListener("click", () => loadTimeline(String(asset.assetId || "")));
    const stateButton = document.createElement("button");
    stateButton.type = "button";
    stateButton.className = "mbt-button-secondary";
    stateButton.textContent = asset.active === true ? "Inactivate" : "Activate";
    stateButton.addEventListener("click", () => setAssetActive(asset, asset.active !== true));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "mbt-button-secondary";
    deleteButton.textContent = "Delete";
    deleteButton.title = "The server blocks deletion after any movement, reservation, visit, or reconciliation link.";
    deleteButton.addEventListener("click", () => deleteAsset(asset));
    action.className = "mbt-table-actions";
    action.append(button, stateButton, deleteButton);
    row.append(
      assetIdentityCell(asset),
      textCell(asset.itemDisplayName
        ? `${asset.itemDisplayName} (${asset.itemCode || asset.binTypeCode || "Bin"})`
        : asset.itemCode || asset.binTypeCode || asset.binTypeName || "Unmapped legacy Bin"),
      textCell(`${asset.currentState?.lifecycleStatus || "Unknown"}${asset.active === false ? " · Inactive" : ""}`),
      textCell(asset.currentState?.currentAddress || "Unknown"),
      textCell(asset.revision),
      action
    );
    rows.append(row);
  }
}

async function loadAssets(query = "") {
  if (state.loading) return;
  state.loading = true;
  setMessage("assetListMessage", "Loading assets…");
  try {
    const parameters = new URLSearchParams({ query, limit: "100" });
    const payload = await assetApi(`${assetSurfaceDetails.assets.endpoint}?${parameters}`);
    state.items = Array.isArray(payload.items) ? payload.items : [];
    renderAssets();
    setMessage("assetListMessage", `${state.items.length} asset${state.items.length === 1 ? "" : "s"} shown.`);
    setStatus("Asset evidence ready", "Private responses are loaded without browser caching.");
  } catch (error) {
    setMessage("assetListMessage", error.message, "warning");
    setStatus("Asset registry unavailable", error.message, "warning");
    if (error.status === 401 && error.redirect) window.location.href = error.redirect;
  } finally {
    state.loading = false;
  }
}

function renderTimeline(payload) {
  const list = element("assetTimeline");
  const summary = element("assetTimelineSummary");
  if (!list || !summary) return;
  list.replaceChildren();
  const movements = Array.isArray(payload.movements) ? payload.movements : [];
  summary.textContent = `${payload.asset?.assetCode || "Selected asset"} · ${movements.length} movement${movements.length === 1 ? "" : "s"}`;
  for (const movement of movements) {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    heading.textContent = `#${movement.assetSequence} · ${movement.movementType}`;
    const detail = document.createElement("span");
    detail.className = "mbt-cell-detail";
    detail.textContent = `${movement.beforeStatus || "registered"} → ${movement.afterStatus} · ${movement.afterAddress || movement.afterLocationReference || movement.afterLocationKind} · ${displayTime(movement.occurredAt)}`;
    item.append(heading, detail);
    list.append(item);
  }
}

async function loadTimeline(assetId) {
  if (!assetId) return;
  state.selectedAssetId = assetId;
  setMessage("assetListMessage", "Loading append-only timeline…");
  try {
    const payload = await assetApi(`${assetSurfaceDetails.assets.endpoint}/${encodeURIComponent(assetId)}/timeline`);
    renderTimeline(payload);
    setMessage("assetListMessage", "Timeline loaded.");
  } catch (error) {
    setMessage("assetListMessage", error.message, "warning");
  }
}

function localTimestampValue(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function renderAssetCsvPreview(rows = []) {
  const body = element("assetCsvPreviewRows");
  if (!body) return;
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const empty = textCell("Choose a CSV file to create a private server preview.");
    empty.colSpan = 6;
    row.append(empty);
    body.append(row);
    return;
  }
  for (const preview of rows) {
    const row = document.createElement("tr");
    row.append(
      textCell(preview.rowNumber),
      textCell(preview.assetCode),
      textCell(preview.itemCode),
      textCell(preview.currentAddress),
      textCell(preview.initialLifecycleStatus),
      textCell(displayTime(preview.occurredAt))
    );
    body.append(row);
  }
}

function updateAssetCsvControls() {
  const file = element("assetCsvFile")?.files?.[0];
  const previewButton = element("assetCsvPreview");
  const applyButton = element("assetCsvApply");
  if (previewButton) previewButton.disabled = !file || state.csvBusy;
  if (applyButton) applyButton.disabled = !state.csvPreview || state.csvBusy;
}

function invalidateAssetCsvPreview(message) {
  state.csvPreview = null;
  renderAssetCsvPreview();
  updateAssetCsvControls();
  setMessage("assetReconciliationMessage", message);
}

async function downloadAssetCsvTemplate(event) {
  event.preventDefault();
  setMessage("assetReconciliationMessage", "Downloading the server-owned asset template…");
  try {
    const response = await assetCsvRequest("/api/mbt/assets/import/template");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "mbt-bin-assets-v2.csv";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage("assetReconciliationMessage", "Template downloaded. Server preview remains mandatory before apply.");
  } catch (error) {
    setMessage("assetReconciliationMessage", error.message, "warning");
  }
}

async function previewAssetCsv() {
  const fileInput = element("assetCsvFile");
  const file = fileInput?.files?.[0];
  if (!file || state.csvBusy) return;
  const expectedVersion = state.csvFileVersion;
  state.csvBusy = true;
  updateAssetCsvControls();
  setMessage("assetReconciliationMessage", "Creating a private server preview…");
  try {
    const response = await assetCsvRequest("/api/mbt/assets/import/preview", {
      method: "POST",
      body: await file.arrayBuffer(),
      fileName: file.name
    });
    const result = await response.json();
    if (expectedVersion !== state.csvFileVersion) {
      invalidateAssetCsvPreview("The selected file changed. Preview the current file again.");
      return;
    }
    state.csvPreview = result;
    renderAssetCsvPreview(Array.isArray(result.rows) ? result.rows : []);
    setMessage(
      "assetReconciliationMessage",
      `${Number(result.summary?.rowCount || 0)} asset row${Number(result.summary?.rowCount || 0) === 1 ? "" : "s"} previewed. Review it before applying.`
    );
  } catch (error) {
    invalidateAssetCsvPreview(error.message);
    setMessage("assetReconciliationMessage", error.message, "warning");
  } finally {
    state.csvBusy = false;
    updateAssetCsvControls();
  }
}

async function applyAssetCsv() {
  const preview = state.csvPreview;
  const reason = String(element("assetCsvReason")?.value || "").trim();
  if (!preview || state.csvBusy) return;
  state.csvBusy = true;
  updateAssetCsvControls();
  setMessage("assetReconciliationMessage", "Registering every previewed asset atomically…");
  try {
    const result = await assetApi(
      `/api/mbt/assets/import/${encodeURIComponent(preview.batchId)}/apply`,
      {
        method: "POST",
        body: {
          normalizedHash: preview.normalizedHash,
          targetRevisionToken: preview.targetRevisionToken,
          reason: reason || "Created assets from approved opening-inventory import"
        },
        idempotencyKey: `mbt-asset-csv-apply-${secureNonce()}`
      }
    );
    const created = Number(result.summary?.created || 0);
    state.csvPreview = null;
    element("assetCsvReason").value = "";
    element("assetCsvFile").value = "";
    renderAssetCsvPreview();
    await loadAssets(String(element("assetSearch")?.value || "").trim());
    setMessage(
      "assetReconciliationMessage",
      `${created} asset${created === 1 ? "" : "s"} registered with opening evidence.`
    );
  } catch (error) {
    setMessage("assetReconciliationMessage", error.message, "warning");
  } finally {
    state.csvBusy = false;
    updateAssetCsvControls();
  }
}

async function registerAsset(form) {
  const data = new FormData(form);
  const occurredAt = new Date(String(data.get("occurredAt") || ""));
  const currentLocationId = String(data.get("currentLocationId") || "").trim();
  const manualAddress = String(data.get("currentAddress") || "").trim();
  const selectedLocation = element("assetCurrentLocationId")?.selectedOptions?.[0];
  if (!manualAddress && !currentLocationId) {
    throw new Error("Select a known current address or enter the customer-site address.");
  }
  const assetCode = String(data.get("assetCode") || "").trim();
  const body = {
    asset: {
      assetCode,
      itemCode: String(data.get("itemCode") || "").trim(),
      active: true,
      underMaintenance: false
    },
    initialState: {
      lifecycleStatus: manualAddress ? "at_customer" : "available",
      location: manualAddress
        ? {
            kind: "customer_site",
            reference: manualAddress,
            customerSiteProfileId: null
          }
        : {
            kind: String(selectedLocation?.dataset?.locationKind || "yard"),
            reference: String(selectedLocation?.dataset?.locationCode || "").trim(),
            yardId: currentLocationId
          },
      occurredAt: occurredAt.toISOString()
    },
    reason: `Created asset ${assetCode} from the MBT Asset Registry`
  };
  const idempotencyKey = `mbt-asset-register-${secureNonce()}`;
  return assetApi(assetSurfaceDetails.assets.endpoint, {
    method: "POST",
    body,
    idempotencyKey
  });
}

element("assetSearchForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  loadAssets(String(element("assetSearch")?.value || "").trim());
});

element("assetReload")?.addEventListener("click", () => {
  loadAssets(String(element("assetSearch")?.value || "").trim());
});

element("assetCurrentLocationId")?.addEventListener("change", (event) => {
  if (event.currentTarget.value) element("assetCurrentAddress").value = "";
});

element("assetCurrentAddress")?.addEventListener("input", (event) => {
  if (String(event.currentTarget.value || "").trim()) element("assetCurrentLocationId").value = "";
});

element("assetRegistrationForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type='submit']");
  submit.disabled = true;
  setMessage("assetRegistrationMessage", "Registering asset and opening evidence…");
  try {
    const result = await registerAsset(form);
    setMessage("assetRegistrationMessage", `${result.asset.assetCode} registered.`);
    form.reset();
    element("assetOccurredAt").value = localTimestampValue(new Date());
    await loadAssets(String(element("assetSearch")?.value || "").trim());
    await loadTimeline(String(result.asset.assetId || ""));
  } catch (error) {
    setMessage("assetRegistrationMessage", error.message, "warning");
  } finally {
    submit.disabled = false;
  }
});

element("assetCsvFile")?.addEventListener("change", (event) => {
  const file = event.currentTarget.files?.[0];
  state.csvFileVersion += 1;
  invalidateAssetCsvPreview(file
    ? `${file.name} selected. Server preview remains mandatory before apply.`
    : "Server preview is required before any CSV row can be applied.");
});

element("assetCsvTemplate")?.addEventListener("click", downloadAssetCsvTemplate);
element("assetCsvPreview")?.addEventListener("click", previewAssetCsv);
element("assetCsvReason")?.addEventListener("input", updateAssetCsvControls);
element("assetCsvApply")?.addEventListener("click", applyAssetCsv);

if (!token) {
  setStatus("Login required", "Return to sign in before opening private asset evidence.", "warning");
} else {
  element("assetOccurredAt").value = localTimestampValue(new Date());
  updateAssetCsvControls();
  void Promise.all([loadAssets(), loadOpeningOptions()]);
}
