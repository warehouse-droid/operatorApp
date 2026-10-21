import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import fc from "fast-check";
import { smartScmLineKey, smartScmOrderedLines, validateSmartScmLineOrder,
  smartScmOrderedPayload, smartScmNetSuiteLineSequence } from "../../../src/smart-scm-line-order.js";
import { buildSmartScmPurchaseOrderRestPayload } from "../../../src/smart-scm-purchase-netsuite.js";
import { buildTransferDependencyRestPayload, smartScmTransferOrderMemoMarker } from "../../../src/transfer-dependency-netsuite.js";
import { projectSmartScmCreatedPo } from "../../../src/smart-scm-created-po.js";

const materials = [1, 2, 3].map((id) => ({ id, itemId: 100 + id, itemName: `Material ${id}`,
  destinationLocationId: 1, destinationName: "3445", salesQuantity: 10 * id,
  confirmedPallets: id, palletQty: id, proposedQuantity: 10 * id,
  unit: "EACH", purchaseUnit: "EACH", lastPurchasePrice: 5 }));
const pallet = { ancillaryPallet: true, destinationLocationId: 1, itemId: 1784, purchaseQuantity: 6 };
const chosen = ["line:1", "line:2", "pallet:1", "line:3"];
const locations = [{ localLocationId: 1, netsuiteLocationId: 1, subsidiaryId: 2 }];
const palletItem = { id: 1784, itemName: "PALLET", unit: "EACH", purchaseUnit: "EACH", lastPurchasePrice: 35 };

test("PALLET can be third without changing line objects", () => {
  const input = [...materials, pallet];
  assert.deepEqual(smartScmOrderedLines(input, chosen), [materials[0], materials[1], pallet, materials[2]]);
  assert.deepEqual(input, [...materials, pallet]);
  assert.deepEqual(validateSmartScmLineOrder(chosen, input), chosen);
});

test("invalid permutations reject missing, duplicate, foreign, malformed and excessive keys", () => {
  for (const invalid of [null, {}, ["line:1"], [...chosen, "line:9"],
    ["line:1", "line:1", "pallet:1", "line:3"], [1, 2, 3, 4], Array(10001).fill("line:1")]) {
    assert.throws(() => validateSmartScmLineOrder(invalid, [...materials, pallet]), (error) => error.status === 400);
  }
});

test("NetSuite payload interleaves PALLET third while preserving all fields", () => {
  const proposal = { id: 10, vendorId: 20, destinationLocationId: 1, lines: materials,
    palletLines: [pallet], palletItem, lineOrder: chosen };
  const legacy = buildSmartScmPurchaseOrderRestPayload({ proposal: { ...proposal, lineOrder: [] }, locations });
  const result = buildSmartScmPurchaseOrderRestPayload({ proposal, locations });
  assert.deepEqual(result.item.items, [legacy.item.items[0], legacy.item.items[1], legacy.item.items[3], legacy.item.items[2]]);
});

test("TO payload interleaves PALLET and preserves dependency transfer defaults", () => {
  const input = { proposal: { lines: materials, palletItemId: 1784, palletTransferQuantity: 6,
    destinationLocationId: 1, lineOrder: chosen }, batch: { id: 10 },
    locations: { source: { netsuiteLocationId: 28, subsidiaryId: 2 }, destination: { netsuiteLocationId: 1 } } };
  const legacy = buildTransferDependencyRestPayload({ ...input, proposal: { ...input.proposal, lineOrder: [] } });
  assert.deepEqual(buildTransferDependencyRestPayload(input).item.items,
    [legacy.item.items[0], legacy.item.items[1], legacy.item.items[3], legacy.item.items[2]]);
});

test("actual TO execution passes the saved order into the NetSuite request", async () => {
  const source = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
  const start = source.indexOf("async function executeSmartScmTransferProposal(proposalId, operator) {");
  const end = source.indexOf("async function retrySmartScmTransferPrint(proposalId, operator) {", start);
  assert.ok(start > 0 && end > start);
  // Preserve offsets for coverage while isolating this real function from server startup.
  const blank = (text) => text.replace(/[^\r\n]/g, " ");
  const isolated = blank(source.slice(0, start)) + source.slice(start, end) + blank(source.slice(end));
  const prepared = { id: 10, runId: 1, mode: "live", sourceLocationId: 28, sourceName: "2967",
    destinationLocationId: 1, destinationName: "3445", lines: materials,
    palletTransferQuantity: 6, lineOrder: chosen };
  const failure = new Error("test NetSuite boundary: request captured without writing");
  let request;
  let failedProposal;
  const context = vm.createContext({
    prepareSmartScmTransferExecution: async () => prepared,
    listYardPrinters: async () => [{ locationId: 28, transferOrderReady: true }],
    config: { smartScm: { liveExecutionEnabled: true } },
    resolveNetSuiteTransferLocations: async () => ({ source: { netsuiteLocationId: 28, subsidiaryId: 2 },
      destination: { netsuiteLocationId: 1 }, intercompany: false }),
    resolvePalletItemFromNetSuite: async () => ({ id: 1784 }),
    recoverSmartScmTransferOrder: async () => null,
    buildTransferDependencyRestPayload,
    smartScmTransferOrderMemoMarker,
    createTransferOrderInNetSuite: async (payload) => { request = payload; throw failure; },
    failSmartScmTransferExecution: async (id, error, operatorId) => { failedProposal = { id, error, operatorId }; }
  });
  new vm.Script(isolated, { filename: "/app/test-artifacts/scm-line-order/server-transfer-boundary.vm.js" }).runInContext(context);
  await assert.rejects(context.executeSmartScmTransferProposal(10, { id: 7 }), (error) => error === failure);
  assert.deepEqual(request.item.items.map((line) => [line.item.id, line.quantity]),
    [["101", 10], ["102", 20], ["1784", 6], ["103", 30]]);
  assert.equal(request.memo, "MBBS-SCM:10");
  assert.deepEqual(failedProposal, { id: 10, error: failure, operatorId: 7 });
});

