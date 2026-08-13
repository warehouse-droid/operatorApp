const token = localStorage.getItem("mbbs.staff.token") || "";
const MAX_BATCH_SELECTION = 100;

const state = {
  commandsEnabled: false,
  activeWorkspace: "candidates",
  mbbsCandidates: [],
  mbbsRateOptions: [],
  selectedMbbsCandidateId: null,
  selectedMbbsCandidateIds: new Set(),
  mbbsBatchResults: [],
  mbbsBatchPreviewContext: null,
  mbbsOrderSearchResults: [],
  mbbsCustomerResults: [],
  billingItems: [],
  billingCursor: null,
  selectedBillingCase: null
};

function element(id) {
  return document.getElementById(id);
}

function inputValue(id) {
  return String(element(id)?.value || "").trim();
}

function setInputValue(id, value) {
  const input = element(id);
  if (input) input.value = String(value ?? "");
}

function message(id, value, tone = "safe") {
  const region = element(id);
  if (!region) return;
  region.textContent = value;
  region.dataset.tone = tone;
}

function commandIdentity(scope) {
  return `${scope}:${crypto.randomUUID()}`;
}

async function api(path, { method = "GET", body, idempotencyKey = "" } = {}) {
  const requestIdentity = crypto.randomUUID();
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      "x-correlation-id": `mbt-billing-ui:${requestIdentity}`,
      "x-request-id": requestIdentity
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "The controlled billing request failed.");
    error.status = response.status;
    error.code = payload.code || "";
    throw error;
  }
  return payload;
}

function money(value, currency = "CAD") {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(Number(value) / 100);
}

function cadMinorInput(id, label) {
  const value = inputValue(id);
  if (!value) return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`${label} must be a positive CAD value with at most two decimal places.`);
  }
  const [whole, fraction = ""] = value.split(".");
  const amountMinor = (Number(whole) * 100) + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`${label} is outside the supported CAD range.`);
  }
  return amountMinor;
}

function textCell(value) {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "—");
  return cell;
}

function actionButton(label, focusKey, operation) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.focusKey = focusKey;
  button.addEventListener("click", operation);
  return button;
}

function retainedFocusKey() {
  return document.activeElement?.dataset?.focusKey || "";
}

function restoreFocus(key, container) {
  if (!key || !container) return;
  const match = [...container.querySelectorAll("[data-focus-key]")]
    .find((candidate) => candidate.dataset.focusKey === key);
  match?.focus();
}

function syncCommandButtons() {
  for (const button of document.querySelectorAll(".mbt-command")) {
    button.disabled = !state.commandsEnabled;
    button.title = state.commandsEnabled
      ? ""
      : "Billing commands are closed by the server safety gates.";
  }
  const batch = element("calculateSelectedMbbsCandidates");
  if (batch && state.commandsEnabled) {
    batch.disabled = state.selectedMbbsCandidateIds.size === 0
      || !inputValue("mbbsCompletedMonth")
      || !inputValue("mbbsRateCardVersion");
    batch.title = batch.disabled
      ? "Choose a completion month, rate card, and at least one ready order."
      : "";
  }
  const create = element("createMbbsBillingCases");
  if (create && state.commandsEnabled) {
    const reason = inputValue("mbbsBatchConversionReason");
    const contextMatches = batchContextsMatch(state.mbbsBatchPreviewContext, currentMbbsBatchContext());
    const allCalculated = state.mbbsBatchResults.length > 0
      && state.mbbsBatchResults.every((result) => result.status === "calculated");
    create.disabled = !contextMatches
      || !allCalculated
      || !inputValue("mbbsBillingCustomerId")
      || reason.length < 3
      || reason.length > 2000;
    create.title = create.disabled
      ? "Calculate the unchanged batch successfully, choose a customer, and enter an audit reason."
      : "Recalculate and create this complete local billing batch atomically.";
  }
}

function currentMbbsBatchContext() {
  return {
    candidateIds: [...state.selectedMbbsCandidateIds].sort(),
    completedMonth: inputValue("mbbsCompletedMonth"),
    completedDate: inputValue("mbbsCompletedDate"),
    rateCardVersionId: inputValue("mbbsRateCardVersion")
  };
}

function batchContextsMatch(left, right) {
  return Boolean(left)
    && left.completedMonth === right.completedMonth
    && left.completedDate === right.completedDate
    && left.rateCardVersionId === right.rateCardVersionId
    && JSON.stringify(left.candidateIds) === JSON.stringify(right.candidateIds);
}

function invalidateMbbsBatchPreview({ clearResults = true } = {}) {
  state.mbbsBatchPreviewContext = null;
  if (clearResults) {
    state.mbbsBatchResults = [];
    renderBatchResults();
  }
  syncCommandButtons();
}

