const token = localStorage.getItem("mbbs.staff.token") || "";

const state = {
  commandsEnabled: false,
  billingItems: [],
  billingCursor: null,
  reconciliationItems: [],
  reconciliationCursor: null,
  selectedBatchId: null
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

function parseJson(id, label) {
  const source = inputValue(id);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function money(value, currency = "CAD") {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency
  }).format(Number(value) / 100);
}

function textCell(value) {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "—");
  return cell;
}

function actionButton(label, focusKey, operation, { command = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.focusKey = focusKey;
  if (command) button.classList.add("mbt-command");
  button.disabled = command && !state.commandsEnabled;
  button.addEventListener("click", operation);
  return button;
}

function actionCell(button) {
  const cell = document.createElement("td");
  cell.append(button);
  return cell;
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
}

async function loadCommandState() {
  const result = await api("/api/mbt/billing/status");
  state.commandsEnabled = result.commandState?.enabled === true;
  syncCommandButtons();
  const suffix = state.commandsEnabled
    ? "Local calculation, reconciliation, and approval commands are enabled."
    : "Commands are closed; retained evidence is available read-only.";
  message("billingCommandMessage", `${suffix} No external posting path exists.`);
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
    cell.colSpan = 6;
    row.append(cell);
    rows.append(row);
  }
  for (const item of state.billingItems) {
    const row = document.createElement("tr");
    const source = item.caseType === "mbt_contract" ? "MBT contract" : "MBBS cross-charge";
    row.append(
      textCell(source),
      textCell(item.customerNetsuiteId),
      textCell(item.status),
      textCell(item.currentVersionNumber || "—"),
      textCell(money(item.totalMinor, item.currency)),
      actionCell(actionButton(
        "Review",
        `billing:${item.billingCaseId}`,
        () => loadBillingCase(item.billingCaseId)
      ))
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
    message(
      "billingQueueMessage",
      `${state.billingItems.length} case(s) loaded. All displayed cases are ${result.postingMode || "local_only"}.`
    );
  } catch (error) {
    message("billingQueueMessage", error.message, "attention");
  }
}

function evidenceText(line) {
  const detail = line.calculationDetail || {};
  const source = detail.source || detail.deduplicationKey || "immutable calculation snapshot";
  return typeof source === "string" ? source : JSON.stringify(source);
}

function renderBillingCase(result) {
  setInputValue("calculationCaseId", result.billingCaseId);
  setInputValue("calculationVisitId", result.serviceVisitId || "");
  setInputValue("calculationDistanceId", result.visitDistanceSnapshotId || "");
  setInputValue("calculationRevision", result.revision);
  setInputValue("approvalCaseId", result.billingCaseId);
  setInputValue("approvalRevision", result.revision);
  const draft = (result.versions || []).find((version) => version.status === "draft");
  setInputValue("approvalVersionId", draft?.billingVersionId || "");
  const summary = element("selectedBillingCase");
  if (summary) {
    const binding = result.caseType === "mbt_contract"
      ? result.serviceVisitId && result.visitDistanceSnapshotId
        ? `visit ${result.serviceVisitId} · distance ${result.visitDistanceSnapshotId}`
        : "visit/distance binding incomplete"
      : `cross-charge ${result.crossChargeCaseId || "retained"}`;
    summary.textContent = `${result.caseType} · ${result.status} · revision ${result.revision} · ${result.postingMode} · ${binding}`;
  }
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
}

function cadMinorInput(id, label) {
  const value = inputValue(id);
  if (!value) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
    throw new Error(`${label} must be a positive CAD value with at most two decimal places.`);
  }
  return Math.round(amount * 100);
}

async function loadBillingCase(caseId) {
  message("billingCommandMessage", "Loading immutable calculation evidence…");
  try {
    const result = await api(`/api/mbt/billing/cases/${encodeURIComponent(caseId)}`);
    renderBillingCase(result);
    message("billingCommandMessage", "Calculation evidence loaded. Original versions remain queryable.");
  } catch (error) {
    message("billingCommandMessage", error.message, "attention");
  }
}

