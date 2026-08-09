import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  dependencyBlocksDispatchStructureChange,
  dispatchDependencyOrderRefs,
  everySalesAssignmentFollowsTransfer
} from "./yard-dependency-structure.js";

for (const dependency of [
  { mode: "yard_replenishment", status: "active" },
  { mode: "yard_replenishment", status: "loaded", loadedQuantity: 1 },
  { dependency_mode: "yard_replenishment", status: "delivered" }
]) {
  assert.equal(
    dependencyBlocksDispatchStructureChange(dependency),
    false,
    "A yard-replenishment dependency blocked a Dispatch container change."
  );
}
assert.equal(
  dependencyBlocksDispatchStructureChange({ mode: "direct_to_customer", status: "active" }),
  true,
  "A direct-ship dependency must remain structurally locked."
);
assert.equal(
  dependencyBlocksDispatchStructureChange({ mode: "unknown" }),
  true,
  "An unknown dependency mode must fail closed."
);

assert.deepEqual(
  dispatchDependencyOrderRefs({
    id: "SOB116330-S1",
    originalOrderId: "SOB116330"
  }),
  ["SOB116330-S1", "SOB116330"],
  "A split child must resolve to its canonical parent dependency."
);
assert.deepEqual(
  dispatchDependencyOrderRefs({
    id: "GOA-5876-5889",
    childOrders: ["SOA05876"],
    childOrderDetails: [{ id: "SOA05876" }, { id: "SOA05889" }]
  }),
  ["GOA-5876-5889", "SOA05876", "SOA05889"],
  "A group must expose each canonical child exactly once."
);
assert.deepEqual(
  dispatchDependencyOrderRefs({}),
  [],
  "Sparse order data must not create an empty dependency reference."
);

const precedes = (transfer, sales) => Number(transfer?.sequence) < Number(sales?.sequence);
assert.equal(
  everySalesAssignmentFollowsTransfer(
    { sequence: 2 },
    [{ sequence: 3 }, { sequence: 4 }],
    precedes
  ),
  true,
  "A prerequisite TO before every split child should be accepted."
);
assert.equal(
  everySalesAssignmentFollowsTransfer(
    { sequence: 2 },
    [{ sequence: 1 }, { sequence: 4 }],
    precedes
  ),
  false,
  "One split child before the prerequisite TO must reject the whole plan."
);
assert.equal(
  everySalesAssignmentFollowsTransfer({ sequence: 2 }, [], precedes),
  false,
  "An empty Sales assignment set must not be treated as sequenced evidence."
);
assert.equal(
  everySalesAssignmentFollowsTransfer({ sequence: 2 }, null, precedes),
  false,
  "A malformed Sales assignment set must fail closed."
);
assert.equal(
  everySalesAssignmentFollowsTransfer({ sequence: 2 }, [{ sequence: 3 }], null),
  false,
  "A missing sequencing comparator must fail closed."
);

const regressionHistory = await readFile(
  new URL("../test/sales-order-reload-regression-matrix.md", import.meta.url),
  "utf8"
);
assert.match(regressionHistory, /SOB116330/u);
assert.match(regressionHistory, /GOA-5876-5889 -> TOB00731/u);
assert.match(regressionHistory, /test:order-dependencies/u);
assert.match(regressionHistory, /test:dispatch-driver-order/u);

console.log(JSON.stringify({
  ok: true,
  assertions: 17,
  unrelatedUnplanAllowed: true,
  yardStructureChangesAllowed: true,
  directShipLocked: true,
  everySplitSequenced: true,
  historyOwned: true
}));
