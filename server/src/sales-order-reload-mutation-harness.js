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
    from: "if (snapshot.completedDropoff) {",
    to: "if (false && snapshot.completedDropoff) {",
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
