const token = localStorage.getItem("mbbs.staff.token") || "";

const byId = (id) => document.getElementById(id);
const message = byId("frontdeskMessage");
const customerSearch = byId("customerSearch");
const customerResults = byId("customerResults");
const openNewContractOrder = byId("openNewContractOrder");
const newContractDialog = byId("newContractDialog");
const newContractCustomer = byId("newContractCustomer");
const quoteForm = byId("quoteForm");
const orderKind = byId("orderKind");
const deliveryOrderFields = byId("deliveryOrderFields");
const deliveryItemCode = byId("deliveryItemCode");
const createOrderButton = byId("createQuoteButton");
const contractMaster = byId("contractMaster");
const workspaceEmpty = byId("workspaceEmpty");
const quoteCard = byId("quoteCard");
const contractCard = byId("contractCard");

const customerChargeDialog = byId("customerChargeDialog");
const customerChargeForm = byId("customerChargeForm");
const customerChargeTitle = byId("customerChargeTitle");
const customerChargeHelp = byId("customerChargeHelp");
const paymentMethod = byId("paymentMethod");
const billingAddressText = byId("billingAddressText");
const serviceAddressText = byId("serviceAddressText");
const contractTelephone = byId("contractTelephone");
const chargeWorkflowFields = byId("chargeWorkflowFields");
const chargeServiceCode = byId("chargeServiceCode");
const chargeDeliveryItemCode = byId("chargeDeliveryItemCode");
const chargeBinFields = byId("chargeBinFields");
const binContentCode = byId("binContentCode");
const chargeBinType = byId("chargeBinType");
const binDiscountCad = byId("binDiscountCad");
const binDiscountReason = byId("binDiscountReason");
const chargeDeliveryAt = byId("chargeDeliveryAt");
const chargeReturnAt = byId("chargeReturnAt");
const chargeDeliveryLabel = byId("chargeDeliveryLabel");
const chargeOrderFrom150 = byId("chargeOrderFrom150");
const aggregateLineEditor = byId("aggregateLineEditor");
const addAggregateLine = byId("addAggregateLine");
const customerChargeReason = byId("customerChargeReason");
const customerChargeSummary = byId("customerChargeSummary");
const confirmCustomerCharge = byId("confirmCustomerCharge");

const extensionDialog = byId("extensionDialog");
const extensionForm = byId("extensionForm");
const extensionFields = byId("extensionFields");
const serviceLineActionDialog = byId("serviceLineActionDialog");
const serviceLineActionForm = byId("serviceLineActionForm");
const serviceLineActionTitle = byId("serviceLineActionTitle");
const serviceLineActionHelp = byId("serviceLineActionHelp");
const serviceLineActionFields = byId("serviceLineActionFields");
const serviceLineActionSubmit = byId("serviceLineActionSubmit");

const state = {
  enabled: false,
  configuration: { binItems: [], binTypes: [], deliveryItems: [], services: [] },
  chargeConfigurationByRate: new Map(),
  customers: [],
  selectedCustomer: null,
  customerContracts: [],
  quote: null,
  contract: null,
  serviceLines: [],
  visits: [],
  amendments: [],
  chargeRequests: [],
  chargeRequest: null,
  chargeKind: null,
  chargeLine: null,
  chargeRateCardVersionId: null,
  searchSequence: 0,
  extensionServiceLineId: null,
  extensionControls: {},
  serviceAction: null,
  serviceActionLineId: null,
  serviceActionControls: {},
  disabledMessage: "Front Desk operations are disabled."
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
    style: "currency", currency, currencyDisplay: "narrowSymbol"
  }).format(Number(amountMinor || 0) / 100);
}

function displayDate(value) {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23", timeZone: "America/Toronto"
  }).format(new Date(value));
}

