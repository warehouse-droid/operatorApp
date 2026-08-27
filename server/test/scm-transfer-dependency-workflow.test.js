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
const dependencySource = fs.readFileSync(
  new URL("../src/order-dependency-repository.js", import.meta.url),
  "utf8"
);

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

test("Auto Transfer creates without a status override and does not request a print", () => {
  const payload = transferDependencyNetSuite.buildTransferDependencyRestPayload({
    proposal: {
      id: 937,
      memo: "Auto approval fixture",
      palletItemId: 1784,
      palletTransferQuantity: 1,
      lines: [{
        itemId: 1363,
        itemName: "Fixture item",
        proposedQuantity: 108,
        palletQty: 1,
        layerQty: 0,
        sectionQty: 0,
        pieceQty: 0
      }]
    },
    batch: { id: 42, salesOrderRef: "SO-AUTO-APPROVE" },
    locations: {
      source: { netsuiteLocationId: 15, subsidiaryId: 1 },
      destination: { netsuiteLocationId: 1, subsidiaryId: 1 },
      intercompany: false
    }
  });

  assert.equal(Object.hasOwn(payload, "orderStatus"), false,
    "NetSuite production rejects orderStatus B during the create POST");
  assert.equal(Object.keys(payload).some((key) => /print/i.test(key)), false,
    "the create request must not trigger or describe a print side effect");
});

test("Auto Transfer wires a separate approval PATCH after the status-free create POST", () => {
  const input = {
    proposal: {
      id: 938,
      memo: "Scoped auto approval fixture",
      palletTransferQuantity: 0,
      lines: [{ itemId: 1363, itemName: "Fixture item", proposedQuantity: 1 }]
    },
    batch: { id: 43, salesOrderRef: "SO-SCOPED-AUTO-APPROVE" },
    locations: {
      source: { netsuiteLocationId: 15, subsidiaryId: 1 },
      destination: { netsuiteLocationId: 1, subsidiaryId: 1 },
      intercompany: false
    }
  };

  const autoTransferBuilder = serverSource.match(
    /async function transferDependencyRestPayload\([\s\S]*?\n\}/u
  )?.[0] || "";
  assert.doesNotMatch(autoTransferBuilder, /autoApprove|orderStatus/u,
    "the Auto Transfer create payload must not include a NetSuite status override");
  const confirmRoute = serverSource.match(
    /app\.post\("\/api\/scm\/transfer-dependencies\/batches\/:id\/proposals\/:proposalId\/confirm"[\s\S]*?\n\}\);/u
  )?.[0] || "";
  assert.match(confirmRoute, /approveTransferOrder:\s*async/u,
    "the Auto Transfer confirm route must inject a distinct approval operation");
  assert.match(confirmRoute, /updateTransferOrderStatusInNetSuite/u,
    "the distinct approval operation must PATCH the created NetSuite TO");
  assert.match(confirmRoute, /statusId:\s*"B"/u,
    "the approval PATCH must request NetSuite Pending Fulfillment");
});

test("two-stage approval persists identity before PATCH and verifies afterward", async () => {
  assert.equal(
    typeof dependencyRepository.ensureTransferDependencyPendingFulfillment,
    "function",
    "the remote two-stage workflow must be independently executable"
  );
  const calls = [];
  let hydration = 0;
  const result = await dependencyRepository.ensureTransferDependencyPendingFulfillment({
    created: { id: 4567 },
    proposal: { id: 937 },
    hydrateTransferOrder: async () => {
      hydration += 1;
      calls.push(`hydrate:${hydration}`);
      return hydration === 1
        ? { id: 4567, tranid: "TOB01003", pendingFulfillment: false, status: "A" }
        : { id: 4567, tranid: "TOB01003", pendingFulfillment: true, status: "B" };
    },
    rememberTransferOrder: async (order) => calls.push(`remember:${order.tranid}`),
    approveTransferOrder: async ({ transferOrderId }) => calls.push(`approve:${transferOrderId}`)
  });
  assert.deepEqual(calls, ["hydrate:1", "remember:TOB01003", "approve:4567", "hydrate:2"]);
  assert.equal(result.pendingFulfillment, true);
});

test("two-stage approval is idempotent when retry hydration finds Pending Fulfillment", async () => {
  let approvals = 0;
  const result = await dependencyRepository.ensureTransferDependencyPendingFulfillment({
    created: { id: 4568, recovered: true },
    proposal: { id: 938 },
    hydrateTransferOrder: async () => ({
      id: 4568,
      tranid: "TOB01004",
      pendingFulfillment: true,
      status: "B"
    }),
    rememberTransferOrder: async () => {},
    approveTransferOrder: async () => { approvals += 1; }
  });
  assert.equal(approvals, 0, "an already-approved recovered TO must never be PATCHed again");
  assert.equal(result.pendingFulfillment, true);
});

