// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const dispatchSource = fs.readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
const customRepositorySource = fs.readFileSync(new URL("../../../src/dispatch-custom-order-repository.js", import.meta.url), "utf8");
const driverRepositorySource = fs.readFileSync(new URL("../../../src/driver-repository.js", import.meta.url), "utf8");
const receivingRepositorySource = fs.readFileSync(new URL("../../../src/receiving-repository.js", import.meta.url), "utf8");

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `Missing source marker: ${startNeedle}`);
  assert.ok(end > start, `Missing source marker after ${startNeedle}: ${endNeedle}`);
  return source.slice(start, end);
}

test("VRMA and ordinary Custom Orders use the same persisted CO eligibility contract as SO/TO", () => {
  const policy = sourceBetween(dispatchSource, "function supportsTransitCoForOrder", "function transitCoSourceRef");
  assert.match(policy, /scm_vrma_orders["']\)\s*return\s+["']VRMA["']/u);
  assert.match(policy, /\[\s*["']SO["']\s*,\s*["']TO["']\s*,\s*["']CUSTOM["']\s*\]\.includes/u);
  assert.match(policy, /isSalesOrderReattempt\(order\)/u, "system-managed re-attempt children must remain excluded");
});

test("Dispatch exposes a dedicated CO control without redirecting Custom Order management", () => {
  const actions = sourceBetween(dispatchSource, "function renderSelectedOrderActions", "function poSourceReferenceText");
  assert.match(actions, /data-action=["']open-transit-co["']/u);
  assert.match(actions, /order\.transitCo\s*\?\s*["']Manage CO["']\s*:\s*["']Add CO["']/u);
  assert.match(dispatchSource, /data-form=["']transit-co["']/u);
  assert.match(dispatchSource, /await\s+saveTransitCoToServer[\s\S]{0,500}commitPlanMutation\(["']co_created["']\)/u,
    "the durable CO row must be saved before the plan mutation can autosave");
});

test("VRMA and Custom CO creation bypasses the NetSuite-only Dispatch details endpoint", () => {
  const submit = sourceBetween(dispatchSource, 'if (form.dataset.form === "edit-order-details")', 'if (form.dataset.form === "driver")');
  const localCoDeclaration = submit.indexOf("const localCoOnlySource");
  const localCoBranch = submit.indexOf('if (wantsTransitCo && localCoOnlySource)');
  const detailsRequest = submit.indexOf("const detailsEndpoint");
  assert.ok(localCoDeclaration >= 0 && localCoBranch > localCoDeclaration && detailsRequest > localCoBranch,
    "local VRMA/Custom CO creation must return before the SO/PO/TO details request");
  const branch = submit.slice(localCoDeclaration, detailsRequest);
  assert.match(branch, /\["VRMA",\s*"CUSTOM"\]\.includes\(transitSourceOrderType\(order\)\)/u);
  assert.match(branch, /await\s+saveTransitCoToServer[\s\S]{0,1200}commitPlanMutation\("co_created"\)/u,
    "the local CO must be durable before its plan mutation is committed");
});

test("Custom Order feed and canonical plan use the active CO destination as the effective pickup", () => {
  assert.match(customRepositorySource, /active_co\.co_ref\s+AS\s+transit_co_ref/u);
  assert.match(customRepositorySource, /co\.source_order_ref\s*=\s*custom_order\.ref_number[\s\S]{0,120}co\.status\s*<>\s*'cancelled'/u);
  assert.match(customRepositorySource, /effectivePickupLocation\s*=\s*String\(transitCo\?\.toYard\s*\|\|\s*pickupLocation\)/u);
  assert.match(customRepositorySource, /function\s+customOrderDispatchPickupLocation[\s\S]{0,180}transitCo\?\.toYard/u);
  assert.match(customRepositorySource, /DISPATCH_CUSTOM_ORDER_ACTIVE_CO/u,
    "an active CO must lock its Custom source against stale edits or cancellation");
});

test("Driver VRMA overlay cannot erase a saved CO transit pickup", () => {
  const overlay = sourceBetween(driverRepositorySource, "async function overlayLiveVrmaRouteDetails", "function assignedTruckForLoad");
  assert.match(overlay, /order\?\.transitCo\?\.toYard\s*\|\|\s*livePickup/u);
  assert.match(overlay, /effectivePickupByRef/u);
});

test("CO receiving preserves VRMA and Custom source identities", () => {
  const receiving = sourceBetween(receivingRepositorySource, "export async function receiveLocalCoOrder", "export async function recordReceivingReceipt");
  assert.match(receiving, /FROM\s+scm_vrma_orders/u);
  assert.match(receiving, /FROM\s+dispatch_custom_orders/u);
  assert.match(receiving, /receiveAsSourceVrma/u);
  assert.match(receiving, /receiveAsSourceCustom/u);
  assert.match(receiving, /UPDATE\s+scm_vrma_orders[\s\S]{0,450}operator_status\s*=\s*'packed'/u);
  assert.match(receiving, /else if\s*\(!receiveAsSourceCustom\)[\s\S]{0,350}INSERT INTO transfer_orders/u,
    "only unknown legacy sources may use the synthetic Transfer Order fallback");
  assert.match(receivingRepositorySource, /cancelled_source_vrma/u);
  assert.match(receivingRepositorySource, /cancelled_source_custom/u);
});
