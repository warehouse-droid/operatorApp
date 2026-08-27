import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("./sales-order-reload.js", import.meta.url);
const original = await readFile(moduleUrl, "utf8");

function replaceExact(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, `Mutation target count changed: ${from}`);
  return source.replace(from, to);
}

function importMutant(source, name) {
  return import(`data:text/javascript;base64,${Buffer.from(`${source}\n// mutant: ${name}`).toString("base64")}`);
}

const line = {
  id: 41,
  line_id: 7,
  item_id: 1354,
  item_name: "Mutation item",
  sku: "MUTATION-ITEM",
  item_type: "InvtPart",
  quantity: 10,
  unit: "EA",
  loaded_qty: 5,
  loaded_uom: "EA",
  netsuite_active: true,
  to_pcs: 1,
  piece_qty: 10
};

function reattemptPreview(candidate) {
  return candidate.buildSalesOrderReattemptPreview({
    sourceLoadRecordId: 42,
    historicalLines: [{
      lineId: "7001",
      itemId: "8001",
      itemName: "HISTORICAL-SKU",
      loadedQty: 20,
      loadedUom: "EA"
    }],
    currentLines: [{
      id: 9001,
      line_id: 7001,
      item_id: 8002,
      item_name: "CURRENT-SKU",
      sku: "CURRENT-SKU",
      quantity: 20,
      unit: "EA",
      piece_qty: 20,
      to_pcs: 1,
      netsuite_active: true
    }],
    itemCatalog: [{
      item_id: 8001,
      item_name: "HISTORICAL-SKU",
      stock_unit: "EA",
      to_pcs: 1,
      item_weight: 1
    }]
  });
}

function snapshot(overrides = {}) {
  return {
    order: {
      netsuite_id: 456789,
      tranid: "SOM456789",
      order_type: "sales_order",
      delivery_method: "Delivery",
      status: "B",
      status_text: "Sales Order : Pending Fulfillment",
      fulfillment_status: "not_fulfilled",
      netsuite_active: true,
      ...overrides.order
    },
    lines: overrides.lines || [line],
    priorLoadCount: 1,
    completedDropoff: false,
    activeCycle: null,
    activeDraft: false,
    activeConsolidation: false,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["order", "lines"].includes(key)))
  };
}

