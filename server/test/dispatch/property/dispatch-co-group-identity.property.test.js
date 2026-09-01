import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  canonicalizeDispatchCoGroupIdentities,
  dispatchCoGroupIdentityMappings
} from "../../../src/dispatch-co-group-identity.js";

const coNumber = fc.integer({ min: 1, max: 99_999_999 });

test("CO group identity property: arbitrary all-CO groups canonicalize exactly once without rewriting stable IDs", () => {
  fc.assert(fc.property(
    fc.uniqueArray(coNumber, { minLength: 2, maxLength: 6 }),
    (numbers) => {
      const sorted = [...numbers].sort((left, right) => left - right);
      const oldRef = `GOA-${sorted.join("-")}`;
      const newRef = `CO-${oldRef}`;
      const children = sorted.map((number) => `CO-SOA${number}`);
      const plan = {
        orders: [{
          id: oldRef,
          type: "CO",
          childOrders: children,
          childOrderDetails: children.map((id) => ({ id, type: "CO" }))
        }],
        trucks: [{ loads: [{
          orders: [{
            id: oldRef,
            type: "CO",
            childOrders: children
          }],
          stops: [{
            id: `stable-stop-${oldRef}-evidence`,
            orderId: oldRef,
            orderRefs: [oldRef]
          }]
        }] }]
      };

      assert.deepEqual(dispatchCoGroupIdentityMappings(plan), [{ oldRef, newRef }]);
      const canonical = canonicalizeDispatchCoGroupIdentities(plan);
      assert.equal(canonical.orders[0].id, newRef);
      assert.equal(canonical.trucks[0].loads[0].orders[0].id, newRef);
      assert.equal(canonical.trucks[0].loads[0].stops[0].orderId, newRef);
      assert.equal(canonical.trucks[0].loads[0].stops[0].id, `stable-stop-${oldRef}-evidence`);
      assert.deepEqual(canonicalizeDispatchCoGroupIdentities(canonical), canonical);
      assert.equal(plan.orders[0].id, oldRef);
    }
  ), { numRuns: 100 });
});

test("CO group identity property: any mixed CO/non-CO group is rejected without mutation", () => {
  fc.assert(fc.property(coNumber, coNumber, (left, right) => {
    const oldRef = `GOA-${left}-${right}`;
    const plan = {
      orders: [{
        id: oldRef,
        type: "CO",
        childOrders: [`CO-SOA${left}`, `SOA${right}`],
        childOrderDetails: [
          { id: `CO-SOA${left}`, type: "CO" },
          { id: `SOA${right}`, type: "SO" }
        ]
      }]
    };
    assert.throws(
      () => canonicalizeDispatchCoGroupIdentities(plan),
      (error) => error?.code === "DISPATCH_CO_GROUP_MIXED_TYPES"
    );
    assert.equal(plan.orders[0].id, oldRef);
  }), { numRuns: 100 });
});

test("group-first source orders remain ordinary GO groups until the one canonical CO is initialized", () => {
  fc.assert(fc.property(
    fc.uniqueArray(coNumber, { minLength: 2, maxLength: 6 }),
    (numbers) => {
      const oldRef = `GOA-${numbers.join("-")}`;
      const sourceGroup = {
        orders: [{
          id: oldRef,
          type: "SO",
          childOrders: numbers.map((number) => `SOA${number}`)
        }]
      };
      const initialized = {
        orders: [{
          id: `CO-${oldRef}`,
          type: "CO",
          childOrders: numbers.map((number) => `SOA${number}`)
        }]
      };
      assert.deepEqual(canonicalizeDispatchCoGroupIdentities(sourceGroup), sourceGroup);
      assert.deepEqual(canonicalizeDispatchCoGroupIdentities(initialized), initialized);
    }
  ), { numRuns: 100 });
});