function localDateTimeValue(value) {
  const date = new Date(value || Date.now());
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

function configuredBinItems() {
  return state.configuration.binItems?.length
    ? state.configuration.binItems
    : state.configuration.binTypes || [];
}

function fullAddress(site) {
  return [site?.addressLine1 || site?.label, site?.addressLine2, site?.city,
    site?.region, site?.postalCode].filter(Boolean).join(", ");
}

function selectableServices(kind = state.chargeKind) {
  const purpose = kind === "initial_bin"
    ? "delivery"
    : kind === "aggregate_order"
      ? "aggregate_delivery"
      : null;
  return purpose
    ? (state.configuration.services || []).filter((item) => item.serviceCode === purpose)
    : state.configuration.services || [];
}

function selectedService() {
  const services = selectableServices();
  return services.find((item) => item.rateCardVersionId === chargeServiceCode.value)
    || services.find((item) => item.serviceCode === chargeServiceCode.value)
    || services[0]
    || null;
}

function selectedChargeBin() {
  return configuredBinItems().find((item) => (
    item.itemCode === chargeBinType.value || item.typeCode === chargeBinType.value
  )) || null;
}

function populateDeliverySelect(select) {
  const current = select.value;
  select.replaceChildren(new Option("Select a delivery item", ""));
  for (const item of state.configuration.deliveryItems || []) {
    select.append(new Option(`${item.displayName || item.itemCode} · ${item.itemCode}`, item.itemCode));
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function populateChargeServiceOptions(kind = null) {
  const services = selectableServices(kind);
  chargeServiceCode.replaceChildren(new Option("Select an active rate card", ""));
  for (const service of services) {
    const label = [
      service.rateCardDisplayName || service.displayName || service.serviceCode,
      service.rateCardVersionNumber ? `v${service.rateCardVersionNumber}` : "",
      service.serviceCode
    ].filter(Boolean).join(" · ");
    chargeServiceCode.append(new Option(label, service.rateCardVersionId));
  }
  if (services.length) {
    chargeServiceCode.value = services[0].rateCardVersionId;
  }
}

function populateConfiguration() {
  populateDeliverySelect(deliveryItemCode);
  populateDeliverySelect(chargeDeliveryItemCode);
  populateChargeServiceOptions();
  syncOrderKindFields();
}

function setOrderPanel(panel, enabled) {
  panel.hidden = !enabled;
  panel.querySelectorAll("input, select, textarea, button").forEach((control) => {
    control.disabled = !enabled;
  });
}

function syncOrderKindFields() {
  const kind = orderKind.value;
  const delivery = kind === "delivery";
  setOrderPanel(deliveryOrderFields, delivery);
  createOrderButton.disabled = !["delivery", "bin", "aggregate"].includes(kind);
  createOrderButton.textContent = delivery
    ? "Send Delivery to Dispatch"
    : kind === "bin"
      ? "Continue to BIN pricing"
      : kind === "aggregate"
        ? "Continue to Aggregate pricing"
        : "Create order";
  byId("newContractTitle").textContent = delivery
    ? "Normal A-to-B Delivery"
    : kind === "bin"
      ? "New BIN contract order"
      : kind === "aggregate"
        ? "New Aggregate Order"
        : "Choose the work type";
  byId("orderKindHelp").textContent = delivery
    ? "This local order goes directly to Dispatch."
    : kind === "bin"
      ? "Continue to fixed per-bin pricing. Garbage has no dump fee; soil, asphalt, and concrete use one fixed charge."
      : kind === "aggregate"
        ? "Aggregate material is priced per yard with the configured distance band."
        : "Select Delivery, BIN, or Aggregate Order.";
}

async function searchCustomers() {
  const query = customerSearch.value.trim();
  const sequence = state.searchSequence += 1;
  if (query.length < 2) {
    state.customers = [];
    renderCustomers();
    return;
  }
  try {
    const result = await api(`/api/mbt/frontdesk/customers?query=${encodeURIComponent(query)}&limit=12`);
    if (sequence !== state.searchSequence) return;
    state.customers = result.items || [];
    renderCustomers();
  } catch (error) {
    if (sequence === state.searchSequence) setMessage(error.message, "attention");
  }
}

async function selectCustomer(customer) {
  globalThis.clearTimeout(searchTimer);
  state.searchSequence += 1;
  state.selectedCustomer = customer;
  state.customers = [customer];
  state.contract = null;
  state.quote = null;
  customerSearch.value = customer.displayName || customer.phone || "";
  renderCustomers();
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
    choice.setAttribute("aria-selected", String(
      state.selectedCustomer?.customerNetsuiteId === customer.customerNetsuiteId
    ));
    if (customer.phone) choice.append(element("span", customer.phone, "mbt-choice-detail"));
    customerResults.append(choice);
  });
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
    choice.append(element("span", `${contract.openServiceLineCount ?? 0} open bin(s)`, "mbt-choice-detail"));
    contractMaster.append(choice);
  }
}

async function loadCustomerContracts() {
  if (!state.selectedCustomer) return;
  try {
    const result = await api(
      `/api/mbt/frontdesk/customers/${encodeURIComponent(state.selectedCustomer.customerNetsuiteId)}/contracts?limit=50`
    );
    state.customerContracts = result.items || [];
  } catch (error) {
    state.customerContracts = [];
    setMessage(error.message, "attention");
  }
  renderContractMaster();
}

