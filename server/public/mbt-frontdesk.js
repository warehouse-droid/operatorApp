const token = localStorage.getItem("mbbs.staff.token") || "";
const message = document.getElementById("frontdeskMessage");
const customerSearch = document.getElementById("customerSearch");
const customerResults = document.getElementById("customerResults");
const openNewContractOrder = document.getElementById("openNewContractOrder");
const newContractDialog = document.getElementById("newContractDialog");
const newContractCustomer = document.getElementById("newContractCustomer");
const quoteForm = document.getElementById("quoteForm");
const orderKind = document.getElementById("orderKind");
const binOrderFields = document.getElementById("binOrderFields");
const deliveryOrderFields = document.getElementById("deliveryOrderFields");
const deliveryItemCode = document.getElementById("deliveryItemCode");
const createOrderButton = document.getElementById("createQuoteButton");
const binType = document.getElementById("binType");
const serviceCode = document.getElementById("serviceCode");
const contractServiceSite = document.getElementById("contractServiceSite");
const contractNewSiteFields = document.getElementById("contractNewSiteFields");
const binDeliveryItemCode = document.getElementById("binDeliveryItemCode");
const orderFrom150 = document.getElementById("orderFrom150");
const orderSurchargeEditor = document.getElementById("orderSurchargeEditor");
const addOrderSurcharge = document.getElementById("addOrderSurcharge");
const deliveryAt = document.getElementById("deliveryAt");
const returnAt = document.getElementById("returnAt");
const serviceLineEditor = document.getElementById("serviceLineEditor");
const addServiceLine = document.getElementById("addServiceLine");
const contractMaster = document.getElementById("contractMaster");
const workspaceEmpty = document.getElementById("workspaceEmpty");
const quoteCard = document.getElementById("quoteCard");
const contractCard = document.getElementById("contractCard");
const extensionDialog = document.getElementById("extensionDialog");
const extensionForm = document.getElementById("extensionForm");
const extensionFields = document.getElementById("extensionFields");
const serviceLineActionDialog = document.getElementById("serviceLineActionDialog");
const serviceLineActionForm = document.getElementById("serviceLineActionForm");
const serviceLineActionTitle = document.getElementById("serviceLineActionTitle");
const serviceLineActionHelp = document.getElementById("serviceLineActionHelp");
const serviceLineActionFields = document.getElementById("serviceLineActionFields");
const serviceLineActionSubmit = document.getElementById("serviceLineActionSubmit");
let extensionStart = null;
let extensionEnd = null;
let extensionReason = null;
let extensionServiceLineId = null;
let serviceLineAction = null;
let serviceLineActionId = null;
let serviceLineActionControls = {};

const state = {
  enabled: false,
  configuration: { binItems: [], binTypes: [], deliveryItems: [], dumpItems: [], surchargeItems: [], services: [] },
  customers: [],
  selectedCustomer: null,
  quote: null,
  contract: null,
  serviceLines: [],
  visits: [],
  amendments: [],
  customerContracts: [],
  searchSequence: 0
};

function commandIdentity(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
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
    const error = new Error(payload.error || "The Front Desk request failed safely.");
    error.code = payload.code || "MBT_FRONTDESK_REQUEST_FAILED";
    throw error;
  }
  return payload;
}

function setMessage(text, tone = "safe") {
  message.textContent = text;
  message.dataset.tone = tone;
}

function element(name, text = "", className = "") {
  const node = document.createElement(name);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, handler, className = "") {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}

function money(amountMinor, currency = "CAD") {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol"
  }).format(Number(amountMinor || 0) / 100);
}

function distance(metres) {
  return `${new Intl.NumberFormat("en-CA", { maximumFractionDigits: 1 }).format(Number(metres || 0) / 1000)} km`;
}

function displayDate(value) {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC"
  }).format(new Date(value));
}

function localDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function selectedService() {
  return state.configuration.services.find((item) => item.serviceCode === serviceCode.value) || null;
}

function selectedBin() {
  return configuredBinItems()
    .find((item) => item.itemCode === binType.value || item.typeCode === binType.value) || null;
}

function configuredBinItems() {
  return Array.isArray(state.configuration.binItems) && state.configuration.binItems.length
    ? state.configuration.binItems
    : Array.isArray(state.configuration.binTypes)
      ? state.configuration.binTypes
      : [];
}

