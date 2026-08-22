import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import * as dependencyRepository from "../src/order-dependency-repository.js";
import * as transferDependencyNetSuite from "../src/transfer-dependency-netsuite.js";

const publicSource = fs.readFileSync(
  new URL("../public/scm-transfer-dependencies.js", import.meta.url),
  "utf8"
);
const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadDependencyUi() {
  const listeners = new Map();
  const app = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    innerHTML: ""
  };
  const document = {
    getElementById(id) {
      return id === "scmDependencyApp" ? app : null;
    },
    addEventListener() {},
    visibilityState: "visible"
  };
  const context = vm.createContext({
    AbortController,
    console,
    document,
    EventSource: class {
      addEventListener() {}
      close() {}
    },
    fetch: async () => {
      throw new Error("Unexpected real fetch in UI harness.");
    },
    Intl,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    crypto: { randomUUID: () => "workflow-test-request" },
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
  vm.runInContext(`${publicSource}
    renderDependencyPage = () => {};
    globalThis.__workflowTest = {
      dependencyState,
      depCandidateQuery,
      loadDependencyCandidates,
      loadSelectedDependencyInventory,
      renderProposal,
      runDependencyAction,
      setApi(fn) { depApi = fn; }
    };`, context);
  return { ...context.__workflowTest, listeners };
}

test("two proposal actions in one Sales Order run independently", async () => {
  const ui = loadDependencyUi();
  const first = deferred();
  let firstStarted = false;
  let secondStarted = false;

  const firstRun = ui.runDependencyAction("Creating first TO...", async () => {
    firstStarted = true;
    await first.promise;
  }, { scope: "proposal:101" });
  await Promise.resolve();
  const secondRun = ui.runDependencyAction("Creating second TO...", async () => {
    secondStarted = true;
  }, { scope: "proposal:102" });
  await Promise.resolve();

  assert.equal(firstStarted, true);
  assert.equal(secondStarted, true, "a global busy flag must not silently discard a sibling proposal action");
  first.resolve();
  await Promise.all([firstRun, secondRun]);
});

test("an older inventory response cannot overwrite a newer Sales Order selection", async () => {
  const ui = loadDependencyUi();
  const orderA = deferred();
  const orderB = deferred();
  ui.dependencyState.reviewStatus = "created";
  ui.dependencyState.candidates = [
    { salesOrderId: 1001, salesOrderRef: "SO-A" },
    { salesOrderId: 1002, salesOrderRef: "SO-B" }
  ];
  ui.setApi((path) => {
    if (path.includes("/1001/inventory")) return orderA.promise;
    if (path.includes("/1002/inventory")) return orderB.promise;
    throw new Error(`Unexpected path ${path}`);
  });

  ui.dependencyState.selectedSalesOrderId = 1001;
  const olderLoad = ui.loadSelectedDependencyInventory({ refreshUndercovered: false });
  ui.dependencyState.selectedSalesOrderId = 1002;
  const newerLoad = ui.loadSelectedDependencyInventory({ refreshUndercovered: false });
  orderB.resolve({ salesOrderId: 1002, marker: "B" });
  await newerLoad;
  orderA.resolve({ salesOrderId: 1001, marker: "A" });
  await olderLoad;

  assert.equal(ui.dependencyState.selectedSalesOrderId, 1002);
  assert.equal(ui.dependencyState.inventory?.marker, "B", "only the newest selection request may commit UI state");
});

test("an older tab response cannot overwrite the newest tab", async () => {
  const ui = loadDependencyUi();
  const created = deferred();
  const open = deferred();
  ui.setApi((path) => {
    if (path.includes("reviewStatus=created")) return created.promise;
    if (path.includes("reviewStatus=open")) return open.promise;
    if (path.includes("/inventory")) return Promise.resolve({ marker: "inventory" });
    throw new Error(`Unexpected path ${path}`);
  });

  ui.dependencyState.reviewStatus = "created";
  const olderLoad = ui.loadDependencyCandidates({ preserveSelection: false, refreshInventory: false });
  ui.dependencyState.reviewStatus = "open";
  const newerLoad = ui.loadDependencyCandidates({ preserveSelection: false, refreshInventory: false });
  open.resolve([{ salesOrderId: 2002, salesOrderRef: "SO-OPEN", workflowStage: "open" }]);
  await newerLoad;
  created.resolve([{ salesOrderId: 2001, salesOrderRef: "SO-CREATED", workflowStage: "created" }]);
  await olderLoad;

  assert.equal(ui.dependencyState.reviewStatus, "open");
  assert.deepEqual(
    Array.from(ui.dependencyState.candidates, (candidate) => candidate.salesOrderRef),
    ["SO-OPEN"],
    "a stale Created response must not replace the newer Open response"
  );
});

test("search requests all workflow stages", () => {
  const ui = loadDependencyUi();
  ui.dependencyState.reviewStatus = "open";
  ui.dependencyState.search = "SOM05433";
  const query = new URLSearchParams(ui.depCandidateQuery().slice(1));
  assert.equal(query.get("reviewStatus"), "all", "search must span Open, Created, and Completed");
  assert.equal(query.get("search"), "SOM05433");
});

test("selecting a cross-tab search result adopts that result's workflow tab", async () => {
  const ui = loadDependencyUi();
  ui.dependencyState.reviewStatus = "open";
  ui.dependencyState.search = "TOB00999";
  ui.dependencyState.candidates = [{
    salesOrderId: 2999,
    salesOrderRef: "SO-CREATED-SEARCH",
    workflowStage: "created"
  }];
  ui.setApi(async (path) => {
    if (path.includes("/2999/inventory")) return { salesOrderId: 2999 };
    throw new Error(`Unexpected path ${path}`);
  });
  const actionTarget = {
    dataset: { action: "select-order", orderId: "2999" },
    closest(selector) {
      return selector === "[data-action]" ? this : null;
    }
  };
  await ui.listeners.get("click")({ target: actionTarget });
  assert.equal(ui.dependencyState.selectedSalesOrderId, "2999");
  assert.equal(ui.dependencyState.reviewStatus, "created");
});

test("Open and all-stage results use latest meaningful activity with deterministic tie breaks", () => {
  assert.equal(
    typeof dependencyRepository.sortTransferDependencyCandidatesByLatestActivity,
    "function",
    "the repository must expose the shared latest-activity ordering policy"
  );
  const sorted = dependencyRepository.sortTransferDependencyCandidatesByLatestActivity([
    { salesOrderId: 3001, salesOrderRef: "SO-OLD", latestActivityAt: "2026-08-01T10:00:00.000Z" },
    { salesOrderId: 3002, salesOrderRef: "SO-TIE-B", latestActivityAt: "2026-08-02T10:00:00.000Z" },
    { salesOrderId: 3003, salesOrderRef: "SO-TIE-A", latestActivityAt: "2026-08-02T10:00:00.000Z" }
  ]);
  assert.deepEqual(sorted.map((order) => order.salesOrderRef), ["SO-TIE-A", "SO-TIE-B", "SO-OLD"]);
});

test("cached Open listing does not await the broad NetSuite refresh", () => {
  const route = serverSource.match(
    /app\.get\("\/api\/scm\/transfer-dependencies\/candidates"[\s\S]*?\n\}\);/
  )?.[0] || "";
  assert(route, "candidate route must remain present");
  assert.doesNotMatch(
    route,
    /await refreshTransferDependencySalesOrderAllocations\(\)/,
    "Open listing must return cached rows before a broad NetSuite refresh completes"
  );
  assert.match(route, /scheduleTransferDependencyAllocationRefresh/, "Open listing must schedule background freshness work");
});

