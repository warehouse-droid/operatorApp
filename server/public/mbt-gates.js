const token = localStorage.getItem("mbbs.staff.token")
  || localStorage.getItem("mbbs.control.token")
  || "";
const statusRegion = document.querySelector(".mbt-status");
const gateList = document.getElementById("gateList");
const operatorNetSuiteGateMatrix = document.getElementById("operatorNetSuiteGateMatrix");
const operatorNetSuiteAttention = document.getElementById("operatorNetSuiteAttention");
const salesOrderFulfillmentGateMatrix = document.getElementById("salesOrderFulfillmentGateMatrix");
const salesOrderFulfillmentAttention = document.getElementById("salesOrderFulfillmentAttention");
const salesOrderFulfillmentHistoricalForm = document.getElementById("salesOrderFulfillmentHistoricalForm");
const salesOrderFulfillmentHistoricalSearch = document.getElementById("salesOrderFulfillmentHistoricalSearch");
const salesOrderFulfillmentHistoricalResults = document.getElementById("salesOrderFulfillmentHistoricalResults");
const queueSalesOrderFulfillmentHistorical = document.getElementById("queueSalesOrderFulfillmentHistorical");
const reasonInput = document.getElementById("gateReason");
const refreshButton = document.getElementById("refreshGates");

let inventory = null;
let attentionCommands = [];
let attentionLoadError = "";
let fulfillmentCandidates = [];
let fulfillmentLoadError = "";
let historicalFulfillmentEvents = [];
let saving = false;

function normalizedRoles(operator) {
  return new Set([...(Array.isArray(operator?.roles) ? operator.roles : []), operator?.role]
    .map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_"))
    .filter(Boolean));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "The MBT gate request failed.");
    error.status = response.status;
    error.code = payload.code || "";
    throw error;
  }
  return payload;
}

function replaceStatus(title, lines, tone = "safe", busy = false) {
  if (!statusRegion) return;
  statusRegion.replaceChildren();
  statusRegion.dataset.tone = tone;
  statusRegion.setAttribute("aria-busy", String(busy));
  const heading = document.createElement("h2");
  heading.textContent = title;
  statusRegion.append(heading);
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    statusRegion.append(paragraph);
  }
}

function badge(label, state) {
  const element = document.createElement("span");
  element.className = "mbt-gate-badge";
  element.dataset.state = state;
  element.textContent = label;
  return element;
}

function dispatchOrderPoolRolloutText(rollout) {
  if (!rollout) return "";
  const projection = rollout.assignmentsReady ? "assignments ready" : "assignments warming";
  const counts = `${Number(rollout.catalogCount || 0).toLocaleString("en-CA")} catalog / ${Number(rollout.legacyCount || 0).toLocaleString("en-CA")} legacy`;
  const pending = `${Number(rollout.pendingRefreshCount || 0).toLocaleString("en-CA")} refreshes pending`;
  const shadow = `${Number(rollout.shadowMatchCount || 0)}/${Number(rollout.requiredShadowMatchCount || 0)} shadow matches; ${Number(rollout.shadowMismatchCount || 0)} mismatches`;
  return `Rollout check: deployment ${rollout.deploymentMode}; catalog ${rollout.status} (generation ${Number(rollout.generation || 0)}, ${counts}); ${projection}; ${pending}; ${shadow}.`;
}