test("an ambiguous approval error is recovered by reading the same remote TO", async () => {
  const patchError = new Error("PATCH response timed out");
  let hydration = 0;
  const result = await dependencyRepository.ensureTransferDependencyPendingFulfillment({
    created: { id: 4569 },
    proposal: { id: 939 },
    hydrateTransferOrder: async () => {
      hydration += 1;
      return {
        id: 4569,
        tranid: "TOB01005",
        pendingFulfillment: hydration > 1,
        status: hydration > 1 ? "B" : "A"
      };
    },
    rememberTransferOrder: async () => {},
    approveTransferOrder: async () => { throw patchError; }
  });
  assert.equal(result.pendingFulfillment, true);
  assert.equal(hydration, 2, "the workflow must reconcile an ambiguous PATCH with a fresh read");
});

test("a confirmed approval failure retains the original error after reconciliation", async () => {
  const patchError = new Error("NetSuite rejected approval");
  let hydration = 0;
  await assert.rejects(
    dependencyRepository.ensureTransferDependencyPendingFulfillment({
      created: { id: 4570 },
      proposal: { id: 940 },
      hydrateTransferOrder: async () => {
        hydration += 1;
        return { id: 4570, tranid: "TOB01006", pendingFulfillment: false, status: "A" };
      },
      rememberTransferOrder: async () => {},
      approveTransferOrder: async () => { throw patchError; }
    }),
    (error) => error === patchError
  );
  assert.equal(hydration, 2, "a failed PATCH must be reconciled once before reporting failure");
});

test("two-stage approval keeps at-most-one PATCH across remote outcome combinations", async () => {
  for (const initiallyApproved of [false, true]) {
    for (const patchThrows of [false, true]) {
      for (const approvedAfterPatch of [false, true]) {
        let approvals = 0;
        let hydrations = 0;
        let remembered = 0;
        const patchError = new Error("property PATCH failure");
        const run = dependencyRepository.ensureTransferDependencyPendingFulfillment({
          created: { id: 4600 },
          proposal: { id: 950 },
          hydrateTransferOrder: async () => {
            hydrations += 1;
            return {
              id: 4600,
              tranid: "TOB01010",
              pendingFulfillment: initiallyApproved || (hydrations > 1 && approvedAfterPatch),
              status: initiallyApproved || (hydrations > 1 && approvedAfterPatch) ? "B" : "A"
            };
          },
          rememberTransferOrder: async () => { remembered += 1; },
          approveTransferOrder: async () => {
            approvals += 1;
            if (patchThrows) throw patchError;
          }
        });
        const shouldReject = !initiallyApproved && patchThrows && !approvedAfterPatch;
        if (shouldReject) await assert.rejects(run, (error) => error === patchError);
        else await run;
        assert.equal(remembered, 1, "every discovered identity must be durably remembered once");
        assert.equal(approvals, initiallyApproved ? 0 : 1, "a remote identity may be PATCHed at most once per attempt");
        assert.equal(hydrations, initiallyApproved ? 1 : 2, "approval must be decided from authoritative reads");
      }
    }
  }
});

test("repository retains a discovered remote identity before approval and on failure", () => {
  const confirmation = dependencySource.match(
    /export async function confirmTransferDependencyBatch[\s\S]*?export async function retryTransferDependencyBatch/u
  )?.[0] || "";
  assert.match(confirmation, /rememberTransferOrder:\s*async[\s\S]*?netsuite_transfer_order_id\s*=\s*\$2/u);
  assert.match(confirmation, /approval_status\s*=\s*'approving'/u);
  assert.match(confirmation, /netsuite_transfer_order_ref\s*=\s*COALESCE\(netsuite_transfer_order_ref,\s*\$5\)/u);
  assert.match(confirmation, /WHEN \$4::bigint IS NOT NULL THEN 'failed'/u,
    "a known remote TO must remain recoverable when approval does not complete");
});

test("two-stage approval rejects invalid identities, transports, and failed verification reads", async () => {
  const validOrder = { id: 4700, tranid: "TOB01020", pendingFulfillment: false, status: "A" };
  for (const created of [undefined, {}, { id: 0 }, { id: 1.5 }]) {
    await assert.rejects(
      dependencyRepository.ensureTransferDependencyPendingFulfillment({ created }),
      /created Transfer Order ID/i
    );
  }
  await assert.rejects(
    dependencyRepository.ensureTransferDependencyPendingFulfillment({ created: { id: 4700 } }),
    /recovery transport/i
  );
  await assert.rejects(
    dependencyRepository.ensureTransferDependencyPendingFulfillment({
      created: { id: 4700 },
      hydrateTransferOrder: async () => validOrder
    }),
    /recovery transport/i
  );
  for (const invalidOrder of [null, { ...validOrder, id: 4701 }, { ...validOrder, tranid: null }, { ...validOrder, tranid: "   " }]) {
    await assert.rejects(
      dependencyRepository.ensureTransferDependencyPendingFulfillment({
        created: { id: 4700 },
        hydrateTransferOrder: async () => invalidOrder,
        rememberTransferOrder: async () => {}
      }),
      /could not be synchronized/i
    );
  }
  await assert.rejects(
    dependencyRepository.ensureTransferDependencyPendingFulfillment({
      created: { id: 4700 },
      hydrateTransferOrder: async () => validOrder,
      rememberTransferOrder: async () => {}
    }),
    /approval transport/i
  );

  const verificationError = new Error("verification read failed");
  let hydration = 0;
  await assert.rejects(
    dependencyRepository.ensureTransferDependencyPendingFulfillment({
      created: { id: 4700 },
      hydrateTransferOrder: async () => {
        hydration += 1;
        if (hydration > 1) throw verificationError;
        return validOrder;
      },
      rememberTransferOrder: async () => {},
      approveTransferOrder: async () => {}
    }),
    (error) => error === verificationError
  );

  const approvalError = new Error("approval response failed");
  hydration = 0;
  await assert.rejects(
    dependencyRepository.ensureTransferDependencyPendingFulfillment({
      created: { id: 4700 },
      hydrateTransferOrder: async () => {
        hydration += 1;
        if (hydration > 1) throw verificationError;
        return validOrder;
      },
      rememberTransferOrder: async () => {},
      approveTransferOrder: async () => { throw approvalError; }
    }),
    (error) => error === approvalError
  );
});