const mutations = [
  {
    name: "allow a terminal Billed Sales Order",
    from: 'const terminal = !active\n    || status === "g"\n    || fulfillmentStatus === "fulfilled"\n    || /\\b(billed|closed|cancelled|canceled|voided|fully fulfilled)\\b/.test(terminalText);',
    to: "const terminal = false",
    async killed(candidate) {
      assert.throws(() => candidate.assertSalesOrderReloadEligibility(snapshot({
        order: { status: "B", status_text: "Sales Order : Pending Fulfillment Billed" }
      })));
    }
  },
  {
    name: "allow customer pickup",
    from: '\n    || deliveryMethod.trim() === "Pick-Up"',
    to: "",
    async killed(candidate) {
      assert.throws(() => candidate.assertSalesOrderReloadEligibility(snapshot({ order: { delivery_method: "Pick-Up" } })));
    }
  },
  {
    name: "allow a local pseudo split",
    from: '\n    || /-S\\d+$/i.test(orderRef)',
    to: "",
    async killed(candidate) {
      assert.throws(() => candidate.assertSalesOrderReloadEligibility(snapshot({ order: { tranid: "SOM456789-S1" } })));
    }
  },
  {
    name: "ignore completed driver drop-off",
    from: "if (snapshot.completedDropoff && !allowCompletedDropoff) {",
    to: "if (false && snapshot.completedDropoff && !allowCompletedDropoff) {",
    async killed(candidate) {
      assert.throws(() => candidate.assertSalesOrderReloadEligibility(snapshot({ completedDropoff: true })));
    }
  },
  {
    name: "allow two active cycles",
    from: "if (snapshot.activeCycle) {",
    to: "if (false && snapshot.activeCycle) {",
    async killed(candidate) {
      assert.throws(() => candidate.assertSalesOrderReloadEligibility(snapshot({ activeCycle: { id: 9 } })));
    }
  },
  {
    name: "re-load required quantity instead of loaded quantity",
    from: "targetSalesQty: loadedSalesQty,",
    to: "targetSalesQty: requiredSalesQty,",
    async killed(candidate) {
      assert.equal(candidate.buildSalesOrderReloadTargets([line])[0].targetSalesQty, 5);
    }
  },
  {
    name: "include service lines",
    from: "if (loadedSalesQty <= QUANTITY_TOLERANCE || !isPickableLine(line)) continue;",
    to: "if (loadedSalesQty <= QUANTITY_TOLERANCE) continue;",
    async killed(candidate) {
      assert.deepEqual(candidate.buildSalesOrderReloadTargets([{ ...line, item_type: "Service" }]), []);
    }
  },
  {
    name: "allow packed quantity above frozen target",
    from: "const packedSalesQty = roundQuantity(Math.min(remainingSalesQty, desired));",
    to: "const packedSalesQty = roundQuantity(desired);",
    async killed(candidate) {
      assert.equal(candidate.reloadPackedQuantities({ targetSalesQty: 10 }, {}, { salesQty: 20 }, { absolute: true }).packedSalesQty, 10);
    }
  },
  {
    name: "accept a non-UUID idempotency key",
    from: "if (!RELOAD_REQUEST_ID_PATTERN.test(requestId)) {",
    to: "if (false && !RELOAD_REQUEST_ID_PATTERN.test(requestId)) {",
    async killed(candidate) {
      assert.throws(() => candidate.normalizeReloadRequestId("not-a-uuid"));
    }
  },
  {
    name: "cancel after Operator activity",
    from: 'if (activityStartedAt || status !== "authorized") {',
    to: "if (false) {",
    async killed(candidate) {
      await assert.rejects(() => candidate.cancelSalesOrderReload({
        orderId: 456789,
        cycleId: 9,
        reason: "Too late",
        actor: { id: "manager-1" }
      }, {
        withTransaction: async (callback) => callback(),
        lockCycle: async () => ({ id: 9, salesOrderId: 456789, status: "in_progress", activityStartedAt: new Date() }),
        cancelCycle: async () => ({ id: 9, status: "cancelled" }),
        writeAudit: async () => {}
      }));
    }
  },
  {
    name: "allow a re-attempt above immutable historical quantity",
    from: "if (target > number(historical) + QUANTITY_TOLERANCE) {",
    to: "if (false && target > number(historical) + QUANTITY_TOLERANCE) {",
    async killed(candidate) {
      const preview = reattemptPreview(candidate);
      // Isolate the physical-unit ceiling from the independent sales-quantity
      // ceiling so this mutant cannot be killed accidentally by the latter.
      preview.lines[0].historicalPieceQty = 20;
      preview.lines[0].historicalLoadedSalesQty = 100;
      assert.throws(() => candidate.buildSalesOrderReattemptTargets({
        preview,
        selections: [{ lineKey: preview.lines[0].lineKey, pieceQty: 21, reason: "Retry" }]
      }));
    }
  },
  {
    name: "allow selection of an unmapped historical line",
    from: "if (selectedForReattempt && !line.selectable) {",
    to: "if (false && selectedForReattempt && !line.selectable) {",
    async killed(candidate) {
      const preview = candidate.buildSalesOrderReattemptPreview({
        sourceLoadRecordId: 43,
        historicalLines: [{ lineId: "1", itemId: "2", itemName: "OLD", loadedQty: 1, loadedUom: "EA" }],
        currentLines: [],
        itemCatalog: [{ item_id: 2, item_name: "OLD", stock_unit: "EA", to_pcs: 1 }]
      });
      assert.throws(() => candidate.buildSalesOrderReattemptTargets({
        preview,
        selections: [{ lineKey: preview.lines[0].lineKey, pieceQty: 1, reason: "Retry" }]
      }));
    }
  },
  {
    name: "allow a selected re-attempt line without its mandatory reason",
    from: "selectionReason = normalizeReloadReason(selection.reason);",
    to: 'selectionReason = "mutant";',
    async killed(candidate) {
      const preview = reattemptPreview(candidate);
      assert.throws(() => candidate.buildSalesOrderReattemptTargets({
        preview,
        selections: [{ lineKey: preview.lines[0].lineKey, pieceQty: 1, reason: "" }]
      }));
    }
  },
  {
    name: "replace current re-attempt identity with historical freight SKU",
    from: "sku: line.currentSku,",
    to: "sku: line.historicalSku,",
    async killed(candidate) {
      const preview = reattemptPreview(candidate);
      const [target] = candidate.buildSalesOrderReattemptTargets({
        preview,
        selections: [{ lineKey: preview.lines[0].lineKey, pieceQty: 1, reason: "Retry" }]
      });
      assert.equal(target.sku, "CURRENT-SKU");
    }
  },
  {
    name: "allow authorization with no selected re-attempt freight",
    from: "if (!selectedCount) {",
    to: "if (false && !selectedCount) {",
    async killed(candidate) {
      const preview = reattemptPreview(candidate);
      assert.throws(() => candidate.buildSalesOrderReattemptTargets({
        preview,
        selections: [{ lineKey: preview.lines[0].lineKey, pieceQty: 0, reason: "" }]
      }));
    }
  }
];

let killed = 0;
const survived = [];
for (const mutation of mutations) {
  const candidate = await importMutant(replaceExact(original, mutation.from, mutation.to), mutation.name);
  try {
    await mutation.killed(candidate);
  } catch {
    killed += 1;
    continue;
  }
  survived.push(mutation.name);
}

assert.equal(killed, mutations.length, `Every critical Sales Order re-load policy mutant must be killed. Survived: ${survived.join(", ")}`);
console.log(`Sales Order re-load mutation harness passed; ${killed}/${mutations.length} mutants killed.`);