async function loadCommandState() {
  const result = await api("/api/mbt/billing/status");
  state.commandsEnabled = result.commandState?.enabled === true;
  syncCommandButtons();
  const suffix = state.commandsEnabled
    ? "Local batch calculations and billing-only address corrections are enabled."
    : "Commands are closed; retained evidence is available read-only.";
  message("billingCommandMessage", `${suffix} No external posting path exists.`);
}

function selectBillingWorkspace(workspace, { focus = false } = {}) {
  const candidatesSelected = workspace === "candidates";
  state.activeWorkspace = candidatesSelected ? "candidates" : "cases";
  const candidateTab = element("billingWorkspaceCandidateTab");
  const caseTab = element("billingWorkspaceCaseTab");
  const candidatePanel = element("mbbsCandidateWorkspace");
  const casePanel = element("billingCaseWorkspace");
  candidateTab?.setAttribute("aria-selected", String(candidatesSelected));
  caseTab?.setAttribute("aria-selected", String(!candidatesSelected));
  if (candidateTab) candidateTab.tabIndex = candidatesSelected ? 0 : -1;
  if (caseTab) caseTab.tabIndex = candidatesSelected ? -1 : 0;
  if (candidatePanel) candidatePanel.hidden = !candidatesSelected;
  if (casePanel) casePanel.hidden = candidatesSelected;
  if (focus) (candidatesSelected ? candidateTab : caseTab)?.focus();
}

function tabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  selectBillingWorkspace(state.activeWorkspace === "candidates" ? "cases" : "candidates", { focus: true });
}

function mbbsReferenceText(candidate) {
  return (candidate.references || [])
    .map((reference) => `${reference.sourceType} ${reference.rootReference}`)
    .join(", ") || "No retained order reference";
}

function mbbsCompletionTime(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? String(value || "—")
    : new Intl.DateTimeFormat("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Toronto"
    }).format(parsed);
}

function mbbsCompletionMonth(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: "America/Toronto"
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : "";
}

function mbbsSourceLabel(sourceSystem) {
  return ({
    driver_pwa: "Driver PWA",
    reconciliation: "Reconciliation",
    sales_order: "Sales Order",
    custom_order: "Custom local order"
  })[sourceSystem] || "Completed order";
}

function selectedMbbsCandidate() {
  return state.mbbsCandidates.find((candidate) => candidate.candidateId === state.selectedMbbsCandidateId) || null;
}

function appendFact(list, label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = String(value || "—");
  list.append(term, detail);
}

function renderMbbsCandidateDetail() {
  const candidate = selectedMbbsCandidate();
  const summary = element("selectedMbbsCandidate");
  const facts = element("mbbsCandidateFacts");
  const form = element("mbbsAddressOverrideForm");
  if (!candidate) {
    if (summary) summary.textContent = "Select an order to review its retained route.";
    facts?.replaceChildren();
    if (form) form.hidden = true;
    return;
  }
  if (summary) summary.textContent = `${mbbsReferenceText(candidate)} · ${mbbsSourceLabel(candidate.sourceSystem)}`;
  facts?.replaceChildren();
  if (facts) {
    appendFact(facts, "Completed", mbbsCompletionTime(candidate.completedAt));
    appendFact(facts, "Origin", candidate.originLabel);
    appendFact(facts, "Destination", candidate.destinationLabel || "Missing");
    appendFact(facts, "Readiness", candidate.chargeable ? "Ready to calculate" : candidate.reason);
    appendFact(
      facts,
      "Billing override",
      candidate.addressOverride
        ? `Revision ${candidate.addressOverride.revision} · ${candidate.addressOverride.destinationAddressText}`
        : "None"
    );
  }
  const canEditAddress = Boolean(
    candidate.addressOverride
    || ((candidate.references || []).length > 0
      && candidate.originLabel
      && (!candidate.destinationLabel || candidate.routeStopCount < 2))
  );
  if (form) {
    form.hidden = !canEditAddress;
    form.dataset.candidateId = candidate.candidateId;
  }
  setInputValue("mbbsAddressOverrideText", candidate.addressOverride?.destinationAddressText || "");
  setInputValue("mbbsAddressOverrideReason", "");
  syncCommandButtons();
}

function selectMbbsCandidate(candidateId) {
  state.selectedMbbsCandidateId = candidateId;
  renderMbbsCandidateDetail();
  renderMbbsCandidates();
}

function updateSelectAllState() {
  const selectAll = element("selectAllMbbsCandidates");
  if (!selectAll) return;
  const ready = state.mbbsCandidates.filter((candidate) => candidate.chargeable).slice(0, MAX_BATCH_SELECTION);
  const selectedReady = ready.filter((candidate) => state.selectedMbbsCandidateIds.has(candidate.candidateId));
  selectAll.checked = ready.length > 0 && selectedReady.length === ready.length;
  selectAll.indeterminate = selectedReady.length > 0 && selectedReady.length < ready.length;
  selectAll.disabled = ready.length === 0;
}

