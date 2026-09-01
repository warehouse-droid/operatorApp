// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const dispatchSource = fs.readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");

function sourceBetween(startNeedle, endNeedle) {
  const start = dispatchSource.indexOf(startNeedle);
  const end = dispatchSource.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `Missing source marker: ${startNeedle}`);
  assert.ok(end > start, `Missing source marker after ${startNeedle}: ${endNeedle}`);
  return dispatchSource.slice(start, end);
}

test("address-only Dispatch Info saves never infer CO cancellation from checkbox state", () => {
  const submitBranch = sourceBetween(
    'if (form.dataset.form === "edit-order-details")',
    'if (form.dataset.form === "driver")'
  );
  assert.doesNotMatch(submitBranch, /cancelTransitCoAndApply/u);
  assert.doesNotMatch(submitBranch, /cancelTransitCoOnServer/u);
});

test("an existing CO exposes a separate explicit cancellation action", () => {
  const editor = sourceBetween("function renderTransitCoEditor", "async function loadOrderDependencyOptions");
  assert.match(editor, /data-action=["']cancel-transit-co["']/u);
  assert.match(editor, /Current CO/u);
});

test("explicit CO cancellation confirms first and clears local state only after server success", () => {
  const clickBranch = sourceBetween('if (action === "cancel-transit-co")', 'if (action === "undo-plan")');
  assert.match(clickBranch, /window\.confirm/u);
  assert.ok(
    clickBranch.indexOf("await cancelTransitCoOnServer") < clickBranch.indexOf("cancelTransitCoForOrder"),
    "server cancellation must succeed before the browser removes the CO relationship"
  );
});

test("CO creation persists a bounded preview before mutating the browser plan", () => {
  const submitBranch = sourceBetween(
    'if (form.dataset.form === "transit-co")',
    'if (form.dataset.form === "edit-order-details")'
  );
  const preview = submitBranch.indexOf("previewTransitCoForOrder");
  const persisted = submitBranch.indexOf("await saveTransitCoToServer");
  const applied = submitBranch.indexOf("upsertTransitCoForOrder", persisted);
  assert.ok(preview >= 0 && persisted > preview && applied > persisted,
    "CO creation must persist its non-mutating preview before applying it to the live plan");
  assert.doesNotMatch(submitBranch, /structuredClone/u,
    "CO failure handling must not copy the full Dispatch order graph");
});
