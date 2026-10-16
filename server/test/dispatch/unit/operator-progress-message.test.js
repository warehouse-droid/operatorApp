import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { evaluateDependencyMutationBlockers } from "../../../src/scm-dependency-management-policy.js";

test("group link error names the packed member, display name and login", () => {
  const result = evaluateDependencyMutationBlockers({ operatorActivity: {
    refs: ["SOA08801"], orders: [{ orderRef: "SOA08801", status: "packed", operator: { displayName: "Pat Packer", username: "pat" } }]
  } });
  assert.equal(result[0].code, "OPERATOR_ACTIVITY_STARTED");
  assert.match(result[0].message, /SOA08801 is packed by Pat Packer \(pat\)/u);
  assert.doesNotMatch(result[0].message, /SOA08800/u);
  assert.deepEqual(result[0].details.refs, ["SOA08801"]);
});

test("loaded evidence and missing actor are described accurately", () => {
  const [blocker] = evaluateDependencyMutationBlockers({ operatorActivity: {
    refs: ["SOA08801"], orders: [{ orderRef: "SOA08801", status: "loaded", operator: null }]
  } });
  assert.match(blocker.message, /SOA08801 has loaded quantities/u);
  assert.match(blocker.message, /operator was not recorded/u);
  assert.doesNotMatch(blocker.message, /is packed/u);
});

test("property: every affected member remains in the message exactly with its own operator", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 99999 }), { minLength: 1, maxLength: 12 }), ids => {
    const orders = ids.map(id => ({ orderRef: `SO-${id}`, status: "packed", operator: { displayName: `Packer-${id}`, username: `login-${id}` } }));
    const [blocker] = evaluateDependencyMutationBlockers({ operatorActivity: { refs: orders.map(row => row.orderRef), orders } });
    for (const row of orders) { assert.ok(blocker.message.includes(`${row.orderRef} is packed by ${row.operator.displayName} (${row.operator.username})`)); }
  }), { numRuns: 80, seed: 20261012 });
});