function toggleCandidate(candidateId, checked) {
  if (checked && state.selectedMbbsCandidateIds.size >= MAX_BATCH_SELECTION) {
    message("mbbsCandidateMessage", `A calculation batch can contain at most ${MAX_BATCH_SELECTION} orders.`, "attention");
    renderMbbsCandidates();
    return;
  }
  if (checked) state.selectedMbbsCandidateIds.add(candidateId);
  else state.selectedMbbsCandidateIds.delete(candidateId);
  invalidateMbbsBatchPreview();
  updateSelectAllState();
  syncCommandButtons();
}

function renderMbbsCandidates() {
  const rows = element("mbbsCandidateRows");
  if (!rows) return;
  const focusKey = retainedFocusKey();
  rows.replaceChildren();
  if (!state.mbbsCandidates.length) {
    const row = document.createElement("tr");
    const cell = textCell("No completed Delivery, custom local, Driver PWA, or reconciliation candidates match this completion period.");
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
  }
  for (const candidate of state.mbbsCandidates) {
    const row = document.createElement("tr");
    if (candidate.candidateId === state.selectedMbbsCandidateId) row.dataset.selected = "true";
    const selectionCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("data-mbbs-candidate-id", candidate.candidateId);
    checkbox.setAttribute("aria-label", `Select ${mbbsReferenceText(candidate)}`);
    checkbox.checked = state.selectedMbbsCandidateIds.has(candidate.candidateId);
    checkbox.disabled = !candidate.chargeable;
    checkbox.addEventListener("change", () => toggleCandidate(candidate.candidateId, checkbox.checked));
    selectionCell.append(checkbox);
    const detailCell = document.createElement("td");
    detailCell.append(actionButton(
      "View",
      `mbbs-detail:${candidate.candidateId}`,
      () => selectMbbsCandidate(candidate.candidateId)
    ));
    row.append(
      selectionCell,
      textCell(mbbsReferenceText(candidate)),
      textCell(mbbsCompletionTime(candidate.completedAt)),
      textCell(candidate.chargeable ? "Ready" : candidate.reason),
      detailCell
    );
    rows.append(row);
  }
  updateSelectAllState();
  syncCommandButtons();
  restoreFocus(focusKey, rows);
}

function appendCustomerOption(customer, { select = false } = {}) {
  const customerSelect = element("mbbsBillingCustomerId");
  if (!customerSelect || !customer?.netsuiteId) return;
  const value = String(customer.netsuiteId);
  let option = [...customerSelect.options].find((entry) => entry.value === value);
  if (!option) {
    option = new Option(
      `${customer.displayName || customer.legalName || "Customer"} · ${customer.entityNumber || value} · #${value}`,
      value
    );
    customerSelect.add(option);
  }
  if (select) customerSelect.value = value;
}

function applyRateCardCustomer() {
  const selectedRate = state.mbbsRateOptions.find(
    (option) => option.rateCardVersionId === inputValue("mbbsRateCardVersion")
  );
  if (!selectedRate?.customerNetsuiteId) {
    syncCommandButtons();
    return;
  }
  const known = state.mbbsCustomerResults.find(
    (customer) => String(customer.netsuiteId) === String(selectedRate.customerNetsuiteId)
  );
  appendCustomerOption(known || {
    netsuiteId: selectedRate.customerNetsuiteId,
    displayName: "Rate-card customer",
    entityNumber: selectedRate.customerNetsuiteId
  }, { select: true });
  message(
    "mbbsBillingCustomerMessage",
    `Using canonical customer #${selectedRate.customerNetsuiteId} mapped to the selected rate card.`
  );
  syncCommandButtons();
}

function renderMbbsRateOptions(defaultVersionId = "") {
  const select = element("mbbsRateCardVersion");
  if (!select) return;
  const retained = select.value;
  select.replaceChildren(new Option("Select an active rate card", ""));
  for (const option of state.mbbsRateOptions) {
    select.add(new Option(
      `${option.displayName} · ${option.rateCardCode} · version ${option.versionNumber}`,
      option.rateCardVersionId
    ));
  }
  if (state.mbbsRateOptions.some((option) => option.rateCardVersionId === retained)) {
    select.value = retained;
  } else if (state.mbbsRateOptions.some((option) => option.rateCardVersionId === defaultVersionId)) {
    select.value = defaultVersionId;
  }
  applyRateCardCustomer();
  syncCommandButtons();
}

function mbbsCandidateQuery(search = "") {
  const params = new URLSearchParams({ limit: "1000" });
  const month = inputValue("mbbsCompletedMonth");
  const completedDate = inputValue("mbbsCompletedDate");
  if (month) params.set("completedMonth", month);
  if (completedDate) params.set("completedDate", completedDate);
  if (search) params.set("search", search);
  return params;
}