function gateArticle(gate) {
  const article = document.createElement("article");
  article.className = "mbt-gate-card";
  article.dataset.flagKey = gate.flagKey;

  const copy = document.createElement("div");
  copy.className = "mbt-gate-copy";
  const title = document.createElement("h3");
  title.textContent = gate.label;
  const key = document.createElement("code");
  key.textContent = gate.flagKey;
  const description = document.createElement("p");
  description.textContent = gate.description;
  copy.append(title, key, description);
  if (gate.dispatchOrderPool) {
    const rollout = document.createElement("p");
    rollout.className = "mbt-gate-runtime-status";
    rollout.textContent = dispatchOrderPoolRolloutText(gate.dispatchOrderPool);
    copy.append(rollout);
    if (gate.dispatchOrderPool.lastError) {
      const rolloutError = document.createElement("p");
      rolloutError.className = "danger";
      rolloutError.textContent = `Catalog error: ${gate.dispatchOrderPool.lastError}`;
      copy.append(rolloutError);
    }
  }

  const states = document.createElement("div");
  states.className = "mbt-gate-states";
  states.append(
    badge(gate.configured ? "Configured on" : "Configured off", gate.configured ? "on" : "off"),
    gate.deploymentGuarded
      ? badge(gate.environmentAllowed ? "Read path ready" : "Read path blocked", gate.environmentAllowed ? "open" : "closed")
      : gate.independent
      ? badge("Admin controlled", "open")
      : badge(gate.environmentAllowed ? "Deployment open" : "Deployment closed", gate.environmentAllowed ? "open" : "closed"),
    badge(gate.effective ? "Effective" : "Inactive", gate.effective ? "effective" : "inactive")
  );

  const action = document.createElement("div");
  action.className = "mbt-gate-action";
  if (gate.locked) {
    action.append(badge("Locked", "locked"));
    const reason = document.createElement("p");
    reason.textContent = gate.lockReason || "This gate is deployment-controlled.";
    action.append(reason);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.gateToggle = gate.flagKey;
    button.dataset.expectedRevision = String(gate.revision);
    button.dataset.nextEnabled = String(!gate.configured);
    button.textContent = gate.configured ? "Turn off" : "Turn on";
    button.setAttribute("aria-label", `${gate.configured ? "Turn off" : "Turn on"} ${gate.label}`);
    const rolloutBlocked = gate.deploymentGuarded && !gate.configured && !gate.activationReady;
    button.disabled = saving || rolloutBlocked;
    action.append(button);
    if (rolloutBlocked) {
      const reason = document.createElement("p");
      reason.textContent = "Turn on is locked until deployment mode is on, the indexed catalog and assignments are ready, pending refreshes are drained, and shadow comparisons match.";
      action.append(reason);
    }
  }

  article.append(copy, states, action);
  return article;
}

