import { readFile } from "node:fs/promises";

import { expect, test } from "./mbt-e2e-test.js";

/* global localStorage, window */

test.use({ serviceWorkers: "block" });

const ORDER_ID = "9988165";
const LINE_ID = "pickup-photo-gate-line";
const pickupOrder = Object.freeze({
  netsuite_id: ORDER_ID,
  tranid: "SO-PICKUP-PHOTO-GATE",
  order_type: "sales_order",
  delivery_method: "Pick-Up",
  customer: "Customer Pickup gate browser fixture",
  trandate: "2026-08-15",
  outbound_location_id: 1,
  outbound_location: "3445",
  operator_status: "packed",
  local_yard_order_status: "Packed",
  lines: [Object.freeze({
    id: LINE_ID,
    line_id: "1",
    item_id: "880165",
    item_name: "Pickup gate item",
    sku: "PICKUP-GATE-ITEM",
    item_description: "Packed Customer Pickup line",
    item_type: "InvtPart",
    quantity: 1,
    unit: "PC",
    piece_qty: 1,
    packed_piece_qty: 1,
    packed_pallet_qty: 0,
    packed_layer_qty: 0,
    packed_section_qty: 0,
    packed_sales_qty: 0,
    loaded_qty: 0,
    to_pcs: 1,
    netsuite_active: true,
    confirmed: true
  })]
});

const currentAssets = Object.freeze({
  "/i18n.js": {
    contentType: "text/javascript",
    body: await readFile(new URL("../../../public/i18n.js", import.meta.url), "utf8")
  },
  "/operator.js": {
    contentType: "text/javascript",
    body: await readFile(new URL("../../../public/operator.js", import.meta.url), "utf8")
  }
});

function fulfillJson(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

function policy(enabled, revision) {
  return {
    schemaVersion: "operator-customer-pickup-photo-requirement-v1",
    flagKey: "operator_customer_pickup_photo_required",
    required: enabled,
    requiredPhotoCount: enabled ? 1 : 0,
    revision,
    updatedAt: "2026-08-15T03:45:00.000Z"
  };
}

async function installCurrentAssets(page) {
  await page.route("**/*", async (route) => {
    const asset = currentAssets[new URL(route.request().url()).pathname];
    return asset
      ? route.fulfill({ status: 200, ...asset })
      : route.fallback();
  });
}

async function installPickupSession(page) {
  await page.addInitScript(({ orderId, lineId }) => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("mbbs.staff.token", "pickup-photo-gate-browser-token");
    localStorage.setItem("mbbs.operator.token", "pickup-photo-gate-browser-token");
    localStorage.setItem("mbbs.operator.locationId", "1");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({
      currentModule: "customer-pickup",
      locationId: 1,
      selectedId: orderId,
      selectedLineId: lineId
    }));
  }, { orderId: ORDER_ID, lineId: LINE_ID });
}

async function installPickupApi(page, policySequence) {
  const state = {
    configRequests: 0,
    completionBodies: [],
    uploadTokenRequests: 0,
    unexpected: []
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/me") {
      return fulfillJson(route, {
        operator: {
          id: "pickup-photo-gate-operator",
          username: "pickup-photo-gate-operator",
          display_name: "Pickup Photo Gate Operator",
          role: "operator",
          roles: ["operator"]
        }
      });
    }
    if (pathname === "/api/delivery/notifications") {
      return fulfillJson(route, {
        total: 0,
        salesOrder: { dueToday: 0 },
        transferOrder: { dueToday: 0 },
        items: []
      });
    }
    if (pathname === "/api/delivery/current-draft") {
      return fulfillJson(route, null);
    }
    if (pathname === `/api/delivery/orders/${ORDER_ID}`) {
      return fulfillJson(route, pickupOrder);
    }
    if (pathname === "/api/customer-pickup/config") {
      const index = Math.min(state.configRequests, policySequence.length - 1);
      state.configRequests += 1;
      return fulfillJson(route, policySequence[index]);
    }
    if (pathname === "/api/operator/netsuite-posting-policy") {
      return fulfillJson(route, {
        schemaVersion: "operator-netsuite-posting-policy-v1",
        supported: true,
        gateKey: "operator_netsuite_customer_pickup_if_3445",
        functionKey: "customer_pickup",
        transactionType: "IF",
        locationId: 1,
        yardCode: "3445",
        present: true,
        configured: false,
        environmentAllowed: false,
        effective: false,
        revision: 1
      });
    }
    if (pathname === "/api/operator/photo-upload-token") {
      state.uploadTokenRequests += 1;
      return fulfillJson(route, { error: "Zero-photo flow must not request an upload token." }, 500);
    }
    if (pathname === `/api/customer-pickup/orders/${ORDER_ID}/load` && request.method() === "POST") {
      state.completionBodies.push(request.postDataJSON());
      const requirement = policySequence[Math.min(state.configRequests - 1, policySequence.length - 1)];
      return fulfillJson(route, {
        id: "pickup-photo-gate-load",
        pickupStatus: "loaded",
        localYardOrderStatus: "loaded",
        remainingLines: 0,
        photoRequirementEnabled: requirement.required,
        requiredPhotoCount: requirement.requiredPhotoCount,
        photoRequirementRevision: requirement.revision,
        photoEvidenceCount: 0
      });
    }
    state.unexpected.push(`${request.method()} ${pathname}`);
    return fulfillJson(route, { error: `Unhandled browser fixture ${request.method()} ${pathname}` }, 404);
  });
  return state;
}

async function openPickupLoad(page, policySequence) {
  await installCurrentAssets(page);
  await installPickupSession(page);
  const state = await installPickupApi(page, policySequence);
  await page.goto("/operator");
  await expect(page.getByRole("heading", { name: "SO-PICKUP-PHOTO-GATE", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.locator(".fulfillment-screen")).toBeVisible();
  return state;
}

test("disabled gate completes Customer Pickup without photo upload", async ({ page }) => {
  const state = await openPickupLoad(page, [policy(false, 20), policy(false, 20)]);
  await expect(page.getByText("Customer Pickup photo proof (optional)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.locator(".fulfillment-card.success")).toBeVisible();
  await expect(page.getByText(/saved without photo evidence/u)).toBeVisible();
  expect(state.configRequests).toBe(2);
  expect(state.uploadTokenRequests).toBe(0);
  expect(state.completionBodies).toEqual([expect.objectContaining({ photoDataUrls: [] })]);
  expect(state.unexpected).toEqual([]);
});

test("gate changing from off to on blocks zero-photo confirmation immediately", async ({ page }) => {
  const state = await openPickupLoad(page, [policy(false, 30), policy(true, 31)]);
  await expect(page.getByText("Customer Pickup photo proof (optional)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Take at least 1 Customer Pickup photo");
  expect(state.configRequests).toBe(2);
  expect(state.completionBodies).toEqual([]);
  expect(state.uploadTokenRequests).toBe(0);
});

test("gate changing from on to off permits zero-photo confirmation without a PWA update", async ({ page }) => {
  const state = await openPickupLoad(page, [policy(true, 40), policy(false, 41)]);
  await expect(page.getByText("Customer Pickup photo proof (required)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.locator(".fulfillment-card.success")).toBeVisible();
  expect(state.configRequests).toBe(2);
  expect(state.completionBodies).toEqual([expect.objectContaining({ photoDataUrls: [] })]);
  expect(state.uploadTokenRequests).toBe(0);
});