function renderMbbsOrderSearchResults() {
  const rows = element("mbbsOrderSearchRows");
  if (!rows) return;
  rows.replaceChildren();
  if (!state.mbbsOrderSearchResults.length) {
    const row = document.createElement("tr");
    const cell = textCell("No completed database orders match this search and completion period.");
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const candidate of state.mbbsOrderSearchResults) {
    const row = document.createElement("tr");
    const actionCell = document.createElement("td");
    const alreadyAdded = state.mbbsCandidates.some((item) => item.candidateId === candidate.candidateId);
    const add = actionButton(
      alreadyAdded ? "Added" : "Add order",
      `mbbs-search-add:${candidate.candidateId}`,
      () => addSearchedMbbsOrder(candidate.candidateId)
    );
    add.disabled = alreadyAdded || !candidate.chargeable;
    actionCell.append(add);
    row.append(
      textCell(mbbsReferenceText(candidate)),
      textCell(candidate.deliveryMethod || mbbsSourceLabel(candidate.sourceSystem)),
      textCell(mbbsCompletionTime(candidate.completedAt)),
      textCell(candidate.chargeable ? "Ready" : candidate.reason),
      actionCell
    );
    rows.append(row);
  }
}

function addSearchedMbbsOrder(candidateId) {
  const candidate = state.mbbsOrderSearchResults.find((item) => item.candidateId === candidateId);
  if (!candidate?.chargeable) return;
  if (!state.mbbsCandidates.some((item) => item.candidateId === candidateId)) {
    state.mbbsCandidates.push(candidate);
  }
  invalidateMbbsBatchPreview();
  state.selectedMbbsCandidateIds.add(candidateId);
  state.selectedMbbsCandidateId = candidateId;
  renderMbbsCandidates();
  renderMbbsCandidateDetail();
  renderMbbsOrderSearchResults();
  message("mbbsCandidateMessage", `${mbbsReferenceText(candidate)} was added explicitly to this billing batch.`);
}

async function searchMbbsOrders() {
  const search = inputValue("mbbsOrderSearch");
  message("mbbsCandidateMessage", "Searching completed database orders…");
  try {
    const result = await api(`/api/mbt/billing/mbbs/candidates?${mbbsCandidateQuery(search)}`);
    state.mbbsOrderSearchResults = Array.isArray(result.items) ? result.items : [];
    renderMbbsOrderSearchResults();
    message(
      "mbbsCandidateMessage",
      `${state.mbbsOrderSearchResults.length} matching completed order(s) found. Pick-Up remains excluded until you choose Add order.`
    );
  } catch (error) {
    message("mbbsCandidateMessage", error.message, "attention");
  }
}

async function loadMbbsCandidates() {
  message("mbbsCandidateMessage", "Loading completed Delivery, custom local, Driver PWA, and reconciliation evidence…");
  try {
    const result = await api(`/api/mbt/billing/mbbs/candidates?${mbbsCandidateQuery()}`);
    invalidateMbbsBatchPreview();
    state.mbbsCandidates = Array.isArray(result.items) ? result.items : [];
    state.mbbsRateOptions = Array.isArray(result.rateOptions) ? result.rateOptions : [];
    state.mbbsOrderSearchResults = [];
    const readyIds = new Set(state.mbbsCandidates.filter((candidate) => candidate.chargeable)
      .map((candidate) => candidate.candidateId));
    state.selectedMbbsCandidateIds = new Set([...state.selectedMbbsCandidateIds]
      .filter((candidateId) => readyIds.has(candidateId)));
    if (!state.mbbsCandidates.some((candidate) => candidate.candidateId === state.selectedMbbsCandidateId)) {
      state.selectedMbbsCandidateId = state.mbbsCandidates[0]?.candidateId || null;
    }
    renderMbbsRateOptions(result.rateCardVersionId || "");
    renderMbbsCandidates();
    renderMbbsCandidateDetail();
    renderMbbsOrderSearchResults();
    const ready = state.mbbsCandidates.filter((candidate) => candidate.chargeable).length;
    message(
      "mbbsCandidateMessage",
      `${state.mbbsCandidates.length} completed candidate(s) loaded; ${ready} ready. ${state.mbbsRateOptions.length} active MBBS rate card(s) available.`
    );
  } catch (error) {
    message("mbbsCandidateMessage", error.message, "attention");
  }
}

function toggleAllCandidates(checked) {
  invalidateMbbsBatchPreview();
  state.selectedMbbsCandidateIds.clear();
  if (checked) {
    const ready = state.mbbsCandidates.filter((candidate) => candidate.chargeable);
    for (const candidate of ready.slice(0, MAX_BATCH_SELECTION)) {
      state.selectedMbbsCandidateIds.add(candidate.candidateId);
    }
    if (ready.length > MAX_BATCH_SELECTION) {
      message("mbbsCandidateMessage", `Selected the first ${MAX_BATCH_SELECTION} ready orders; calculate another batch for the remainder.`);
    }
  }
  renderMbbsCandidates();
}

function selectedRateLabel(rateCardVersionId) {
  const option = state.mbbsRateOptions.find((item) => item.rateCardVersionId === rateCardVersionId);
  return option ? `${option.rateCardCode} v${option.versionNumber}` : rateCardVersionId;
}