async function calculateBilling(event) {
  event.preventDefault();
  message("billingCommandMessage", "Calculating every draft line atomically…");
  const caseId = inputValue("calculationCaseId");
  const receiptId = inputValue("calculationReceiptId");
  try {
    const waiverAmountMinor = cadMinorInput("calculationWaiverCad", "Waiver amount");
    const waiverReason = inputValue("calculationWaiverReason");
    if (waiverAmountMinor !== null && !waiverReason) {
      throw new Error("Provide an audit note for the waiver.");
    }
    const result = await api(`/api/mbt/billing/cases/${encodeURIComponent(caseId)}/calculate`, {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-billing-calculate"),
      body: {
        serviceVisitId: inputValue("calculationVisitId"),
        distanceSnapshotId: inputValue("calculationDistanceId"),
        ...(receiptId ? { dumpReceiptId: receiptId } : {}),
        expectedRevision: Number(inputValue("calculationRevision")),
        componentQuantities: {},
        customPrices: [],
        ...(waiverAmountMinor === null ? {} : {
          waiver: { amountMinor: waiverAmountMinor, reason: waiverReason, description: "Audited billing waiver", taxable: false }
        }),
        reason: inputValue("calculationReason")
      }
    });
    message("billingCommandMessage", `Draft version ${result.versionNumber} is complete and local-only.`);
    await Promise.all([loadBillingCase(caseId), loadBillingCases()]);
  } catch (error) {
    message("billingCommandMessage", error.message, "attention");
  }
}

async function approveBilling(event) {
  event.preventDefault();
  const caseId = inputValue("approvalCaseId");
  message("billingCommandMessage", "Validating the complete draft and every open variance…");
  try {
    const result = await api(`/api/mbt/billing/cases/${encodeURIComponent(caseId)}/approve-local`, {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-billing-approve"),
      body: {
        billingVersionId: inputValue("approvalVersionId"),
        expectedRevision: Number(inputValue("approvalRevision")),
        reason: inputValue("approvalReason")
      }
    });
    message("billingCommandMessage", `Version ${result.versionNumber} approved locally. External work created: 0.`);
    await Promise.all([loadBillingCase(caseId), loadBillingCases()]);
  } catch (error) {
    message("billingCommandMessage", error.message, "attention");
  }
}

async function generateMbbs(event) {
  event.preventDefault();
  const output = element("mbbsGenerationResult");
  try {
    const evidence = parseJson("mbbsGenerationJson", "MBBS snapshot generation evidence");
    const result = await api("/api/mbt/billing/mbbs/generate", {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-billing-mbbs"),
      body: { ...evidence, reason: inputValue("mbbsGenerationReason") }
    });
    if (output) output.textContent = JSON.stringify(result, null, 2);
    await loadBillingCases();
  } catch (error) {
    if (output) output.textContent = error.message;
  }
}

function reconciliationQuery() {
  const params = new URLSearchParams({ limit: "25" });
  if (state.reconciliationCursor) params.set("cursor", state.reconciliationCursor);
  return params;
}

function renderReconciliationBatches() {
  const rows = element("reconciliationBatchRows");
  if (!rows) return;
  const focusKey = retainedFocusKey();
  rows.replaceChildren();
  if (!state.reconciliationItems.length) {
    const row = document.createElement("tr");
    const cell = textCell("No retained reconciliation batches are available.");
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
  }
  for (const item of state.reconciliationItems) {
    const row = document.createElement("tr");
    row.append(
      textCell(item.batchReference),
      textCell(item.manualSource),
      textCell(item.rowCount),
      textCell(item.openVarianceCount),
      actionCell(actionButton(
        "Review evidence",
        `reconciliation:${item.batchId}`,
        () => loadReconciliationBatch(item.batchId)
      ))
    );
    rows.append(row);
  }
  const more = element("moreReconciliation");
  if (more) more.hidden = !state.reconciliationCursor;
  restoreFocus(focusKey, rows);
}

async function loadReconciliationBatches({ reset = true } = {}) {
  if (reset) {
    state.reconciliationItems = [];
    state.reconciliationCursor = null;
  }
  message("reconciliationMessage", "Loading immutable comparison batches…");
  try {
    const result = await api(`/api/mbt/reconciliation/batches?${reconciliationQuery()}`);
    state.reconciliationItems.push(...(Array.isArray(result.items) ? result.items : []));
    state.reconciliationCursor = result.nextCursor || null;
    renderReconciliationBatches();
    message("reconciliationMessage", `${state.reconciliationItems.length} batch(es) loaded.`);
  } catch (error) {
    message("reconciliationMessage", error.message, "attention");
  }
}

function selectVariance(batchId, rowId) {
  setInputValue("resolutionBatchId", batchId);
  setInputValue("resolutionRowId", rowId);
  element("resolutionNote")?.focus();
}

function renderReconciliationEvidence(batch) {
  const rows = element("reconciliationEvidenceRows");
  if (!rows) return;
  rows.replaceChildren();
  for (const item of batch.rows || []) {
    const row = document.createElement("tr");
    const differences = Array.isArray(item.differences)
      ? item.differences.map((difference) => difference.field).join(", ")
      : "";
    const action = item.comparisonResult === "open_variance" && !item.resolution
      ? actionButton(
        "Resolve",
        `variance:${item.reconciliationRowId}`,
        () => selectVariance(batch.batchId, item.reconciliationRowId),
        { command: true }
      )
      : document.createTextNode(item.effectiveResult || "Retained");
    const actionColumn = document.createElement("td");
    actionColumn.append(action);
    row.append(
      textCell(item.comparisonKind),
      textCell(item.manualReference),
      textCell(item.effectiveResult),
      textCell(differences || "Exact match"),
      actionColumn
    );
    rows.append(row);
  }
  syncCommandButtons();
}

