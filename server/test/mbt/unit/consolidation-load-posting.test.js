import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { createConsolidationPostingPreparation } from "../../../src/consolidation-load-posting.js";

function fixture({ enabled = true } = {}) {
  const materialized = [], drafts = [], checks = [], preflights = [];
  const prepare = createConsolidationPostingPreparation({
    assertClaims: async (input) => checks.push(input),
    resolveTargets: async ({ orderId, orderType, deferTargets }) => {
      assert.equal(deferTargets, true);
      return { netSuitePostingOwner: orderType === "sales_order" ? "driver_completion" : "operator",
        localOnly: orderType === "co_order", materializeTargets: async () => {
          materialized.push(orderId); return { targets: [{ sourceOrderKind: "TO", sourceNetSuiteId: orderId }] };
        } };
    },
    getPolicy: async () => ({ effective: enabled }),
    preflight: async (id) => preflights.push(id),
    buildDraft: (draft) => { drafts.push(draft); return draft; },
    createCommand: async () => ({ command: { id: "command" } })
  });
  return { prepare, materialized, drafts, checks, preflights };
}
const batch = { id: "batch", locationId: 1, photoRefs: ["a", "b"] };
test("Sales Orders and local CO loads never materialize NetSuite targets", async () => {
  const f = fixture();
  assert.equal(await f.prepare({ id: "operator" }, batch, [{ netsuite_id: "1", order_type: "sales_order" }, { netsuite_id: "2", order_type: "co_order" }]), null);
  assert.deepEqual(f.materialized, []);
  assert.deepEqual(f.drafts, []);
});
test("a mixed batch creates only the native TO target while claiming every order", async () => {
  const f = fixture();
  const result = await f.prepare({ id: "operator" }, batch, [{ netsuite_id: "1", order_type: "sales_order" }, { netsuite_id: "2", order_type: "transfer_order" }]);
  assert.equal(result.id, "command");
  assert.deepEqual(f.materialized, ["2"]);
  assert.deepEqual(f.drafts[0].localOrderKeys, ["delivery_prep:sales_order:1", "delivery_prep:transfer_order:2"]);
  assert.equal(f.drafts[0].localOperation.kind, "delivery_consolidation_load");
  assert.deepEqual(f.preflights, ["batch"]);
});
test("backend gate off keeps a native TO local without reading transform targets", async () => {
  const f = fixture({ enabled: false });
  assert.equal(await f.prepare({ id: "operator" }, batch, [{ netsuite_id: "2", order_type: "transfer_order" }]), null);
  assert.deepEqual(f.materialized, []);
});
test("properties: any mix of SO, TO and CO can materialize only gated native TOs", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("sales_order", "transfer_order", "co_order"), { minLength: 1, maxLength: 20 }), fc.boolean(), async (types, enabled) => {
    const f = fixture({ enabled });
    const orders = types.map((order_type, index) => ({ order_type, netsuite_id: String(index + 1) }));
    await f.prepare({ id: "operator" }, batch, orders);
    assert.deepEqual(f.materialized, enabled ? orders.filter((order) => order.order_type === "transfer_order").map((order) => order.netsuite_id) : []);
    assert.equal(f.drafts.length, enabled && types.includes("transfer_order") ? 1 : 0);
  }), { seed: 20260915, numRuns: 150 });
});