test("created quantity revisions are gated by execution progress", () => {
  assert.equal(
    typeof dependencyRepository.transferDependencyRevisionProgressBlock,
    "function",
    "created quantity updates need one explicit progress gate"
  );
  assert.equal(dependencyRepository.transferDependencyRevisionProgressBlock({
    dependencyStatus: "active",
    loadedQuantity: 0,
    deliveredQuantity: 0,
    locallyReceivedQuantity: 0,
    transferPackedQuantity: 0,
    transferFulfilledQuantity: 0,
    transferReceivedQuantity: 0
  }), null);
  assert.match(dependencyRepository.transferDependencyRevisionProgressBlock({
    dependencyStatus: "loaded",
    loadedQuantity: 1
  }), /started|loaded/i);
});

test("a created revision targets the existing NetSuite TO with PATCH and item replacement", () => {
  assert.equal(
    typeof transferDependencyNetSuite.buildTransferDependencyUpdateRequest,
    "function",
    "the NetSuite update request builder must be executable and testable"
  );
  const request = transferDependencyNetSuite.buildTransferDependencyUpdateRequest({
    transferOrderId: 4567,
    intercompany: false,
    payload: { item: { items: [{ item: { id: "11" }, quantity: 4 }] } }
  });
  assert.equal(request.method, "PATCH");
  assert.equal(request.path, "/record/v1/transferOrder/4567?replace=item");
  assert.equal(request.payload.item.items[0].quantity, 4);
});