test("only confirmed Pending Fulfillment becomes locally approved and pending user print", () => {
  assert.equal(typeof dependencyRepository.transferDependencyCreationOutcome, "function");
  assert.deepEqual(dependencyRepository.transferDependencyCreationOutcome({
    tranid: "TOB01000",
    status: "B",
    statusText: "Transfer Order : Pending Fulfillment",
    pendingFulfillment: true
  }), {
    pendingFulfillment: true,
    creationStatus: "created",
    approvalStatus: "approved",
    printStatus: "pending_user_print",
    statusMessage: null
  });
  assert.deepEqual(dependencyRepository.transferDependencyCreationOutcome({
    tranid: "TOB01001",
    status: "A",
    statusText: "Transfer Order : Pending Approval",
    pendingFulfillment: false
  }), {
    pendingFulfillment: false,
    creationStatus: "attention",
    approvalStatus: "failed",
    printStatus: "blocked",
    statusMessage: "TOB01001 was created, but NetSuite status is Transfer Order : Pending Approval instead of Pending Fulfillment."
  });
  assert.equal(
    dependencyRepository.transferDependencyCreationOutcome({
      tranid: "TOB01002",
      status: "A",
      pendingFulfillment: false
    }).statusMessage,
    "TOB01002 was created, but NetSuite status is A instead of Pending Fulfillment."
  );
  assert.equal(
    dependencyRepository.transferDependencyCreationOutcome({}).statusMessage,
    "Transfer Order was created, but NetSuite status is unknown instead of Pending Fulfillment."
  );
});

test("print readiness failures never downgrade an approval that NetSuite already confirmed", () => {
  assert.equal(typeof dependencyRepository.transferDependencyApprovalStatusAfterPrintBlock, "function");
  assert.equal(
    dependencyRepository.transferDependencyApprovalStatusAfterPrintBlock("approved", "failed"),
    "approved",
    "quantity verification can block print but cannot undo confirmed NetSuite approval"
  );
  assert.equal(
    dependencyRepository.transferDependencyApprovalStatusAfterPrintBlock("approved", "pending"),
    "approved",
    "missing print configuration can block print but cannot undo confirmed NetSuite approval"
  );
  assert.equal(
    dependencyRepository.transferDependencyApprovalStatusAfterPrintBlock("pending", "failed"),
    "failed",
    "legacy pending-approval proposals retain their existing failure behavior"
  );
  assert.equal(
    dependencyRepository.transferDependencyApprovalStatusAfterPrintBlock(undefined, "pending"),
    "pending"
  );
  assert.match(serverSource, /transferDependencyApprovalStatusAfterPrintBlock\(\s*proposal\.approvalStatus,\s*"failed"\s*\)/u);
  assert.match(serverSource, /transferDependencyApprovalStatusAfterPrintBlock\(\s*proposal\.approvalStatus,\s*"pending"\s*\)/u);
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

test("an auto-approved unprinted TO is visibly pending user print and exposes a print-only action", () => {
  const ui = loadDependencyUi();
  const markup = ui.renderProposal({
    id: 89,
    mode: "yard_replenishment",
    fromLocationId: 15,
    fromLocation: "12441",
    toLocationId: 1,
    toLocation: "3445",
    creationStatus: "created",
    transferOrderId: 4568,
    transferOrderRef: "TOB01000",
    revision: 1,
    palletCalculationComplete: true,
    palletQuantityOverridden: false,
    palletTransferQuantity: 1,
    calculatedPalletQuantity: 1,
    quantityVerificationStatus: "pending",
    approvalStatus: "approved",
    printJob: null,
    lines: []
  });

  assert.match(markup, /Pending user print/i);
  const printButton = markup.match(/<button[^>]*data-action="approve-print"[^>]*>[\s\S]*?<\/button>/u)?.[0] || "";
  const printButtonLabel = printButton.replace(/<[^>]+>/gu, "");
  assert.match(printButton, /Print Source-yard Ticket/i);
  assert.doesNotMatch(printButtonLabel, /Approve/i,
    "an already approved TO must never ask the user to approve it again");
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
