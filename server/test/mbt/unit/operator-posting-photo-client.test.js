import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../../../public/operator.js", import.meta.url), "utf8");
function functionText(name, next) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf(`async function ${next}(`, start));
}
const photos = ["data:image/jpeg;base64,cGhvdG8x", "data:image/jpeg;base64,cGhvdG8y"];

test("delivery Sales Orders remain local operations owned by driver completion", () => {
  const start = source.indexOf("function operatorNetSuitePostingIsLocalOnly(");
  const fn = source.slice(start, source.indexOf("async function loadOperatorNetSuitePostingPolicy(", start));
  const context = vm.createContext({});
  vm.runInContext(fn, context);
  const local = context.operatorNetSuitePostingIsLocalOnly;
  assert.equal(local({ order_type: "sales_order" }, "delivery_prep"), true);
  assert.equal(local({ order_type: "sales_order" }, "customer_pickup"), false);
  assert.equal(local({ order_type: "transfer_order" }, "delivery_prep"), false);
  assert.equal(local({ is_dispatch_group: true, child_orders: [{ order_type: "sales_order" }, { order_type: "co_order" }] }, "delivery_prep"), true);
  assert.equal(local({ is_dispatch_group: true, child_orders: [{ order_type: "sales_order" }, { order_type: "transfer_order" }] }, "delivery_prep"), false);
});

for (const kind of ["delivery", "pickup", "receiving"]) {
  test(`${kind}: native and local posting submit identities without waiting for photo network traffic`, async () => {
    for (const effective of [true, false]) {
      const calls = [];
      const policy = { effective, gateKey: "test", revision: 1 };
      const context = vm.createContext({
        fulfillmentOrder: { netsuite_id: 7, order_type: kind === "delivery" ? "transfer_order" : "sales_order" }, receiptOrder: { netsuite_id: 8, order_type: "purchase_order" },
        fulfillmentSubmitting: false, receiptSubmitting: false, receiptResult: null, fulfillmentPhotoDataUrls: photos, receiptPhotoDataUrls: photos,
        fulfillmentNetSuitePolicy: policy, receiptNetSuitePolicy: policy, currentModule: kind === "pickup" ? "customer-pickup-load" : "delivery",
        fulfillmentLoadRequestId: "load-id", receiptRequestId: "receipt-id", locationId: 1,
        deliveryOrderType: kind === "delivery" ? "transfer_order" : "sales_order", receivingOrderType: "purchase_order", receivingSelectedSourceId: null,
        fulfillmentProgressTimer: null, receiptProgressTimer: null,
        window: { setInterval: () => 1, clearInterval: () => {} },
        render: () => {}, showToast: (message) => calls.push({ type: "toast", message }),
        operatorNetSuitePostingIsLocalOnly: () => false, refreshCustomerPickupPhotoRequirement: async () => {}, fulfillmentRequiredPhotoCount: () => 2,
        loadOperatorNetSuitePostingPolicy: async () => policy, operatorNetSuitePolicyToken: (value) => value,
        stopFulfillmentCamera: () => {}, stopReceiptCamera: () => {}, saveOperatorState: () => {},
        prepareOperatorBackgroundPhotos: async () => ({ backgroundPhotos: [{ id: "photo-one" }, { id: "photo-two" }] }),
        resumeOperatorBackgroundPhotos: () => {},
        uploadOperatorPhotos: async () => { calls.push({ type: "upload" }); return ["r2://one", "r2://two"]; },
        api: async (path, options) => { calls.push({ type: "post", path, payload: JSON.parse(options.body) }); return { status: "complete", result: { complete: true } }; }
      });
      const fn = kind === "receiving" ? functionText("confirmReceipt", "pollReceiptJob") : functionText("confirmFulfillment", "pollFulfillmentJob");
      await vm.runInContext(`${fn}\n${kind === "receiving" ? "confirmReceipt" : "confirmFulfillment"}()`, context);
      const post = calls.find((call) => call.type === "post");
      assert.ok(post, JSON.stringify(calls));
      assert.deepEqual(post.payload.backgroundPhotos, [{ id: "photo-one" }, { id: "photo-two" }]);
      assert.equal(post.payload.photoDataUrls, undefined);
      assert.equal(calls.filter((call) => call.type === "upload").length, 0);
      assert.equal(calls.filter((call) => call.type === "post").length, 1);
    }
  });
}
