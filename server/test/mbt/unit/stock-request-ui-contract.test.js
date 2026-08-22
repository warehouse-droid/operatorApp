import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const publicUrl = new URL("../../../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");

test("Sales Request Stock page is private, yard-aware, multi-line, and exposes the approved status tabs", () => {
  const html = readPublic("sales-stock-requests.html");
  const source = readPublic("sales-stock-requests.js");
  assert.match(html, /salesStockRequestApp/);
  assert.match(source, /Regular/i);
  assert.match(source, /Special/i);
  assert.match(source, /allowPublicSales\s*:\s*false/);
  assert.match(source, /Pending/);
  assert.match(source, /Accepted/);
  assert.match(source, /Completed/);
  assert.match(source, /stock-request-items/);
  assert.match(source, /availability\/refresh/);
  assert.match(source, /Add (?:another )?line/i);
  assert.match(source, /EventSource\(["']\/api\/events/);
});

test("Sales regular stock request cannot retain an empty destination while an authorized yard is displayed", async () => {
  const source = readPublic("sales-stock-requests.js");
  let resolveList;
  let fetchCalls = 0;
  let renderCount = 0;
  let renderedHtml = "";
  const listResponse = new Promise((resolve) => { resolveList = resolve; });
  let responsePromise = listResponse;
  const app = {
    get innerHTML() { return renderedHtml; },
    set innerHTML(value) {
      renderedHtml = value;
      renderCount += 1;
    },
    addEventListener() {},
    contains() { return false; },
    querySelector() { return null; }
  };
  const context = vm.createContext({
    console,
    crypto: { randomUUID: () => "race-line" },
    CSS: { escape: (value) => String(value) },
    document: {
      activeElement: null,
      getElementById: () => app,
      title: ""
    },
    EventSource: class EventSource {},
    fetch: async () => {
      fetchCalls += 1;
      return responsePromise;
    },
    localStorage: { getItem: () => null, setItem() {} },
    requireDispatchLogin() {},
    URLSearchParams,
    window: {
      addEventListener() {},
      clearTimeout,
      setTimeout
    }
  });
  vm.runInContext(source, context, { filename: "sales-stock-requests.js" });

  const loading = vm.runInContext("salesStockLoad()", context);
  assert.match(app.innerHTML, /data-sales-stock-action="new"[^>]*disabled/);
  vm.runInContext("salesStockStartNew()", context);
  assert.equal(vm.runInContext("salesStockState.composer", context), null);

  // Also recover a composer created by an older page or an in-flight click just before loading began.
  vm.runInContext(`salesStockState.composer = {
    requestId: null,
    expectedRevision: null,
    partial: false,
    remarks: "",
    destinationLocationId: "",
    lines: [salesStockNewLine()]
  }`, context);
  resolveList({
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => ({
      yards: [{ locationId: 28, yardCode: "2967" }],
      filterOptions: { vendors: [], sourceYards: [] },
      requests: []
    })
  });
  await loading;

  assert.equal(vm.runInContext("salesStockState.composer.destinationLocationId", context), "28");
  assert.match(app.innerHTML, /value="28" selected>2967/);
  assert.match(app.innerHTML, /data-sales-stock-action="bucket"[^>]*disabled/);

  const composingRenderCount = renderCount;
  assert.equal(await vm.runInContext("salesStockLoad({ background: true })", context), false);
  assert.equal(fetchCalls, 1, "an active composer must prevent background network refresh");
  assert.equal(renderCount, composingRenderCount, "an active composer must never be rerendered by background refresh");
  assert.equal(vm.runInContext("salesStockState.refreshPending", context), true);

  vm.runInContext(`salesStockState.composer = null;
    salesStockState.refreshPending = false;
    renderSalesStockRequests();`, context);
  const unchangedRenderCount = renderCount;
  assert.equal(await vm.runInContext("salesStockLoad({ background: true })", context), false);
  assert.equal(fetchCalls, 2);
  assert.equal(renderCount, unchangedRenderCount, "unchanged live data must not replace the page");

  let resolveStaleSearch;
  responsePromise = new Promise((resolve) => { resolveStaleSearch = resolve; });
  vm.runInContext(`salesStockState.composer = {
    requestId: null,
    destinationLocationId: "28",
    lines: [salesStockNewLine({ itemSearch: "AB", searchGeneration: 1 })]
  }`, context);
  const staleSearch = vm.runInContext(
    "salesStockSearchItems(salesStockState.composer.lines[0], 1)",
    context
  );
  vm.runInContext(`salesStockState.composer.lines[0].itemSearch = "ABC";
    salesStockState.composer.lines[0].searchGeneration = 2;`, context);
  const staleSearchRenderCount = renderCount;
  resolveStaleSearch({
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => ({ items: [{ itemId: 99, itemCode: "AB-OLD" }] })
  });
  await staleSearch;
  assert.equal(vm.runInContext("salesStockState.suggestions.size", context), 0);
  assert.equal(renderCount, staleSearchRenderCount, "an out-of-order item search must not rerender the composer");

  vm.runInContext(`salesStockState.composer.lines[0].itemSearch = "A";
    salesStockState.composer.lines[0].searchGeneration = 3;`, context);
  await vm.runInContext("salesStockSearchItems(salesStockState.composer.lines[0], 3)", context);
  assert.equal(fetchCalls, 3, "a one-character item term must not issue a request");
  assert.equal(renderCount, staleSearchRenderCount, "a one-character item term with no suggestions must not rerender");

  let resolveAbandonedAvailability;
  responsePromise = new Promise((resolve) => { resolveAbandonedAvailability = resolve; });
  vm.runInContext(`salesStockState.composer = {
    requestId: null,
    destinationLocationId: "28",
    lines: [salesStockNewLine()]
  };
  salesStockState.suggestions.set(salesStockState.composer.lines[0].key, [{
    itemId: 99,
    itemCode: "ITEM-99"
  }]);`, context);
  const abandonedAvailability = vm.runInContext(
    "salesStockChooseItem(salesStockState.composer.lines[0], 99)",
    context
  );
  vm.runInContext("salesStockState.composer = null", context);
  const abandonedRenderCount = renderCount;
  resolveAbandonedAvailability({
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => ({
      item: { itemId: 99, itemCode: "ITEM-99" },
      yards: [{ locationId: 1, requestableAvailable: 10 }]
    })
  });
  await abandonedAvailability;
  assert.equal(fetchCalls, 4);
  assert.equal(renderCount, abandonedRenderCount, "an abandoned availability request must not rerender the page");

  const restoredInput = {
    focusCalls: 0,
    ranges: [],
    focus() { this.focusCalls += 1; },
    setSelectionRange(start, end) { this.ranges.push([start, end]); }
  };
  context.document.activeElement = {
    closest: () => ({ dataset: { salesStockLine: "race-line" } }),
    dataset: { salesStockField: "itemSearch" },
    matches: (selector) => selector === "[data-sales-stock-field]",
    selectionStart: 2,
    selectionEnd: 2
  };
  app.contains = () => true;
  app.querySelector = (selector) => selector.includes("data-sales-stock-field=\"itemSearch\"")
    ? restoredInput
    : null;
  vm.runInContext("renderSalesStockRequests()", context);
  assert.equal(restoredInput.focusCalls, 1, "a legitimate render must restore the active composer field");
  assert.deepEqual(restoredInput.ranges, [[2, 2]]);
});

test("SCM Stock Requests page has the two-pane Request and Pending TO workflow", () => {
  const html = readPublic("scm-stock-requests.html");
  const source = readPublic("scm-stock-requests.js");
  const css = readPublic("stock-requests.css");
  assert.match(html, /scmStockRequestApp/);
  assert.match(source, /Regular/i);
  assert.match(source, /Special/i);
  assert.match(source, /Pending TO/);
  assert.match(source, /Convert to TO/);
  assert.match(source, /Confirm TO \+ Print/);
  assert.match(source, /Re-print/);
  assert.match(source, /Request Changes/);
  assert.match(source, /Reject/);
  assert.match(css, /grid-template-columns\s*:\s*minmax\([^;]+\)\s+minmax\(/);
  assert.match(css, /overflow(?:-y)?\s*:\s*auto/);
});

test("role-aware navigation links to Request Stock without changing existing modules", () => {
  const sidebar = readPublic("app-sidebar.js");
  const sales = readPublic("sales.js");
  const scm = readPublic("scm-menu.html");
  assert.match(sidebar, /Request Stock[^\n]+\/sales\/stock-requests/);
  assert.match(sidebar, /Stock Requests[^\n]+\/scm\/stock-requests/);
  assert.match(sales, /\/sales\/stock-requests/);
  assert.match(scm, /\/scm\/stock-requests/);
});

test("stock-request feedback is content-sized and availability shows Sales plus conversion equivalents", () => {
  const sales = readPublic("sales-stock-requests.js");
  const scm = readPublic("scm-stock-requests.js");
  const css = readPublic("stock-requests.css");

  assert.match(css, /grid-template-rows\s*:\s*auto\s+auto\s+auto\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /\.stock-request-workspace\s*\{[^}]*grid-row\s*:\s*4/s);
  assert.match(css, /\.stock-request-notice\s*\{[^}]*align-self\s*:\s*start/s);
  for (const source of [sales, scm]) {
    assert.match(source, /requestableAvailable/);
    assert.match(source, /Sales quantity/i);
    assert.match(source, /\bPLT\b/);
    assert.match(source, /\bLYR\b/);
    assert.match(source, /\bSEC\b/);
    assert.match(source, /\bPCS\b/);
    assert.match(source, /toPlt/);
    assert.match(source, /toLyr/);
    assert.match(source, /toSec/);
    assert.match(source, /toPcs/);
  }
});

test("Sales highlights returned requests and all Sales buckets expose persistent filters", () => {
  const source = readPublic("sales-stock-requests.js");
  const css = readPublic("stock-requests.css");

  assert.match(source, /Request Change/);
  assert.match(source, /changes_requested/);
  assert.match(source, /stock-request-card-attention/);
  assert.match(css, /\.stock-request-card-attention\s*\{[^}]*background[^;}]*#(?:fff|fffb|fef)/is);
  assert.match(source, /vendorFilter/);
  assert.match(source, /requestDateFilter/);
  assert.match(source, /sourceLocationFilter/);
  assert.match(source, /name="vendor"/);
  assert.match(source, /name="requestDate"/);
  assert.match(source, /name="sourceLocationId"/);
});

test("SCM exposes Request, Pending TO, Rejected, and Closed queues with the required filters", () => {
  const source = readPublic("scm-stock-requests.js");

  for (const label of ["Request", "Pending TO", "Rejected", "Closed"]) {
    assert.match(source, new RegExp(`>${label}<`));
  }
  assert.match(source, /vendorFilter/);
  assert.match(source, /requestDateFilter/);
  assert.match(source, /sourceLocationFilter/);
  assert.match(source, /destinationLocationFilter/);
  assert.match(source, /name="vendor"/);
  assert.match(source, /name="requestDate"/);
  assert.match(source, /name="sourceLocationId"/);
  assert.match(source, /name="destinationLocationId"/);
});

test("SCM can reverse a returned decision and reject only an unconfirmed local pending TO", () => {
  const source = readPublic("scm-stock-requests.js");

  assert.match(source, /status\s*===\s*["']changes_requested["']/);
  assert.match(source, /Reject Pending TO/);
  assert.match(source, /netsuiteTransferOrderId/);
  assert.match(source, /printJobId/);
  assert.match(source, /\/api\/scm\/stock-transfers\/\$\{[^}]+\}\/reject/);
});

test("live list rendering restores search focus and ignores stale responses", () => {
  for (const name of ["sales-stock-requests.js", "scm-stock-requests.js"]) {
    const source = readPublic(name);
    assert.match(source, /loadGeneration/);
    assert.match(source, /selectionStart/);
    assert.match(source, /setSelectionRange/);
    assert.match(source, /document\.activeElement/);
  }
});

test("Sales can submit a request remark and both roles display it", () => {
  const sales = readPublic("sales-stock-requests.js");
  const scm = readPublic("scm-stock-requests.js");

  assert.match(sales, /name="remarks"/);
  assert.match(sales, /composer\.remarks/);
  assert.match(sales, /remarks:\s*composer\.remarks/);
  assert.match(sales, /request\.remarks/);
  assert.match(scm, /request\.remarks/);
});

test("availability Sales UOM and conversion equivalents render on separate rows", () => {
  const sales = readPublic("sales-stock-requests.js");
  const scm = readPublic("scm-stock-requests.js");
  const css = readPublic("stock-requests.css");

  for (const source of [sales, scm]) {
    assert.match(source, /stock-request-availability-primary/);
    assert.match(source, /stock-request-availability-equivalents/);
  }
  assert.match(css, /\.stock-request-availability-primary\s*\{[^}]*display\s*:\s*(?:flex|grid|block)/s);
  assert.match(css, /\.stock-request-availability-equivalents\s*\{[^}]*display\s*:\s*(?:flex|grid|block)/s);
});

test("Sales explains backorder conversion and SCM shows the calculated shortage", () => {
  const sales = readPublic("sales-stock-requests.js");
  const scm = readPublic("scm-stock-requests.js");
  const css = readPublic("stock-requests.css");

  assert.match(sales, /allowOverAvailability:\s*false/);
  assert.match(sales, /payload\.allowOverAvailability\s*===\s*true/);
  assert.match(sales, /salesStock\.overAvailabilityEnabled/);
  assert.match(sales, /SCM can convert the full requested quantity/);
  assert.match(css, /\.stock-request-availability-override\s*\{[^}]*background\s*:\s*#fff4cc/s);
  assert.match(scm, /Backorder allowed/);
  assert.match(scm, /backorder/);
  assert.match(css, /\.stock-request-backorder\s*\{/);
});

test("Sales Request Stock has complete Simplified Chinese UI and validation coverage", () => {
  const html = readPublic("sales-stock-requests.html");
  const source = readPublic("sales-stock-requests.js");
  const i18nSource = readPublic("i18n.js");
  const stored = new Map([["mbbs.ui.language", "zh-CN"]]);
  const context = {
    localStorage: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value)
    },
    document: { documentElement: {}, addEventListener() {} },
    window: { dispatchEvent() {} },
    CustomEvent: class CustomEvent {}
  };
  vm.runInNewContext(i18nSource, context, { filename: "i18n.js" });
  const i18n = context.window.MBBS_I18N;
  const calls = [...source.matchAll(
    /\bsalesStock(T|Tf)\(\s*"([^"]+)",\s*"((?:[^"\\]|\\.)*)"/g
  )].map((match) => ({ helper: match[1], key: match[2], fallback: JSON.parse(`"${match[3]}"`) }));
  assert(calls.length >= 65, `expected broad Sales Stock Request i18n coverage, found ${calls.length} calls`);
  const missing = [];
  const untranslated = [];
  const placeholderMismatches = [];
  for (const call of calls) {
    const translated = i18n.t(call.key, `__missing__${call.key}`);
    if (translated === `__missing__${call.key}`) {
      missing.push(call.key);
    }
    if (translated === call.fallback) {
      untranslated.push(call.key);
    }
    if (call.helper === "Tf") {
      const fallbackVariables = [...call.fallback.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      const translatedVariables = [...translated.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      if (JSON.stringify(fallbackVariables) !== JSON.stringify(translatedVariables)) {
        placeholderMismatches.push(call.key);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], `missing Sales Stock Request Chinese keys: ${missing.join(", ")}`);
  assert.deepEqual([...new Set(untranslated)], [], `untranslated Sales Stock Request keys: ${untranslated.join(", ")}`);
  assert.deepEqual([...new Set(placeholderMismatches)], [], `Sales Stock Request placeholder mismatch: ${placeholderMismatches.join(", ")}`);
  assert.match(source, /salesStockMessage\(salesStockState\.error\)/);
  assert.equal(i18n.message("Select an item on every request line."), "请为每个申请行选择物品。");
  assert.equal(i18n.message("Select a source yard for ABC."), "请为 ABC 选择来源堆场。");
  assert.equal(i18n.message("Requested quantity 20 exceeds requestable availability 10."), "申请数量 20 超过可申请库存 10。");
  assert.match(html, /i18n\.js\?v=20260815-customer-pickup-photo-gate-v1/);
  assert.match(html, /sales-stock-requests\.js\?v=20260821-stock-composer-stability-v1/);
});