function populateBinSelect(select) {
  const currentValue = select.value;
  select.replaceChildren(new Option("Select a bin", ""));
  for (const item of configuredBinItems()) {
    select.append(new Option(
      `${item.displayName || item.typeCode} · ${item.itemCode || item.typeCode}`,
      item.itemCode || item.typeCode
    ));
  }
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function populateDumpSelect(select) {
  const currentValue = select.value;
  select.replaceChildren(new Option("Select contents", ""));
  for (const item of state.configuration.dumpItems || []) {
    select.append(new Option(
      `${item.displayName || item.itemCode} · ${item.itemCode}`,
      item.itemCode
    ));
  }
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function populateDeliveryItemSelect(select) {
  const currentValue = select.value;
  select.replaceChildren(new Option("Select a Delivery fee item", ""));
  for (const item of state.configuration.deliveryItems || []) {
    select.append(new Option(
      `${item.displayName || item.itemCode} · ${item.itemCode}`,
      item.itemCode
    ));
  }
  if ([...select.options].some((option) => option.value === currentValue)) select.value = currentValue;
}

function populateConfiguration() {
  serviceLineEditor.querySelectorAll("select[data-line-bin]").forEach(populateBinSelect);
  serviceLineEditor.querySelectorAll("select[data-line-dump-item]").forEach(populateDumpSelect);
  serviceCode.replaceChildren(new Option("Select a service", ""));
  for (const item of state.configuration.services || []) {
    const label = item.serviceCode === "delivery"
      ? "Delivery"
      : (item.displayName || item.serviceCode);
    serviceCode.append(new Option(label, item.serviceCode));
  }
  populateDeliveryItemSelect(deliveryItemCode);
  populateDeliveryItemSelect(binDeliveryItemCode);
  syncOrderKindFields();
}

function addSurchargeRow(values = {}) {
  const row = element("div", "", "mbt-surcharge-row");
  row.dataset.orderSurcharge = "true";
  const itemLabel = element("label", "", "mbt-field");
  itemLabel.append(element("span", "Surcharge item"));
  const select = document.createElement("select");
  select.dataset.surchargeItem = "true";
  select.required = true;
  select.append(new Option("Select a surcharge", ""));
  for (const item of state.configuration.surchargeItems || []) {
    select.append(new Option(`${item.displayName || item.itemCode} · ${item.itemCode}`, item.itemCode));
  }
  select.value = values.itemCode || "";
  itemLabel.append(select);
  const amountLabel = element("label", "", "mbt-field");
  amountLabel.append(element("span", "Manual amount (CAD)"));
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0.01";
  amount.step = "0.01";
  amount.required = true;
  amount.dataset.surchargeAmount = "true";
  amount.value = values.amountCad || "";
  amountLabel.append(amount);
  const remove = button("Remove", () => row.remove(), "mbt-button-secondary");
  row.append(itemLabel, amountLabel, remove);
  orderSurchargeEditor.append(row);
  select.focus();
}

function requestedSurcharges() {
  const rows = [...orderSurchargeEditor.querySelectorAll("[data-order-surcharge]")];
  const surcharges = rows.map((row, index) => {
    const itemCode = row.querySelector("[data-surcharge-item]")?.value || "";
    const amountText = row.querySelector("[data-surcharge-amount]")?.value || "";
    if (!/^\d+(?:\.\d{1,2})?$/u.test(amountText) || Number(amountText) <= 0 || !itemCode) {
      throw new Error(`Complete surcharge ${index + 1} with an item and positive CAD amount.`);
    }
    return { itemCode, amountMinor: Math.round(Number(amountText) * 100) };
  });
  if (new Set(surcharges.map(({ itemCode }) => itemCode)).size !== surcharges.length) {
    throw new Error("Each surcharge item may be added once.");
  }
  return surcharges;
}

function setOrderPanel(panel, enabled) {
  panel.hidden = !enabled;
  panel.querySelectorAll("input, select, textarea, button").forEach((control) => {
    control.disabled = !enabled;
  });
}

function syncOrderKindFields() {
  const kind = orderKind.value;
  const bin = kind === "bin";
  const delivery = kind === "delivery";
  setOrderPanel(binOrderFields, bin);
  setOrderPanel(deliveryOrderFields, delivery);
  addServiceLine.hidden = !bin;
  addServiceLine.disabled = !bin;
  createOrderButton.disabled = !bin && !delivery;
  createOrderButton.textContent = bin ? "Create draft BIN quote" : delivery ? "Send Delivery to Dispatch" : "Create order";
  const title = document.getElementById("newContractTitle");
  if (title) title.textContent = bin ? "BIN contract order" : delivery ? "Normal A-to-B Delivery" : "Choose the work type";
  const help = document.getElementById("orderKindHelp");
  if (help) help.textContent = bin
    ? "Enter one contract site, then add one row per physical bin. Each bin has one dump item and estimated weight."
    : delivery
      ? "This local order goes directly to the existing Dispatch custom-order pool; no contract is created."
      : "Select Delivery for normal A-to-B work, or BIN for a contract with one or more physical bins.";
}

async function selectCustomer(customer) {
  globalThis.clearTimeout(searchTimer);
  state.searchSequence += 1;
  state.selectedCustomer = customer;
  state.customers = [customer];
  customerSearch.value = customer.displayName || customer.phone || "";
  renderCustomers();
  populateLineSiteSelects();
  await loadCustomerContracts();
  setMessage(`${customer.displayName || "Customer"} selected. Existing contracts are ready.`);
}

function renderCustomers() {
  customerResults.replaceChildren();
  customerSearch.setAttribute("aria-expanded", String(state.customers.length > 0));
  if (!state.customers.length && customerSearch.value.trim().length >= 2) {
    customerResults.append(element("p", "No active customers found.", "mbt-frontdesk-muted"));
    return;
  }
  state.customers.forEach((customer, index) => {
    const choice = button(
      `${customer.displayName} · ${customer.entityNumber || customer.customerNetsuiteId}`,
      () => selectCustomer(customer)
    );
    choice.id = `customer-choice-${index}`;
    choice.dataset.customerId = String(customer.customerNetsuiteId || "");
    choice.addEventListener("pointerdown", () => {
      // Cancel a queued/in-flight search before the browser dispatches click.
      // Otherwise its render can remove the tapped result between pointerdown
      // and click on slower touch devices.
      globalThis.clearTimeout(searchTimer);
      state.searchSequence += 1;
    });
    choice.setAttribute("role", "option");
    choice.setAttribute(
      "aria-selected",
      String(state.selectedCustomer?.customerNetsuiteId === customer.customerNetsuiteId)
    );
    if (customer.phone) {
      choice.append(element("span", customer.phone, "mbt-choice-detail"));
    }
    customerResults.append(choice);
  });
}

function syncContractSiteFields() {
  const enteringNew = contractServiceSite.value === "__new__";
  contractNewSiteFields.hidden = !enteringNew;
  contractNewSiteFields.querySelectorAll("[data-contract-site-label], [data-contract-address-one], [data-contract-city], [data-contract-region], [data-contract-postal-code], [data-contract-country]").forEach((control) => {
    control.required = enteringNew;
  });
}

function populateLineSiteSelects() {
  const current = contractServiceSite.value;
  contractServiceSite.replaceChildren(new Option("Enter a new service site", "__new__"));
  for (const site of state.selectedCustomer?.sites || []) {
    const address = [site.addressLine1 || site.label, site.city, site.postalCode].filter(Boolean).join(" · ");
    contractServiceSite.append(new Option(address || "Saved service site", site.siteProfileId));
  }
  contractServiceSite.value = [...contractServiceSite.options].some((option) => option.value === current)
    ? current
    : "__new__";
  syncContractSiteFields();
}

function openNewContractOrderDialog() {
  if (!state.enabled) {
    setMessage("Front Desk operations are closed by the server safety gate.", "attention");
    return;
  }
  if (!state.selectedCustomer) {
    setMessage("Select a customer before adding a new order.", "attention");
    return;
  }
  populateLineSiteSelects();
  newContractCustomer.textContent = `${state.selectedCustomer.displayName} · Choose Delivery or BIN to continue.`;
  newContractDialog.showModal();
  orderKind.focus();
}

function renderContractMaster() {
  contractMaster.replaceChildren();
  if (!state.selectedCustomer) {
    contractMaster.append(element("p", "Select a customer to view their current contracts.", "mbt-frontdesk-muted"));
    return;
  }
  if (!state.customerContracts.length) {
    contractMaster.append(element("p", "No local contracts exist for this customer yet.", "mbt-frontdesk-muted"));
    return;
  }
  for (const contract of state.customerContracts) {
    const choice = button(
      `${contract.contractNumber} · ${String(contract.status || "unknown").replaceAll("_", " ")}`,
      () => loadContractTimeline(contract.contractId)
    );
    choice.setAttribute("aria-pressed", String(state.contract?.contractId === contract.contractId));
    const detail = element(
      "span",
      `${contract.openServiceLineCount ?? contract.serviceLineCount ?? 0} open physical bin line(s)`,
      "mbt-choice-detail"
    );
    choice.append(detail);
    contractMaster.append(choice);
  }
}

async function loadCustomerContracts() {
  if (!state.selectedCustomer) return;
  try {
    const result = await api(
      `/api/mbt/frontdesk/customers/${encodeURIComponent(state.selectedCustomer.customerNetsuiteId)}/contracts?limit=50`
    );
    if (state.selectedCustomer?.customerNetsuiteId !== result.customerNetsuiteId) return;
    state.customerContracts = result.items || [];
    renderContractMaster();
  } catch (error) {
    state.customerContracts = [];
    renderContractMaster();
    setMessage(error.message, "attention");
  }
}

async function loadContractTimeline(contractId) {
  try {
    const result = await api(`/api/mbt/frontdesk/contracts/${encodeURIComponent(contractId)}`);
    state.contract = result.contract;
    state.serviceLines = result.serviceLines || [];
    state.visits = result.visits || [];
    state.amendments = result.amendments || [];
    state.quote = null;
    renderContractMaster();
    renderContract();
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function priceGrid(pricing) {
  const list = element("dl", "", "mbt-price-grid");
  const entries = [
    ["Estimated total", money(pricing.totalMinor, pricing.currency)],
    ["Subtotal", money(pricing.subtotalMinor, pricing.currency)],
    ["Tax", money(pricing.taxMinor, pricing.currency)],
    ["One-way distance", distance(pricing.distanceMetres)],
    ["Delivery price", pricing.pricingOriginYardCode === "150" ? "150 yard" : "Standard · 3445 / 2967"]
  ];
  for (const [label, value] of entries) {
    const group = element("div");
    group.append(element("dt", label), element("dd", value));
    list.append(group);
  }
  return list;
}

function pricingLines(pricing) {
  const list = element("ul", "", "mbt-pricing-lines");
  for (const line of pricing.lines || []) {
    const item = element("li");
    item.append(
      element("span", line.label || line.code),
      element("strong", money(line.amountMinor, pricing.currency))
    );
    list.append(item);
  }
  return list;
}

function renderQuote() {
  quoteCard.replaceChildren();
  quoteCard.hidden = !state.quote;
  if (!state.quote) return;
  workspaceEmpty.hidden = true;
  contractCard.hidden = true;
  const quote = state.quote;
  const summary = element("article", "", "mbt-quote-summary");
  summary.append(
    element("p", `${String(quote.status).toUpperCase()} · Revision ${quote.revision}`, "mbt-eyebrow"),
    element("h2", `Quote ${quote.quoteNumber}`),
    priceGrid(quote.pricing),
    pricingLines(quote.pricing)
  );
  const actions = element("div", "", "mbt-quote-actions");
  if (quote.status === "draft") {
    actions.append(button("Issue quote", issueQuote));
  } else if (quote.status === "issued") {
    actions.append(button("Accept quote", acceptQuote));
  } else if (quote.status === "accepted") {
    actions.append(button("Convert to contract", convertQuote));
  }
  summary.append(actions);
  quoteCard.append(summary);
}

function visitStatus(visit) {
  if (visit.serviceAction === "delivery" && visit.status === "ready") {
    return "Ready · Front leg";
  }
  if (visit.serviceAction === "return_bin" && visit.status === "tentative") {
    const predecessor = state.visits.find((item) => item.visitId === visit.predecessorVisitId);
    return `Tentative · waits for ${predecessor?.displayName || "Initial delivery"}`;
  }
  return String(visit.status || "unknown").replaceAll("_", " ");
}

function currentServiceLineVisit(serviceLine) {
  return state.visits.find((visit) => (
    visit.serviceLineId === serviceLine.serviceLineId
      && !["completed", "cancelled", "voided"].includes(String(visit.status))
  )) || null;
}

function serviceLineActionField(labelText, control) {
  const label = element("label", "", "mbt-field");
  label.htmlFor = control.id;
  label.append(element("span", labelText), control);
  serviceLineActionFields.append(label);
  return label;
}

function serviceLineWindow(defaultStartAt) {
  const start = document.createElement("input");
  start.id = "serviceLineActionStart";
  start.type = "datetime-local";
  start.required = true;
  const end = document.createElement("input");
  end.id = "serviceLineActionEnd";
  end.type = "datetime-local";
  end.required = true;
  const starting = new Date(defaultStartAt || Date.now());
  const ending = new Date(starting.getTime() + (4 * 60 * 60 * 1000));
  start.value = localDateTimeValue(starting.toISOString());
  end.value = localDateTimeValue(ending.toISOString());
  serviceLineActionField("Service window start", start);
  serviceLineActionField("Service window end", end);
  return { start, end };
}

function actionReasonField() {
  const reason = document.createElement("textarea");
  reason.id = "serviceLineActionReason";
  reason.rows = 3;
  reason.required = true;
  serviceLineActionField("Audit reason", reason);
  return reason;
}

function openServiceLineAction(line, action) {
  serviceLineAction = action;
  serviceLineActionId = line.serviceLineId;
  serviceLineActionControls = {};
  serviceLineActionFields.replaceChildren();

  if (action === "exchange") {
    serviceLineActionTitle.textContent = `Exchange bin · Line ${line.lineNumber}`;
    serviceLineActionHelp.textContent = "Schedule a physical replacement. A different bin size requires customer confirmation before Dispatch may execute the changed leg.";
    const window = serviceLineWindow(line.plannedDeliveryAt);
    const incomingBinType = document.createElement("select");
    incomingBinType.id = "incomingBinType";
    incomingBinType.required = true;
    incomingBinType.append(new Option("Select incoming bin size", ""));
    for (const item of state.configuration.binTypes || []) {
      incomingBinType.append(new Option(item.displayName || item.typeCode, item.binTypeId));
    }
    incomingBinType.value = line.binTypeId;
    serviceLineActionField("Incoming bin size", incomingBinType);

    const chargeMode = document.createElement("select");
    chargeMode.id = "exchangeChargeMode";
    chargeMode.append(new Option("Charge the change", "charged"));
    chargeMode.append(new Option("Free internal upgrade / replacement", "free_internal"));
    serviceLineActionField("Charge treatment", chargeMode);
    const waiverReason = document.createElement("textarea");
    waiverReason.id = "exchangeWaiverReason";
    waiverReason.rows = 2;
    const waiverField = serviceLineActionField("Free-change waiver reason", waiverReason);
    const syncWaiverRequirement = () => {
      const required = chargeMode.value === "free_internal";
      waiverField.hidden = !required;
      waiverReason.required = required;
      if (!required) waiverReason.value = "";
    };
    chargeMode.addEventListener("change", syncWaiverRequirement);
    syncWaiverRequirement();
    serviceLineActionControls = { ...window, incomingBinType, chargeMode, waiverReason, reason: actionReasonField() };
    serviceLineActionSubmit.textContent = "Create exchange leg";
  } else if (action === "collection") {
    serviceLineActionTitle.textContent = `Collect bin · Line ${line.lineNumber}`;
    serviceLineActionHelp.textContent = "Request this bin’s collection only. The contract closes only after the final physical bin is completed by the Driver workflow.";
    const window = serviceLineWindow(line.plannedReturnAt);
    serviceLineActionControls = { ...window, reason: actionReasonField() };
    serviceLineActionSubmit.textContent = "Request collection";
  } else {
    serviceLineActionTitle.textContent = `Customer confirmation · Line ${line.lineNumber}`;
    serviceLineActionHelp.textContent = "Record the customer’s decision before a Dispatch change to this bin’s schedule or size can be executed.";
    const decision = document.createElement("select");
    decision.id = "customerConfirmationDecision";
    decision.required = true;
    decision.append(new Option("Customer confirmed", "confirmed"));
    decision.append(new Option("Customer declined", "declined"));
    serviceLineActionField("Customer decision", decision);
    serviceLineActionControls = { decision, reason: actionReasonField() };
    serviceLineActionSubmit.textContent = "Record customer decision";
  }
  serviceLineActionDialog.showModal();
}

async function saveServiceLineAction(event) {
  event.preventDefault();
  const line = state.serviceLines.find((item) => item.serviceLineId === serviceLineActionId);
  if (!line || !state.contract || !serviceLineAction) {
    setMessage("Refresh the contract before changing a physical bin line.", "attention");
    return;
  }
  const controls = serviceLineActionControls;
  const reason = controls.reason?.value.trim();
  const base = { expectedRevision: line.revision, reason };
  let path;
  let body;
  if (serviceLineAction === "exchange") {
    path = `/api/mbt/frontdesk/contracts/${state.contract.contractId}/service-lines/${line.serviceLineId}/exchanges`;
    body = {
      ...base,
      exchangeWindow: {
        startAt: new Date(controls.start.value).toISOString(),
        endAt: new Date(controls.end.value).toISOString()
      },
      incomingBinTypeId: controls.incomingBinType.value,
      chargeMode: controls.chargeMode.value,
      waiverReason: controls.waiverReason.value.trim() || undefined
    };
  } else if (serviceLineAction === "collection") {
    path = `/api/mbt/frontdesk/contracts/${state.contract.contractId}/service-lines/${line.serviceLineId}/collections`;
    body = {
      ...base,
      collectionWindow: {
        startAt: new Date(controls.start.value).toISOString(),
        endAt: new Date(controls.end.value).toISOString()
      }
    };
  } else {
    path = `/api/mbt/frontdesk/contracts/${state.contract.contractId}/service-lines/${line.serviceLineId}/customer-confirmations`;
    body = { ...base, decision: controls.decision.value };
  }
  setMessage("Saving the physical-bin service action…");
  try {
    await api(path, {
      method: "POST",
      body,
      idempotencyKey: commandIdentity(`mbt-frontdesk-${serviceLineAction}`)
    });
    serviceLineActionDialog.close();
    await Promise.all([
      loadCustomerContracts(),
      loadContractTimeline(state.contract.contractId)
    ]);
    setMessage("Physical-bin service action saved locally and the contract detail is refreshed.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function renderContract() {
  contractCard.replaceChildren();
  contractCard.hidden = !state.contract;
  if (!state.contract) return;
  workspaceEmpty.hidden = true;
  quoteCard.hidden = true;
  const summary = element("article", "", "mbt-contract-summary");
  summary.append(
    element("p", `LOCAL CONTRACT · Revision ${state.contract.revision}`, "mbt-eyebrow"),
    element("h2", `Contract ${state.contract.contractNumber}`)
  );
  if (state.serviceLines.length) {
    const lines = element("section", "", "mbt-service-line-list");
    lines.append(element("h3", "Physical bin service lines"));
    for (const line of state.serviceLines) {
      const card = element("section", "", "mbt-service-line-card");
      card.dataset.confirmation = line.customerConfirmation?.status || "not_required";
      const frontLeg = currentServiceLineVisit(line);
      card.append(
        element("h3", `Line ${line.lineNumber} · ${line.binTypeCode || "Bin"}`),
        element("p", `Status: ${String(line.status || "unknown").replaceAll("_", " ")}`),
        element("p", `Contents: ${line.dumpItemCode || "Legacy / not recorded"}${line.estimatedTonnes ? ` · ${line.estimatedTonnes} t estimated` : ""}`),
        element("p", `Site: ${[
          line.site?.addressLine1 || line.site?.label,
          line.site?.city,
          line.site?.postalCode
        ].filter(Boolean).join(" · ") || "Service site snapshot unavailable"}`),
        element("p", `Delivery: ${displayDate(line.plannedDeliveryAt)} · Return: ${displayDate(line.plannedReturnAt)}`),
        element("p", frontLeg ? `Current leg: ${frontLeg.displayName || frontLeg.serviceAction} · ${visitStatus(frontLeg)}` : "No actionable leg is currently scheduled.")
      );
      if (line.customerConfirmation?.status === "required") {
        card.append(element("p", `Customer confirmation required: ${line.customerConfirmation.reason || "Dispatch changed this physical bin line."}`));
      }
      if (!["closed", "cancelled"].includes(line.status)) {
        const lineActions = element("div", "", "mbt-quote-actions");
        lineActions.append(
          button("Extend return", () => openExtension(line.serviceLineId), "mbt-button-secondary"),
          button("Exchange bin", () => openServiceLineAction(line, "exchange"), "mbt-button-secondary"),
          button("Collect bin", () => openServiceLineAction(line, "collection"), "mbt-button-secondary")
        );
        if (line.customerConfirmation?.status === "required") {
          lineActions.append(button("Record customer confirmation", () => openServiceLineAction(line, "confirmation")));
        }
        card.append(lineActions);
      }
      lines.append(card);
    }
    summary.append(lines);
  }
  const timeline = element("ol", "", "mbt-timeline");
  for (const visit of state.visits) {
    const item = element("li", "", "mbt-visit-card");
    item.append(
      element("h3", visit.serviceAction === "delivery" ? "Delivery visit" : (visit.displayName || "Return bin")),
      element("p", visitStatus(visit), "mbt-visit-status"),
      element("p", `${displayDate(visit.scheduledStartAt)} – ${displayDate(visit.scheduledEndAt)}`)
    );
    timeline.append(item);
  }
  summary.append(timeline);
  for (const amendment of state.amendments) {
    const card = element("section", "", "mbt-amendment-card");
    card.append(
      element("h3", `Approved extension ${amendment.amendmentNumber}`),
      element("p", amendment.reason || "Return schedule amended with approval.")
    );
    summary.append(card);
  }
  if (!state.serviceLines.length) {
    const actions = element("div", "", "mbt-quote-actions");
    actions.append(button("Extend return", () => openExtension()));
    summary.append(actions);
  }
  contractCard.append(summary);
}

async function issueQuote() {
  const delivery = new Date(state.quote.proposedDeliveryAt);
  const validUntil = new Date(delivery.getTime() + 24 * 60 * 60 * 1000).toISOString();
  setMessage("Issuing the local quote…");
  try {
    const result = await api(`/api/mbt/frontdesk/quotes/${state.quote.quoteId}/issue`, {
      method: "POST",
      body: {
        expectedRevision: state.quote.revision,
        validUntil,
        reason: "Issue the reviewed Front Desk quote"
      },
      idempotencyKey: commandIdentity("mbt-frontdesk-issue")
    });
    state.quote = result.quote;
    renderQuote();
    setMessage("Quote issued. Record customer acceptance when confirmed.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

async function acceptQuote() {
  setMessage("Recording local quote acceptance…");
  try {
    const result = await api(`/api/mbt/frontdesk/quotes/${state.quote.quoteId}/accept`, {
      method: "POST",
      body: {
        expectedRevision: state.quote.revision,
        acceptedAt: new Date().toISOString(),
        reason: "Record customer acceptance of the Front Desk quote"
      },
      idempotencyKey: commandIdentity("mbt-frontdesk-accept")
    });
    state.quote = result.quote;
    renderQuote();
    setMessage("Quote accepted. Conversion will create local records only.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

async function convertQuote() {
  setMessage("Creating the local contract and its ordered visit chain…");
  try {
    const result = await api(`/api/mbt/frontdesk/quotes/${state.quote.quoteId}/convert`, {
      method: "POST",
      body: {
        expectedRevision: state.quote.revision,
        reason: "Convert the accepted Front Desk quote to a local contract"
      },
      idempotencyKey: commandIdentity("mbt-frontdesk-convert")
    });
    state.contract = result.contract;
    state.serviceLines = result.serviceLines || [];
    state.visits = result.visits || [];
    state.amendments = [];
    await loadCustomerContracts();
    renderContract();
    setMessage("Local contract created. The first visit is ready; the return remains tentative.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function openExtension(serviceLineId = null) {
  extensionServiceLineId = serviceLineId;
  const returnVisit = [...state.visits].reverse().find((visit) => (
    visit.serviceAction === "return_bin" && (!serviceLineId || visit.serviceLineId === serviceLineId)
  ));
  extensionFields.replaceChildren();
  extensionStart = document.createElement("input");
  extensionStart.id = "extensionStart";
  extensionStart.type = "datetime-local";
  extensionStart.required = true;
  extensionEnd = document.createElement("input");
  extensionEnd.id = "extensionEnd";
  extensionEnd.type = "datetime-local";
  extensionEnd.required = true;
  extensionReason = document.createElement("textarea");
  extensionReason.id = "extensionReason";
  extensionReason.rows = 3;
  extensionReason.required = true;
  for (const [labelText, control] of [
    ["New return date and time", extensionStart],
    ["Return window end", extensionEnd],
    ["Audit reason", extensionReason]
  ]) {
    const label = element("label", "", "mbt-field");
    label.htmlFor = control.id;
    label.append(element("span", labelText), control);
    extensionFields.append(label);
  }
  extensionStart.value = localDateTimeValue(returnVisit?.scheduledStartAt);
  extensionEnd.value = localDateTimeValue(returnVisit?.scheduledEndAt);
  extensionReason.value = "";
  extensionDialog.showModal();
}

async function saveExtension(event) {
  event.preventDefault();
  setMessage("Approving the local return extension…");
  try {
    const path = extensionServiceLineId
      ? `/api/mbt/frontdesk/contracts/${state.contract.contractId}/service-lines/${extensionServiceLineId}/extensions`
      : `/api/mbt/frontdesk/contracts/${state.contract.contractId}/extensions`;
    const selectedLine = state.serviceLines.find((line) => line.serviceLineId === extensionServiceLineId);
    const result = await api(path, {
      method: "POST",
      body: {
        expectedRevision: selectedLine?.revision ?? state.contract.revision,
        returnWindow: {
          startAt: new Date(extensionStart.value).toISOString(),
          endAt: new Date(extensionEnd.value).toISOString()
        },
        reason: extensionReason.value.trim()
      },
      idempotencyKey: commandIdentity("mbt-frontdesk-extension")
    });
    state.contract = result.contract;
    if (result.serviceLine) {
      state.serviceLines = state.serviceLines.map((line) => (
        line.serviceLineId === result.serviceLine.serviceLineId ? result.serviceLine : line
      ));
    }
    state.visits = state.visits.map((visit) => (
      visit.visitId === result.returnVisit.visitId ? result.returnVisit : visit
    ));
    state.amendments.push({ ...result.amendment, reason: extensionReason.value.trim() });
    extensionDialog.close();
    extensionServiceLineId = null;
    renderContract();
    setMessage("Return extension approved. The delivery visit was not changed.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

async function searchCustomers() {
  const query = customerSearch.value.trim();
  state.searchSequence += 1;
  const sequence = state.searchSequence;
  if (query.length < 2) {
    state.customers = [];
    state.selectedCustomer = null;
    state.customerContracts = [];
    state.contract = null;
    state.serviceLines = [];
    renderCustomers();
    populateLineSiteSelects();
    renderContractMaster();
    return;
  }
  try {
    const result = await api(`/api/mbt/frontdesk/customers?query=${encodeURIComponent(query)}&limit=25`);
    if (sequence !== state.searchSequence) return;
    state.customers = result.items || [];
    renderCustomers();
  } catch (error) {
    if (sequence === state.searchSequence) setMessage(error.message, "attention");
  }
}

function refreshServiceLineLabels() {
  [...serviceLineEditor.querySelectorAll("[data-service-line]")].forEach((line, index) => {
    const number = index + 1;
    const legend = line.querySelector("legend");
    if (legend) legend.textContent = `Bin ${number}`;
    line.querySelectorAll("input, select, textarea").forEach((control) => {
      const suffix = String(control.dataset.lineField || control.id || "field").replace(/\d+$/, "");
      if (control !== binType && control !== deliveryAt && control !== returnAt) {
        control.id = `${suffix}${number}`;
      }
    });
    line.querySelectorAll("label").forEach((label) => {
      const control = label.querySelector("input, select, textarea");
      if (control) label.htmlFor = control.id;
    });
  });
}

function addNewServiceLine() {
  const source = serviceLineEditor.querySelector("[data-service-line]");
  if (!source) return;
  const clone = source.cloneNode(true);
  clone.querySelectorAll("input").forEach((input) => { input.value = ""; });
  clone.querySelectorAll("textarea").forEach((textarea) => { textarea.value = ""; });
  clone.querySelectorAll("select[data-line-bin]").forEach((select) => {
    select.value = "";
    populateBinSelect(select);
  });
  clone.querySelectorAll("select[data-line-dump-item]").forEach((select) => {
    select.value = "";
    populateDumpSelect(select);
  });
  clone.querySelector("[data-remove-service-line]")?.remove();
  const remove = button("Remove bin", () => {
    clone.remove();
    refreshServiceLineLabels();
  }, "mbt-button-secondary");
  remove.dataset.removeServiceLine = "true";
  clone.append(remove);
  serviceLineEditor.append(clone);
  refreshServiceLineLabels();
  clone.querySelector("select[data-line-bin]")?.focus();
}

function requestedContractSite() {
  if (!contractServiceSite.value) throw new Error("Select or enter the contract service site.");
  if (contractServiceSite.value !== "__new__") return { siteProfileId: contractServiceSite.value };
  const site = {
    label: document.querySelector("[data-contract-site-label]")?.value.trim(),
    addressLine1: document.querySelector("[data-contract-address-one]")?.value.trim(),
    addressLine2: document.querySelector("[data-contract-address-two]")?.value.trim(),
    city: document.querySelector("[data-contract-city]")?.value.trim(),
    region: document.querySelector("[data-contract-region]")?.value.trim(),
    postalCode: document.querySelector("[data-contract-postal-code]")?.value.trim(),
    countryCode: document.querySelector("[data-contract-country]")?.value.trim().toUpperCase(),
    siteInstructions: document.querySelector("[data-contract-site-instructions]")?.value.trim()
  };
  if (!site.label || !site.addressLine1 || !site.city || !site.region || !site.postalCode || !site.countryCode) {
    throw new Error("Complete the contract service-site address before adding bins.");
  }
  return { site };
}

function requestedServiceLines() {
  const physicalLines = [];
  for (const [index, group] of [...serviceLineEditor.querySelectorAll("[data-service-line]")].entries()) {
    const binSelect = group.querySelector("select[data-line-bin]");
    const dumpSelect = group.querySelector("select[data-line-dump-item]");
    const estimatedTonnesInput = group.querySelector("input[data-line-estimated-tonnes]");
    const deliveryInput = group.querySelector("input[data-line-delivery]");
    const returnInput = group.querySelector("input[data-line-return]");
    const bin = configuredBinItems()
      .find((item) => item.itemCode === binSelect?.value || item.typeCode === binSelect?.value);
    const dumpItemCode = dumpSelect?.value || "";
    const estimatedTonnes = estimatedTonnesInput?.value || "";
    if (!bin || !dumpItemCode || !/^\d{1,3}(?:\.\d{1,3})?$/u.test(estimatedTonnes)
        || Number(estimatedTonnes) <= 0 || Number(estimatedTonnes) > 100
        || !deliveryInput?.value || !returnInput?.value) {
      throw new Error(`Complete bin ${index + 1}: BIN item, dump item, estimated tonnes, delivery, and return are required.`);
    }
    const proposedDeliveryAt = new Date(deliveryInput.value);
    const proposedReturnAt = new Date(returnInput.value);
    if (!(proposedReturnAt > proposedDeliveryAt)) {
      throw new Error(`Bin ${index + 1} return must follow its delivery.`);
    }
    physicalLines.push({
      binItemCode: bin.itemCode,
      binTypeId: bin.binTypeId,
      dumpItemCode,
      estimatedTonnes,
      proposedDeliveryAt: proposedDeliveryAt.toISOString(),
      proposedReturnAt: proposedReturnAt.toISOString()
    });
  }
  return physicalLines;
}

async function createDeliveryOrder() {
  const itemCode = deliveryItemCode.value;
  const pickupLocation = document.getElementById("deliveryPickup").value.trim();
  const dropoffLocation = document.getElementById("deliveryDropoff").value.trim();
  const orderDetails = document.getElementById("deliveryDetails").value.trim();
  const weightLbs = Number(document.getElementById("deliveryWeightLbs").value);
  const stopMinutes = Number(document.getElementById("deliveryStopMinutes").value);
  if (!itemCode || !pickupLocation || !dropoffLocation || !orderDetails
      || !Number.isSafeInteger(weightLbs) || weightLbs < 1
      || !Number.isSafeInteger(stopMinutes) || stopMinutes < 0) {
    throw new Error("Complete the Delivery fee, A-to-B locations, details, weight, and stop time.");
  }
  const result = await api("/api/mbt/frontdesk/delivery-orders", {
    method: "POST",
    body: {
      customerNetsuiteId: state.selectedCustomer.customerNetsuiteId,
      itemCode,
      pickupLocation,
      dropoffLocation,
      orderDetails,
      weightLbs,
      stopMinutes
    },
    idempotencyKey: commandIdentity("mbt-frontdesk-delivery")
  });
  newContractDialog.close();
  quoteForm.reset();
  syncOrderKindFields();
  setMessage(`${result.deliveryOrder?.refNumber || "Delivery"} is ready in Dispatch for truck and day assignment.`);
}

async function createQuote(event) {
  event.preventDefault();
  if (!state.selectedCustomer) {
    setMessage("Select an active customer first.", "attention");
    return;
  }
  if (orderKind.value === "delivery") {
    setMessage("Creating the local Delivery order for Dispatch…");
    try {
      await createDeliveryOrder();
    } catch (error) {
      setMessage(error.message, "attention");
    }
    return;
  }
  if (orderKind.value !== "bin") {
    setMessage("Select Delivery or BIN first.", "attention");
    return;
  }
  const service = selectedService();
  let serviceLines;
  let contractSite;
  let surcharges;
  try {
    serviceLines = requestedServiceLines();
    contractSite = requestedContractSite();
    surcharges = requestedSurcharges();
  } catch (error) {
    setMessage(error.message, "attention");
    return;
  }
  const bin = selectedBin();
  if (!service || !bin || !binDeliveryItemCode.value || !serviceLines.length) {
    setMessage("Select the BIN workflow, one-way Delivery fee, and every physical bin item.", "attention");
    return;
  }
  setMessage("Calculating the server-owned distance, rate, and tax…");
  try {
    const result = await api("/api/mbt/frontdesk/quotes", {
      method: "POST",
      body: {
        customerNetsuiteId: state.selectedCustomer.customerNetsuiteId,
        ...contractSite,
        serviceTemplateVersionId: service.templateVersionId,
        rateCardVersionId: service.rateCardVersionId,
        binItemCode: serviceLines[0].binItemCode,
        binTypeId: bin.binTypeId,
        deliveryItemCode: binDeliveryItemCode.value,
        pricingOriginYardCode: orderFrom150.checked ? "150" : "3445",
        dumpItemCode: serviceLines[0].dumpItemCode,
        estimatedTonnes: serviceLines[0].estimatedTonnes,
        surcharges,
        serviceCode: service.serviceCode,
        proposedDeliveryAt: serviceLines[0].proposedDeliveryAt,
        proposedReturnAt: serviceLines[0].proposedReturnAt,
        serviceLines,
        reason: "Create a local Front Desk quote"
      },
      idempotencyKey: commandIdentity("mbt-frontdesk-create")
    });
    state.quote = result.quote;
    state.contract = null;
    newContractDialog.close();
    renderQuote();
    setMessage("Draft estimate created: rental + estimated dump weight + one-way delivery + manual surcharge.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

async function initialize() {
  try {
    const [status, configuration] = await Promise.all([
      api("/api/mbt/frontdesk/status"),
      api("/api/mbt/frontdesk/configuration")
    ]);
    state.enabled = status.enabled === true;
    state.configuration = configuration;
    populateConfiguration();
    refreshServiceLineLabels();
    renderContractMaster();
    if (!state.enabled) {
      quoteForm.querySelectorAll("input, select, button").forEach((control) => {
        control.disabled = true;
      });
      openNewContractOrder.disabled = true;
      setMessage("Front Desk operations are closed by the server safety gate.", "attention");
      return;
    }
    setMessage("Front Desk is ready for the scoped local pilot. No NetSuite posting is available here.");
  } catch (error) {
    quoteForm.querySelectorAll("input, select, button").forEach((control) => {
      control.disabled = true;
    });
    openNewContractOrder.disabled = true;
    setMessage(error.message, "attention");
  }
}

let searchTimer = 0;
customerSearch.addEventListener("input", () => {
  globalThis.clearTimeout(searchTimer);
  searchTimer = globalThis.setTimeout(searchCustomers, 80);
});
customerSearch.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" || !state.customers.length) return;
  event.preventDefault();
  document.getElementById("customer-choice-0")?.focus();
});
customerResults.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  const choices = [...customerResults.querySelectorAll("button[data-customer-id]")];
  const current = choices.indexOf(document.activeElement);
  const delta = event.key === "ArrowDown" ? 1 : -1;
  choices[(current + delta + choices.length) % choices.length]?.focus();
  event.preventDefault();
});
quoteForm.addEventListener("submit", createQuote);
extensionForm.addEventListener("submit", saveExtension);
document.getElementById("closeExtension").addEventListener("click", () => extensionDialog.close());
serviceLineActionForm.addEventListener("submit", saveServiceLineAction);
document.getElementById("closeServiceLineAction").addEventListener("click", () => serviceLineActionDialog.close());
openNewContractOrder.addEventListener("click", openNewContractOrderDialog);
document.getElementById("closeNewContractOrder").addEventListener("click", () => newContractDialog.close());
addServiceLine.addEventListener("click", addNewServiceLine);
addOrderSurcharge.addEventListener("click", () => addSurchargeRow());
contractServiceSite.addEventListener("change", syncContractSiteFields);
orderKind.addEventListener("change", syncOrderKindFields);

initialize();
