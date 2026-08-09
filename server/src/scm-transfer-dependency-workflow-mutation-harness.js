import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const uiSource = fs.readFileSync(new URL("../public/scm-transfer-dependencies.js", import.meta.url), "utf8");
const repositorySource = fs.readFileSync(new URL("./order-dependency-repository.js", import.meta.url), "utf8");
const netSuiteSource = fs.readFileSync(new URL("./transfer-dependency-netsuite.js", import.meta.url), "utf8");

function replaceOnce(source, from, to, name) {
  assert.equal(source.split(from).length - 1, 1, `${name}: mutation target drifted`);
  return source.replace(from, to);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function uiImplementation(source) {
  const app = {
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    innerHTML: ""
  };
  const context = vm.createContext({
    AbortController,
    console,
    document: {
      getElementById: () => app,
      addEventListener() {},
      visibilityState: "visible"
    },
    EventSource: class { addEventListener() {} close() {} },
    fetch: async () => { throw new Error("unexpected fetch"); },
    Intl,
    Promise,
    Set,
    URLSearchParams,
    crypto: { randomUUID: () => "mutation-request" },
    requireDispatchLogin() {},
    setTimeout,
    clearTimeout,
    window: {
      addEventListener() {},
      clearTimeout,
      setTimeout,
      matchMedia: () => ({ matches: false })
    }
  });
  vm.runInContext(`${source}
    renderDependencyPage = () => {};
    globalThis.__mutation = {
      dependencyState,
      depCandidateQuery,
      loadSelectedDependencyInventory,
      runDependencyAction,
      setApi(fn) { depApi = fn; }
    };`, context);
  return context.__mutation;
}

async function verifyIndependentProposalActions(source) {
  const ui = uiImplementation(source);
  const pending = deferred();
  let secondStarted = false;
  const first = ui.runDependencyAction("first", () => pending.promise, { scope: "proposal:1" });
  await Promise.resolve();
  const second = ui.runDependencyAction("second", async () => { secondStarted = true; }, { scope: "proposal:2" });
  await Promise.resolve();
  assert.equal(secondStarted, true);
  pending.resolve();
  await Promise.all([first, second]);
}

async function verifyNewestInventoryWins(source) {
  const ui = uiImplementation(source);
  const oldOrder = deferred();
  const newOrder = deferred();
  ui.dependencyState.reviewStatus = "created";
  ui.dependencyState.candidates = [
    { salesOrderId: 1, salesOrderRef: "OLD" },
    { salesOrderId: 2, salesOrderRef: "NEW" }
  ];
  ui.setApi((path) => path.includes("/1/inventory") ? oldOrder.promise : newOrder.promise);
  ui.dependencyState.selectedSalesOrderId = 1;
  const older = ui.loadSelectedDependencyInventory({ refreshUndercovered: false });
  ui.dependencyState.selectedSalesOrderId = 2;
  const newer = ui.loadSelectedDependencyInventory({ refreshUndercovered: false });
  newOrder.resolve({ marker: "new" });
  await newer;
  oldOrder.resolve({ marker: "old" });
  await older;
  assert.equal(ui.dependencyState.inventory.marker, "new");
}

function verifyGlobalSearch(source) {
  const ui = uiImplementation(source);
  ui.dependencyState.reviewStatus = "open";
  ui.dependencyState.search = "TOB00999";
  assert.equal(new URLSearchParams(ui.depCandidateQuery().slice(1)).get("reviewStatus"), "all");
}

function netSuiteHelpers(source) {
  const update = source.match(/export function buildTransferDependencyUpdateRequest[\s\S]*?(?=\nexport function transferOrderQuantityRevisionStatusBlock)/)?.[0] || "";
  const printKey = source.match(/export function transferDependencyPickingTicketJobKey[\s\S]*$/)?.[0] || "";
  assert(update && printKey, "NetSuite mutation helper extraction drifted");
  const context = { result: null };
  vm.runInNewContext(`${update.replace("export function", "function")}
    ${printKey.replace("export function", "function")}
    result = { buildTransferDependencyUpdateRequest, transferDependencyPickingTicketJobKey };`, context);
  return context.result;
}

function verifyPatchOnly(source) {
  const helper = netSuiteHelpers(source);
  const request = helper.buildTransferDependencyUpdateRequest({
    transferOrderId: 42,
    payload: { item: { items: [{ item: { id: "1" }, quantity: 1 }] } }
  });
  assert.equal(request.method, "PATCH");
  assert.match(request.path, /\?replace=item$/);
}

function verifyPrintGeneration(source) {
  const helper = netSuiteHelpers(source);
  const first = helper.transferDependencyPickingTicketJobKey({ proposalId: 1, transferOrderRef: "TO1", generation: 1 });
  const second = helper.transferDependencyPickingTicketJobKey({ proposalId: 1, transferOrderRef: "TO1", generation: 2 });
  assert.notEqual(first, second);
}

function progressHelper(source) {
  const helper = source.match(/export function transferDependencyRevisionProgressBlock[\s\S]*?(?=\nfunction terminalTransferOrderStatus)/)?.[0] || "";
  assert(helper, "Progress mutation helper extraction drifted");
  const context = {
    EPSILON: 0.000001,
    number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.abs(parsed) : 0; },
    text(value) { return String(value ?? "").trim(); },
    result: null
  };
  vm.runInNewContext(`${helper.replace("export function", "function")}
    result = transferDependencyRevisionProgressBlock;`, context);
  return context.result;
}