function operatorGateCell(gate) {
  const cell = document.createElement("td");
  cell.className = "mbt-operator-gate-cell";
  cell.dataset.state = gate?.effective ? "effective" : "inactive";
  if (!gate) {
    cell.textContent = "Missing gate";
    return cell;
  }
  const state = document.createElement("strong");
  state.textContent = gate.effective
    ? `Creates ${gate.transactionType}`
    : gate.configured && !gate.environmentAllowed
      ? "Configured on · ceiling closed"
      : "Local only";
  const revision = document.createElement("span");
  revision.textContent = `Revision ${gate.revision ?? "missing"}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mbt-operator-gate-toggle";
  button.dataset.gateToggle = gate.flagKey;
  button.dataset.expectedRevision = String(gate.revision);
  button.dataset.nextEnabled = String(!gate.configured);
  button.textContent = gate.configured ? "Turn off" : "Turn on";
  button.setAttribute("aria-label", `${gate.configured ? "Turn off" : "Turn on"} ${gate.label}`);
  button.disabled = saving || gate.locked;
  cell.append(state, revision, button);
  if (gate.locked) {
    const lock = document.createElement("small");
    lock.textContent = gate.lockReason || "Gate unavailable";
    cell.append(lock);
  }
  return cell;
}

function renderOperatorNetSuiteGateMatrix() {
  if (!operatorNetSuiteGateMatrix || !inventory) return;
  operatorNetSuiteGateMatrix.replaceChildren();
  const gates = inventory.gates.filter((gate) => gate.gateGroup === "operator_netsuite_posting");
  const ceiling = document.createElement("div");
  ceiling.className = "mbt-gate-ceiling";
  ceiling.dataset.state = inventory.netSuiteDirectAccessAllowed ? "open" : "closed";
  ceiling.textContent = inventory.netSuiteDirectAccessAllowed
    ? "NetSuite direct-access ceiling is open. A configured-on cell is effective."
    : "NetSuite direct-access ceiling is closed. Every cell remains Local only even if configured on.";

  const functions = [
    { key: "customer_pickup", label: "Customer Pickup", type: "IF" },
    { key: "receiving", label: "Receiving", type: "IR" },
    { key: "delivery_prep", label: "Delivery Prep", type: "IF" }
  ];
  const yards = [...new Set(gates.map((gate) => String(gate.yardCode || "")))];
  const table = document.createElement("table");
  table.className = "mbt-operator-gate-table";
  const head = document.createElement("thead");
  const headingRow = document.createElement("tr");
  const yardHeading = document.createElement("th");
  yardHeading.scope = "col";
  yardHeading.textContent = "Yard";
  headingRow.append(yardHeading);
  for (const definition of functions) {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = `${definition.label} → ${definition.type}`;
    headingRow.append(heading);
  }
  head.append(headingRow);
  const body = document.createElement("tbody");
  for (const yardCode of yards) {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = yardCode;
    row.append(label);
    for (const definition of functions) {
      row.append(operatorGateCell(gates.find((gate) => (
        gate.yardCode === yardCode && gate.operatorFunction === definition.key
      ))));
    }
    body.append(row);
  }
  table.append(head, body);
  operatorNetSuiteGateMatrix.append(ceiling, table);
}

function renderSalesOrderFulfillmentGateMatrix() {
  if (!salesOrderFulfillmentGateMatrix || !inventory) return;
  salesOrderFulfillmentGateMatrix.replaceChildren();
  const gates = inventory.gates.filter((gate) => gate.gateGroup === "dispatch_sales_order_fulfillment");
  const ceiling = document.createElement("div");
  ceiling.className = "mbt-gate-ceiling";
  ceiling.dataset.state = inventory.netSuiteDirectAccessAllowed ? "open" : "closed";
  ceiling.textContent = inventory.netSuiteDirectAccessAllowed
    ? "NetSuite direct access is open. Each enabled yard starts only after its recorded activation watermark."
    : "NetSuite direct access is closed. These configured gates remain inactive and no SO fulfillment worker can post.";
  const cards = document.createElement("div");
  cards.className = "mbt-fulfillment-gate-grid";
  cards.replaceChildren(...gates.map(gateArticle));
  salesOrderFulfillmentGateMatrix.append(ceiling, cards);
}

function fulfillmentLineSummary(line) {
  return `Line ${line.orderLine} · target ${line.targetQuantity} = Operator ${line.operatorLoadedQuantity} + PO ${line.completedPoQuantity} + direct TO ${line.completedDirectToQuantity}`;
}

function fulfillmentActionSelect(candidate) {
  const label = document.createElement("label");
  label.className = "mbt-fulfillment-action";
  label.textContent = "Admin action";
  const select = document.createElement("select");
  select.dataset.fulfillmentAction = candidate.id;
  const actions = candidate.status === "uncertain"
    ? [["recover", "Recover by external ID"]]
    : [["recheck", "Recheck live order"]];
  if (candidate.status !== "uncertain" && (candidate.lineSnapshot || []).length) {
    actions.push(
      ["snapshot", "Use frozen delivered snapshot"],
      ["all_live_remaining", "Use all live remaining"],
      ["custom", "Use custom bounded quantities"]
    );
  }
  if (candidate.status === "failed") actions.push(["recover", "Recover by external ID"]);
  if (["historical", "gate_disabled"].includes(candidate.status)) actions.push(["historical_backfill", "Queue as selected historical"]);
  actions.push(["skip", "Skip permanently"]);
  for (const [value, copy] of actions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = copy;
    select.append(option);
  }
  if (candidate.status === "uncertain") select.value = "recover";
  if (candidate.status === "historical") select.value = "historical_backfill";
  label.append(select);
  return label;
}

function fulfillmentCandidateCard(candidate) {
  const article = document.createElement("article");
  article.className = "mbt-attention-card mbt-fulfillment-candidate";
  article.dataset.candidateStatus = candidate.status;
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = `${candidate.dispatchOrderRef} · ${candidate.status}`;
  const identity = document.createElement("code");
  identity.textContent = `${candidate.externalId} · source ${candidate.sourceSalesOrderRef || "unresolved"}`;
  const completion = document.createElement("p");
  completion.textContent = `Completion ${candidate.dispatchCompletedAt || "time unavailable"} · ${candidate.completionEvidenceType || "evidence unresolved"} · ${candidate.loadId || "no load"}`;
  copy.append(title, identity, completion);
  if (candidate.lastError) {
    const error = document.createElement("p");
    error.className = "danger";
    error.textContent = candidate.lastError;
    copy.append(error);
  }
  const lines = document.createElement("div");
  lines.className = "mbt-fulfillment-lines";
  for (const line of candidate.lineSnapshot || []) {
    const row = document.createElement("label");
    const summary = document.createElement("span");
    summary.textContent = fulfillmentLineSummary(line);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0.000001";
    input.step = "any";
    input.value = String(line.deliveredQuantity);
    input.dataset.fulfillmentCandidateLine = candidate.id;
    input.dataset.orderLine = String(line.orderLine);
    input.setAttribute("aria-label", `${candidate.dispatchOrderRef} line ${line.orderLine} custom fulfillment quantity`);
    row.append(summary, input);
    lines.append(row);
  }
  copy.append(lines);
  const actions = document.createElement("div");
  actions.className = "mbt-fulfillment-card-actions";
  actions.append(fulfillmentActionSelect(candidate));
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.fulfillmentResolve = candidate.id;
  button.textContent = "Apply reviewed action";
  button.disabled = saving;
  actions.append(button);
  article.append(copy, actions);
  return article;
}

function renderSalesOrderFulfillmentCandidates() {
  if (!salesOrderFulfillmentAttention) return;
  salesOrderFulfillmentAttention.replaceChildren();
  if (fulfillmentLoadError) {
    const unavailable = document.createElement("p");
    unavailable.className = "mbt-attention-empty danger";
    unavailable.textContent = `Delivery SO fulfillment queue unavailable: ${fulfillmentLoadError}`;
    salesOrderFulfillmentAttention.append(unavailable);
    return;
  }
  if (!fulfillmentCandidates.length) {
    const empty = document.createElement("p");
    empty.className = "mbt-attention-empty";
    empty.textContent = "No Delivery SO fulfillment candidates need Admin review.";
    salesOrderFulfillmentAttention.append(empty);
    return;
  }
  salesOrderFulfillmentAttention.replaceChildren(...fulfillmentCandidates.map(fulfillmentCandidateCard));
}

function renderHistoricalFulfillmentEvents() {
  if (!salesOrderFulfillmentHistoricalResults) return;
  salesOrderFulfillmentHistoricalResults.replaceChildren();
  if (!historicalFulfillmentEvents.length) {
    const empty = document.createElement("p");
    empty.className = "mbt-attention-empty";
    empty.textContent = "Search for an exact or partial SO reference to preview immutable completion evidence.";
    salesOrderFulfillmentHistoricalResults.append(empty);
    return;
  }
  for (const event of historicalFulfillmentEvents) {
    const label = document.createElement("label");
    label.className = "mbt-historical-event";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = event.eventId;
    checkbox.dataset.historicalFulfillmentEvent = event.eventId;
    checkbox.disabled = !event.supported || ["completed", "reconciled", "closed"].includes(event.candidateStatus);
    const copy = document.createElement("span");
    copy.textContent = `${event.orderRef} · ${event.dispatchCompletedAt} · source ${event.sourceSalesOrderRef || "unresolved"} · ${event.candidateStatus || "not queued"}${event.supported ? "" : " · unsupported yard/source"}`;
    label.append(checkbox, copy);
    salesOrderFulfillmentHistoricalResults.append(label);
  }
}

function renderAttentionCommands() {
  if (!operatorNetSuiteAttention) return;
  operatorNetSuiteAttention.replaceChildren();
  if (attentionLoadError) {
    const unavailable = document.createElement("p");
    unavailable.className = "mbt-attention-empty danger";
    unavailable.textContent = `Attention queue unavailable: ${attentionLoadError}`;
    operatorNetSuiteAttention.append(unavailable);
    return;
  }
  if (!attentionCommands.length) {
    const empty = document.createElement("p");
    empty.className = "mbt-attention-empty";
    empty.textContent = "No Operator NetSuite posting commands need attention.";
    operatorNetSuiteAttention.append(empty);
    return;
  }
  for (const command of attentionCommands) {
    const article = document.createElement("article");
    article.className = "mbt-attention-card";
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = `${command.yardCode} · ${String(command.functionKey || "").replaceAll("_", " ")} · ${command.transactionType}`;
    const identity = document.createElement("code");
    identity.textContent = command.id;
    const detail = document.createElement("p");
    detail.textContent = command.lastError || "Verification stopped before local completion.";
    const steps = document.createElement("p");
    steps.textContent = (command.steps || []).map((step) => (
      `${step.sourceOrderRef || step.sourceNetSuiteId}: ${step.status}`
    )).join(" · ");
    copy.append(title, identity, detail, steps);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.postingResume = command.id;
    button.textContent = "Resume verification";
    button.disabled = saving;
    article.append(copy, button);
    operatorNetSuiteAttention.append(article);
  }
}

function renderGates() {
  if (!gateList || !inventory) return;
  gateList.replaceChildren(...inventory.gates
    .filter((gate) => !["operator_netsuite_posting", "dispatch_sales_order_fulfillment"].includes(gate.gateGroup))
    .map(gateArticle));
  renderOperatorNetSuiteGateMatrix();
  renderSalesOrderFulfillmentGateMatrix();
  renderAttentionCommands();
  renderSalesOrderFulfillmentCandidates();
  renderHistoricalFulfillmentEvents();
}

function commandKey(flagKey) {
  const nonce = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `mbt-admin-gate-${flagKey}-${nonce}`;
}

async function loadGates(message = "Gate controls ready") {
  const [nextInventory, attention, fulfillment] = await Promise.all([
    api("/api/mbt/config/gates"),
    api("/api/admin/operator-netsuite-posting/attention")
      .then((result) => ({ result, error: "" }))
      .catch((error) => ({ result: null, error: error.message })),
    api("/api/admin/sales-order-fulfillment/candidates?status=waiting_evidence,attention,uncertain,failed,historical,gate_disabled")
      .then((result) => ({ result, error: "" }))
      .catch((error) => ({ result: null, error: error.message }))
  ]);
  inventory = nextInventory;
  attentionCommands = attention.result?.commands || [];
  attentionLoadError = attention.error;
  fulfillmentCandidates = fulfillment.result?.candidates || [];
  fulfillmentLoadError = fulfillment.error;
  renderGates();
  const effective = inventory.gates.filter((gate) => gate.effective).length;
  const configured = inventory.gates.filter((gate) => gate.configured).length;
  replaceStatus(message, [
    `${configured} Admin gates are configured on; ${effective} are currently effective.`,
    inventory.environmentRootAllowed
      ? "The MBT deployment ceiling is open for approved local capabilities."
      : "The MBT deployment ceiling is closed for MBT modules; independent operational gates retain their own ceilings.",
    inventory.netSuiteDirectAccessAllowed
      ? "The NetSuite direct-access ceiling is open for configured Operator yard/function cells."
      : "The NetSuite direct-access ceiling is closed; all Operator IF/IR cells are Local only."
  ]);
}

async function updateGate(button) {
  const flagKey = String(button.dataset.gateToggle || "");
  const selected = inventory?.gates?.find((gate) => gate.flagKey === flagKey);
  if (!selected || selected.locked || saving) return;
  const reason = String(reasonInput?.value || "").trim();
  if (!reason) {
    replaceStatus("Audit reason required", ["Enter why this gate is changing, then try again."], "attention");
    reasonInput?.focus();
    return;
  }
  saving = true;
  renderGates();
  replaceStatus("Saving gate change", [
    `${selected.label} is being changed to ${selected.configured ? "off" : "on"}. Please wait.`
  ], "safe", true);
  try {
    await api(`/api/mbt/config/gates/${encodeURIComponent(flagKey)}`, {
      method: "PUT",
      headers: { "idempotency-key": commandKey(flagKey) },
      body: JSON.stringify({
        enabled: !selected.configured,
        expectedRevision: selected.revision,
        reason
      })
    });
    await loadGates(`${selected.label} is now configured ${selected.configured ? "off" : "on"}`);
  } catch (error) {
    if (error.status === 401) {
      location.replace("/");
      return;
    }
    const failureMessage = error.code === "MBT_STALE_REVISION"
      ? "Another Admin changed this gate. The latest state is shown below; review it before trying again."
      : error.message;
    inventory = await api("/api/mbt/config/gates").catch(() => inventory);
    renderGates();
    replaceStatus("Gate change not saved", [failureMessage], "attention");
  } finally {
    saving = false;
    renderGates();
  }
}

async function resumeOperatorNetSuitePosting(button) {
  const commandId = String(button.dataset.postingResume || "");
  if (!commandId || saving) return;
  const reason = String(reasonInput?.value || "").trim();
  if (!reason) {
    replaceStatus("Audit reason required", ["Enter why verification is being resumed, then try again."], "attention");
    reasonInput?.focus();
    return;
  }
  saving = true;
  renderGates();
  replaceStatus("Resuming NetSuite verification", [
    "The existing external ID will be checked before any retry. Local completion remains frozen."
  ], "safe", true);
  try {
    await api(`/api/admin/operator-netsuite-posting/${encodeURIComponent(commandId)}/resume`, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    await loadGates("NetSuite verification resumed");
  } catch (error) {
    replaceStatus("Verification was not resumed", [error.message], "attention");
    await loadGates("Review the latest posting state").catch(() => {});
  } finally {
    saving = false;
    renderGates();
  }
}

async function resolveSalesOrderFulfillment(button) {
  const candidateId = String(button.dataset.fulfillmentResolve || "");
  const candidate = fulfillmentCandidates.find((item) => item.id === candidateId);
  if (!candidate || saving) return;
  const reason = String(reasonInput?.value || "").trim();
  if (!reason) {
    replaceStatus("Audit reason required", ["Enter why this fulfillment decision is safe, then try again."], "attention");
    reasonInput?.focus();
    return;
  }
  const select = salesOrderFulfillmentAttention?.querySelector(`[data-fulfillment-action="${CSS.escape(candidateId)}"]`);
  const action = String(select?.value || "recheck");
  const lines = action === "custom"
    ? [...salesOrderFulfillmentAttention.querySelectorAll(`[data-fulfillment-candidate-line="${CSS.escape(candidateId)}"]`)]
      .map((input) => ({
        orderLine: Number(input.dataset.orderLine),
        quantity: Number(input.value)
      }))
    : [];
  saving = true;
  renderGates();
  replaceStatus("Saving reviewed fulfillment action", [
    `${candidate.dispatchOrderRef} remains frozen until the server validates this decision.`
  ], "safe", true);
  try {
    await api(`/api/admin/sales-order-fulfillment/${encodeURIComponent(candidateId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ action, lines, reason })
    });
    await loadGates(`${candidate.dispatchOrderRef} action saved`);
  } catch (error) {
    replaceStatus("Fulfillment action was not saved", [error.message], "attention");
    await loadGates("Review the latest fulfillment state").catch(() => {});
  } finally {
    saving = false;
    renderGates();
  }
}

