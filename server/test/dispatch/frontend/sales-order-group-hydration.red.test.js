import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

function fixture({ failure = false, incomplete = false, changeSelection = false, nested = false } = {}) {
  const full = ["SOB119854", "SOB119855"].map((id) => ({
    id, type: "SO", catalogHydrated: true,
    items: Array.from({ length: 12 }, (_, index) => ({ itemId: 1158 + index, lineId: 4919454 + index, quantity: index + 1 }))
  }));
  let orders = full.map((order) => ({ ...order, catalogHydrated: false, itemCount: 12, items: order.items.slice(0, 8) }));
  if (nested) {
    orders[0].catalogHydrated = true;
    orders[0].items = full[0].items;
    orders[0].childOrders = ["SOB-NESTED"];
    orders[0].childOrderDetails = [{ id: "SOB-NESTED", catalogHydrated: false, items: [] }];
    full[0].childOrders = ["SOB-NESTED"];
    full[0].childOrderDetails = [{ id: "SOB-NESTED", catalogHydrated: true, items: full[0].items }];
  }
  let selected = orders.map((order) => order.id);
  const requests = [];
  const functions = cargoFunctions("../../public/dispatch.js", [
    "dispatchGroupOrderNeedsHydration", "hydrateDispatchGroupSelection", "hydrateDispatchOrder", "applyTargetedDispatchOrderUpdate",
    "canonicalDispatchOrderType", "isAggregateDispatchCoGroup"
  ], {
    selectedOrders: () => selected.map((id) => orders.find((order) => order.id === id)),
    orderById: (id) => orders.find((order) => order.id === id),
    dispatchOrderHydrationPromises: new Map(),
    fetch: async (url) => {
      const id = decodeURIComponent(url.split("/").at(-1));
      requests.push(id);
      if (failure && id === "SOB119855") { throw new Error("Details unavailable"); }
      if (changeSelection) { selected = ["SOB119854"]; }
      return { ok: true, json: async () => ({ order: incomplete ? orders.find((order) => order.id === id) : full.find((order) => order.id === id) }) };
    },
    mergeDispatchOrderSearchFeed: (fresh) => { orders = orders.map((order) => fresh.find((candidate) => candidate.id === order.id) || order); },
    renderDispatchOrderPoolPatch: () => {},
    dispatchErrorMessage: async () => "Details unavailable"
  });
  return { ...functions, requests, full };
}

test("ID-03 grouping loads every selected order including all items after the eighth", async () => {
  const view = fixture();
  const orders = await view.hydrateDispatchGroupSelection();
  assert.deepEqual(view.requests.sort(), ["SOB119854", "SOB119855"]);
  assert.deepEqual(orders, view.full);
});

test("ID-03 a full group with an incomplete child reloads its complete details", async () => {
  const view = fixture({ nested: true });
  const orders = await view.hydrateDispatchGroupSelection();
  assert.deepEqual(view.requests.sort(), ["SOB119854", "SOB119855"]);
  assert.equal(orders[0].childOrderDetails[0].items.length, 12);
});

test("ID-03 failed, incomplete, and changed-selection hydration cannot proceed to grouping", async () => {
  for (const options of [{ failure: true }, { incomplete: true }, { changeSelection: true }]) {
    const view = fixture(options);
    await assert.rejects(view.hydrateDispatchGroupSelection(), /unavailable|complete|selection/iu);
  }
});

test("ID-03 confirm-group awaits hydration before reading its members and grouping", () => {
  const source = fs.readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
  const action = source.slice(source.indexOf('if (action === "confirm-group")'), source.indexOf('if (action === "request-unpack-for-split")'));
  assert.match(action, /await hydrateDispatchGroupSelection\(\)/u);
  assert.ok(action.indexOf("await hydrateDispatchGroupSelection()") < action.indexOf("const selectedBefore"));
  assert.ok(action.indexOf("const selectedBefore") < action.indexOf("if (!groupOrder"));
  const { groupOrder } = cargoFunctions("../../public/dispatch.js", ["groupOrder", "dispatchGroupOrderNeedsHydration", "canonicalDispatchOrderType", "isAggregateDispatchCoGroup"], {
    selectedOrders: () => [{ id: "SOB119854", catalogHydrated: false }, { id: "SOB119855", catalogHydrated: true }],
    routeNotice: ""
  });
  assert.equal(groupOrder("SOB119854"), false, "incomplete data must stop before any grouping mutation");
});

test("ID-03 direct CO cargo stays groupable when source children are informational", () => {
  const { dispatchGroupOrderNeedsHydration } = cargoFunctions("../../public/dispatch.js", [
    "dispatchGroupOrderNeedsHydration", "canonicalDispatchOrderType", "isAggregateDispatchCoGroup"
  ]);
  const direct = { id: "CO-SOB119965", type: "CO", sourceTable: "local_co_orders", sourceOrderId: "SOB119965",
    catalogHydrated: true, items: [{ itemId: 3632, quantity: 735.04 }], childOrders: ["SOB119965"],
    childOrderDetails: [{ id: "SOB119965", type: "SO", catalogHydrated: false, items: [] }] };
  assert.equal(dispatchGroupOrderNeedsHydration(direct), false);
  assert.equal(dispatchGroupOrderNeedsHydration({ ...direct, catalogHydrated: false }), true);
  assert.equal(dispatchGroupOrderNeedsHydration({ id: "CO-GROUP", type: "CO", catalogHydrated: true,
    childOrders: [direct.id], childOrderDetails: [{ ...direct, catalogHydrated: false }] }), true);
  assert.equal(dispatchGroupOrderNeedsHydration({ id: "GOB", type: "SO", childOrders: ["SO-MISSING"] }), true);
});