function renderBatchResults() {
  const rows = element("mbbsBatchResultRows");
  if (!rows) return;
  rows.replaceChildren();
  if (!state.mbbsBatchResults.length) {
    const row = document.createElement("tr");
    const cell = textCell("No batch has been calculated yet.");
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const result of state.mbbsBatchResults) {
    const candidate = result.candidate
      || state.mbbsCandidates.find((item) => item.candidateId === result.candidateId)
      || {};
    const row = document.createElement("tr");
    row.append(
      textCell(mbbsReferenceText(candidate)),
      textCell(result.status === "calculated" ? "Calculated" : result.error?.message || "Failed"),
      textCell(result.status === "calculated" ? `${Number(result.distanceMetres).toLocaleString("en-CA")} m` : "—"),
      textCell(result.status === "calculated" ? selectedRateLabel(result.rateCardVersionId) : "—"),
      textCell(result.status === "calculated" ? money(result.charge.amountMinor, result.charge.currency) : "—")
    );
    rows.append(row);
  }
}

async function calculateSelectedMbbsCandidates() {
  const candidateIds = [...state.selectedMbbsCandidateIds];
  const completedMonth = inputValue("mbbsCompletedMonth");
  const completedDate = inputValue("mbbsCompletedDate");
  const rateCardVersionId = inputValue("mbbsRateCardVersion");
  if (!completedMonth || !rateCardVersionId || candidateIds.length === 0) {
    message("mbbsCandidateMessage", "Choose a completion month, rate card, and at least one ready order.", "attention");
    return;
  }
  message("mbbsCandidateMessage", `Calculating ${candidateIds.length} selected completed order(s)…`);
  try {
    const requestContext = currentMbbsBatchContext();
    const result = await api("/api/mbt/billing/mbbs/candidates/batch-preview", {
      method: "POST",
      body: { candidateIds, completedMonth, completedDate, rateCardVersionId }
    });
    if (result.postingMode !== "local_only_preview" || result.externalWork !== null) {
      throw new Error("The server did not preserve the local-only MBBS preview boundary.");
    }
    state.mbbsBatchResults = Array.isArray(result.results) ? result.results : [];
    state.mbbsBatchPreviewContext = requestContext;
    renderBatchResults();
    syncCommandButtons();
    message(
      "mbbsCandidateMessage",
      `${result.successCount} order(s) calculated; ${result.failureCount} failed. No billing, Dispatch, Driver PWA, outbox, or NetSuite rows were created.`,
      result.failureCount ? "attention" : "safe"
    );
  } catch (error) {
    message("mbbsCandidateMessage", error.message, "attention");
  }
}

function renderMbbsCustomerResults({ preferredCustomerId = "" } = {}) {
  const select = element("mbbsBillingCustomerId");
  if (!select) return;
  const retained = preferredCustomerId || select.value;
  select.replaceChildren(new Option("Search and choose a customer", ""));
  for (const customer of state.mbbsCustomerResults) {
    appendCustomerOption(customer);
  }
  if ([...select.options].some((option) => option.value === retained)) {
    select.value = retained;
  }
  applyRateCardCustomer();
  syncCommandButtons();
}

async function searchMbbsBillingCustomers() {
  const search = inputValue("mbbsBillingCustomerSearch");
  message("mbbsBillingCustomerMessage", "Searching the canonical customer master…");
  try {
    const params = new URLSearchParams({ search, limit: "25" });
    const result = await api(`/api/mbt/billing/mbbs/customers?${params}`);
    state.mbbsCustomerResults = Array.isArray(result.items) ? result.items : [];
    const exact = state.mbbsCustomerResults.find((customer) => (
      String(customer.netsuiteId) === search
      || String(customer.entityNumber).toLowerCase() === search.toLowerCase()
    ));
    renderMbbsCustomerResults({
      preferredCustomerId: exact?.netsuiteId
        || (state.mbbsCustomerResults.length === 1 ? state.mbbsCustomerResults[0].netsuiteId : "")
    });
    message(
      "mbbsBillingCustomerMessage",
      `${state.mbbsCustomerResults.length} active canonical customer(s) found.`
    );
  } catch (error) {
    message("mbbsBillingCustomerMessage", error.message, "attention");
  }
}