async function loadReconciliationBatch(batchId) {
  message("reconciliationMessage", "Loading retained application and manual snapshots…");
  try {
    const result = await api(`/api/mbt/reconciliation/batches/${encodeURIComponent(batchId)}`);
    state.selectedBatchId = batchId;
    renderReconciliationEvidence(result);
    message("reconciliationMessage", `${result.rows.length} comparison row(s) loaded from ${result.batchReference}.`);
  } catch (error) {
    message("reconciliationMessage", error.message, "attention");
  }
}

async function createReconciliation(event) {
  event.preventDefault();
  try {
    const comparisons = parseJson("reconciliationComparisons", "Reconciliation comparisons");
    if (!Array.isArray(comparisons)) throw new Error("Reconciliation comparisons must be a JSON array.");
    const result = await api("/api/mbt/reconciliation/batches", {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-reconciliation-create"),
      body: {
        batchReference: inputValue("reconciliationBatchReference"),
        manualSource: inputValue("reconciliationManualSource"),
        comparisons,
        reason: inputValue("reconciliationCreateReason")
      }
    });
    message("reconciliationMessage", `Batch ${result.batchReference} retained with ${result.rows.length} comparison(s).`);
    await Promise.all([loadReconciliationBatches(), loadReconciliationBatch(result.batchId)]);
  } catch (error) {
    message("reconciliationMessage", error.message, "attention");
  }
}

async function resolveVariance(event) {
  event.preventDefault();
  const batchId = inputValue("resolutionBatchId");
  const correctionSource = inputValue("resolutionCorrection");
  try {
    const correctionReference = correctionSource
      ? parseJson("resolutionCorrection", "Correction reference")
      : null;
    const result = await api(`/api/mbt/reconciliation/batches/${encodeURIComponent(batchId)}/resolve`, {
      method: "POST",
      idempotencyKey: commandIdentity("mbt-reconciliation-resolve"),
      body: {
        reconciliationRowId: inputValue("resolutionRowId"),
        decision: inputValue("resolutionDecision"),
        note: inputValue("resolutionNote"),
        correctionReference
      }
    });
    message("reconciliationMessage", `Immutable decision recorded: ${result.decision}.`);
    await Promise.all([loadReconciliationBatches(), loadReconciliationBatch(batchId)]);
  } catch (error) {
    message("reconciliationMessage", error.message, "attention");
  }
}

function bind() {
  element("refreshBillingCases")?.addEventListener("click", () => loadBillingCases());
  element("billingStatusFilter")?.addEventListener("change", () => loadBillingCases());
  element("billingTypeFilter")?.addEventListener("change", () => loadBillingCases());
  element("billingMonthFilter")?.addEventListener("change", () => loadBillingCases());
  element("moreBillingCases")?.addEventListener("click", () => loadBillingCases({ reset: false }));
  element("calculateBillingForm")?.addEventListener("submit", calculateBilling);
  element("approveBillingForm")?.addEventListener("submit", approveBilling);
  element("mbbsGenerationForm")?.addEventListener("submit", generateMbbs);
  element("refreshReconciliation")?.addEventListener("click", () => loadReconciliationBatches());
  element("moreReconciliation")?.addEventListener("click", () => loadReconciliationBatches({ reset: false }));
  element("createReconciliationForm")?.addEventListener("submit", createReconciliation);
  element("resolveVarianceForm")?.addEventListener("submit", resolveVariance);
  const mbbs = element("mbbsGenerationJson");
  if (mbbs) mbbs.placeholder = "{\n  \"currency\": \"CAD\",\n  \"rateCardVersionId\": \"…\",\n  \"rateDistanceBandId\": \"…\",\n  \"customerNetsuiteId\": \"…\",\n  \"completedLoadSnapshotIds\": [\"…\"]\n}";
  const comparisons = element("reconciliationComparisons");
  if (comparisons) comparisons.placeholder = "[{\n  \"comparisonKind\": \"distance\",\n  \"applicationEvidenceId\": \"…\",\n  \"manualReference\": \"…\",\n  \"manualSnapshot\": {}\n}]";
}

async function load() {
  if (!token) return;
  bind();
  try {
    await loadCommandState();
    await Promise.all([loadBillingCases(), loadReconciliationBatches()]);
  } catch (error) {
    message("billingCommandMessage", error.message, "attention");
  }
}

load();
