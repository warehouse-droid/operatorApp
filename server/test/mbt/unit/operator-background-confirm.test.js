import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../../../public/operator.js", import.meta.url), "utf8");
for (const local of [true, false]) {
  test(`Load submits without photo network traffic (local=${local})`, async () => {
    const calls = [];
    const context = vm.createContext({
      fulfillmentOrder: { netsuite_id: "GOB-120487-120489", order_type: "sales_order" },
      fulfillmentSubmitting: false, fulfillmentPhotoDataUrls: ["data:image/jpeg;base64,YQ==", "data:image/jpeg;base64,Yg=="],
      fulfillmentNetSuitePolicy: { effective: !local }, currentModule: "delivery", fulfillmentLoadRequestId: "request",
      locationId: 1, deliveryOrderType: "sales_order", fulfillmentProgressTimer: null,
      window: { setInterval: () => 1, clearInterval: () => {} }, render() {}, showToast() {},
      operatorNetSuitePostingIsLocalOnly: () => local, fulfillmentRequiredPhotoCount: () => 2,
      loadOperatorNetSuitePostingPolicy: async () => ({ effective: !local }), operatorNetSuitePolicyToken: x => x,
      stopFulfillmentCamera() {},
      uploadOperatorPhotos: () => { calls.push("blocking-upload"); return new Promise(() => {}); },
      prepareOperatorBackgroundPhotos: async () => ({ backgroundPhotos: [{ id: "photo1" }, { id: "photo2" }] }),
      resumeOperatorBackgroundPhotos: () => { calls.push("resume"); },
      api: async (_path, options) => { calls.push(JSON.parse(options.body)); return { status: "complete", result: { id: 1 } }; }
    });
    const start = source.indexOf("async function confirmFulfillment(");
    const end = source.indexOf("async function pollFulfillmentJob(", start);
    await Promise.race([vm.runInContext(`${source.slice(start, end)}\nconfirmFulfillment()`, context), new Promise(resolve => setTimeout(resolve, 50))]);
    const request = calls.find(call => typeof call === "object");
    assert.ok(request, "Load must reach the server while the photo network is stalled");
    assert.equal(calls.includes("blocking-upload"), false);
    assert.deepEqual(request.backgroundPhotos, [{ id: "photo1" }, { id: "photo2" }]);
    assert.equal(JSON.stringify(request).includes("data:image"), false);
  });
}