async function loadContractTimeline(contractId) {
  try {
    const [timeline, charges] = await Promise.all([
      api(`/api/mbt/frontdesk/contracts/${encodeURIComponent(contractId)}`),
      api(`/api/mbt/frontdesk/contracts/${encodeURIComponent(contractId)}/charge-requests`)
        .catch(() => ({ items: [] }))
    ]);
    state.contract = timeline.contract;
    state.serviceLines = timeline.serviceLines || [];
    state.visits = timeline.visits || [];
    state.amendments = timeline.amendments || [];
    state.chargeRequests = charges.items || [];
    state.quote = null;
    renderContractMaster();
    renderContract();
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function pricingLines(pricing) {
  const list = element("ul", "", "mbt-pricing-lines");
  for (const line of pricing.lines || []) {
    const item = element("li");
    item.append(
      element("span", line.label || line.description || line.code || line.lineCode),
      element("strong", money(line.customerAmountMinor ?? line.amountMinor, pricing.currency))
    );
    list.append(item);
  }
  return list;
}

function priceGrid(pricing) {
  const list = element("dl", "", "mbt-price-grid");
  const fixed = pricing.pricingModel === "fixed_bin_customer_charge";
  const entries = fixed ? [
    ["Customer total", money(pricing.totalMinor, pricing.currency)],
    ["Pre-tax revenue", money(pricing.preTaxRevenueMinor, pricing.currency)],
    [pricing.taxMode === "included" ? "Included HST" : "Added HST",
      money(pricing.taxMode === "included" ? pricing.includedHstMinor : pricing.addedHstMinor, pricing.currency)],
    ["Deposit", money(pricing.requiredDepositMinor, pricing.currency)],
    ["Due now", money(pricing.dueNowMinor, pricing.currency)]
  ] : [
    ["Total", money(pricing.totalMinor, pricing.currency)],
    ["Subtotal", money(pricing.subtotalMinor, pricing.currency)],
    ["Tax", money(pricing.taxMinor, pricing.currency)]
  ];
  for (const [label, value] of entries) {
    const group = element("div");
    group.append(element("dt", label), element("dd", value));
    list.append(group);
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
  if (quote.status === "draft") actions.append(button("Issue quote", issueQuote));
  if (quote.status === "issued") actions.append(button("Accept quote", acceptQuote));
  if (quote.status === "accepted") actions.append(button("Convert to contract", convertQuote));
  summary.append(actions);
  quoteCard.append(summary);
}

function requestTotals(request) {
  const list = element("dl", "", "mbt-price-grid");
  const entries = [
    ["Current contract total", money(request.currentContractTotalMinor, request.currency)],
    ["New request charge", money(request.newRequestChargeableMinor, request.currency)],
    ["Resulting contract total", money(request.resultingContractTotalMinor, request.currency)],
    ["Deposit", money(request.requiredDepositMinor, request.currency)],
    ["Due now", money(request.dueNowMinor, request.currency)],
    [request.taxMode === "included" ? "Included HST" : "Added HST",
      money(request.taxMode === "included" ? request.includedHstMinor : request.addedHstMinor, request.currency)]
  ];
  for (const [label, value] of entries) {
    const group = element("div");
    group.append(element("dt", label), element("dd", value));
    list.append(group);
  }
  return list;
}

function renderCustomerCharge(request) {
  customerChargeSummary.replaceChildren(
    element("p", request.paymentMethod === "cash"
      ? "Cash total shown below already includes HST and will remain local."
      : "13% HST is added once below. Future NetSuite work will send pre-tax lines only.", "mbt-frontdesk-muted"),
    requestTotals(request),
    pricingLines(request)
  );
  customerChargeSummary.hidden = false;
  confirmCustomerCharge.hidden = false;
}

function contractLineContent(line) {
  return line.pricing?.contentCode
    || (String(line.dumpItemCode || "").toLowerCase().includes("soil") ? "soil" : "garbage");
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
  const topActions = element("div", "", "mbt-quote-actions");
  topActions.append(button("Add bin", () => openCustomerChargeDialog(null, "add_bin")));
  summary.append(topActions);
  const lines = element("section", "", "mbt-service-line-list");
  lines.append(element("h3", "Physical bin service lines"));
  for (const line of state.serviceLines) {
    const card = element("section", "", "mbt-service-line-card");
    card.append(
      element("h3", `Line ${line.lineNumber} · ${line.binTypeCode || "Bin"}`),
      element("p", `Status: ${String(line.status || "unknown").replaceAll("_", " ")}`),
      element("p", `Contents: ${contractLineContent(line)}`),
      element("p", `Site: ${fullAddress(line.site) || "Service site snapshot unavailable"}`),
      element("p", `Delivery: ${displayDate(line.plannedDeliveryAt)} · Return: ${displayDate(line.plannedReturnAt)}`)
    );
    if (!["closed", "cancelled"].includes(line.status)) {
      const actions = element("div", "", "mbt-quote-actions");
      actions.append(
        button("Extend return", () => openExtension(line.serviceLineId), "mbt-button-secondary"),
        button("Exchange bin", () => openCustomerChargeDialog(line, "exchange_bin"), "mbt-button-secondary"),
        button("Collect bin", () => openServiceLineAction(line, "collection"), "mbt-button-secondary")
      );
      if (line.customerConfirmation?.status === "required") {
        actions.append(button("Record customer confirmation", () => openServiceLineAction(line, "confirmation")));
      }
      card.append(actions);
    }
    lines.append(card);
  }
  summary.append(lines);
  if (state.chargeRequests.length) {
    const history = element("section", "", "mbt-service-line-list");
    history.append(element("h3", "Priced request history"));
    for (const request of state.chargeRequests) {
      history.append(element("p", `${request.requestNumber} · ${request.status} · ${money(request.newRequestChargeableMinor, request.currency)}`));
    }
    summary.append(history);
  }
  if (state.amendments.length) {
    const amendmentHistory = element("section", "", "mbt-service-line-list");
    amendmentHistory.append(element("h3", "Approved amendments"));
    for (const amendment of state.amendments) {
      amendmentHistory.append(element(
        "p",
        `Approved ${String(amendment.amendmentType || "amendment").replaceAll("_", " ")} ${amendment.amendmentNumber}`
      ));
    }
    summary.append(amendmentHistory);
  }
  const timeline = element("ol", "", "mbt-timeline");
  for (const visit of state.visits) {
    const item = element("li", "", "mbt-visit-card");
    item.append(
      element("h3", visit.displayName || visit.serviceAction),
      element("p", String(visit.status || "unknown").replaceAll("_", " "), "mbt-visit-status"),
      element("p", `${displayDate(visit.scheduledStartAt)} – ${displayDate(visit.scheduledEndAt)}`)
    );
    timeline.append(item);
  }
  summary.append(timeline);
  contractCard.append(summary);
}

async function loadChargeConfiguration(rateCardVersionId) {
  if (!rateCardVersionId) throw new Error("Select an active MBT workflow before pricing this request.");
  if (!state.chargeConfigurationByRate.has(rateCardVersionId)) {
    const result = await api(
      `/api/mbt/frontdesk/customer-charge/configuration?rateCardVersionId=${encodeURIComponent(rateCardVersionId)}`
    );
    state.chargeConfigurationByRate.set(rateCardVersionId, result);
  }
  return state.chargeConfigurationByRate.get(rateCardVersionId);
}

async function syncChargeWorkflowConfiguration() {
  try {
    const service = selectedService();
    if (!service) {
      throw new Error("Select an active MBT rate card before pricing this request.");
    }
    const configuration = await loadChargeConfiguration(service.rateCardVersionId);
    state.chargeRateCardVersionId = service.rateCardVersionId;
    populateContentAndBins(
      configuration,
      binContentCode.value || "garbage",
      chargeBinType.value
    );
    aggregateLineEditor.replaceChildren();
    if (state.chargeKind === "aggregate_order") {
      addAggregateRow();
    }
    setMessage(`Using ${service.rateCardDisplayName || service.displayName || service.serviceCode}.`);
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function populateContentAndBins(configuration, requestedContent = "garbage", requestedBinItem = "") {
  binContentCode.replaceChildren();
  for (const content of configuration.binContents || []) {
    binContentCode.append(new Option(content.displayName, content.contentCode));
  }
  binContentCode.value = requestedContent;
  const syncBins = () => {
    const selectedContent = configuration.binContents.find((item) => item.contentCode === binContentCode.value);
    const allowed = new Set(selectedContent?.allowedBinSizesYards || []);
    const prior = chargeBinType.value || requestedBinItem;
    chargeBinType.replaceChildren(new Option("Select a bin", ""));
    for (const item of configuredBinItems().filter((bin) => allowed.has(Number(bin.nominalYards)))) {
      chargeBinType.append(new Option(`${item.displayName || item.typeCode} · ${item.itemCode}`, item.itemCode));
    }
    if ([...chargeBinType.options].some((option) => option.value === prior)) chargeBinType.value = prior;
    if (!chargeBinType.value && chargeBinType.options.length === 2) chargeBinType.selectedIndex = 1;
  };
  binContentCode.onchange = syncBins;
  syncBins();
}

function addAggregateRow(values = {}) {
  const configuration = state.chargeConfigurationByRate.get(state.chargeRateCardVersionId) || {};
  if (aggregateLineEditor.children.length >= 4) return;
  const row = element("div", "", "mbt-surcharge-row");
  row.dataset.aggregateLine = "true";
  const itemLabel = element("label", "", "mbt-field");
  itemLabel.append(element("span", "Aggregate material"));
  const select = document.createElement("select");
  select.dataset.aggregateItem = "true";
  select.required = true;
  select.append(new Option("Select material", ""));
  for (const item of configuration.aggregateItems || []) {
    select.append(new Option(`${item.displayName} · ${money(item.unitAmountMinor)}/yard`, item.itemCode));
  }
  select.value = values.itemCode || "";
  itemLabel.append(select);
  const quantityLabel = element("label", "", "mbt-field");
  quantityLabel.append(element("span", "Quantity (yards)"));
  const quantity = document.createElement("input");
  quantity.type = "number";
  quantity.min = "0.001";
  quantity.max = "1000";
  quantity.step = "0.001";
  quantity.required = true;
  quantity.dataset.aggregateQuantity = "true";
  quantity.value = values.quantityYards || "1.000";
  quantityLabel.append(quantity);
  row.append(itemLabel, quantityLabel, button("Remove", () => row.remove(), "mbt-button-secondary"));
  aggregateLineEditor.append(row);
}

function requestedAggregateLines() {
  const lines = [...aggregateLineEditor.querySelectorAll("[data-aggregate-line]")].map((row, index) => {
    const itemCode = row.querySelector("[data-aggregate-item]")?.value || "";
    const quantityYards = row.querySelector("[data-aggregate-quantity]")?.value || "";
    if (!itemCode || !/^\d{1,4}(?:\.\d{1,3})?$/u.test(quantityYards) || Number(quantityYards) <= 0) {
      throw new Error(`Complete aggregate line ${index + 1} with a material and positive yard quantity.`);
    }
    return { itemCode, quantityYards };
  });
  if (new Set(lines.map((line) => line.itemCode)).size !== lines.length) {
    throw new Error("Each aggregate material may appear only once.");
  }
  return lines;
}

function contractRateCardVersionId() {
  return state.contract?.pricing?.rateCardVersionId || state.contract?.rateCardVersionId || null;
}

function initialSiteSelection(addressText) {
  const matching = (state.selectedCustomer?.sites || []).find((site) => fullAddress(site) === addressText);
  if (matching) return { siteProfileId: matching.siteProfileId };
  return {
    site: {
      label: addressText.slice(0, 200),
      addressLine1: addressText.slice(0, 500),
      city: "Not specified",
      region: "ON",
      postalCode: "N/A",
      countryCode: "CA"
    }
  };
}

async function openCustomerChargeDialog(line, kind) {
  if (!state.selectedCustomer || (kind !== "initial_bin" && kind !== "aggregate_order" && !state.contract)) {
    setMessage("Select a customer and contract before pricing this request.", "attention");
    return;
  }
  const workflowIsSelectable = ["initial_bin", "aggregate_order"].includes(kind);
  const service = workflowIsSelectable
    ? selectableServices(kind)[0] || null
    : (state.configuration.services || []).find(
      (item) => item.rateCardVersionId === contractRateCardVersionId()
    ) || null;
  if (workflowIsSelectable && !service) {
    setMessage("Activate an MBT rate card with a Front Desk workflow before pricing this request.", "attention");
    return;
  }
  const rateCardVersionId = workflowIsSelectable
    ? service?.rateCardVersionId
    : contractRateCardVersionId();
  try {
    state.chargeKind = kind;
    state.chargeLine = line;
    state.chargeRateCardVersionId = rateCardVersionId;
    state.chargeRequest = null;
    customerChargeForm.reset();
    if (workflowIsSelectable) {
      populateChargeServiceOptions(kind);
      chargeServiceCode.value = service?.rateCardVersionId || "";
    }
    const configuration = await loadChargeConfiguration(rateCardVersionId);
    aggregateLineEditor.replaceChildren();
    customerChargeSummary.replaceChildren();
    customerChargeSummary.hidden = true;
    confirmCustomerCharge.hidden = true;
    paymentMethod.value = "cash";
    contractTelephone.value = state.selectedCustomer.phone || "";
    const site = line?.site || state.serviceLines[0]?.site || state.selectedCustomer.sites?.[0] || {};
    serviceAddressText.value = fullAddress(site);
    billingAddressText.value = fullAddress(state.selectedCustomer.sites?.[0]) || serviceAddressText.value;
    chargeServiceCode.value = service?.rateCardVersionId || "";
    populateDeliverySelect(chargeDeliveryItemCode);
    chargeDeliveryItemCode.value = line?.pricing?.deliveryItemCode
      || state.contract?.pricing?.deliveryItemCode
      || state.configuration.deliveryItems?.[0]?.itemCode
      || "";
    const outgoingContent = line ? contractLineContent(line) : "garbage";
    populateContentAndBins(configuration, outgoingContent, line?.binItemCode || "");
    chargeDeliveryAt.value = localDateTimeValue(
      kind === "exchange_bin" ? Date.now() + 86_400_000 : Date.now() + 86_400_000
    );
    chargeReturnAt.value = localDateTimeValue(line?.plannedReturnAt || Date.now() + (15 * 86_400_000));
    customerChargeReason.value = kind === "initial_bin"
      ? "Create a fixed-price Front Desk BIN quote"
      : kind === "aggregate_order"
        ? "Create a standalone aggregate order"
        : kind === "add_bin"
          ? "Customer requested an additional bin"
          : "Customer requested a bin exchange";
    const aggregateOnly = kind === "aggregate_order";
    chargeBinFields.hidden = aggregateOnly;
    chargeBinFields.querySelectorAll("input, select, textarea").forEach((control) => {
      control.disabled = aggregateOnly;
    });
    chargeWorkflowFields.hidden = !["initial_bin", "aggregate_order"].includes(kind);
    chargeOrderFrom150.checked = aggregateOnly;
    chargeOrderFrom150.disabled = aggregateOnly;
    if (aggregateOnly) addAggregateRow();
    customerChargeTitle.textContent = kind === "initial_bin"
      ? "New BIN contract price"
      : kind === "aggregate_order"
        ? "Aggregate Order price"
        : kind === "add_bin"
          ? `Add bin · ${state.contract.contractNumber}`
          : `Exchange bin · Line ${line.lineNumber}`;
    chargeDeliveryLabel.textContent = kind === "exchange_bin" ? "Exchange date and time" : "Delivery date and time";
    customerChargeHelp.textContent = aggregateOnly
      ? "Material is charged per yard. Delivery starts at $150 through 30 km, then follows the configured distance bands."
      : "The server calculates fixed bin charges, payment-specific HST, deposit, optional aggregate, and the exact customer amount.";
    newContractDialog.close();
    customerChargeDialog.showModal();
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function chargeCommonBody() {
  const aggregateLines = requestedAggregateLines();
  if (aggregateLines.length && !chargeOrderFrom150.checked) {
    throw new Error("Select Order from 150 whenever aggregate ships with a bin.");
  }
  const body = {
    paymentMethod: paymentMethod.value,
    billingAddressText: billingAddressText.value.trim(),
    serviceAddressText: serviceAddressText.value.trim(),
    contractTelephone: contractTelephone.value.trim(),
    orderFrom150: chargeOrderFrom150.checked,
    aggregateLines,
    reason: customerChargeReason.value.trim()
  };
  if (!body.billingAddressText || !body.serviceAddressText || !body.contractTelephone || !body.reason) {
    throw new Error("Complete billing address, service address, telephone, and request reason.");
  }
  return body;
}

function chargeBinBody() {
  const bin = selectedChargeBin();
  const discountText = binDiscountCad.value.trim();
  if (!bin || !/^\d+(?:\.\d{1,2})?$/u.test(discountText)) {
    throw new Error("Select an allowed bin and enter a valid per-bin discount.");
  }
  const discountMinor = Math.round(Number(discountText) * 100);
  if (discountMinor > 0 && !binDiscountReason.value.trim()) {
    throw new Error("A per-bin discount requires a reason.");
  }
  const proposedDeliveryAt = new Date(chargeDeliveryAt.value);
  const proposedReturnAt = new Date(chargeReturnAt.value);
  if (!(proposedReturnAt > proposedDeliveryAt)) {
    throw new Error("The return date must follow delivery or exchange.");
  }
  return {
    incomingContentCode: binContentCode.value,
    incomingBinSizeYards: Number(bin.nominalYards),
    incomingBinTypeId: bin.binTypeId,
    binItemCode: bin.itemCode,
    deliveryItemCode: chargeDeliveryItemCode.value,
    discountMinor,
    discountReason: discountMinor ? binDiscountReason.value.trim() : null,
    proposedDeliveryAt: proposedDeliveryAt.toISOString(),
    proposedReturnAt: proposedReturnAt.toISOString()
  };
}

async function previewCustomerChargeRequest(event) {
  event.preventDefault();
  if (!state.chargeKind) return;
  try {
    const common = chargeCommonBody();
    if (state.chargeKind === "initial_bin") {
      const service = selectedService();
      const bin = chargeBinBody();
      if (!service || !chargeDeliveryItemCode.value) throw new Error("Select the BIN workflow and delivery item.");
      setMessage("Calculating the fixed-price BIN quote…");
      const result = await api("/api/mbt/frontdesk/quotes", {
        method: "POST",
        body: {
          customerNetsuiteId: state.selectedCustomer.customerNetsuiteId,
          ...initialSiteSelection(common.serviceAddressText),
          serviceTemplateVersionId: service.templateVersionId,
          rateCardVersionId: service.rateCardVersionId,
          serviceCode: service.serviceCode,
          deliveryItemCode: bin.deliveryItemCode,
          binItemCode: bin.binItemCode,
          binTypeId: bin.incomingBinTypeId,
          contentCode: bin.incomingContentCode,
          discountMinor: bin.discountMinor,
          discountReason: bin.discountReason,
          proposedDeliveryAt: bin.proposedDeliveryAt,
          proposedReturnAt: bin.proposedReturnAt,
          serviceLines: [{
            binItemCode: bin.binItemCode,
            binTypeId: bin.incomingBinTypeId,
            contentCode: bin.incomingContentCode,
            discountMinor: bin.discountMinor,
            discountReason: bin.discountReason,
            proposedDeliveryAt: bin.proposedDeliveryAt,
            proposedReturnAt: bin.proposedReturnAt,
            ...initialSiteSelection(common.serviceAddressText)
          }],
          ...common
        },
        idempotencyKey: commandIdentity("mbt-frontdesk-fixed-bin")
      });
      state.quote = result.quote;
      state.contract = null;
      customerChargeDialog.close();
      renderQuote();
      setMessage("Fixed-price BIN quote created. Review the exact customer total before issuing it.");
      return;
    }
    const body = {
      kind: state.chargeKind,
      customerNetsuiteId: state.chargeKind === "aggregate_order"
        ? state.selectedCustomer.customerNetsuiteId
        : undefined,
      contractId: state.contract?.contractId,
      serviceLineId: state.chargeLine?.serviceLineId,
      expectedContractRevision: state.contract?.revision,
      expectedServiceLineRevision: state.chargeLine?.revision,
      rateCardVersionId: state.chargeRateCardVersionId,
      ...common
    };
    if (state.chargeKind !== "aggregate_order") {
      body.bin = chargeBinBody();
      if (state.chargeKind === "exchange_bin") {
        const outgoing = configuredBinItems().find((item) => item.binTypeId === state.chargeLine.binTypeId);
        body.bin.outgoingContentCode = contractLineContent(state.chargeLine);
        body.bin.outgoingBinSizeYards = Number(outgoing?.nominalYards);
      }
    }
    setMessage("Calculating the new request charge…");
    const result = await api("/api/mbt/frontdesk/charge-requests/preview", {
      method: "POST", body,
      idempotencyKey: commandIdentity("mbt-frontdesk-charge-preview")
    });
    state.chargeRequest = result.request;
    renderCustomerCharge(result.request);
    setMessage("Charge calculated. Review current, new, resulting, deposit, and due-now amounts with the customer.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

async function confirmCustomerChargeRequest() {
  const request = state.chargeRequest;
  if (!request) return;
  try {
    const result = await api(`/api/mbt/frontdesk/charge-requests/${request.chargeRequestId}/confirm`, {
      method: "POST",
      body: { expectedRevision: request.revision, reason: customerChargeReason.value.trim() },
      idempotencyKey: commandIdentity("mbt-frontdesk-charge-confirm")
    });
    customerChargeDialog.close();
    state.chargeRequest = null;
    if (state.contract) {
      const contractId = state.contract.contractId;
      await Promise.all([loadCustomerContracts(), loadContractTimeline(contractId)]);
    }
    setMessage(result.dispatchOrder
      ? `${result.dispatchOrder.refNumber || "Aggregate order"} is ready in Dispatch.`
      : "Customer request confirmed; the operational bin work and charge evidence are linked.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

async function createDeliveryOrder() {
  const itemCode = deliveryItemCode.value;
  const pickupLocation = byId("deliveryPickup").value.trim();
  const dropoffLocation = byId("deliveryDropoff").value.trim();
  const orderDetails = byId("deliveryDetails").value.trim();
  const weightLbs = Number(byId("deliveryWeightLbs").value);
  const stopMinutes = Number(byId("deliveryStopMinutes").value);
  if (!itemCode || !pickupLocation || !dropoffLocation || !orderDetails
      || !Number.isSafeInteger(weightLbs) || weightLbs < 1
      || !Number.isSafeInteger(stopMinutes) || stopMinutes < 0) {
    throw new Error("Complete the delivery item, A-to-B locations, details, weight, and stop time.");
  }
  const result = await api("/api/mbt/frontdesk/delivery-orders", {
    method: "POST",
    body: {
      customerNetsuiteId: state.selectedCustomer.customerNetsuiteId,
      itemCode, pickupLocation, dropoffLocation, orderDetails, weightLbs, stopMinutes
    },
    idempotencyKey: commandIdentity("mbt-frontdesk-delivery")
  });
  newContractDialog.close();
  quoteForm.reset();
  syncOrderKindFields();
  setMessage(`${result.deliveryOrder?.refNumber || "Delivery"} is ready in Dispatch.`);
}

async function createOrder(event) {
  event.preventDefault();
  if (!state.selectedCustomer) {
    setMessage("Select an active customer first.", "attention");
    return;
  }
  try {
    if (orderKind.value === "delivery") {
      setMessage("Creating the local Delivery order for Dispatch…");
      await createDeliveryOrder();
    } else if (orderKind.value === "bin") {
      await openCustomerChargeDialog(null, "initial_bin");
    } else if (orderKind.value === "aggregate") {
      await openCustomerChargeDialog(null, "aggregate_order");
    }
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

async function issueQuote() {
  try {
    const delivery = new Date(state.quote.proposedDeliveryAt);
    const result = await api(`/api/mbt/frontdesk/quotes/${state.quote.quoteId}/issue`, {
      method: "POST",
      body: {
        expectedRevision: state.quote.revision,
        validUntil: new Date(delivery.getTime() + 86_400_000).toISOString(),
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
  try {
    const result = await api(`/api/mbt/frontdesk/quotes/${state.quote.quoteId}/accept`, {
      method: "POST",
      body: {
        expectedRevision: state.quote.revision,
        acceptedAt: new Date().toISOString(),
        reason: "Record customer acceptance of the fixed-price quote"
      },
      idempotencyKey: commandIdentity("mbt-frontdesk-accept")
    });
    state.quote = result.quote;
    renderQuote();
    setMessage("Customer acceptance recorded. Convert the quote to create the bin contract.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

async function convertQuote() {
  try {
    const result = await api(`/api/mbt/frontdesk/quotes/${state.quote.quoteId}/convert`, {
      method: "POST",
      body: { expectedRevision: state.quote.revision, reason: "Convert the accepted fixed-price quote" },
      idempotencyKey: commandIdentity("mbt-frontdesk-convert")
    });
    state.contract = result.contract;
    state.serviceLines = result.serviceLines || [];
    state.visits = result.visits || [];
    state.quote = null;
    await loadCustomerContracts();
    renderContract();
    setMessage("Contract created. The accepted initial charge is locked and no NetSuite write was made.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function field(labelText, control, target = serviceLineActionFields) {
  const label = element("label", "", "mbt-field");
  label.append(element("span", labelText), control);
  target.append(label);
  return control;
}

function windowFields(target, startValue) {
  const start = document.createElement("input");
  start.type = "datetime-local";
  start.required = true;
  start.value = localDateTimeValue(startValue);
  const end = document.createElement("input");
  end.type = "datetime-local";
  end.required = true;
  end.value = localDateTimeValue(new Date(startValue || Date.now()).getTime() + 14_400_000);
  field("Window start", start, target);
  field("Window end", end, target);
  return { start, end };
}

function openExtension(serviceLineId = null) {
  state.extensionServiceLineId = serviceLineId;
  extensionFields.replaceChildren();
  const line = state.serviceLines.find((item) => item.serviceLineId === serviceLineId);
  const controls = windowFields(extensionFields, line?.plannedReturnAt || state.contract?.plannedReturnAt);
  const reason = document.createElement("textarea");
  reason.required = true;
  field("Approval reason", reason, extensionFields);
  state.extensionControls = { ...controls, reason };
  extensionDialog.showModal();
}

async function saveExtension(event) {
  event.preventDefault();
  const line = state.serviceLines.find((item) => item.serviceLineId === state.extensionServiceLineId);
  const path = line
    ? `/api/mbt/frontdesk/contracts/${state.contract.contractId}/service-lines/${line.serviceLineId}/extensions`
    : `/api/mbt/frontdesk/contracts/${state.contract.contractId}/extensions`;
  try {
    await api(path, {
      method: "POST",
      body: {
        expectedRevision: line?.revision ?? state.contract.revision,
        returnWindow: {
          startAt: new Date(state.extensionControls.start.value).toISOString(),
          endAt: new Date(state.extensionControls.end.value).toISOString()
        },
        reason: state.extensionControls.reason.value.trim()
      },
      idempotencyKey: commandIdentity("mbt-frontdesk-extension")
    });
    extensionDialog.close();
    await loadContractTimeline(state.contract.contractId);
    setMessage("Approved return extension saved.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function openServiceLineAction(line, action) {
  state.serviceAction = action;
  state.serviceActionLineId = line.serviceLineId;
  serviceLineActionFields.replaceChildren();
  if (action === "collection") {
    serviceLineActionTitle.textContent = `Collect bin · Line ${line.lineNumber}`;
    serviceLineActionHelp.textContent = "Request collection for this bin only.";
    const controls = windowFields(serviceLineActionFields, line.plannedReturnAt);
    const reason = document.createElement("textarea");
    reason.required = true;
    field("Audit reason", reason);
    state.serviceActionControls = { ...controls, reason };
    serviceLineActionSubmit.textContent = "Request collection";
  } else {
    serviceLineActionTitle.textContent = `Customer confirmation · Line ${line.lineNumber}`;
    serviceLineActionHelp.textContent = "Record the customer's decision for an operational size change.";
    const decision = document.createElement("select");
    decision.append(new Option("Customer confirmed", "confirmed"), new Option("Customer declined", "declined"));
    field("Customer decision", decision);
    const reason = document.createElement("textarea");
    reason.required = true;
    field("Audit reason", reason);
    state.serviceActionControls = { decision, reason };
    serviceLineActionSubmit.textContent = "Record decision";
  }
  serviceLineActionDialog.showModal();
}

async function saveServiceLineAction(event) {
  event.preventDefault();
  const line = state.serviceLines.find((item) => item.serviceLineId === state.serviceActionLineId);
  if (!line) return;
  const controls = state.serviceActionControls;
  const collection = state.serviceAction === "collection";
  const path = `/api/mbt/frontdesk/contracts/${state.contract.contractId}/service-lines/${line.serviceLineId}/${collection ? "collections" : "customer-confirmations"}`;
  const body = collection ? {
    expectedRevision: line.revision,
    collectionWindow: {
      startAt: new Date(controls.start.value).toISOString(),
      endAt: new Date(controls.end.value).toISOString()
    },
    reason: controls.reason.value.trim()
  } : {
    expectedRevision: line.revision,
    decision: controls.decision.value,
    reason: controls.reason.value.trim()
  };
  try {
    await api(path, {
      method: "POST", body,
      idempotencyKey: commandIdentity(`mbt-frontdesk-${state.serviceAction}`)
    });
    serviceLineActionDialog.close();
    await loadContractTimeline(state.contract.contractId);
    setMessage("Physical-bin service action saved.");
  } catch (error) {
    setMessage(error.message, "attention");
  }
}

function openNewContractOrderDialog() {
  if (!state.enabled) {
    setMessage(state.disabledMessage, "attention");
    return;
  }
  if (!state.selectedCustomer) {
    setMessage("Select a customer before adding a new order.", "attention");
    return;
  }
  newContractCustomer.textContent = `${state.selectedCustomer.displayName} · Choose the order type.`;
  newContractDialog.showModal();
  orderKind.focus();
}

function disableCommandSurfaces() {
  for (const form of [quoteForm, customerChargeForm, extensionForm, serviceLineActionForm]) {
    form.querySelectorAll("input, select, textarea, button").forEach((control) => {
      control.disabled = true;
    });
  }
}

async function initialize() {
  try {
    const status = await api("/api/mbt/frontdesk/status");
    state.enabled = status.enabled === true;
    if (!state.enabled) {
      const gateReason = status.commandState?.reason;
      state.disabledMessage = status.message
        || `Front Desk is disabled by the server safety gate${gateReason ? ` (${gateReason})` : ""}.`;
      disableCommandSurfaces();
      openNewContractOrder.disabled = true;
      setMessage(state.disabledMessage, "attention");
      return;
    }
    const configuration = await api("/api/mbt/frontdesk/configuration");
    state.configuration = configuration;
    populateConfiguration();
    renderContractMaster();
    setMessage("Front Desk is ready. Cash stays local; non-cash HST is calculated once. NetSuite posting is not enabled.");
  } catch (error) {
    disableCommandSurfaces();
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
  byId("customer-choice-0")?.focus();
});
quoteForm.addEventListener("submit", createOrder);
orderKind.addEventListener("change", syncOrderKindFields);
openNewContractOrder.addEventListener("click", openNewContractOrderDialog);
byId("closeNewContractOrder").addEventListener("click", () => newContractDialog.close());
customerChargeForm.addEventListener("submit", previewCustomerChargeRequest);
chargeServiceCode.addEventListener("change", syncChargeWorkflowConfiguration);
confirmCustomerCharge.addEventListener("click", confirmCustomerChargeRequest);
byId("closeCustomerCharge").addEventListener("click", () => customerChargeDialog.close());
addAggregateLine.addEventListener("click", () => addAggregateRow());
extensionForm.addEventListener("submit", saveExtension);
byId("closeExtension").addEventListener("click", () => extensionDialog.close());
serviceLineActionForm.addEventListener("submit", saveServiceLineAction);
byId("closeServiceLineAction").addEventListener("click", () => serviceLineActionDialog.close());

initialize();
