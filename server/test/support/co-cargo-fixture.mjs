import assert from "node:assert/strict";
import fs from "node:fs";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";

export function productionFunctions(path, names, dependencies = {}) {
  const file = new URL(path, import.meta.url);
  const source = fs.readFileSync(file, "utf8");
  const spans = names.map((name) => {
    const marker = new RegExp(`^(?:export )?function ${name}\\(`, "m").exec(source);
    assert.ok(marker, `Missing production function ${name}`);
    const tail = source.slice(marker.index);
    const end = /^}/m.exec(tail);
    assert.ok(end, `Missing function end ${name}`);
    return { start: marker.index, end: marker.index + end.index + 1 };
  });
  // Preserve original offsets for V8 coverage. Only the extracted function
  // spans are admissible coverage evidence; padding is not executed app code.
  let body = source.replace(/[^\n\r]/g, " ");
  for (const span of spans) {
    body = body.slice(0, span.start) + source.slice(span.start, span.end).replace(/^export /, "       ") + body.slice(span.end);
  }
  return compileFunction(`${body}\nreturn {${names.join(",")}};`, Object.keys(dependencies), { filename: fileURLToPath(file) })(
    ...Object.values(dependencies)
  );
}

export function coFixture(suffix = "7453-7455") {
  const childOrders = [`SOA-${suffix}-A`, `SOA-${suffix}-B`];
  const items = [
    { lineId: 4829037, itemId: 4775, sku: "PER-MEL80S-RDM-AB", itemType: "InvtPart", quantity: 559.68, pallets: 6, layers: 0, pieces: 0, sections: 0, unit: "SQFT" },
    { lineId: 4829081, itemId: 1784, sku: "PALLET", itemType: "InvtPart", quantity: 6, pallets: 0, layers: 0, pieces: 0, sections: 0, unit: "EACH" }
  ];
  return {
    id: `CO-GOA-${suffix}`, type: "CO", sourceTable: "local_co_orders",
    sourceOrderId: `GOA-${suffix}`, sourceOrderType: "SO", catalogHydrated: true,
    sourceYard: "2967", pickupLocations: ["2967"], destinationYard: "12441",
    items, pallets: 6, layers: 0, pieces: 0, sections: 0,
    childOrders,
    childOrderDetails: childOrders.map((id, index) => ({
      id, type: "SO", sourceYard: "2967", pickupLocations: ["2967"],
      items: [items[index]], pallets: index === 0 ? 6 : 0
    }))
  };
}

export function staleCoFixture(suffix) {
  const co = coFixture(suffix);
  return { ...co, items: [], pallets: 0, globalGroupDefinition: true,
    childOrderDetails: co.childOrders.map((id) => ({ id, type: "CO", items: [] })) };
}

export function coCargoFrontend() {
  return productionFunctions("../../public/dispatch.js", [
    "canonicalDispatchOrderType", "isAggregateDispatchCoGroup", "flattenDispatchGroupMembers",
    "preserveDispatchPlanningFields", "specialOrderPalletItemQuantity", "effectiveOrderPalletQuantity"
  ]);
}