async function previewHistoricalFulfillment(event) {
  event?.preventDefault?.();
  if (saving) return;
  const search = String(salesOrderFulfillmentHistoricalSearch?.value || "").trim();
  if (search.length < 2) {
    replaceStatus("SO reference required", ["Enter at least two characters before previewing historical completions."], "attention");
    salesOrderFulfillmentHistoricalSearch?.focus();
    return;
  }
  replaceStatus("Searching historical completions", ["No historical completion is queued by this preview."], "safe", true);
  try {
    const result = await api(`/api/admin/sales-order-fulfillment/historical?search=${encodeURIComponent(search)}`);
    historicalFulfillmentEvents = result.events || [];
    renderHistoricalFulfillmentEvents();
    replaceStatus("Historical preview ready", [`${historicalFulfillmentEvents.length} completion event(s) found. Select only reviewed rows.`]);
  } catch (error) {
    historicalFulfillmentEvents = [];
    renderHistoricalFulfillmentEvents();
    replaceStatus("Historical preview failed", [error.message], "attention");
  }
}

async function queueHistoricalFulfillment() {
  if (saving) return;
  const completionEventIds = [...(salesOrderFulfillmentHistoricalResults?.querySelectorAll("[data-historical-fulfillment-event]:checked") || [])]
    .map((input) => input.value);
  const reason = String(reasonInput?.value || "").trim();
  if (!completionEventIds.length) {
    replaceStatus("Historical selection required", ["Select at least one supported completion event."], "attention");
    return;
  }
  if (!reason) {
    replaceStatus("Audit reason required", ["Enter why these historical completions should be queued."], "attention");
    reasonInput?.focus();
    return;
  }
  saving = true;
  renderGates();
  replaceStatus("Queueing selected historical completions", ["Only the selected immutable event IDs are being admitted."], "safe", true);
  try {
    const result = await api("/api/admin/sales-order-fulfillment/historical", {
      method: "POST",
      body: JSON.stringify({ completionEventIds, reason })
    });
    historicalFulfillmentEvents = [];
    await loadGates(`${result.candidates?.length || 0} historical completion(s) queued`);
  } catch (error) {
    replaceStatus("Historical completions were not queued", [error.message], "attention");
  } finally {
    saving = false;
    renderGates();
  }
}

