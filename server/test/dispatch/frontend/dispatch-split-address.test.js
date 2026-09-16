import assert from "node:assert/strict";
import fs from "node:fs";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

const source = fs.readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
async function submit({ missingAfterSave = false, saveError = false, requestError = false, acknowledgedOverride = false } = {}) {
  const order = { id: "SOA08748-S2", type: "SO", sourceTable: "sales_orders", originalOrderId: "SOA08748" };
  const data = { address: "76 Heatherside Dr", pickupAddress: "", expectedDeliveryDate: "" };
  const events = [];
  const statuses = [];
  const { isLocalDispatchOrder, splitParentOrderId } = cargoFunctions("../../public/dispatch.js", ["isLocalDispatchOrder", "splitParentOrderId"]);
  const start = source.indexOf('  if (form.dataset.form === "edit-order-details") {');
  const end = source.indexOf('  if (form.dataset.form === "driver") {', start);
  const deps = { form: { dataset: { form: "edit-order-details" }, querySelector: () => null }, data,
    orderById: () => missingAfterSave && events.includes("save-plan") ? null : order,
    modalOrderId: order.id, modalType: "", routeNotice: "", activeOrderType: "SO",
    modalTimeValue: () => "", timeValidationMessage: () => "", supportsTransitCoForOrder: () => false,
    setEditFormStatus: (_form, message, kind) => statuses.push({ message, kind }), transitSourceOrderType: () => "SO", isLocalDispatchOrder, splitParentOrderId,
    dispatchLeaseRequestPayload: payload => payload, dispatchSessionId: "address-test", summarizeOrder: value => value,
    saveCurrentPlanNow: async () => { events.push("save-plan"); if (saveError) {throw new Error("Plan save failed");} },
    fetch: async (url, options) => { events.push("details"); assert.match(url, /SOA08748-S2\/details/u);
      assert.equal(JSON.parse(options.body).address, data.address);
      return { ok: !requestError, text: async () => "Address save failed",
        json: async () => ({ updated: { dispatch_address: data.address,
          ...(acknowledgedOverride ? { dispatch_details_override: { address: data.address } } : {}) } }) }; },
    mergeTargetedDispatchMutationOrders: () => {}, clearActiveRouteEstimates: () => {}, commitPlanMutation: () => events.push("commit") };
  const wrapper = "return (async () => {";
  const prefix = wrapper + source.slice(wrapper.length, start).replace(/[^\n\r]/gu, " ");
  await compileFunction(`${prefix}${source.slice(start, end)}})();`, Object.keys(deps), {
    filename: fileURLToPath(new URL("../../../public/dispatch.js", import.meta.url))
  })(...Object.values(deps));
  await new Promise(resolve => setImmediate(resolve));
  return { events, order, data, statuses };
}

test("the real split details form saves pending split creation before persisting the override", async () => {
  const { events, order, data } = await submit();
  assert.deepEqual(events, ["save-plan", "details", "commit"]);
  assert.equal(order.destinationAddress, data.address);
});

test("failed plan/detail saves and removed splits remain visible errors without committing a local address", async () => {
  for (const input of [{ missingAfterSave: true }, { saveError: true }, { requestError: true }]) {
    const { events, order, statuses } = await submit(input);
    assert.equal(events.includes("commit"), false);
    assert.equal(order.destinationAddress, undefined);
    assert.equal(statuses.at(-1).kind, "error");
    assert.match(statuses.at(-1).message, /^Update failed:/u);
    if (!input.requestError) {assert.equal(events.includes("details"), false);}
  }
});

test("the acknowledged override remains on the order submitted in subsequent plan saves", async () => {
  const { order, data, events } = await submit({ acknowledgedOverride: true });
  assert.deepEqual(order.dispatchDetailsOverride, { address: data.address });
  assert.equal(events.at(-1), "commit");
});
