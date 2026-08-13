import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const operator = await readFile(new URL("../../../public/operator.js", import.meta.url), "utf8");
const deliveryRepository = await readFile(new URL("../../../src/delivery-repository.js", import.meta.url), "utf8");

function section(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `Missing source section ${startToken}`);
  return source.slice(start, end);
}

test("Delivery Prep materializes its line summary once per query", () => {
  assert.match(deliveryRepository, /delivery_line_summary AS MATERIALIZED\s*\(/);
});

test("photo uploads retain source resolution and use a bounded two-file queue", async () => {
  assert.match(operator, /OPERATOR_CAMERA_IDEAL_WIDTH\s*=\s*4096/);
  assert.match(operator, /OPERATOR_CAMERA_IDEAL_HEIGHT\s*=\s*3072/);
  assert.match(operator, /imageCapture\.takePhoto\(photoSettings\)/);

  const uploadSection = section(operator, "async function uploadOperatorPhotos", "async function publicApi");
  assert.match(uploadSection, /mapWithConcurrency\(photos, 2,/);
  assert.doesNotMatch(uploadSection, /resize|compress|canvas/i);

  const helperSource = section(operator, "async function mapWithConcurrency", "function updateUploadElapsed");
  const mapWithConcurrency = Function(`${helperSource}; return mapWithConcurrency;`)();
  let active = 0;
  let maximumActive = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(result, [10, 20, 30, 40, 50]);
  assert.equal(maximumActive, 2);

  let pending = 0;
  await assert.rejects(
    mapWithConcurrency([1, 2], 2, async (value) => {
      pending += 1;
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 1 : 10));
      pending -= 1;
      if (value === 1) {
        throw new Error("upload failed");
      }
      return value;
    }),
    /upload failed/
  );
  assert.equal(pending, 0, "a failed queue must wait for in-flight uploads before allowing a retry");
});

test("upload progress updates one text node instead of rebuilding photo screens", () => {
  const fulfillment = section(operator, "async function confirmFulfillment", "async function pollFulfillmentJob");
  const receipt = section(operator, "async function confirmReceipt", "async function pollReceiptJob");
  assert.match(fulfillment, /updateUploadElapsed\("\[data-fulfillment-upload-elapsed\]"/);
  assert.match(receipt, /updateUploadElapsed\("\[data-receipt-upload-elapsed\]"/);
  assert.doesNotMatch(fulfillment, /setInterval\(\(\) => \{\s*if \(fulfillmentSubmitting\) render\(\)/);
  assert.doesNotMatch(receipt, /setInterval\(\(\) => \{\s*if \(receiptSubmitting\) render\(\)/);
});

test("completed loads render Delivery Prep before awaiting a server refresh", () => {
  const finish = section(operator, "async function finishFulfillment", "function renderReceiptScreen");
  const removeIndex = finish.indexOf("removeDeliveryOrderFromLocalState(completedOrder)");
  const renderIndex = finish.indexOf("render();", removeIndex);
  const refreshIndex = finish.indexOf("await reloadDeliveryScreen();", renderIndex);
  assert.ok(removeIndex >= 0, "the completed order must leave the local list immediately");
  assert.ok(renderIndex > removeIndex, "Delivery Prep must render after local state is cleaned");
  assert.ok(refreshIndex > renderIndex, "the network refresh must happen after navigation renders");
});

test("background delivery polling cannot pile onto refreshes or uploads", () => {
  const notificationLoader = section(operator, "async function loadDeliveryNotifications", "function applyDeliveryNotifications");
  assert.match(notificationLoader, /deliveryNotificationsRequest/);
  assert.match(notificationLoader, /deliveryNotificationsRequest\?\.promise === promise/);

  const timers = operator.slice(operator.indexOf("boot();"), operator.indexOf('if ("serviceWorker" in navigator)'));
  const guard = /deliveryOrdersLoadingCount \|\| fulfillmentSubmitting \|\| receiptSubmitting \|\| returnBusy/g;
  assert.equal((timers.match(guard) || []).length, 2);
});