async function load() {
  if (!token) {
    location.replace("/");
    return;
  }
  try {
    const { operator } = await api("/api/auth/me");
    if (!normalizedRoles(operator).has("admin")) {
      location.replace(operator?.homeRoute || "/");
      return;
    }
    await loadGates();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      location.replace("/");
      return;
    }
    replaceStatus("Gate controls unavailable", [error.message], "attention");
  }
}

gateList?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-gate-toggle]");
  if (button) updateGate(button);
});

operatorNetSuiteGateMatrix?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-gate-toggle]");
  if (button) updateGate(button);
});

salesOrderFulfillmentGateMatrix?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-gate-toggle]");
  if (button) updateGate(button);
});

operatorNetSuiteAttention?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-posting-resume]");
  if (button) resumeOperatorNetSuitePosting(button);
});

salesOrderFulfillmentAttention?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-fulfillment-resolve]");
  if (button) resolveSalesOrderFulfillment(button);
});

salesOrderFulfillmentHistoricalForm?.addEventListener("submit", previewHistoricalFulfillment);
queueSalesOrderFulfillmentHistorical?.addEventListener("click", queueHistoricalFulfillment);

refreshButton?.addEventListener("click", async () => {
  if (saving) return;
  replaceStatus("Refreshing gate controls", ["Loading the latest server-owned revisions."], "safe", true);
  await loadGates().catch((error) => {
    replaceStatus("Refresh failed", [error.message], "attention");
  });
});

load();