async function createMbbsBillingCases() {
  const context = currentMbbsBatchContext();
  if (!batchContextsMatch(state.mbbsBatchPreviewContext, context)
      || state.mbbsBatchResults.length === 0
      || state.mbbsBatchResults.some((result) => result.status !== "calculated")) {
    message("mbbsCandidateMessage", "Recalculate the unchanged selected batch successfully before creating billing cases.", "attention");
    return;
  }
  message("mbbsCandidateMessage", `Creating one atomic local billing batch for ${context.candidateIds.length} selected order(s)…`);
  try {
    const result = await api("/api/mbt/billing/mbbs/candidates/batch-create", {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-billing-batch-create"),
      body: {
        candidateIds: context.candidateIds,
        completedMonth: context.completedMonth,
        completedDate: context.completedDate,
        rateCardVersionId: context.rateCardVersionId,
        customerNetsuiteId: inputValue("mbbsBillingCustomerId"),
        reason: inputValue("mbbsBatchConversionReason")
      }
    });
    if (result.postingMode !== "local_only" || result.externalWork !== null) {
      throw new Error("The server did not preserve the local-only MBBS billing boundary.");
    }
    state.mbbsBatchPreviewContext = null;
    setInputValue("mbbsBatchConversionReason", "");
    syncCommandButtons();
    await loadBillingCases();
    message(
      "mbbsCandidateMessage",
      `${result.durableCaseCount} local billing case(s) created from ${result.requestedCandidateCount} completed order(s). No outbox or NetSuite work was created.`
    );
  } catch (error) {
    message("mbbsCandidateMessage", error.message, "attention");
  }
}

async function changeMbbsCompletedDate() {
  const completedDate = inputValue("mbbsCompletedDate");
  if (completedDate) setInputValue("mbbsCompletedMonth", completedDate.slice(0, 7));
  invalidateMbbsBatchPreview();
  await loadMbbsCandidates();
}

async function changeMbbsCompletedMonth() {
  const month = inputValue("mbbsCompletedMonth");
  const completedDate = inputValue("mbbsCompletedDate");
  if (completedDate && !completedDate.startsWith(`${month}-`)) {
    setInputValue("mbbsCompletedDate", "");
  }
  invalidateMbbsBatchPreview();
  await loadMbbsCandidates();
}

function changeMbbsRateCard() {
  invalidateMbbsBatchPreview();
  applyRateCardCustomer();
}

async function saveMbbsAddressOverride(event) {
  event.preventDefault();
  const form = element("mbbsAddressOverrideForm");
  const candidateId = String(form?.dataset.candidateId || "");
  const candidate = state.mbbsCandidates.find((item) => item.candidateId === candidateId);
  const completedMonth = inputValue("mbbsCompletedMonth") || mbbsCompletionMonth(candidate?.completedAt);
  message("mbbsCandidateMessage", "Saving the audited billing-only destination…");
  try {
    await api(`/api/mbt/billing/mbbs/candidates/${encodeURIComponent(candidateId)}/address-override`, {
      method: "PUT",
      idempotencyKey: commandIdentity("mbt-billing-address-override"),
      body: {
        completedMonth,
        destinationAddressText: inputValue("mbbsAddressOverrideText"),
        expectedRevision: candidate?.addressOverride?.revision || 0,
        reason: inputValue("mbbsAddressOverrideReason")
      }
    });
    state.selectedMbbsCandidateId = candidateId;
    await loadMbbsCandidates();
    message("mbbsCandidateMessage", "Billing-only address saved. Operational order and Driver PWA evidence was not changed.");
  } catch (error) {
    message("mbbsCandidateMessage", error.message, "attention");
  }
}

function billingQuery() {
  const params = new URLSearchParams({ limit: "25" });
  const status = inputValue("billingStatusFilter");
  const caseType = inputValue("billingTypeFilter");
  const billingMonth = inputValue("billingMonthFilter");
  if (status) params.set("status", status);
  if (caseType) params.set("caseType", caseType);
  if (billingMonth) params.set("billingMonth", billingMonth);
  if (state.billingCursor) params.set("cursor", state.billingCursor);
  return params;
}

function renderBillingCases() {
  const rows = element("billingCaseRows");
  if (!rows) return;
  const focusKey = retainedFocusKey();
  rows.replaceChildren();
  if (!state.billingItems.length) {
    const row = document.createElement("tr");
    const cell = textCell("No local billing cases match these filters.");
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
  }
  for (const item of state.billingItems) {
    const row = document.createElement("tr");
    if (item.billingCaseId === state.selectedBillingCase?.billingCaseId) row.dataset.selected = "true";
    const source = item.caseType === "mbt_contract" ? "MBT contract" : "MBBS cross-charge";
    const actionCell = document.createElement("td");
    actionCell.append(actionButton(
      "Review",
      `billing:${item.billingCaseId}`,
      () => loadBillingCase(item.billingCaseId)
    ));
    row.append(
      textCell(source),
      textCell(item.customerNetsuiteId),
      textCell(item.status),
      textCell(money(item.totalMinor, item.currency)),
      actionCell
    );
    rows.append(row);
  }
  const more = element("moreBillingCases");
  if (more) more.hidden = !state.billingCursor;
  restoreFocus(focusKey, rows);
}

async function loadBillingCases({ reset = true } = {}) {
  if (reset) {
    state.billingItems = [];
    state.billingCursor = null;
  }
  message("billingQueueMessage", "Loading retained local billing cases…");
  try {
    const result = await api(`/api/mbt/billing/cases?${billingQuery()}`);
    state.billingItems.push(...(Array.isArray(result.items) ? result.items : []));
    state.billingCursor = result.nextCursor || null;
    renderBillingCases();
    message("billingQueueMessage", `${state.billingItems.length} local case(s) loaded.`);
  } catch (error) {
    message("billingQueueMessage", error.message, "attention");
  }
}