test("remote Transfer Order execution status blocks quantity PATCH before mutation", () => {
  assert.equal(
    typeof transferDependencyNetSuite.transferOrderQuantityRevisionStatusBlock,
    "function",
    "remote status needs an explicit pre-PATCH execution gate"
  );
  assert.equal(transferDependencyNetSuite.transferOrderQuantityRevisionStatusBlock({
    status: "B",
    status_text: "Transfer Order : Pending Fulfillment"
  }), null);
  assert.match(transferDependencyNetSuite.transferOrderQuantityRevisionStatusBlock({
    status: "D",
    status_text: "Transfer Order : Partially Fulfilled"
  }), /partially fulfilled|started/i);
});

test("each deliberate reprint has a new immutable picking-ticket key", () => {
  assert.equal(
    typeof transferDependencyNetSuite.transferDependencyPickingTicketJobKey,
    "function",
    "reprint identity must be deterministic and independently testable"
  );
  const first = transferDependencyNetSuite.transferDependencyPickingTicketJobKey({
    proposalId: 88,
    transferOrderRef: "TOB00999",
    generation: 1
  });
  const reprint = transferDependencyNetSuite.transferDependencyPickingTicketJobKey({
    proposalId: 88,
    transferOrderRef: "TOB00999",
    generation: 2
  });
  assert.notEqual(first, reprint);
  assert.match(reprint, /:2$/);
});

test("created and printed cards remain quantity-editable and expose reprint", () => {
  const ui = loadDependencyUi();
  const markup = ui.renderProposal({
    id: 88,
    mode: "yard_replenishment",
    fromLocationId: 1,
    fromLocation: "3445",
    toLocationId: 15,
    toLocation: "12441",
    creationStatus: "created",
    transferOrderId: 4567,
    transferOrderRef: "TOB00999",
    revision: 3,
    palletCalculationComplete: true,
    palletQuantityOverridden: false,
    palletTransferQuantity: 1,
    calculatedPalletQuantity: 1,
    approvalStatus: "approved",
    printJob: { id: 99, status: "printed" },
    lines: [{
      id: 7,
      salesLineId: 70,
      itemId: 11,
      itemName: "Fixture Item",
      sku: "FIXTURE",
      unit: "PC",
      proposedQuantity: 4,
      quantities: { pallets: 4, layers: 0, sections: 0, pieces: 0, salesQty: 0 },
      conversions: { pallets: 1, layers: 0, sections: 0, pieces: 1 }
    }]
  });
  assert.match(markup, /data-action="save-created-proposal"/, "created quantity changes need an explicit revision action");
  assert.match(markup, /data-action="approve-print"[^>]*>[\s\S]*Reprint/, "a printed TO must expose reprint");
  const lineInput = markup.match(/<input[^>]*data-proposal-unit="pallets"[^>]*>/)?.[0] || "";
  assert(lineInput && !/\bdisabled\b/.test(lineInput), "created material quantities must remain editable before execution starts");
});

