import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const dispatchSource = await readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
const v2Source = await readFile(new URL("../../../src/dispatch-planner-v2-repository.js", import.meta.url), "utf8");
const driverSource = await readFile(new URL("../../../src/driver-repository.js", import.meta.url), "utf8");

function sourceFunctionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Expected ${name} to be implemented.`);
  const parametersOpen = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < source.length; index += 1) {
    if (source[index] === "(") {parameterDepth += 1;}
    if (source[index] === ")") {parameterDepth -= 1;}
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  const open = source.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") {depth += 1;}
    if (source[index] === "}") {depth -= 1;}
    if (!depth) {return source.slice(start, index + 1);}
  }
  throw new Error(`Could not read ${name}.`);
}

function functionBody(name) {
  return sourceFunctionBody(dispatchSource, name);
}

test("Dispatch browser routes PO pickups and drops through the residual projection", () => {
  assert.match(dispatchSource, /function poRouteProjectionForOrder\(/u);
  assert.match(dispatchSource, /function routeItemsForOrder\(/u);
  assert.match(dispatchSource, /function routeDropoffsForOrder\(/u);
  assert.match(functionBody("dropoffForStop"), /routeDropoffsForOrder\(order\)/u);
  assert.match(functionBody("dropItemsForStop"), /routeItemsForOrder\(order\)/u);
  assert.match(functionBody("tooltipItemsForOrder"), /routeItemsForOrder\(order\)/u);
  assert.match(functionBody("addPoDropoffsToLoad"), /routeDropoffsForOrder\(order\)/u);
  assert.match(functionBody("orderWeightLbs"), /poRouteProjectionForOrder\(order\).*weight/su);
});

test("browser pickup weight is calculated from the location-scoped items", () => {
  const body = functionBody("pickupWeightForOrderLocation");
  assert.match(body, /tooltipItemsForOrder\(order,\s*\{\s*pickupLocation:\s*location\s*\}\)/u);
  assert.match(body, /itemWeight/u);
  assert.ok(
    body.indexOf("if (scopedWeight > 0)") < body.lastIndexOf("return orderWeightLbs(order)"),
    "location-scoped item weight must win before the legacy whole-order fallback"
  );
});

test("browser PO drop totals prefer the route projection over stale saved-stop quantities", () => {
  const quantityBody = functionBody("routeDropQuantity");
  assert.ok(
    quantityBody.indexOf("poRouteProjectionForOrder(order)") < quantityBody.indexOf("stop?.[stopField]"),
    "routeDropQuantity must consult the PO route projection before legacy explicit stop values"
  );
  assert.match(functionBody("dropPallets"), /routeDropQuantity\(order,\s*stop,\s*"pallets"\)/u);
  assert.match(functionBody("dropFootprintPallets"), /\["layers",\s*"sections",\s*"pieces"\].*routeDropQuantity/su);
  const weightBody = functionBody("dropWeightLbs");
  assert.ok(
    weightBody.indexOf("poRouteProjectionForOrder(order)") < weightBody.indexOf("stop?.dropWeight"),
    "dropWeightLbs must consult the PO route projection before legacy explicit stop values"
  );
});

test("browser executes the production residual totals instead of the stale 51-pallet stop", () => {
  const names = [
    "poRouteProjectionForOrder",
    "routeItemsForOrder",
    "routeDropoffsForOrder",
    "orderWeightLbs",
    "dropoffForStop",
    "dropItemsForStop",
    "dropWeightLbs",
    "routeDropQuantity",
    "dropPallets",
    "dropFootprintPallets"
  ];
  const context = {
    sameDispatchLocation: (left, right) => String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase()
  };
  vm.runInNewContext(
    `${names.map(functionBody).join("\n")}\nglobalThis.route = { ${names.join(", ")} };`,
    context
  );
  const { route } = context;
  const order = {
    id: "SN1398699",
    type: "PO",
    pallets: 51,
    weight: 75986.2305,
    poRouteProjection: {
      version: 1,
      pallets: 13,
      layers: 0,
      sections: 0,
      pieces: 0,
      weight: 19901.67,
      items: [
        { lineRowId: "dusk", pallets: 12, quantity: 654, itemWeight: 27.44 },
        { lineRowId: "urban", pallets: 1, quantity: 52.31, itemWeight: 27.45 },
        { lineRowId: "pallet", pallets: 0, quantity: 13, itemWeight: 40 }
      ],
      dropoffs: [{
        key: "location:1",
        destinationYard: "3445",
        lineRowIds: ["dusk", "urban", "pallet"],
        pallets: 13,
        layers: 0,
        sections: 0,
        pieces: 0,
        weight: 19901.67
      }]
    }
  };
  const staleStop = {
    dropoffKey: "location:1",
    dropLocation: "3445",
    dropPallets: 51,
    dropLayers: 5,
    dropWeight: 75986.2305
  };

  assert.equal(route.dropPallets(order, staleStop), 13);
  assert.equal(route.dropFootprintPallets(order, staleStop), 13);
  assert.equal(route.dropWeightLbs(order, staleStop), 19902);
  assert.equal(route.orderWeightLbs(order), 19902);
});

test("Driver PO pickup details use full source items while drop details use the residual projection", () => {
  const detailsFromPlan = sourceFunctionBody(driverSource, "driverOrderDetailsFromPlan");
  assert.match(detailsFromPlan, /context\.stopType\s*===\s*"pickup"/u);
  assert.match(detailsFromPlan, /planOrder\?\.items/u);
  assert.match(detailsFromPlan, /purchaseOrderRouteItems\(planOrder\)/u);
  const body = sourceFunctionBody(driverSource, "orderDetails");
  assert.ok(
    body.indexOf("purchaseOrderRouteProjection(planOrder)") < body.indexOf("detailsFromReceiving"),
    "Driver route projection must be selected before querying the full PO receiving lines"
  );
});

test("the compact V2 snapshot retains the PO route projection", () => {
  assert.match(v2Source, /"poRouteProjection"/u);
});