function evidenceText(line) {
  const detail = line.calculationDetail || {};
  const source = detail.source || detail.deduplicationKey || "immutable calculation snapshot";
  return typeof source === "string" ? source : JSON.stringify(source);
}

function renderBillingCaseActions(result) {
  const actions = element("billingCaseActions");
  const calculationForm = element("billingCaseCalculationForm");
  const approvalForm = element("billingCaseApprovalForm");
  const help = element("billingCaseActionHelp");
  const versions = Array.isArray(result.versions) ? result.versions : [];
  const currentVersion = versions.find((version) => (
    Number(version.versionNumber) === Number(result.currentVersionNumber)
  )) || versions[0] || null;
  const canCalculate = result.caseType === "mbt_contract"
    && Number(result.currentVersionNumber) === 0
    && Boolean(result.serviceVisitId)
    && Boolean(result.visitDistanceSnapshotId)
    && ["open", "ready", "in_review"].includes(result.status);
  const canApprove = result.caseType === "mbt_contract"
    && currentVersion?.status === "draft"
    && ["ready", "in_review"].includes(result.status);
  if (actions) actions.hidden = false;
  if (calculationForm) calculationForm.hidden = !canCalculate;
  if (approvalForm) approvalForm.hidden = !canApprove;
  if (help) {
    help.textContent = canCalculate
      ? "Calculate one complete local draft from this case's retained evidence."
      : canApprove
        ? `Draft version ${currentVersion.versionNumber} is ready for local approval.`
        : result.caseType === "mbbs_cross_charge"
          ? "MBBS cross-charge cases are generated from immutable completed-load snapshots."
          : "No local action is available for this case state.";
  }
  setInputValue("billingCaseDumpReceiptId", "");
  setInputValue("billingCaseWaiverCad", "");
  setInputValue("billingCaseWaiverReason", "");
  setInputValue("billingCaseCalculationReason", "");
  setInputValue("billingCaseApprovalReason", "");
  syncCommandButtons();
}

function renderBillingCase(result) {
  state.selectedBillingCase = result;
  const source = result.caseType === "mbt_contract" ? "MBT contract" : "MBBS cross-charge";
  const summary = element("selectedBillingCase");
  if (summary) summary.textContent = `${source} · ${result.status} · revision ${result.revision} · ${result.postingMode}`;
  const rows = element("billingEvidenceRows");
  if (!rows) return;
  rows.replaceChildren();
  for (const version of result.versions || []) {
    const versionRow = document.createElement("tr");
    versionRow.className = "mbt-summary-row";
    versionRow.append(
      textCell(`Version ${version.versionNumber} · ${version.status}`),
      textCell("—"),
      textCell(money(version.subtotalMinor, result.currency)),
      textCell(money(version.estimatedTaxMinor, result.currency)),
      textCell(money(version.totalMinor, result.currency)),
      textCell(version.postingMode)
    );
    rows.append(versionRow);
    for (const line of version.lines || []) {
      const row = document.createElement("tr");
      row.append(
        textCell(`${line.sequenceNumber + 1}. ${line.description}`),
        textCell(`${line.quantity} ${line.unitOfMeasure}`),
        textCell(money(line.netAmountMinor, line.currency)),
        textCell(money(line.estimatedTaxMinor, line.currency)),
        textCell(money(line.totalAmountMinor, line.currency)),
        textCell(evidenceText(line))
      );
      rows.append(row);
    }
  }
  if (!(result.versions || []).length) {
    const row = document.createElement("tr");
    const cell = textCell("No calculated version exists yet.");
    cell.colSpan = 6;
    row.append(cell);
    rows.append(row);
  }
  renderBillingCaseActions(result);
  renderBillingCases();
}

async function loadBillingCase(caseId) {
  message("billingQueueMessage", "Loading the selected local billing case…");
  try {
    const result = await api(`/api/mbt/billing/cases/${encodeURIComponent(caseId)}`);
    renderBillingCase(result);
    message("billingQueueMessage", "Selected case detail loaded.");
  } catch (error) {
    message("billingQueueMessage", error.message, "attention");
  }
}

