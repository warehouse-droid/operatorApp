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

for (const kind of ["delivery", "pickup", "receiving"]) {
  test(`${kind}: renders the NetSuite stage before awaiting submission`, async () => {
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
        render: () => { calls.push({type:"render",message:kind === "receiving" ? context.receiptStatusText : context.fulfillmentStatusText,stage:kind === "receiving" ? context.receiptJobStage : context.fulfillmentJobStage}); }, showToast: (message) => calls.push({ type: "toast", message }),
        operatorNetSuitePostingIsLocalOnly: () => false, refreshCustomerPickupPhotoRequirement: async () => {}, fulfillmentRequiredPhotoCount: () => 2,
        loadOperatorNetSuitePostingPolicy: async () => policy, operatorNetSuitePolicyToken: (value) => value,
        stopFulfillmentCamera: () => {}, stopReceiptCamera: () => {}, saveOperatorState: () => {},
        prepareOperatorBackgroundPhotos: async () => ({ backgroundPhotos: [{ id: "photo-one" }, { id: "photo-two" }] }),
        resumeOperatorBackgroundPhotos: () => {},
        uploadOperatorPhotos: async () => { calls.push({ type: "upload" }); return ["r2://one", "r2://two"]; },
        api: async (path, options) => { calls.push({ type: "post", path, payload: JSON.parse(options.body), screen: calls.filter(call=>call.type==="render").at(-1) }); return { status: "complete", result: { complete: true } }; }
      });
      const fn = kind === "receiving" ? functionText("confirmReceipt", "pollReceiptJob") : functionText("confirmFulfillment", "pollFulfillmentJob");
      await vm.runInContext(`${fn}\n${kind === "receiving" ? "confirmReceipt" : "confirmFulfillment"}()`, context);
      const post = calls.find((call) => call.type === "post");
      assert.ok(post, JSON.stringify(calls));
      if (effective) { assert.match(post.screen.message,/NetSuite/); assert.equal(post.screen.stage,"Posting to NetSuite"); }
      assert.deepEqual(post.payload.backgroundPhotos, [{ id: "photo-one" }, { id: "photo-two" }]);
      assert.equal(post.payload.photoDataUrls, undefined);
      assert.equal(calls.filter((call) => call.type === "upload").length, 0);
      assert.equal(calls.filter((call) => call.type === "post").length, 1);
    }
  });
}


test("posting stays pending beyond 15 seconds and reports the delay until verification",async()=>{
  const fn=source.slice(source.indexOf("async function pollOperatorNetSuitePostingJob("),source.indexOf("async function editReloadPacking("));
  let calls=0;const progress=[];
  const context=vm.createContext({
    Date: { now: () => calls * 1000 },
    operatorPostingPollWakeups: new Map(),
    clearTimeout:()=>{},
    setTimeout:resolve=>resolve(),
    api:async()=>++calls===18?{status:"completed",result:{localFinalization:{verified:true}}}:{status:"posting",steps:[{status:"pending"}]}
  });
  vm.runInContext(fn,context);
  assert.equal((await context.pollOperatorNetSuitePostingJob("pending-job",value=>progress.push(value))).verified,true);
  assert.equal(calls,18);
  assert.ok(progress.some(value=>/taking longer/i.test(value.message)));
});
