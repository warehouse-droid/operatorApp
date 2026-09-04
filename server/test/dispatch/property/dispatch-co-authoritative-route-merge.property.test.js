import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import fc from "fast-check";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);

function functionBody(name) {
  const start = dispatchSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Expected ${name} to be implemented.`);
  const parametersOpen = dispatchSource.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "(") {
      parameterDepth += 1;
    }
    if (dispatchSource[index] === ")") {
      parameterDepth -= 1;
    }
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  assert.notEqual(parametersClose, -1, `Could not read ${name} parameters.`);
  const open = dispatchSource.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "{") {
      depth += 1;
    }
    if (dispatchSource[index] === "}") {
      depth -= 1;
    }
    if (!depth) {
      return dispatchSource.slice(start, index + 1);
    }
  }
  throw new Error(`Could not read ${name}.`);
}

const preserveDispatchPlanningFields = Function(
  `"use strict"; return (${functionBody("preserveDispatchPlanningFields")});`
)();

test("authoritative active CO routes win for every configured yard pair without changing group identity", () => {
  const yard = fc.constantFrom("3445", "2967", "12441", "150");
  fc.assert(fc.property(
    yard,
    yard,
    fc.constantFrom("pending_load", "loaded", "completed"),
    fc.uniqueArray(fc.stringMatching(/^SO[A-Z][0-9]{5}$/), { minLength: 1, maxLength: 5 }),
    (staleToYard, authoritativeToYard, status, childOrders) => {
      const existing = {
        id: "GROUP-ORDER",
        childOrders,
        transitCo: {
          id: "CO-GROUP-ORDER",
          fromYard: "2967",
          toYard: staleToYard
        },
        transitOriginalPickupLocations: ["2967"],
        transitOriginalSourceYard: "2967"
      };
      const incomingTransitCo = {
        id: "CO-GROUP-ORDER",
        fromYard: "2967",
        toYard: authoritativeToYard,
        status,
        sourceOrderId: "GROUP-ORDER"
      };
      const merged = preserveDispatchPlanningFields(existing, {
        id: "GROUP-ORDER",
        sourceYard: authoritativeToYard,
        pickupLocations: [authoritativeToYard],
        transitCo: incomingTransitCo,
        transitOriginalPickupLocations: ["2967"],
        transitOriginalSourceYard: "2967"
      });

      assert.deepEqual(merged.transitCo, incomingTransitCo);
      assert.equal(merged.sourceYard, authoritativeToYard);
      assert.deepEqual(merged.pickupLocations, [authoritativeToYard]);
      assert.deepEqual(merged.childOrders, childOrders);
    }
  ), { numRuns: 250 });
});