test("synced NetSuite sequence takes precedence over permanent IDs and interleaves PALLET", () => {
  const rows = [
    { line_id: 999, item_id: 101, item_name: "A", raw: { line_sequence_number: 1 } },
    { line_id: 5, item_id: 103, item_name: "C", raw: { line_sequence_number: 4 } },
    { line_id: 1, item_id: 1784, item_name: "PALLET", raw: { line_sequence_number: 3 } },
    { line_id: 10, item_id: 102, item_name: "B", raw: { line_sequence_number: 2 } }
  ].map((row) => ({ ...row, location_id: 1, quantity: 6, unit: "EACH", rate: 5, amount: 30, item_weight: 2 }));
  const current = { header: { vendor: "Vendor" }, lines: rows };
  const result = projectSmartScmCreatedPo({ lines: [], physicalPalletLines: [] }, current);
  const display = smartScmOrderedLines([...result.lines, ...result.physicalPalletLines], result.lineOrder);
  assert.deepEqual(display.map((line) => line.itemName), ["A", "B", "PALLET", "C"]);
  assert.deepEqual(result.lineOrder, ["line:netsuite-po-line:999", "line:netsuite-po-line:10", "line:netsuite-po-line:1", "line:netsuite-po-line:5"]);
});

test("NetSuite sequence accepts persisted aliases and refuses invalid numbers", () => {
  assert.equal(smartScmNetSuiteLineSequence({ raw: { line_sequence_number: "3" } }), 3);
  assert.equal(smartScmNetSuiteLineSequence({ lineSequenceNumber: 2 }), 2);
  for (const value of [null, "", -1, 1.5, "bad", Infinity]) assert.equal(smartScmNetSuiteLineSequence({ line_sequence_number: value }), null);
});

test("multiple pallet destinations retain independent positions and zero PALLET is omitted", () => {
  const multi = [materials[0], { ...materials[1], destinationLocationId: 28 }, materials[2]];
  const proposal = { vendorId: 20, destinationLocationId: 1, lines: multi, palletItem,
    palletLines: [{ ...pallet, destinationLocationId: 1, purchaseQuantity: 4 }, { ...pallet, destinationLocationId: 28, purchaseQuantity: 2 }],
    lineOrder: ["line:1", "pallet:28", "line:2", "pallet:1", "line:3"] };
  const yards = [...locations, { localLocationId: 28, netsuiteLocationId: 28, subsidiaryId: 2 }];
  const items = buildSmartScmPurchaseOrderRestPayload({ proposal, locations: yards }).item.items;
  assert.deepEqual(items.map((line) => [line.item.id, line.location.id, line.quantity]), [
    ["101", "1", 10], ["1784", "28", 2], ["102", "28", 20], ["1784", "1", 4], ["103", "1", 30]
  ]);
  proposal.palletLines[1].purchaseQuantity = 0;
  assert.deepEqual(buildSmartScmPurchaseOrderRestPayload({ proposal, locations: yards }).item.items, [items[0], items[2], items[3], items[4]]);
});

test("removed and unknown saved keys preserve the surviving order", () => {
  assert.deepEqual(smartScmOrderedLines([materials[0], materials[2], pallet], chosen), [materials[0], pallet, materials[2]]);
  assert.deepEqual(smartScmOrderedLines(materials, null), materials);
});

test("ordering is idempotent, conserves rows, appends new keys once and preserves payload identity", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { maxLength: 40 }), (ids) => {
    const input = ids.map((id) => ({ id, quantity: id * 3 }));
    const reverse = ids.slice().reverse().map((id) => `line:${id}`);
    const result = smartScmOrderedLines(input, [...reverse, "line:missing"]);
    assert.deepEqual(result.map((line) => line.id), ids.slice().reverse());
    assert.deepEqual(smartScmOrderedLines(result, reverse), result);
    assert.deepEqual(smartScmOrderedPayload(input, input.map(smartScmLineKey), reverse), result);
    assert.deepEqual(smartScmOrderedLines([...input, { id: 10001 }], reverse), [...result, { id: 10001 }]);
  }), { numRuns: 200, seed: 930 });
});
