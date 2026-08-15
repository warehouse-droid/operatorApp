import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const operatorSource = fs.readFileSync(
  new URL("../../../public/operator.js", import.meta.url),
  "utf8"
);
const regressionMatrix = fs.readFileSync(
  new URL("../../sales-order-reload-regression-matrix.md", import.meta.url),
  "utf8"
);

function sourceBetween(startMarker, endMarker) {
  const start = operatorSource.indexOf(startMarker);
  const end = operatorSource.indexOf(endMarker, start);
  assert.ok(start >= 0, `Operator source is missing ${startMarker}.`);
  assert.ok(end > start, `Operator source is missing ${endMarker} after ${startMarker}.`);
  return operatorSource.slice(start, end);
}

function loadReloadPhotoPolicy() {
  const source = sourceBetween("function isPackedReloadReady", "function renderOrderPanel");
  return Function("t", `${source}; return { isPackedReloadReady, deliveryLoadAction };`)(
    (_key, fallback) => fallback
  );
}

test("packed authorized re-load enters photo capture even when canonical order is loaded", () => {
  const policy = loadReloadPhotoPolicy();
  const order = {
    operator_status: "loaded",
    local_yard_order_status: "Loaded",
    reload_authorized: true,
    reload_cycle: { status: "packed" }
  };

  assert.equal(policy.isPackedReloadReady(order), true);
  assert.deepEqual(policy.deliveryLoadAction(order, "active"), {
    reloadReady: true,
    show: true,
    label: "Take Photos & Re-load",
    allowPackedQuantityEdit: false,
    showEditPacking: true
  });
});

test("ordinary loaded and unfinished re-load orders cannot bypass packing", () => {
  const policy = loadReloadPhotoPolicy();

  assert.deepEqual(policy.deliveryLoadAction({ operator_status: "loaded" }, "active"), {
    reloadReady: false,
    show: false,
    label: "Load",
    allowPackedQuantityEdit: true,
    showEditPacking: false
  });
  assert.equal(policy.deliveryLoadAction({
    reload_authorized: true,
    reload_cycle: { status: "preparing" }
  }, "active").show, false);
  assert.equal(policy.deliveryLoadAction({ operator_status: "packed" }, "packed").show, true);
});

test("Operator wires the re-load action to the existing two-photo live-camera screen", () => {
  const detailSource = sourceBetween("function renderDetailPanel", "function renderFulfillmentScreen");
  const fulfillmentSource = sourceBetween("function renderFulfillmentScreen", "function renderLine");
  const startSource = sourceBetween("async function startFulfillment", "function stopFulfillmentCamera");

  assert.match(detailSource, /deliveryLoadAction\(order, viewMode\)/u);
  assert.match(detailSource, /data-action="start-fulfill"/u);
  assert.match(detailSource, /loadAction\.label/u);
  assert.match(startSource, /await api\(`\/api\/delivery\/orders\/\$\{encodeURIComponent\(/u);
  assert.match(startSource, /isPackedReloadReady/u);
  assert.match(startSource, /if \(order\.reload_authorized\) await startFulfillmentCamera\(\)/u);
  assert.match(fulfillmentSource, /data-action="start-camera"/u);
  assert.match(operatorSource, /function fulfillmentRequiredPhotoCount\(\)[\s\S]*?return 2;/u);
  assert.match(fulfillmentSource, /const requiredPhotoCount = isPickupLoad[\s\S]*?: fulfillmentRequiredPhotoCount\(\)/u);
  assert.match(fulfillmentSource, /fulfillmentPhotoCount >= requiredPhotoCount/u);
});

test("packed re-load replaces the invalid quantity update with an explicit edit transition", () => {
  const selectedLineSource = sourceBetween("function renderSelectedLinePanel", "function renderStepper");
  const editSource = sourceBetween("async function editReloadPacking", "async function startFulfillment");

  assert.match(selectedLineSource, /allowPackedQuantityEdit/u);
  assert.match(selectedLineSource, /data-action="edit-reload-packing"/u);
  assert.match(editSource, /status:\s*"preparing"/u);
  assert.match(operatorSource, /button\.dataset\.action === "edit-reload-packing"/u);
});

test("re-load photo-entry regression is recorded in the permanent matrix", () => {
  assert.match(regressionMatrix, /test:sales-order-reload-photo-entry/u);
  assert.match(regressionMatrix, /Take Photos & Re-load/u);
  assert.match(regressionMatrix, /RELOAD_ALREADY_PACKED/u);
});