test("draft proposals expose an explicit source-stock backorder control that defaults off", () => {
  const ui = loadDependencyUi();
  const base = {
    id: 937,
    mode: "yard_replenishment",
    fromLocationId: 15,
    fromLocation: "12441",
    toLocationId: 1,
    toLocation: "3445",
    creationStatus: "draft",
    palletCalculationComplete: true,
    palletQuantityOverridden: false,
    palletTransferQuantity: 1,
    calculatedPalletQuantity: 1,
    palletItemId: 1784,
    palletItemName: "PALLET",
    lines: [{
      id: 1117,
      salesLineId: 272392,
      itemId: 1363,
      itemName: "UNI-UCARA-ST-STDB",
      sku: "UNI-UCARA-ST-STDB",
      unit: "PC",
      proposedQuantity: 108,
      quantities: { pallets: 1, layers: 0, sections: 0, pieces: 0, salesQty: 0 },
      conversions: { pallets: 108, layers: 0, sections: 0, pieces: 1 }
    }]
  };
  const protectedMarkup = ui.renderProposal({ ...base, allowSourceBackorder: false });
  const protectedInput = protectedMarkup.match(/<input[^>]*data-proposal-field="allowSourceBackorder"[^>]*>/u)?.[0] || "";
  assert(protectedInput, "every editable draft needs the explicit source-backorder control");
  assert.doesNotMatch(protectedInput, /\bchecked\b/u, "new proposals must remain protected by default");

  const allowedMarkup = ui.renderProposal({ ...base, allowSourceBackorder: true });
  const allowedInput = allowedMarkup.match(/<input[^>]*data-proposal-field="allowSourceBackorder"[^>]*>/u)?.[0] || "";
  assert.match(allowedInput, /\bchecked\b/u);
  assert.match(allowedMarkup, /source stock backorder/i);
  ui.dependencyState.inventory = {
    items: [
      { itemId: 1363, balances: [{ locationId: 15, quantityAvailable: 171, effectiveAvailable: 171 }] },
      { itemId: 1784, balances: [{ locationId: 15, quantityAvailable: 0, effectiveAvailable: 0 }] }
    ]
  };
  const shortageMarkup = ui.renderProposal({ ...base, allowSourceBackorder: true });
  assert.match(shortageMarkup, /PALLET:\s*1 requested[^;]*0 available[^;]*1 backorder/iu,
    "the enabled proposal must disclose its current automatic PALLET shortfall");
  assert.match(publicSource, /allowSourceBackorder:\s*card\.querySelector/u,
    "Save Draft and Confirm must send the explicit setting to the server");
});

test("source-stock backorder persistence is migration-backed and audited", () => {
  const migration = fs.readFileSync(
    new URL("../migrations/170_transfer_dependency_source_backorder.sql", import.meta.url),
    "utf8"
  );
  const repository = fs.readFileSync(
    new URL("../src/order-dependency-repository.js", import.meta.url),
    "utf8"
  );
  assert.match(migration, /allow_source_backorder\s+boolean\s+NOT NULL\s+DEFAULT false/iu);
  assert.match(repository, /allowSourceBackorder:\s*proposal\.allow_source_backorder\s*===\s*true/u);
  assert.match(repository, /scm\.transfer_dependency\.source_backorder_updated/u);
  const creationAudit = repository.slice(
    repository.indexOf('action: "scm.transfer_dependency.created"'),
    repository.indexOf("return {", repository.indexOf('action: "scm.transfer_dependency.created"'))
  );
  assert.match(creationAudit, /sourceBackorders:\s*validation\.sourceBackorders/u,
    "the immutable creation audit must retain the exact authorized source shortfall");
});

test("source-stock backorder validation keeps one bulk inventory query", () => {
  const repository = fs.readFileSync(
    new URL("../src/order-dependency-repository.js", import.meta.url),
    "utf8"
  );
  const validation = repository.slice(
    repository.indexOf("export async function validateTransferDependencyBatchForCreation"),
    repository.indexOf("async function transferLinesForOrder")
  );
  assert(validation, "the creation validator must remain present");
  assert.equal(
    validation.match(/await query\(/gu)?.length || 0,
    1,
    "source-backorder checks must reuse one set-based inventory query, never query once per item or proposal"
  );
});