function verifyProgressGate(source) {
  const block = progressHelper(source);
  assert.equal(block({ dependencyStatus: "active", loadedQuantity: 0 }), null);
  assert.match(block({ dependencyStatus: "active", loadedQuantity: 1 }), /started|loaded|packing|progress/i);
}

const mutants = [
  {
    name: "restore the global action lock",
    source: uiSource,
    from: 'const scope = String(options.scope || "global");',
    to: 'const scope = "global";',
    verify: verifyIndependentProposalActions
  },
  {
    name: "let a stale inventory response commit",
    source: uiSource,
    from: "if (requestVersion !== dependencyInventoryRequestVersion\n      || String(dependencyState.selectedSalesOrderId) !== String(selectedSalesOrderId)) {",
    to: "if (false && (requestVersion !== dependencyInventoryRequestVersion\n      || String(dependencyState.selectedSalesOrderId) !== String(selectedSalesOrderId))) {",
    verify: verifyNewestInventoryWins
  },
  {
    name: "limit search to the active tab",
    source: uiSource,
    from: 'const params = new URLSearchParams({ reviewStatus: search ? "all" : reviewStatus });',
    to: "const params = new URLSearchParams({ reviewStatus });",
    verify: verifyGlobalSearch
  },
  {
    name: "POST a replacement TO instead of PATCHing",
    source: netSuiteSource,
    from: 'method: "PATCH",',
    to: 'method: "POST",',
    verify: verifyPatchOnly
  },
  {
    name: "allow progress when one progress field is zero",
    source: repositorySource,
    from: "if (progressFields.some((field) => number(state[field]) > EPSILON)) {",
    to: "if (progressFields.every((field) => number(state[field]) > EPSILON)) {",
    verify: verifyProgressGate
  },
  {
    name: "reuse one immutable key for every reprint",
    source: netSuiteSource,
    from: "return `transfer-dependency:${proposal}:picking-ticket:${orderRef}:${printGeneration}`;",
    to: "return `transfer-dependency:${proposal}:picking-ticket:${orderRef}`;",
    verify: verifyPrintGeneration
  }
];

let killed = 0;
for (const mutant of mutants) {
  const source = replaceOnce(mutant.source, mutant.from, mutant.to, mutant.name);
  let detected = false;
  try {
    await mutant.verify(source);
  } catch {
    detected = true;
  }
  assert(detected, `Mutation survived: ${mutant.name}`);
  killed += 1;
}

assert.equal(killed, mutants.length);
console.log(`SCM transfer workflow mutation harness passed: ${killed}/${mutants.length} mutants killed.`);
