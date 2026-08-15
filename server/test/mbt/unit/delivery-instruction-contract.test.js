import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const serverSource = read("../../../src/server.js");
const driverRepositorySource = read("../../../src/driver-repository.js");
const driverSource = read("../../../public/driver.js");
const dispatchSource = read("../../../public/dispatch.js");
const dispatchHtml = read("../../../public/dispatch.html");
const dispatchCss = read("../../../public/dispatch.css");
const sidebarSource = read("../../../public/app-sidebar.js");
const deliveryInstructionCss = read("../../../public/delivery-instructions.css");
const salesDeliveryInstructionHtml = read("../../../public/sales-delivery-instructions.html");
const salesDeliveryInstructionSource = read("../../../public/sales-delivery-instructions.js");
const deliveryInstructionUploadSource = read("../../../public/delivery-instruction-upload.js");

test("Sales and Dispatch expose role-scoped delivery instruction APIs and page route", () => {
  assert.match(serverSource, /\/api\/sales\/delivery-instructions\/orders/);
  assert.match(serverSource, /requirePrivateSalesRecordAccess/);
  assert.match(serverSource, /\/api\/dispatch\/orders\/:id\/delivery-instructions/);
  assert.match(serverSource, /\/api\/delivery-instruction-media\/:mediaId\/content/);
  assert.match(serverSource, /\/sales\/delivery-instructions/);
  assert.match(sidebarSource, /Delivery Instructions[^\n]+\/sales\/delivery-instructions/);
});