async function calculateSelectedBillingCase(event) {
  event.preventDefault();
  const selected = state.selectedBillingCase;
  message("billingQueueMessage", "Calculating the selected case from retained evidence…");
  try {
    if (!selected?.billingCaseId || !selected.serviceVisitId || !selected.visitDistanceSnapshotId) {
      throw new Error("The selected case does not contain complete visit and distance evidence.");
    }
    const waiverAmountMinor = cadMinorInput("billingCaseWaiverCad", "Waiver amount");
    const waiverReason = inputValue("billingCaseWaiverReason");
    if (waiverAmountMinor !== null && !waiverReason) {
      throw new Error("Provide an audit note for the waiver.");
    }
    const dumpReceiptId = inputValue("billingCaseDumpReceiptId");
    await api(`/api/mbt/billing/cases/${encodeURIComponent(selected.billingCaseId)}/calculate`, {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-billing-calculate"),
      body: {
        serviceVisitId: selected.serviceVisitId,
        distanceSnapshotId: selected.visitDistanceSnapshotId,
        ...(dumpReceiptId ? { dumpReceiptId } : {}),
        expectedRevision: Number(selected.revision),
        componentQuantities: {},
        customPrices: [],
        ...(waiverAmountMinor === null ? {} : {
          waiver: {
            amountMinor: waiverAmountMinor,
            reason: waiverReason,
            description: "Audited billing waiver",
            taxable: false
          }
        }),
        reason: inputValue("billingCaseCalculationReason")
      }
    });
    await loadBillingCases();
    await loadBillingCase(selected.billingCaseId);
    message("billingQueueMessage", "The complete draft was calculated locally. No external work was created.");
  } catch (error) {
    message("billingQueueMessage", error.message, "attention");
  }
}

async function approveSelectedBillingCase(event) {
  event.preventDefault();
  const selected = state.selectedBillingCase;
  message("billingQueueMessage", "Validating the selected local draft…");
  try {
    const currentVersion = (selected?.versions || []).find((version) => (
      Number(version.versionNumber) === Number(selected.currentVersionNumber)
    ));
    if (!selected?.billingCaseId || currentVersion?.status !== "draft") {
      throw new Error("The selected case does not have a current draft to approve.");
    }
    await api(`/api/mbt/billing/cases/${encodeURIComponent(selected.billingCaseId)}/approve-local`, {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-billing-approve"),
      body: {
        billingVersionId: currentVersion.billingVersionId,
        expectedRevision: Number(selected.revision),
        reason: inputValue("billingCaseApprovalReason")
      }
    });
    await loadBillingCases();
    await loadBillingCase(selected.billingCaseId);
    message("billingQueueMessage", "The selected draft was approved locally. No external work was created.");
  } catch (error) {
    message("billingQueueMessage", error.message, "attention");
  }
}

function bind() {
  element("billingWorkspaceCandidateTab")?.addEventListener("click", () => selectBillingWorkspace("candidates"));
  element("billingWorkspaceCaseTab")?.addEventListener("click", () => selectBillingWorkspace("cases"));
  element("billingWorkspaceCandidateTab")?.addEventListener("keydown", tabKeydown);
  element("billingWorkspaceCaseTab")?.addEventListener("keydown", tabKeydown);
  element("refreshMbbsCandidates")?.addEventListener("click", loadMbbsCandidates);
  element("mbbsCompletedMonth")?.addEventListener("change", changeMbbsCompletedMonth);
  element("mbbsCompletedDate")?.addEventListener("change", changeMbbsCompletedDate);
  element("mbbsRateCardVersion")?.addEventListener("change", changeMbbsRateCard);
  element("searchMbbsOrders")?.addEventListener("click", searchMbbsOrders);
  element("mbbsOrderSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchMbbsOrders();
    }
  });
  element("selectAllMbbsCandidates")?.addEventListener("change", (event) => toggleAllCandidates(event.target.checked));
  element("calculateSelectedMbbsCandidates")?.addEventListener("click", calculateSelectedMbbsCandidates);
  element("searchMbbsBillingCustomers")?.addEventListener("click", searchMbbsBillingCustomers);
  element("mbbsBillingCustomerSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchMbbsBillingCustomers();
    }
  });
  element("mbbsBillingCustomerId")?.addEventListener("change", syncCommandButtons);
  element("mbbsBatchConversionReason")?.addEventListener("input", syncCommandButtons);
  element("createMbbsBillingCases")?.addEventListener("click", createMbbsBillingCases);
  element("mbbsAddressOverrideForm")?.addEventListener("submit", saveMbbsAddressOverride);
  element("refreshBillingCases")?.addEventListener("click", () => loadBillingCases());
  element("billingStatusFilter")?.addEventListener("change", () => loadBillingCases());
  element("billingTypeFilter")?.addEventListener("change", () => loadBillingCases());
  element("billingMonthFilter")?.addEventListener("change", () => loadBillingCases());
  element("moreBillingCases")?.addEventListener("click", () => loadBillingCases({ reset: false }));
  element("billingCaseCalculationForm")?.addEventListener("submit", calculateSelectedBillingCase);
  element("billingCaseApprovalForm")?.addEventListener("submit", approveSelectedBillingCase);
}

async function load() {
  if (!token) return;
  bind();
  selectBillingWorkspace("candidates");
  renderBatchResults();
  try {
    await loadCommandState();
    await Promise.all([loadMbbsCandidates(), loadBillingCases()]);
  } catch (error) {
    message("billingCommandMessage", error.message, "attention");
  }
}

load();