test("Dispatch lazy-loads instruction data and does not commit a plan mutation when saving it", () => {
  assert.match(dispatchSource, /loadDeliveryInstructionEditor/);
  assert.match(dispatchSource, /saveDeliveryInstructionEditor/);
  const saver = dispatchSource.match(/async function saveDeliveryInstructionEditor[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(saver, /commitPlanMutation|clearActiveRouteEstimates|requestTargetedOrderPoolRefresh/);
  assert.match(dispatchSource, /replace-delivery-instruction-media/);
  assert.match(salesDeliveryInstructionSource, /replaceMediaId/);
  assert.match(serverSource, /delivery\.instructions\.media\.replaced/);
  assert.match(serverSource, /mediaMutation\?\.type !== "replay"/);
});

test("Dispatch resolves grouped and split cards to stable original Sales Order instruction targets", () => {
  const helperStart = dispatchSource.indexOf("function canonicalDispatchOrderType");
  const helperEnd = dispatchSource.indexOf("function normalizePoDropoffs");
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "Delivery-instruction target helpers were not found.");
  const helperSource = dispatchSource.slice(helperStart, helperEnd);
  const deliveryInstructionOrderTargets = Function(
    `"use strict"; ${helperSource}; return deliveryInstructionOrderTargets;`
  )();

  assert.deepEqual(deliveryInstructionOrderTargets({ id: "SOB100001", type: "SO", customer: "Alpha" }), [{
    id: "SOB100001",
    customer: "Alpha",
    memberRefs: ["SOB100001"]
  }]);
  assert.deepEqual(deliveryInstructionOrderTargets({
    id: "SOB100001-S1",
    type: "SO",
    originalOrderId: "SOB100001",
    customer: "Alpha"
  }), [{
    id: "SOB100001",
    customer: "Alpha",
    memberRefs: ["SOB100001-S1"]
  }]);
  assert.deepEqual(deliveryInstructionOrderTargets({
    id: "GSO-DELIVERY",
    type: "SO",
    childOrders: ["SOB100001-S1", "SOB100001-S2", "SOB100002", "POB200001"],
    childOrderDetails: [
      { id: "SOB100001-S1", type: "SO", originalOrderId: "SOB100001", customer: "Alpha" },
      { id: "SOB100001-S2", type: "SO", originalOrderId: "SOB100001", customer: "Alpha" },
      { id: "SOB100002", type: "SO", customer: "Beta" },
      { id: "POB200001", type: "PO", customer: "Vendor" }
    ]
  }), [
    { id: "SOB100001", customer: "Alpha", memberRefs: ["SOB100001-S1", "SOB100001-S2"] },
    { id: "SOB100002", customer: "Beta", memberRefs: ["SOB100002"] }
  ]);

  const saver = dispatchSource.slice(
    dispatchSource.indexOf("async function saveDeliveryInstructionEditor"),
    dispatchSource.indexOf("async function uploadDeliveryInstructionEditorFiles")
  );
  const uploader = dispatchSource.slice(
    dispatchSource.indexOf("async function uploadDeliveryInstructionEditorFiles"),
    dispatchSource.indexOf("function chooseDeliveryInstructionEditorReplacement")
  );
  const deleter = dispatchSource.slice(
    dispatchSource.indexOf("async function deleteDeliveryInstructionEditorMedia"),
    dispatchSource.indexOf("function renderModal")
  );
  for (const mutationSource of [saver, uploader, deleter]) {
    assert.match(mutationSource, /deliveryInstructionEditorTargetOrderId/);
    assert.doesNotMatch(mutationSource, /encodeURIComponent\(state\.orderId\)/);
  }
});

test("Dispatch edit popup keeps planning and CO controls left and SO instructions right", () => {
  assert.match(dispatchSource, /edit-order-workspace/);
  assert.match(dispatchSource, /edit-order-planning-pane[\s\S]*renderTransitCoEditor/);
  assert.match(dispatchSource, /edit-order-instruction-pane[\s\S]*deliveryInstructionEditor/);
  assert.match(dispatchSource, /data-delivery-instruction-order/);
  assert.match(dispatchCss, /\.edit-order-workspace\.has-delivery-instructions\s*\{[\s\S]*grid-template-columns:/);
  assert.match(dispatchCss, /@media \(max-width: 900px\)[\s\S]*\.edit-order-workspace\.has-delivery-instructions[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(dispatchHtml, /dispatch\.js\?v=20260814-plan-resume-v1/);
});

test("Sales and Dispatch compress instruction images to 720p and accept file drops", () => {
  const browserWindow = {};
  Function("window", deliveryInstructionUploadSource)(browserWindow);
  const upload = browserWindow.DeliveryInstructionUpload;
  assert.ok(upload);
  assert.equal(upload.JPEG_QUALITY, 0.72);
  assert.deepEqual(upload.outputDimensions(1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(upload.outputDimensions(1707, 1280), { width: 960, height: 720 });
  assert.deepEqual(upload.outputDimensions(1080, 1920), { width: 720, height: 1280 });
  assert.deepEqual(upload.outputDimensions(640, 480), { width: 640, height: 480 });
  assert.equal(upload.outputFileName("instruction.png"), "instruction-720p.jpg");

  for (const source of [salesDeliveryInstructionSource, dispatchSource]) {
    assert.match(source, /data-delivery-instruction-drop-zone/);
    assert.match(source, /DeliveryInstructionUpload\.prepareFiles/);
    assert.match(source, /DeliveryInstructionUpload\?\.isFileDrag/);
  }
  assert.match(deliveryInstructionCss, /\.delivery-instruction-upload-zone\.drag-over/);
  assert.match(salesDeliveryInstructionHtml, /delivery-instruction-upload\.js\?v=20260812-delivery-image-720p-v1/);
  assert.match(dispatchHtml, /delivery-instruction-upload\.js\?v=20260812-delivery-image-720p-v1/);
});

test("Driver deduplicates split siblings onto one original-SO instruction page", async () => {
  const helperStart = driverRepositorySource.indexOf("function materializedDriverSalesOrders");
  const helperEnd = driverRepositorySource.indexOf("async function materializeDriverJob");
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "Driver instruction attachment helpers were not found.");
  const attachDriverDeliveryInstructions = Function(
    "getDeliveryInstructionsForDriverOrderIds",
    `"use strict"; ${driverRepositorySource.slice(helperStart, helperEnd)}; return attachDriverDeliveryInstructions;`
  )(async () => ({
    "-101": {
      orderId: -101,
      orderRef: "SOB100001-S1",
      instructionOrderId: 100001,
      instructionOrderRef: "SOB100001",
      revision: 2,
      automatic: { text: "Call first", phones: [] },
      additionalText: "Use the gate",
      media: []
    },
    "-102": {
      orderId: -102,
      orderRef: "SOB100001-S2",
      instructionOrderId: 100001,
      instructionOrderRef: "SOB100001",
      revision: 2,
      automatic: { text: "Call first", phones: [] },
      additionalText: "Use the gate",
      media: []
    }
  }));
  const materialized = {
    stopType: "dropoff",
    orders: [
      { orderId: -101, orderRef: "SOB100001-S1", orderType: "SO", party: "Customer" },
      { orderId: -102, orderRef: "SOB100001-S2", orderType: "SO", party: "Customer" }
    ]
  };
  await attachDriverDeliveryInstructions(materialized);
  assert.equal(materialized.deliveryInstructions.revision, 2);
  assert.deepEqual(materialized.deliveryInstructions.orders.map((entry) => entry.orderRef), ["SOB100001"]);
  assert.equal(materialized.deliveryInstructions.orders[0].additionalText, "Use the gate");
});

test("Driver renders a combined instruction-first pager and excludes non-drop-off types", () => {
  assert.match(driverSource, /renderDeliveryInstructionPage/);
  assert.match(driverSource, /deliveryInstructions/);
  assert.match(driverSource, /stop-detail-page/);
  assert.match(driverSource, /stopType\s*!==\s*["']dropoff["']/);
  assert.match(driverSource, /No delivery instructions/);
});

test("online Driver images use the authenticated content URL immediately and expose retry", () => {
  const urlHelper = driverSource.match(/function driverDeliveryInstructionMediaUrl[\s\S]*?\n}/)?.[0] || "";
  assert.match(urlHelper, /navigator\.onLine/);
  assert.match(urlHelper, /token=/);
  assert.doesNotMatch(urlHelper, /offlineStorageAvailable|offlinePartition/);
  assert.match(driverSource, /data-instruction-media-image/);
  assert.match(driverSource, /retry-instruction-image/);
  assert.match(driverSource, /Image could not load/);
});

test("live instruction edits refresh only the Driver stop detail and preserve the route screen", () => {
  assert.match(serverSource, /\/api\/driver\/jobs\/:jobId\/delivery-instructions/);
  const refresher = driverSource.match(/async function refreshCurrentDeliveryInstructions[\s\S]*?\n}/)?.[0] || "";
  assert.match(refresher, /details\.outerHTML = renderStopDetails\(currentJob\)/);
  assert.match(refresher, /scrollContainer\.scrollTop = scrollTop/);
  assert.match(refresher, /downloadDayPlan\(currentJob\.planDate, \{ forceRefresh: true \}\)/);
  assert.doesNotMatch(refresher, /renderJob\(|loadNextJob\(/);
});

test("the complete Driver day plan batches delivery instructions instead of querying per stop", () => {
  const dayPlan = driverRepositorySource.match(
    /export async function getDriverDayJobs[\s\S]*?export async function getDriverNextJobContext/
  )?.[0] || "";
  assert.match(dayPlan, /deferDeliveryInstructions: true/);
  assert.equal((dayPlan.match(/getDeliveryInstructionsForDriverOrderIds\(/g) || []).length, 1);
  assert.match(dayPlan, /attachDriverDeliveryInstructions\(job, instructionByOrderId\)/);
});

test("Sales delivery-order cards retain their own height and wrap long content without overlap", () => {
  assert.match(
    deliveryInstructionCss,
    /\.delivery-instruction-order-list\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/
  );
  assert.match(
    deliveryInstructionCss,
    /\.delivery-instruction-order-card\s*\{[\s\S]*?flex:\s*0\s+0\s+auto;[\s\S]*?height:\s*auto;/
  );
  assert.match(
    deliveryInstructionCss,
    /\.delivery-instruction-order-card\s*>\s*span[\s\S]*?overflow-wrap:\s*anywhere;/
  );
  assert.match(salesDeliveryInstructionHtml, /delivery-instructions\.css\?v=20260812-delivery-image-720p-v1/);
});
